// Runtime settings (PLAN.md task 7.9, Track Q; docs/processes.md "Settings"): a typed registry of the
// knobs the processes read while the bot runs, changeable from chat with `!set` and persisted.
//
//   const s = RuntimeSettings.open(file, { log });   // defaults, then <config dir>/settings.json
//   s.applyStartup('guardRadius', 24);               // config.json / CLI values: win at start-up, not persisted
//   s.get('guardRadius');                            // live value: processes call get() every time, never copy it
//   s.set('guardRadius', '8');                       // !set: validate, apply, persist (throws SettingError)
//   s.onChange((key, value) => ...);
//
// Precedence at start-up: default < settings.json < config.json < CLI flag. Afterwards `!set` wins
// (and is written to settings.json, so it survives a restart unless a flag or config.json overrides
// it again). settings.json lives next to config.json, never inside the repository; with --no-config
// and no --settings the settings are in memory only (tests).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isInside, REPO_ROOT } from '../connection/realm.ts';
import { silentLogger, type Logger } from '../log.ts';

interface BoolDef {
  kind: 'boolean';
  default: boolean;
  description: string;
}

interface NumberDef {
  kind: 'number';
  default: number;
  min: number;
  max: number;
  /** Whole numbers only. */
  integer?: boolean;
  unit?: string;
  description: string;
}

/** Track AD: free text checked by `parse` (returns the normalised value, throws SettingError). */
interface TextDef {
  kind: 'text';
  default: string;
  /** What the value may be, shown by `!set <key>` (`x y z|none`). */
  values: string;
  parse(raw: string): string;
  description: string;
}

export type SettingDef = BoolDef | NumberDef | TextDef; // Track AD: TextDef

/** Track AD: `x y z` / `x,y,z` (whole numbers) or `none` -> `x y z` / `none`. */
export function parseBlockText(raw: string, key: string): string {
  const s = raw.trim().toLowerCase();
  if (s === 'none' || s === '') return 'none';
  const n = s.split(/[\s,]+/).map((v) => Math.floor(Number(v))); // a block position: decimals floor (merge of Tracks AD and AF)
  if (n.length !== 3 || !n.every((v) => Number.isFinite(v))) throw new SettingError(`${key} must be x y z or none, got "${raw}"`);
  return n.join(' ');
}

/**
 * Every runtime setting. Placeholders (read by later tracks) are marked; adding one is one entry here
 * plus the reader calling `settings.get(key)`.
 */
