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
import { flyControlOf } from '../../chat/commands-fly.ts'; // Track AU
import type { ChatLine } from '../../chat/text.ts';
import type { WorldCache } from '../../world/cache/cache.ts';
import { mapRoutes, mapSource, type HealthRoute } from '../map/routes.ts';
import { MapBuilder } from '../map/data.ts'; // decision 0062: the map screen
import { MapLive } from '../map/live.ts';
import type { BlockColours } from './icons/colours.ts';
import { isLoopbackInterface, panelAuth, RateLimiter } from './auth.ts';
import { LogRing } from './logRing.ts';
import { panelRoutes, type CommandResult } from './routes.ts';
import { buildPanelHelp, buildPanelState, liteState, type PanelChatLine, type PanelState } from './state.ts'; // Track AM: buildPanelHelp; decision 0061: liteState for the stream
import { buildMemory, chestRows, MEMORY_TTL_MS, type PanelMemory } from './memory.ts'; // Track AP
import { mapMarks, marksWindow, MARKS_RADIUS } from './marks.ts'; // Track AR; decision 0062: a window and the block marks
import { IconBook } from './icons/book.ts'; // decision 0046: the item pictures
import { assetDir, FsAssets } from './icons/source.ts';
import { eventRoutes } from '../../events/routes.ts'; // decision 0059: GET /api/events
import { viaPanel } from '../../events/actor.ts';
import { events as eventBus, type EventBus } from '../../events/bus.ts'; // decision 0061: the events topic
import { formatEvent } from '../../events/registry.ts';
import { clientModules } from './assets.ts'; // decision 0061: the page's browser modules
import { StreamHub, type Topic } from './stream.ts'; // decision 0061: the push channel
import { PANEL_BUDGETS } from './budgets.ts';
import { EVENTS_TOPIC, STATE_SAMPLE_MS, STATE_TOPIC } from './shared.ts';

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
  /** The item pictures; default: the minecraft-assets package when it is installed (tests pass their own or null for none). */
  icons?: IconBook | null;
  /** Decision 0061: where the `events` stream topic comes from; default the process's event bus (decision 0059). */
  events?: Pick<EventBus, 'subscribe'>;
  /** Decision 0062: block colours and top-face textures of the map; default the installed package's (null: none). */
  colours?: BlockColours | null;
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
  /**
   * Decision 0061: the push channel. Other modules add topics here (docs/panel.md "Add a topic"):
   * `panel.hub.topic('jobs', { kind: 'event' }).publish(...)`; the page listens with `page.listen('jobs', fn)`.
   * The panel itself carries `state` and `events` (every bot event, decision 0059).
   */
  readonly hub: StreamHub;
  /** The state topic (a snapshot on connect, then deltas; sampled every STATE_SAMPLE_MS while a stream listens). */
  readonly stateTopic: Topic;
  /** Decision 0062: the map screen's tiles, overlays and slices (topics `map`, `map-live`; /api/map/*); undefined while the panel is off. */
  readonly map: MapLive | undefined;
  /** Add a route behind the panel's token (asked after the panel's own, before the health server's); works before or after start(). */
  use(route: HealthRoute): void;
}

