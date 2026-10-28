// LAN control panel (Track AE): GET /api/state, the JSON the page polls every 2 s. Built from
// closures so it is testable without a connection (test/unit/health/panel-state.test.ts).
import type { Vec3 } from '../../connection/types.ts';
import { SETTING_DEFS, SETTING_KEYS, formatSettingValue, type SettingDef, type SettingKey, type SettingSource } from '../../config/settings.ts';
import type { StackEntry } from '../../tasks/process/manager.ts';
import { GROUP_ORDER, settingGroups, type CommandInfo } from '../../chat/help.ts'; // Track AM: Help tab
import { MODE_KEYS, MODE_NAMES, modeLine, modeValues } from '../../chat/modes.ts'; // Track AM
import type { SettingValue } from '../../config/settings.ts'; // Track AM
import { buildInventory, type InventorySource, type PanelInventory } from './inventory.ts'; // Track AP
import type { PanelMemory } from './memory.ts'; // Track AP

export const PANEL_STATE_VERSION = 1;

export interface PanelSetting {
  key: string;
  kind: 'boolean' | 'number' | 'text'; // text: Tracks AD / AF (stashChest, chorePen)
  value: string;
  default: string;
  min?: number;
  max?: number;
  unit?: string;
  /** text settings: what the value may be (`x y z|none`). */
  values?: string;
  source: SettingSource;
  description: string;
}

export interface PanelChatLine {
  ts: number;
  text: string;
  /** False when the chat layer dropped it (not spawned, rate limit): shown only here. */
  sent: boolean;
}

export interface PanelState {
  v: number;
  ts: number;
  bot: { name: string; server: string; task: string; state: string; healthy: boolean; gameVersion: string };
  /** The `!status` reply: status line, then the process line(s). */
  status: string[];
  stack: { name: string; kind: string; priority: number; state: string; line: string; etaS: number | null }[];
  /** Track AR: `!pause` holds the commands (the Pause / Resume buttons); null without a process manager. */
  paused: boolean | null;
  self: {
    health: number | null;
    food: number | null;
    pos: { x: number; y: number; z: number } | null;
    dimension: string | null;
    timeOfDay: number | null;
    phase: 'day' | 'dusk' | 'night' | 'dawn' | null;
    /** Track AP: player.saturation (update_attributes), null until the server sent it. */
    saturation: number | null;
    /** Track AU: `gliding, 23 rockets` while a flight runs, else `on the ground, 23 rockets`; null without the fly commands. */
    flight: string | null;
    /** Track AP: from level_event start / stop rain / thunder; null until one arrived. */
    weather: 'clear' | 'rain' | 'thunder' | null;
    /** Track AP: the world's day number (absolute time / 24000). */
    day: number | null;
    /** Track AP: deaths this run and the last one (RespawnController). */
    deaths: number | null;
    lastDeath: { cause: string; ts: string; messages: string[] } | null;
  };
  /** Track AP: the graphical inventory (inventory.ts); null without the world model. */
  inventory: PanelInventory | null;
  /** Track AP: the current job: the active user process (else the first user process) of the stack. */
  job: { name: string; state: string; line: string; etaS: number | null } | null;
  /** Track AP: PvE totals (PveController.stats + CombatController.totals) and the damage taken while the panel ran. */
  combat: PanelCombat | null;
  /** Track AP: what the bot remembers (memory.ts), counts only; null without a world cache. */
  memory: PanelMemory | null;
  /** Track AP: the planner worker (skills/nav/worker.ts PlannerStats); null without one. */
  planner: PanelPlanner | null;
  /** Track AP: the connection (metrics). */
  conn: PanelConn | null;
  settings: PanelSetting[];
  logs: string[];
  chat: PanelChatLine[];
  commands: string[];
  quick: string[];
}

export interface PanelCombat {
  fights: number;
  kills: number;
  retargets: number;
  flees: number;
  guardTriggers: number;
  /** Hits taken and the health they cost since the bot started (pve MobTracker.onHit). */
  hits: number;
  damageTaken: number;
  lastHit: { damage: number; agoS: number } | null;
}

export interface PanelPlanner {
  /** plannerThreads (0 = planning in the main thread). */
  threads: number | null;
  running: boolean;
  plans: number;
  interims: number;
  results: number;
  failed: number;
  /** Main-thread ms forwarding world changes to the worker: total and the longest flush. */
  forwardMs: number;
  maxForwardMs: number;
  starts: number;
  crashes: number;
}