export const SETTING_DEFS = {
  allowBreak: { kind: 'boolean', default: false, description: 'walks may dig through blocks in the way (planner dig-through moves)' },
  allowPlace: { kind: 'boolean', default: false, description: 'walks may pillar up with throwaway blocks (planner place moves)' },
  closeDoors: { kind: 'boolean', default: false, description: 'close doors and gates behind after walking through' },
  sprint: { kind: 'boolean', default: true, description: 'sprint on long straight runs (walks, follow)' },
  guardRadius: { kind: 'number', default: 16, min: 2, max: 64, integer: true, unit: 'blocks', description: 'guard: fight hostiles within this radius of home' },
  fleeHealth: { kind: 'number', default: 8, min: 0, max: 20, unit: 'health', description: 'flee to the shelter / home below this health with a hostile near (0 = never)' },
  nudgeInterval: { kind: 'number', default: 240, min: 0, max: 86400, unit: 's', description: 'keepalive nudge interval (0 = never); applies from the next nudge' },
  followDistance: { kind: 'number', default: 3, min: 1, max: 16, unit: 'blocks', description: '!follow stops this close to the target' },
  // placeholders read by other tracks (wave 6: nav, survival, farming, mining)
  avoidMobRadius: { kind: 'number', default: 4, min: 0, max: 32, unit: 'blocks', description: 'planner: keep this far from hostile mobs (placeholder, Track R/S)' },
  avoidSpawnerRadius: { kind: 'number', default: 8, min: 0, max: 64, unit: 'blocks', description: 'planner: keep this far from spawners (placeholder, Track R/S)' },
  toolWearLimit: { kind: 'number', default: 10, min: 0, max: 2000, integer: true, unit: 'uses', description: 'do not use a tool with fewer uses left (placeholder, Track S)' },
  throwawayMin: { kind: 'number', default: 16, min: 0, max: 2304, integer: true, unit: 'blocks', description: 'keep at least this many throwaway blocks (placeholder, Track S)' },
  useBoneMeal: { kind: 'boolean', default: true, description: 'farming: use bone meal on crops (placeholder, Track U)' },
  mineTunnelLen: { kind: 'number', default: 32, min: 1, max: 256, integer: true, unit: 'blocks', description: 'mining: tunnel length per branch (placeholder)' },
  nlConfirm: { kind: 'boolean', default: true, description: '!do and chat to the bot: show the plan and wait for !yes before running it' }, // Track Y
  autoFood: { kind: 'boolean', default: true, description: 'hunt food mobs as a chore by day when the inventory food is below foodMin' }, // Track X
  foodMin: { kind: 'number', default: 10, min: 0, max: 200, integer: true, unit: 'hunger points', description: 'auto food: hunt when the food carried totals fewer hunger points' }, // Track X
  foodLeave: { kind: 'number', default: 2, min: 0, max: 16, integer: true, unit: 'mobs', description: '!food never leaves fewer of a kind than this within the radius' }, // Track X
  mineSeenOnly: { kind: 'boolean', default: false, description: 'mining: only ore the bot has seen an open face of (off: any known ore, tunnelling to it)' }, // Track Z
  mineDirect: { kind: 'boolean', default: true, description: 'mining: no walk to an ore (or a long detour): dig a 1-wide 2-high tunnel or a shaft straight to it, under the dig rules (off: walk with dig-through only)' }, // Track AQ
  protectRadius: { kind: 'number', default: 48, min: 0, max: 256, integer: true, unit: 'blocks', description: 'the base: nothing is dug or broken by a walk, a mine approach or a sight line within this distance of home (0 = off; built blocks are never dug anywhere)' }, // 2026-10-30: !mine dug through the owner's house
  digPenalty: { kind: 'number', default: 60, min: 0, max: 1000, integer: true, unit: 'ticks', description: 'cost added per block a route digs through, on top of the break time: 60 means a walk of about 13 extra blocks beats one dug block' }, // 2026-10-30
  plannerThreads: { kind: 'number', default: 1, min: 0, max: 1, integer: true, unit: 'threads', description: 'plan paths in a worker thread (bigger budgets, no tick waits for the planner); 0 = on the main thread' }, // Track AB
  autoBreed: { kind: 'boolean', default: false, description: 'breed the animals of chorePen as a chore (every 10 min while it holds fewer than 8 adults of a kind)' }, // Track AF
  chorePen: { kind: 'text', default: 'none', values: 'x y z|none', parse: (raw: string) => parseBlockText(raw, 'chorePen'), description: 'the pen (fence-enclosed) whose animals the breeding chore and the food chore may use: a block inside it, or none' }, // Track AF (merge: AD's parseBlockText)
  stashChest: { kind: 'text', default: 'none', values: 'x y z|none', parse: (raw: string) => parseBlockText(raw, 'stashChest'), description: 'stash step: chest a full inventory is emptied into (none: the job chest, a carried shulker box, then dropping junk)' }, // Track AD
  stashShulker: { kind: 'boolean', default: true, description: 'stash step: place a carried shulker box, fill it, break it and pick it up when the inventory is full' }, // Track AD
  lastWelcomed: { kind: 'text', default: 'none', values: 'version|none', parse: (raw: string) => { const v = raw.trim(); if (!/^[\w.+-]{1,64}$/.test(v)) throw new SettingError(`lastWelcomed must be a version string or none, got "${raw}"`); return v; }, description: 'the bot version whose welcome whisper the owners got (none: whisper at the next sighting; docs/ux.md)' }, // Track AM
  buildScaffold: { kind: 'boolean', default: true, description: '!build: place temporary scaffold blocks (support, pillar columns) for cells it cannot reach or click otherwise, removed afterwards' }, // Track AL
  homeChestRadius: { kind: 'number', default: 16, min: 2, max: 48, integer: true, unit: 'blocks', description: 'home logistics: chests, barrels and shulker boxes within this radius of home are found, read and unloaded into' }, // Track AG
  homeChestWalk: { kind: 'number', default: 64, min: 0, max: 256, integer: true, unit: 'path blocks', description: 'home logistics: containers whose walk from home is longer than this (the planner\'s path) are skipped and remembered as unreachable; 0 = no path check (homeChestRadius only)' }, // Track AN
  getSuggestsBring: { kind: 'boolean', default: true, description: '!get: when the chests at home already hold enough of the item, the reply says so and names !bring (!get still makes new ones)' }, // Track AS
  autoUnload: { kind: 'boolean', default: true, description: 'unload into the chests at home as a chore when idle there with more than 8 stacks of unloadable items or a full shulker box' }, // Track AG
  mineBranchY: { kind: 'text', default: 'auto', values: 'auto|-64..320', parse: (raw: string) => { const s = raw.trim().toLowerCase(); if (s === 'auto' || s === '') return 'auto'; const n = Number(s); if (!Number.isInteger(n) || n < -64 || n > 320) throw new SettingError(`mineBranchY must be auto or a whole number -64..320, got "${raw}"`); return String(n); }, description: 'branch mining: the Y of the tunnels when !mine knows no ore (auto: the best Y of the ore, e.g. iron 16, diamond -58)' }, // Track AI
  exploreRadius: { kind: 'number', default: 128, min: 16, max: 1024, integer: true, unit: 'blocks', description: '!explore: radius of the area walked (around home, else the bot)' }, // Track AI
  guardReach: { kind: 'number', default: 24, min: 0, max: 64, integer: true, unit: 'path blocks', description: 'guard: a hostile not within reach is fought only when the planner finds a walk to it of at most this length (else ignored for 30 s); 0 = no path check' }, // Track AO
  guardWhileWalking: { kind: 'text', default: 'near', values: 'reach|near|all', parse: (raw: string) => { const v = raw.trim().toLowerCase(); if (v !== 'reach' && v !== 'near' && v !== 'all') throw new SettingError(`guardWhileWalking must be reach, near or all, got "${raw}"`); return v; }, description: 'guard during a walk (come, follow, goto, get, unload, build, ...): reach = only mobs within reach; near = also melee mobs, creepers and archers aiming at me within 6 path blocks; all = as when idle' }, // Track AO
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTING_DEFS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFS)[K] extends { kind: 'boolean' } ? boolean : (typeof SETTING_DEFS)[K] extends { kind: 'text' } ? string : number; // Track AF: text
export type SettingValues = { [K in SettingKey]: SettingValue<K> };

