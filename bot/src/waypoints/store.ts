// Waypoints (PLAN.md task 7.10): named positions per server, persisted in the config directory so
// they survive a restart. See docs/waypoints.md.
//
//   file      <config dir>/waypoints/<server id>.json; the config dir is the directory of the config
//             file (--config, BEDROCKBOT_CONFIG, else %LOCALAPPDATA%\bedrockbot or ~/.bedrockbot).
//             With --no-config the waypoints live in memory only.
//   server id derived from the connection target: `<host>_<port>` for a BDS, `realm-<name>` (or
//             `realm-id-<id>`, `realm-invite-<code>`) for a Realm; anything but [A-Za-z0-9._-] -> `_`.
//   names     case-insensitive, 1..32 of [a-z0-9_-]; `death`, `home` and `spawn` are set automatically
//             (waypoints/auto.ts) but may be overwritten / deleted like any other.
//   y         null when the server gave no usable height (a world spawn at y 32767): goto then walks
//             to the column (an `xz` goal).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { locateConfig, loadConfig, type BotConfig } from '../config/config.ts';
import { DEFAULT_HOST, DEFAULT_PORT } from '../config/defaults.ts';
import { silentLogger, type Logger } from '../log.ts';

export interface WaypointPos {
  x: number;
  y: number | null;
  z: number;
}

export interface Waypoint extends WaypointPos {
  name: string;
  /** Set by an event (death, spawn packet, !home set), not by !wp set. */
  auto: boolean;
  /** ISO time it was set. */
  at: string;
}

export const AUTO_WAYPOINTS = ['death', 'home', 'spawn'] as const;
export type AutoWaypoint = (typeof AUTO_WAYPOINTS)[number];

const NAME = /^[a-z0-9_][a-z0-9_-]{0,31}$/;

/** Normalised (lower case) name, or undefined when it is not a valid waypoint name. */
export function waypointName(s: string | undefined): string | undefined {
  const n = s?.trim().toLowerCase();
  return n && NAME.test(n) ? n : undefined;
}

const FileSchema = z.object({
  version: z.literal(1),
  server: z.string().optional(),
  waypoints: z.record(
    z.string(),
    z.object({
      x: z.number().int(),
      y: z.number().int().nullable(),
      z: z.number().int(),
      auto: z.boolean().optional(),
      at: z.string().optional(),
    }),
  ),
});

export interface WaypointStoreOptions {
  /** JSON file; undefined = in memory only. */
  file?: string;
  /** Written into the file for humans. */
  server?: string;
  log?: Logger;
  now?: () => Date;
}

export class WaypointStore {
  readonly file: string | undefined;
  private readonly server: string | undefined;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly points = new Map<string, Waypoint>();
  private readonly listeners = new Set<(name: string, w: Waypoint | undefined) => void>();

  constructor(opts: WaypointStoreOptions = {}) {
    this.file = opts.file;
    this.server = opts.server;
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? (() => new Date());
  }

  /** Reads the file (if any). A broken file is kept aside as `<file>.bad` and the store starts empty. Returns the count. */
  load(): number {
    const f = this.file;
    if (!f || !existsSync(f)) return this.points.size;
    try {
      const data = FileSchema.parse(JSON.parse(readFileSync(f, 'utf8')));
      this.points.clear();
      for (const [raw, w] of Object.entries(data.waypoints)) {
        const name = waypointName(raw);
        if (!name) continue;
        this.points.set(name, { name, x: w.x, y: w.y, z: w.z, auto: w.auto ?? false, at: w.at ?? '' });
      }
      this.log.info(`waypoints: ${this.points.size} from ${f}`);
    } catch (e) {
      this.log.warn(`waypoints: ${f} is not a waypoint file (${e instanceof Error ? e.message : String(e)}); keeping it as ${f}.bad`);
      try {
        renameSync(f, `${f}.bad`);
      } catch {
        // ignore
      }
    }
    return this.points.size;
  }

  get size(): number {
    return this.points.size;
  }

  get(name: string): Waypoint | undefined {
    const n = waypointName(name);
    return n ? this.points.get(n) : undefined;
  }

