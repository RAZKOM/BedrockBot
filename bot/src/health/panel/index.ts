// LAN control panel (Track AE, docs/panel.md, decision 0026): a page at `/` on the health server
// that shows what `!status` shows plus vitals, the log tail, the debug map and the `!set` table, and
// runs `!commands` through the chat's command handler as the first owner.
//
//   const panel = setupPanel({ settings, conn, metrics, chat, built, runningTask, runtime, ... });
//   health = new HealthServer({ ..., ...panel.healthOptions });   // host + token check when shared
//   await panel.start(health);                                     // mounts the routes / own server
//
// Where it serves (planPanel): panel.port ?? healthPort. Same port as the health server = one server
// on panel.host; another port = the health server stays as it was (127.0.0.1, no token) and the panel
// gets its own server on panel.host:panel.port (with /healthz, /metrics and /map too). Without a
// token the panel never binds anything but the loopback.
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { Chat, OwnerConfig } from '../../chat/chat.ts';
import { senderLabel } from '../../chat/chat.ts';
import { formatStatus } from '../../chat/commands.ts';
import type { Settings } from '../../config/resolve.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import type { Connection } from '../../connection/connection.ts';
import { HealthServer } from '../../connection/health.ts';
import type { Metrics } from '../../connection/metrics.ts';
import type { Logger } from '../../log.ts';
import type { RunningTask } from '../../tasks/base.ts';
import type { BuiltContext } from '../../tasks/context.ts';
import type { WalkingTask } from '../../tasks/registry.ts';
import type { ChatLine } from '../../chat/text.ts';
import type { WorldCache } from '../../world/cache/cache.ts';
import { mapRoutes, type HealthRoute } from '../map/routes.ts';
import { isLoopbackInterface, panelAuth, RateLimiter } from './auth.ts';
import { LogRing } from './logRing.ts';
import { panelRoutes, type CommandResult } from './routes.ts';
import { buildPanelHelp, buildPanelState, type PanelChatLine, type PanelState } from './state.ts'; // Track AM: buildPanelHelp

export interface PanelPlan {
  mode: 'off' | 'shared' | 'separate';
  host: string;
  port: number | undefined;
  token: string | undefined;
  /** Set when the configured host was refused (no token): the reason, logged as an error. */
  refused?: string;
}

/** Where the panel serves (pure; unit-tested). */
export function planPanel(healthPort: number | undefined, panel: Settings['panel']): PanelPlan {
  const port = panel.port ?? healthPort;
  let host = panel.host;
  let refused: string | undefined;
  if (!panel.token && !isLoopbackInterface(host)) {
    refused = `panel: refusing to serve on ${host} without panel.token; serving on 127.0.0.1 only (set panel.token, \`pnpm config:init\` prints one; docs/panel.md)`;
    host = '127.0.0.1';
  }
  const mode = port === undefined ? 'off' : healthPort !== undefined && port === healthPort ? 'shared' : 'separate';
  return { mode, host, port, token: panel.token, ...(refused ? { refused } : {}) };
}

/** The chat line a panel command becomes: from the first owner name, else the first owner XUID, else the console. */
export function panelLine(owners: OwnerConfig, text: string): ChatLine | undefined {
  const name = owners.names[0];
  if (name) return { type: 'chat', source: name, message: text, body: text, xuid: '', truth: false };
  const xuid = owners.xuids[0];
  if (xuid) return { type: 'chat', source: 'panel', message: text, body: text, xuid, truth: false };
  if (owners.allowConsole) return { type: 'announcement', source: 'Server', message: `[Server] ${text}`, body: text, xuid: '', truth: false };
  return undefined;
}