export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];

export class SettingError extends Error {
  override name = 'SettingError';
}

/** Case-insensitive key lookup (`guardradius` -> `guardRadius`). */
export function settingKey(name: string): SettingKey | undefined {
  const n = name.trim().toLowerCase();
  return SETTING_KEYS.find((k) => k.toLowerCase() === n);
}

const TRUE = new Set(['true', 'on', 'yes', '1']);
const FALSE = new Set(['false', 'off', 'no', '0']);

/** Parse and validate a value (string from chat / CLI, or a JSON value from a file). Throws SettingError. */
export function parseSettingValue<K extends SettingKey>(key: K, raw: unknown): SettingValue<K> {
  const def: SettingDef = SETTING_DEFS[key];
  if (def.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw as SettingValue<K>;
    const s = String(raw).trim().toLowerCase();
    if (TRUE.has(s)) return true as SettingValue<K>;
    if (FALSE.has(s)) return false as SettingValue<K>;
    throw new SettingError(`${key} must be on or off, got ${show(raw)}`);
  }
  if (def.kind === 'text') return def.parse(typeof raw === 'string' ? raw : String(raw)) as SettingValue<K>; // Track AD
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n < def.min || n > def.max || (def.integer === true && !Number.isInteger(n))) {
    throw new SettingError(`${key} must be ${def.integer ? 'a whole number ' : ''}${def.min}..${def.max}, got ${show(raw)}`);
  }
  return n as SettingValue<K>;
}