export interface PanelConn {
  server: string;
  version: string;
  state: string;
  uptimeS: number;
  sessionS: number | null;
  reconnects: number;
  disconnects: number;
  kicks: number;
  lastDisconnect: string | null;
}

/** Quick buttons (`!come` needs a player in the game, so it is not here). */
export const QUICK_COMMANDS = ['!status', '!home go', '!stop', '!guard on', '!guard off', '!eat', '!equip', '!inv'];

export interface PanelStateSource {
  name: () => string;
  server: string;
  task: string;
  connState: () => string;
  healthy: () => boolean;
  gameVersion: () => string;
  statusLines: () => string[];
  stack?: () => readonly StackEntry[] | undefined;
  vitals: () => { health: number | null; food: number | null | undefined };
  position: () => Vec3 | undefined;
  dimension: () => number | undefined;
  timeOfDay: () => number | undefined;
  settings?: { get(key: SettingKey): boolean | number; source(key: SettingKey): SettingSource };
  logs: () => string[];
  chat: () => PanelChatLine[];
  commands: () => string[];
  // ---- Track AP (all optional; a missing or throwing one gives null) ----
  inventory?: () => InventorySource | undefined;
  saturation?: () => number | undefined;
  /** Track AU: the flight state (chat/commands-fly.ts FlyControl.state). */
  flight?: () => { gliding: boolean; rockets: number; phase: string | undefined } | undefined;
  weather?: () => 'clear' | 'rain' | 'thunder' | undefined;
  day?: () => number | undefined;
  deaths?: () => { deaths: number; lastDeath?: { cause: string; ts: string; messages: string[] } | undefined } | undefined;
  combat?: () => PanelCombat | undefined;
  memory?: () => PanelMemory | undefined;
  planner?: () => PanelPlanner | undefined;
  conn?: () => PanelConn | undefined;
  /** Track AR: ProcessManager.paused. */
  paused?: () => boolean | undefined;
}

const DIMENSIONS: Record<number, string> = { 0: 'overworld', 1: 'nether', 2: 'the_end' };

export function dimensionName(d: number | undefined): string | null {
  if (d === undefined) return null;
  return DIMENSIONS[d] ?? String(d);
}