/** The item pictures from the minecraft-assets package, null (and a log line) when it is not installed. */
function openIcons(log: Logger): IconBook | null {
  const dir = assetDir();
  if (!dir) {
    log.warn('panel: item pictures off (the minecraft-assets package is not installed: pnpm install); the inventory keeps its drawn glyphs');
    return null;
  }
  return new IconBook(new FsAssets(dir));
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
  const icons = plan.mode === 'off' ? null : d.icons !== undefined ? d.icons : openIcons(log);
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
      icons: () => icons !== null,
      saturation: () => saturation,
      flight: () => flyControlOf(runningTask)?.state(), // Track AU
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
      link: () => {
        const l = conn.link;
        const r = built.respawn;
        const death = r?.dead ? r.lastDeath : undefined;
        const died = death ? Date.parse(death.ts) : NaN;
        return {
          ...l,
          lastDisconnect: metrics.lastDisconnect,
          ...(r?.dead ? { dead: { since: Number.isFinite(died) ? died : Date.now(), cause: death?.cause ?? 'unknown', respawnAt: r.respawnDelayMs >= 0 && Number.isFinite(died) ? died + r.respawnDelayMs : null } } : {}),
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

  // ---- decision 0061: the push channel (GET /api/stream) and its state topic
  const hub = new StreamHub({ log });
  const stateTopic = hub.topic(STATE_TOPIC, { kind: 'state', read: () => liteState(state()), sampleMs: STATE_SAMPLE_MS, budget: PANEL_BUDGETS.snapshot, deltaBudget: PANEL_BUDGETS.delta });
  // the events topic (decision 0059, docs/events.md "Live subscription"): every new event as it is
  // recorded, with its display text; a page that connects late asks GET /api/events?since=<id> once
  const eventsTopic = hub.topic(EVENTS_TOPIC, { kind: 'event', budget: PANEL_BUDGETS.event });
  if (plan.mode !== 'off') unsubs.push((d.events ?? eventBus).subscribe((e) => eventsTopic.publish({ ...e, text: formatEvent(e) })));
  let pushT: NodeJS.Timeout | undefined;
  /** After a command: push the state soon (the command's effect: settings, stack, chat), not only on the next sample. */
  const pushSoon = (): void => {
    if (pushT || hub.stats().clients === 0) return;
    pushT = setTimeout(() => {
      pushT = undefined;
      stateTopic.refresh();
    }, 250);
    pushT.unref();
  };

  const run = (text: string): CommandResult => {
    const line = panelLine(chat.owners, text);
    if (!line) return { ok: false, replies: [], error: 'no owner to run commands as (owners empty and consoleOwner off)' };
    const as = line.type === 'announcement' ? 'console' : line.source;
    log.info(`panel: ${text} (as ${as})`);
    const mark = replies.total;
    viaPanel(() => chat.handle(line)); // decision 0059: command.received source panel
    pushSoon(); // decision 0061: the stream shows the effect without waiting for the sampler
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

  // ---- decision 0062: the map screen (docs/map.md): tiles over the `map` topic, overlays on `map-live`, /api/map/*
  const mob = built.mobility;
  const mapSrc = mapSource({
    world: mob?.world,
    cache: d.worldCache,
    position: () => runningTask.position(),
    skillsStatus: () => mob?.skills.status(),
    taskStatus: () => runningTask.status(),
    server: d.settings.server,
    ...(d.colours !== undefined ? { colours: d.colours } : {}),
  });
  const colours = mapSrc.colours as BlockColours | null | undefined;
  const map = plan.mode === 'off' ? undefined : new MapLive({ hub, builder: new MapBuilder(mapSrc), source: mapSrc, colours, log });

  const routes = panelRoutes({
    state,
    run,
    limiter: new RateLimiter(5, 1000),
    help: () => buildPanelHelp({ commands: () => chat.commandInfo(), settings: d.runtime }), // Track AM: Help tab
    chests: () => chestRows(cache()?.chests.all() ?? [], runningTask.position()), // Track AP: the memory block's list
    marks: (url) => {
      // Track AR: chests and herds on the panel's map; decision 0062: the map's window and the block marks
      const w = marksWindow(url);
      return mapMarks(cache(), w?.origin ?? runningTask.position(), w?.radius ?? MARKS_RADIUS);
    },
    ...(icons ? { icon: (name: string) => icons.png(name) } : {}), // decision 0046
    ...(colours && typeof colours.texture === 'function' ? { tex: (name: string) => colours.texture(name) } : {}), // decision 0062
  });
  // decision 0061: one route list behind the token: the panel's own routes, the stream, whatever other
  // modules add with use() (docs/panel.md "Add a topic"), then the page's modules (/ui/<hash>/...)
  let modulesRoute: HealthRoute | undefined;
  const routeList: HealthRoute[] = [routes, hub.route(), ...(map ? [map.route()] : [])];
  const allRoutes: HealthRoute = (path, req, res) => {
    for (const r of routeList) if (r(path, req, res)) return true;
    return modulesRoute?.(path, req, res) ?? false;
  };
  const healthOptions = plan.mode === 'shared' ? { host: plan.host, auth } : {};

  return {
    plan,
    healthOptions,
    state,
    run,
    urls,
    hub,
    stateTopic,
    map,
    use: (route) => {
      routeList.push(route);
    },
    async start(health) {
      if (plan.mode === 'off') return true;
      if (plan.refused) log.error(plan.refused);
      try {
        modulesRoute = clientModules().route(); // decision 0061: stripped once, kept in memory
      } catch (e) {
        log.error(`panel: the page's modules do not load: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      logs.tap();
      if (plan.mode === 'shared') {
        if (!health) return false;
        health.use(allRoutes);
        health.use(eventRoutes()); // decision 0059
        boundPort = plan.port;
      } else {
        const debugMap = mapRoutes(mapSrc);
        own = new HealthServer({ port: plan.port ?? 0, host: plan.host, metrics, alive: () => runningTask.alive?.() ?? true, log, routes: debugMap, auth });
        own.use(allRoutes);
        own.use(eventRoutes()); // decision 0059
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
      hub.close(); // decision 0061: ends every stream
      map?.stop(); // decision 0062
      if (pushT) clearTimeout(pushT);
      for (const u of unsubs.splice(0)) u(); // Track AP
      await own?.stop();
      own = undefined;
    },
  };
}