export function formatSettingValue(key: SettingKey, v: boolean | number | string): string {
  const def: SettingDef = SETTING_DEFS[key];
  if (def.kind === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

/** `guardRadius 16 (2..64 blocks, default 16): guard: fight hostiles ...` */
export function describeSetting(key: SettingKey, value: boolean | number | string): string {
  const def: SettingDef = SETTING_DEFS[key];
  const range = def.kind === 'boolean' ? 'on|off' : def.kind === 'text' ? def.values : `${def.min}..${def.max}${def.unit ? ` ${def.unit}` : ''}`;
  return `${key} ${formatSettingValue(key, value)} (${range}, default ${formatSettingValue(key, def.default)}): ${def.description}`;
}

export type SettingSource = 'default' | 'file' | 'startup' | 'chat';

export interface RuntimeSettingsOptions {
  /** settings.json; undefined = in memory only. */
  file?: string;
  log?: Logger;
}

export class RuntimeSettings {
  readonly file: string | undefined;
  private readonly values: SettingValues;
  private readonly sources = new Map<SettingKey, SettingSource>();
  /** What settings.json holds (only values set with !set); unknown keys from the file are kept as they were. */
  private persisted: Record<string, unknown> = {};
  private readonly listeners = new Set<(key: SettingKey, value: boolean | number | string, old: boolean | number | string) => void>();
  private readonly log: Logger;

  constructor(opts: RuntimeSettingsOptions = {}) {
    this.file = opts.file;
    this.log = opts.log ?? silentLogger;
    this.values = Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTING_DEFS[k].default])) as SettingValues;
  }

  /**
   * Defaults, then the file (if it exists). Invalid JSON is an error (exit 2 in the CLI, like a bad
   * config file); an unknown key or a value out of bounds is logged and ignored (kept in the file).
   */
  static open(file: string | undefined, opts: { log?: Logger } = {}): RuntimeSettings {
    const s = new RuntimeSettings({ file, log: opts.log });
    if (file && existsSync(file)) s.loadFile(file);
    return s;
  }

  private loadFile(file: string): void {
    let raw: unknown;
    try {
      const text = readFileSync(file, 'utf8');
      raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (e) {
      throw new SettingError(`settings file ${file}: not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SettingError(`settings file ${file}: expected a JSON object`);
    this.persisted = { ...(raw as Record<string, unknown>) };
    for (const [name, v] of Object.entries(this.persisted)) {
      if (name.startsWith('$')) continue; // $comment, $schemaVersion
      const key = settingKey(name);
      if (!key) {
        this.log.warn(`settings file ${file}: unknown setting "${name}" ignored`);
        continue;
      }
      try {
        this.assign(key, parseSettingValue(key, v), 'file');
      } catch (e) {
        this.log.warn(`settings file ${file}: ${e instanceof Error ? e.message : String(e)}; using ${formatSettingValue(key, this.values[key])}`);
      }
    }
  }

  get<K extends SettingKey>(key: K): SettingValue<K> {
    return this.values[key];
  }

  source(key: SettingKey): SettingSource {
    return this.sources.get(key) ?? 'default';
  }

  /** All values (a copy, for status and tests). */
  snapshot(): SettingValues {
    return { ...this.values };
  }

  /** A value from config.json or the command line: wins at start-up, is not written to the file. Throws SettingError. */
  applyStartup(key: SettingKey, raw: unknown): void {
    this.assign(key, parseSettingValue(key, raw), 'startup');
  }

  /** `!set key value`: validate, apply live, persist. Returns the new value. Throws SettingError. */
  set<K extends SettingKey>(key: K, raw: unknown): SettingValue<K> {
    const v = parseSettingValue(key, raw);
    this.assign(key, v, 'chat');
    this.persisted[key] = v;
    this.save();
    return v;
  }

  /** `!set key default`: back to the built-in default and removed from the file. */
  reset(key: SettingKey): boolean | number | string {
    const def = SETTING_DEFS[key].default;
    this.assign(key, def, 'default');
    delete this.persisted[key];
    this.save();
    return def;
  }

  onChange(fn: (key: SettingKey, value: boolean | number | string, old: boolean | number | string) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private assign(key: SettingKey, v: boolean | number | string, source: SettingSource): void {
    const old = this.values[key];
    (this.values as Record<SettingKey, boolean | number | string>)[key] = v;
    this.sources.set(key, source);
    if (old !== v) {
      for (const fn of [...this.listeners]) {
        try {
          fn(key, v, old);
        } catch (e) {
          this.log.warn(`setting ${key} listener failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  /** Write settings.json atomically (temp file + rename). A failure is logged; the live value stays. */
  private save(): void {
    const file = this.file;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.persisted, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      this.log.warn(`could not write ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export interface SettingsFileInput {
  /** --settings <file> */
  flag?: string | undefined;
  /** env BEDROCKBOT_SETTINGS */
  env?: string | undefined;
  /** The config file path in use (read or not), from locateConfig; undefined with --no-config. */
  configPath?: string | undefined;
  cwd: string;
  /** Repository root (settings never go inside it). */
  repoRoot?: string;
}

/**
 * Where settings.json lives: --settings > BEDROCKBOT_SETTINGS > next to the config file
 * (`<config dir>/settings.json`). With --no-config and neither of the first two: undefined (in memory).
 * An explicit path inside the repository is an error; a derived one is dropped with `warning`.
 */
export function resolveSettingsFile(i: SettingsFileInput): { file: string | undefined; warning?: string } {
  const repo = i.repoRoot ?? REPO_ROOT;
  const explicit = i.flag ?? i.env;
  if (explicit) {
    const file = isAbsolute(explicit) ? explicit : resolve(i.cwd, explicit);
    if (isInside(file, repo)) throw new SettingError(`settings file ${file} is inside the repository; keep it next to your config file (outside the repo)`);
    return { file };
  }
  if (!i.configPath) return { file: undefined };
  const file = join(dirname(i.configPath), 'settings.json');
  if (isInside(file, repo)) return { file: undefined, warning: `config file is inside the repository; runtime settings are not persisted (use --settings <file> outside it)` };
  return { file };
}

/**
 * Start-up overrides from config.json (`settings` block, `nudgeInterval`) and the command line
 * (`--set key=value` repeatable, `--nudge-interval`), applied in that order (the CLI wins).
 * Throws SettingError on an unknown key or a bad value.
 */
export function applyStartupSettings(s: RuntimeSettings, src: { config?: Record<string, unknown> | undefined; configNudge?: number | undefined; cliSet?: readonly string[] | undefined; cliNudge?: string | undefined }): void {
  for (const [name, v] of Object.entries(src.config ?? {})) {
    const key = settingKey(name);
    if (!key) throw new SettingError(`config settings.${name}: unknown setting (${SETTING_KEYS.join(', ')})`);
    s.applyStartup(key, v);
  }
  if (src.configNudge !== undefined) s.applyStartup('nudgeInterval', src.configNudge);
  for (const kv of src.cliSet ?? []) {
    const m = /^([^=\s]+)\s*=\s*(.*)$/.exec(kv);
    if (!m) throw new SettingError(`--set expects key=value, got "${kv}"`);
    const key = settingKey(m[1]!);
    if (!key) throw new SettingError(`--set ${m[1]}: unknown setting (${SETTING_KEYS.join(', ')})`);
    s.applyStartup(key, m[2]);
  }
  if (src.cliNudge !== undefined) s.applyStartup('nudgeInterval', src.cliNudge);
}

/** Key under which index.ts hands the RuntimeSettings to a task (TaskContext.values; base.ts has no field for it yet). */
export const SETTINGS_VALUE_KEY = '$settings';

/** The task's settings: the CLI's instance, or a fresh in-memory one (tests, tasks created directly). */
export function settingsFromValues(values: Readonly<Record<string, unknown>>): { settings: RuntimeSettings; own: boolean } {
  const s = values[SETTINGS_VALUE_KEY];
  return s instanceof RuntimeSettings ? { settings: s, own: false } : { settings: new RuntimeSettings(), own: true };
}

function show(v: unknown): string {
  return typeof v === 'string' ? `"${v}"` : (JSON.stringify(v) ?? 'undefined');
}