/** Time of day (0..23999) -> day / dusk (12000) / night (13000) / dawn (23000). */
export function phaseOf(tod: number | undefined): PanelState['self']['phase'] {
  if (tod === undefined) return null;
  if (tod >= 23000) return 'dawn';
  if (tod >= 13000) return 'night';
  if (tod >= 12000) return 'dusk';
  return 'day';
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function settingRow(key: SettingKey, s: NonNullable<PanelStateSource['settings']>): PanelSetting {
  const def: SettingDef = SETTING_DEFS[key];
  const row: PanelSetting = {
    key,
    kind: def.kind,
    value: formatSettingValue(key, s.get(key)),
    default: formatSettingValue(key, def.default),
    source: s.source(key),
    description: def.description,
  };
  if (def.kind === 'number') {
    row.min = def.min;
    row.max = def.max;
    if (def.unit) row.unit = def.unit;
  } else if (def.kind === 'text') {
    row.values = def.values;
  }
  return row;
}

/** One poll's worth; every part guarded so a throwing source cannot break the page. */
export function buildPanelState(src: PanelStateSource, now = Date.now()): PanelState {
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const pos = safe(src.position, undefined);
  const v = safe(src.vitals, { health: null, food: null });
  const tod = safe(src.timeOfDay, undefined);
  const settings = src.settings;
  const stack = safe(() => src.stack?.() ?? [], []).map((e) => ({ name: e.name, kind: e.kind, priority: e.priority, state: e.held ? 'held' : e.state, line: e.line, etaS: e.etaS ?? null }));
  const user = stack.find((e) => e.kind === 'user' && e.state === 'active') ?? stack.find((e) => e.kind === 'user');
  const deaths = safe(() => src.deaths?.(), undefined);
  const ld = deaths?.lastDeath;
  const opt = <T>(fn: (() => T | undefined) | undefined): T | null => (fn ? (safe(fn, undefined) ?? null) : null);
  const inv = safe(() => src.inventory?.(), undefined);
  return {
    v: PANEL_STATE_VERSION,
    ts: now,
    bot: {
      name: safe(src.name, ''),
      server: src.server,
      task: src.task,
      state: safe(src.connState, 'unknown'),
      healthy: safe(src.healthy, false),
      gameVersion: safe(src.gameVersion, ''),
    },
    status: safe(src.statusLines, []),
    stack,
    paused: opt(src.paused), // Track AR
    self: {
      health: v.health ?? null,
      food: v.food ?? null,
      pos: pos ? { x: round2(pos.x), y: round2(pos.y), z: round2(pos.z) } : null,
      dimension: dimensionName(safe(src.dimension, undefined)),
      timeOfDay: tod ?? null,
      phase: phaseOf(tod),
      saturation: opt(src.saturation),
      flight: (() => { const f = safe(() => src.flight?.(), undefined); return f ? `${f.gliding ? 'gliding' : f.phase ? `flight: ${f.phase}` : 'on the ground'}, ${f.rockets} rocket${f.rockets === 1 ? '' : 's'}` : null; })(), // Track AU
      weather: opt(src.weather),
      day: opt(src.day),
      deaths: typeof deaths?.deaths === 'number' ? deaths.deaths : null,
      lastDeath: ld ? { cause: ld.cause, ts: ld.ts, messages: ld.messages.slice(0, 3) } : null,
    },
    inventory: inv ? safe(() => buildInventory(inv), null) : null,
    job: user ? { name: user.name, state: user.state, line: user.line, etaS: user.etaS } : null,
    combat: opt(src.combat),
    memory: opt(src.memory),
    planner: opt(src.planner),
    conn: opt(src.conn),
    settings: settings ? SETTING_KEYS.map((k) => safe(() => settingRow(k, settings), undefined)).filter((r): r is PanelSetting => r !== undefined) : [],
    logs: safe(src.logs, []),
    chat: safe(src.chat, []),
    commands: safe(src.commands, []),
    quick: QUICK_COMMANDS,
  };
}

// ---- Track AP: the page's poll (GET /api/state?lite=1) ----------------------------------------------

/** The state without what never changes while the bot runs (setting descriptions, defaults, ranges; the command names; the quick buttons): the page has those from its first render. */
export type PanelStateLite = Omit<PanelState, 'settings' | 'commands' | 'quick'> & { lite: true; settings: Pick<PanelSetting, 'key' | 'value' | 'source'>[] };

export function liteState(s: PanelState): PanelStateLite {
  const { settings, commands: _c, quick: _q, ...rest } = s;
  return { ...rest, lite: true, settings: settings.map((r) => ({ key: r.key, value: r.value, source: r.source })) };
}

// ---- Track AM: the Help tab (GET /api/help, fetched once when the tab is opened; docs/ux.md) --------

export interface PanelHelpCommand {
  name: string;
  tier: string;
  group: string;
  syntax: string;
  help: string;
  example: string;
  auto: string;
}

export interface PanelHelp {
  commands: PanelHelpCommand[];
  settings: { key: string; group: string; value: string; default: string; description: string }[];
  modes: { name: string; values: Record<string, string> }[];
  /** The mode the settings match now (`careful`, ..., `custom (...)`). */
  mode: string;
}

export interface PanelHelpSource {
  commands: () => readonly CommandInfo[];
  settings?: { get<K extends SettingKey>(key: K): SettingValue<K> } | undefined;
}

/** The command registry (front door first, then by group), the settings by group and the modes. */
export function buildPanelHelp(src: PanelHelpSource): PanelHelp {
  const order = (g: string): number => GROUP_ORDER.indexOf(g as (typeof GROUP_ORDER)[number]);
  const commands = [...src.commands()]
    .sort((a, b) => (a.tier === b.tier ? order(a.group) - order(b.group) || a.name.localeCompare(b.name) : a.tier === 'front' ? -1 : 1))
    .map((c) => ({ name: c.name, tier: c.tier, group: c.group, syntax: c.syntax === c.phrase ? '' : c.syntax, help: c.phrase, example: c.example ?? `!${c.name}`, auto: c.auto ?? '' }));
  const s = src.settings;
  const settings = settingGroups().flatMap(([group, keys]) =>
    keys.map((k) => ({ key: k, group, value: s ? formatSettingValue(k, s.get(k)) : '', default: formatSettingValue(k, SETTING_DEFS[k].default), description: SETTING_DEFS[k].description })),
  );
  const modes = MODE_NAMES.map((m) => {
    const v = modeValues(m);
    return { name: m, values: Object.fromEntries(MODE_KEYS.map((k) => [k, formatSettingValue(k, v[k])])) };
  });
  return { commands, settings, modes, mode: s ? modeLine(s) : 'unknown' };
}