  /** Sorted by name. */
  list(): Waypoint[] {
    return [...this.points.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Set (and persist) a waypoint; positions are floored to the block. Unchanged positions are not rewritten. */
  set(name: string, p: WaypointPos, opts: { auto?: boolean } = {}): Waypoint {
    const n = waypointName(name);
    if (!n) throw new Error(`bad waypoint name "${name}" (1..32 of a-z 0-9 _ -)`);
    const pos = { x: Math.floor(p.x), y: p.y === null ? null : Math.floor(p.y), z: Math.floor(p.z) };
    const old = this.points.get(n);
    const auto = opts.auto ?? false;
    if (old?.x === pos.x && old.y === pos.y && old.z === pos.z && old.auto === auto) return old;
    const w: Waypoint = { name: n, ...pos, auto, at: this.now().toISOString() };
    this.points.set(n, w);
    this.save();
    this.emit(n, w);
    return w;
  }

  delete(name: string): boolean {
    const n = waypointName(name);
    if (!n || !this.points.delete(n)) return false;
    this.save();
    this.emit(n, undefined);
    return true;
  }

  /** Called after every change (name, new value or undefined when deleted). */
  onChange(fn: (name: string, w: Waypoint | undefined) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(name: string, w: Waypoint | undefined): void {
    for (const fn of [...this.listeners]) fn(name, w);
  }

  /** Atomic write (temp file + rename); failures are logged, the store keeps working in memory. */
  private save(): void {
    const f = this.file;
    if (!f) return;
    const waypoints: Record<string, Omit<Waypoint, 'name'>> = {};
    for (const w of this.list()) waypoints[w.name] = { x: w.x, y: w.y, z: w.z, auto: w.auto, at: w.at };
    const body = `${JSON.stringify({ version: 1, ...(this.server ? { server: this.server } : {}), waypoints }, null, 2)}\n`;
    try {
      mkdirSync(dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, f);
    } catch (e) {
      this.log.warn(`waypoints: could not write ${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** File-name-safe server id. */
export function sanitizeServerId(s: string): string {
  const out = s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80);
  return out || 'server';
}

/** The server id of the connection target: CLI values first, then the config file, then the defaults (like config/resolve.ts). */
export function serverIdOf(values: Readonly<Record<string, unknown>>, cfg: BotConfig = {}): string {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  if (str(values.target) === 'realm') {
    const r = cfg.realm ?? {};
    const cliSel = values['realm-name'] !== undefined || values['realm-id'] !== undefined || values['realm-invite'] !== undefined;
    const name = cliSel ? str(values['realm-name']) : r.realmName;
    const id = cliSel ? str(values['realm-id']) : r.realmId;
    const invite = cliSel ? str(values['realm-invite']) : r.realmInvite;
    if (name) return sanitizeServerId(`realm-${name}`);
    if (id) return sanitizeServerId(`realm-id-${id}`);
    return sanitizeServerId(`realm-invite-${invite ?? 'unknown'}`);
  }
  const host = str(values.host) ?? cfg.host ?? DEFAULT_HOST;
  const port = str(values.port) ?? (cfg.port !== undefined ? String(cfg.port) : String(DEFAULT_PORT));
  return sanitizeServerId(`${host}_${port}`);
}

export function waypointsFile(configDir: string, serverId: string): string {
  return join(configDir, 'waypoints', `${sanitizeServerId(serverId)}.json`);
}

/**
 * Where a task's waypoints live: the config file's directory (as index.ts locates it), or none with
 * --no-config. The config file is read only for the target fields (host, port, realm).
 */
export function waypointsLocation(values: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env, cwd: string = env.INIT_CWD ?? process.cwd()): { file: string | undefined; server: string } {
  if (values['no-config'] === true) return { file: undefined, server: serverIdOf(values) };
  const flag = typeof values.config === 'string' ? values.config : undefined;
  const loc = locateConfig(flag, env, cwd);
  let cfg: BotConfig = {};
  try {
    cfg = loadConfig(loc).config;
  } catch {
    // index.ts has already reported a broken config file
  }
  const server = serverIdOf(values, cfg);
  return { file: waypointsFile(dirname(loc.path), server), server };
}
