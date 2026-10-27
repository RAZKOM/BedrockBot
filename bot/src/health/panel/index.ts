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
import { buildMemory, chestRows, MEMORY_TTL_MS, type PanelMemory } from './memory.ts'; // Track AP
import { mapMarks } from './marks.ts'; // Track AR

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

  // ---- Track AP: what the statuses need beyond the existing closures (passive listeners, only when the panel serves)
  const unsubs: (() => void)[] = [];
  let saturation: number | undefined;
  let rain = false;
  let thunder = false;
  let weatherKnown = false;
  const hits = { n: 0, damage: 0, last: undefined as { damage: number; at: number } | undefined };
  if (plan.mode !== 'off') {
    unsubs.push(
      conn.on('update_attributes', (p) => {
        for (const a of p.attributes) if (a.name === 'minecraft:player.saturation') saturation = a.current;
      }),
      conn.on('level_event', (p: { event?: unknown }) => {
        const e = p.event;
        if (e === 'start_rain' || e === 3001) rain = true;
        else if (e === 'stop_rain' || e === 3003) rain = false;
        else if (e === 'start_thunder' || e === 3002) thunder = true;
        else if (e === 'stop_thunder' || e === 3004) thunder = false;
        else return;
        weatherKnown = true;
      }),
    );
    const off = walking.pve?.mobs.onHit((_g, damage) => {
      if (damage <= 0) return;
      hits.n++;
      hits.damage += damage;
      hits.last = { damage, at: Date.now() };
    });
    if (off) unsubs.push(off);
  }
  const cache = (): WorldCache | undefined => d.worldCache;
  let memo: { at: number; value: PanelMemory } | undefined;
  const memory = (): PanelMemory | undefined => {
    const c = cache();
    if (!c) return undefined;
    const now = Date.now();
    if (!memo || now - memo.at > MEMORY_TTL_MS) memo = { at: now, value: buildMemory(c, runningTask.position()) };
    return memo.value;
  };

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
      paused: () => walking.processes?.paused, // Track AR: the Pause / Resume buttons
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
      // Track AP: inventory and statuses
      inventory: () => built.mobility?.world.inventory,
      saturation: () => saturation,
      weather: () => (weatherKnown ? (thunder ? 'thunder' : rain ? 'rain' : 'clear') : undefined),
      day: () => {
        const t = clock?.time;
        return t === undefined ? undefined : Math.floor(t / 24000);
      },
      deaths: () => (built.respawn ? { deaths: built.respawn.deaths, lastDeath: built.respawn.lastDeath } : undefined),
      combat: () => {
        const p = walking.pve;
        if (!p) return undefined;
        const t = p.combat.totals;
        return {
          fights: p.stats.fights,
          kills: p.stats.kills,
          retargets: t.retargets,
          flees: p.stats.flees,
          guardTriggers: p.stats.guardTriggers,
          hits: hits.n,
          damageTaken: Math.round(hits.damage * 10) / 10,
          lastHit: hits.last ? { damage: hits.last.damage, agoS: Math.round((Date.now() - hits.last.at) / 1000) } : null,
        };
      },
      memory,
      planner: () => {
        const nav = built.mobility?.skills.nav;
        if (!nav) return undefined;
        const s = nav.planner?.stats;
        const threads = d.runtime ? Number(d.runtime.get('plannerThreads')) : null;
        return {
          threads,
          running: nav.planner !== undefined,
          plans: s?.plans ?? 0,
          interims: s?.interims ?? 0,
          results: s?.results ?? 0,
          failed: s?.failed ?? 0,
          forwardMs: Math.round((s?.forwardMs ?? 0) * 10) / 10,
          maxForwardMs: Math.round((s?.maxForwardMs ?? 0) * 100) / 100,
          starts: s?.starts ?? 0,
          crashes: s?.crashes ?? 0,
        };
      },
      conn: () => {
        const m = metrics.snapshot();
        return {
          server: d.settings.server,
          version: conn.gameVersion,
          state: conn.state,
          uptimeS: m.uptimeS,
          sessionS: m.session?.uptimeS ?? null,
          reconnects: m.reconnects,
          disconnects: m.disconnects,
          kicks: m.kicks.total,
          lastDisconnect: m.lastDisconnect ? `${m.lastDisconnect.ts} ${m.lastDisconnect.kind}: ${m.lastDisconnect.reason}`.slice(0, 200) : null,
        };
      },
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

  const routes = panelRoutes({
    state,
    run,
    limiter: new RateLimiter(5, 1000),
    help: () => buildPanelHelp({ commands: () => chat.commandInfo(), settings: d.runtime }), // Track AM: Help tab
    chests: () => chestRows(cache()?.chests.all() ?? [], runningTask.position()), // Track AP: the memory block's list
    marks: () => mapMarks(cache(), runningTask.position()), // Track AR: chests and herds on the panel's map
  });
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
      for (const u of unsubs.splice(0)) u(); // Track AP
      await own?.stop();
      own = undefined;
    },
  };
}