/** Panel URLs for a bound host: every LAN IPv4 address for 0.0.0.0 / ::, else the host itself. */
export function panelUrls(host: string, port: number, ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  if (host !== '0.0.0.0' && host !== '::') return [`http://${host.includes(':') ? `[${host}]` : host}:${port}/`];
  const lan = Object.values(ifaces)
    .flatMap((l) => l ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${port}/`);
  return [...new Set([...lan, `http://127.0.0.1:${port}/`])];
}

/** The bot's own chat (everything Chat.say sends), newest last. */
export class ChatTap {
  private readonly lines: PanelChatLine[] = [];
  total = 0;
  private readonly capacity: number;

  constructor(capacity = 30) {
    this.capacity = capacity;
  }

  /** Wrap `chat.say` on this instance (every reply goes through it). */
  attach(chat: Pick<Chat, 'say'>): void {
    const orig = chat.say.bind(chat);
    chat.say = (message: string): boolean => {
      const sent = orig(message);
      this.add(message, sent);
      return sent;
    };
  }

  add(text: string, sent: boolean, ts = Date.now()): void {
    this.lines.push({ ts, text, sent });
    this.total++;
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
  }

  /** Lines added after `total` was `mark`. */
  since(mark: number): string[] {
    const n = Math.min(this.total - mark, this.lines.length);
    return n > 0 ? this.lines.slice(-n).map((l) => l.text) : [];
  }

  list(): PanelChatLine[] {
    return [...this.lines];
  }
}

export interface PanelDeps {
  settings: Pick<Settings, 'healthPort' | 'panel' | 'server' | 'task'>;
  conn: Connection;
  metrics: Metrics;
  chat: Chat;
  built: BuiltContext;
  runningTask: RunningTask;
  runtime?: RuntimeSettings;
  worldCache?: WorldCache;
  log: Logger;
}

export interface Panel {
  readonly plan: PanelPlan;
  /** Merge into the health server's options (host and token check) when the panel shares it. */
  readonly healthOptions: { host?: string; auth?: HealthRoute };
  /** Mount the routes on `health` (shared) or start the panel's own server; false = failed (logged). */
  start(health: HealthServer | undefined): Promise<boolean>;
  stop(): Promise<void>;
  urls(): string[];
  state(): PanelState;
  run(text: string): CommandResult;
}

export function setupPanel(d: PanelDeps): Panel {
  const { conn, metrics, chat, built, runningTask, log } = d;
  const plan = planPanel(d.settings.healthPort, d.settings.panel);
  const logs = new LogRing(200);
  const replies = new ChatTap(30);
  const walking = runningTask as WalkingTask;
  const clock = plan.mode === 'off' ? undefined : built.ctx.clock(); // created before connecting (passive listener)
  replies.attach(chat); // every reply the bot says, also when the panel is off (cheap)
  let own: HealthServer | undefined;
  let boundPort: number | undefined;
  const auth = panelAuth(plan.token);

  const state = (): PanelState =>
    buildPanelState({
      name: () => conn.username,
      server: d.settings.server,
      task: d.settings.task,
      connState: () => conn.state,
      healthy: () => conn.state === 'spawned' && (runningTask.alive?.() ?? true),
      gameVersion: () => conn.gameVersion,
      statusLines: () => {
        const snap = metrics.snapshot();
        const line = formatStatus({
          uptimeS: snap.uptimeS,
          sessionS: snap.session?.uptimeS,
          reconnects: snap.reconnects,
          kicks: snap.kicks.total,
          position: runningTask.position(),
          gameVersion: conn.gameVersion,
          tick: conn.tick,
          extra: runningTask.statusLine?.() ?? { task: d.settings.task },
        });
        return [line, ...(walking.processLines?.() ?? [])];
      },
      stack: () => walking.processes?.stack(),
      vitals: () => ({
        health: built.respawn?.health ?? built.mobility?.world.self.health ?? null,
        food: built.mobility ? built.mobility.world.self.food : null,
      }),
      position: () => runningTask.position(),
      dimension: () => built.mobility?.world.self.dimension,
      timeOfDay: () => clock?.timeOfDay,
      settings: d.runtime,
      logs: () => logs.tail(50),
      chat: () => replies.list(),
      commands: () => chat.commandNames(),
    });

  const run = (text: string): CommandResult => {
    const line = panelLine(chat.owners, text);
    if (!line) return { ok: false, replies: [], error: 'no owner to run commands as (owners empty and consoleOwner off)' };
    const as = line.type === 'announcement' ? 'console' : line.source;
    log.info(`panel: ${text} (as ${as})`);
    const mark = replies.total;
    chat.handle(line);
    return { ok: true, replies: replies.since(mark) };
  };

  const urls = (): string[] => (plan.mode === 'off' || boundPort === undefined ? [] : panelUrls(plan.host, boundPort));

  chat.register({
    name: 'panel',
    help: '(control panel URLs on this machine and the LAN)',
    group: 'info', example: '!panel', // Track AM
    run: ({ reply, sender }) => {
      if (plan.mode === 'off') {
        reply('panel is off: set healthPort (or panel.port) in the config; see docs/panel.md');
        return;
      }
      const u = urls();
      if (u.length === 0) {
        reply('panel is not serving (see the log)');
        return;
      }
      const lan = !isLoopbackInterface(plan.host);
      reply(`panel: ${u.join(' ')}${lan ? ' (token required: config panel.token)' : ' (this machine only; panel.host 0.0.0.0 + panel.token for the LAN)'}`);
      log.info(`!panel from ${senderLabel(sender)}`);
    },
  });

  const routes = panelRoutes({ state, run, limiter: new RateLimiter(5, 1000), help: () => buildPanelHelp({ commands: () => chat.commandInfo(), settings: d.runtime }) }); // Track AM: Help tab
  const healthOptions = plan.mode === 'shared' ? { host: plan.host, auth } : {};

  return {
    plan,
    healthOptions,
    state,
    run,
    urls,
    async start(health) {
      if (plan.mode === 'off') return true;
      if (plan.refused) log.error(plan.refused);
      logs.tap();
      if (plan.mode === 'shared') {
        if (!health) return false;
        health.use(routes);
        boundPort = plan.port;
      } else {
        const mob = built.mobility;
        const map = mapRoutes({ world: mob?.world, cache: d.worldCache, position: () => runningTask.position(), skillsStatus: () => mob?.skills.status(), taskStatus: () => runningTask.status(), server: d.settings.server });
        own = new HealthServer({ port: plan.port ?? 0, host: plan.host, metrics, alive: () => runningTask.alive?.() ?? true, log, routes: map, auth });
        own.use(routes);
        try {
          boundPort = await own.start();
        } catch (e) {
          log.error(`panel on ${plan.host}:${plan.port} failed: ${e instanceof Error ? e.message : String(e)}`);
          own = undefined;
          return false;
        }
      }
      log.info(`control panel: ${urls().join(' ')}${plan.token ? ' (token required)' : ' (loopback only, no token)'}`);
      return true;
    },
    async stop() {
      logs.stop();
      await own?.stop();
      own = undefined;
    },
  };
}
