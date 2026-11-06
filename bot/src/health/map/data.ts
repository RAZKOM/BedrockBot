// The data behind the debug map (PLAN.md task 7.15): GET /map.json. Reads the world cache (chunk
// tiles), the world model (bot, entities), the skills status (the last goto: goal, path when the
// navigator report has one) and the task status (home, shelter, waypoints when present). Everything
// is optional, so the page works for any task. See docs/world-cache.md ("Debug map").
import { bareType, classify as entityClass, entityFeet } from '../../skills/combat/hostiles.ts';
import type { MapTile, WorldCache } from '../../world/cache/cache.ts';
import { currentRev } from '../../world/cache/summary.ts';
import { NO_NAME, type SurfaceLayer } from '../../world/cache/surface.ts';
import { hexColour } from '../panel/icons/colours.ts';
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import { MAP_JSON_VERSION, type CompactTileJson, type MapEntityJson, type MapJson, type MapPaletteEntry, type MapTileJson } from './schema.ts';

/** Track PC: map colours of block names (health/panel/icons/colours.ts BlockColours satisfies it). */
export interface MapColourSource {
  /** `0xRRGGBB`, null = no art (the class colour), undefined = not computed yet. */
  peek(name: string): number | null | undefined;
  /** Computes the colours of these names. */
  load(names: Iterable<string>): Promise<void>;
}

export interface MapSource {
  /** The world model (self, entities). */
  world?: {
    self: { pos: Vec3; yaw: number; dimension: number };
    entities: ReadonlyMap<bigint, EntityInfo>;
    /** Decision 0062: a loaded block (the Y-slice of loaded columns); undefined = not loaded. */
    blockAt?(p: Vec3): { name: string } | undefined;
    isLoaded?(cx: number, cz: number): boolean;
  };
  cache?: WorldCache;
  /** The bot's feet (the input loop's simulation); default world.self.pos. */
  position?: () => Vec3 | undefined;
  /** BotSkills.status() (busy, running, lastGoto). */
  skillsStatus?: () => unknown;
  /** The running task's status (home, shelter, waypoints when it has them). */
  taskStatus?: () => unknown;
  server?: string | null;
  /** Track PC: block colours for the palette; without one every palette colour is null. */
  colours?: MapColourSource | null;
}

export interface MapQuery {
  /** Window radius in chunks (default 12, max 64). */
  r?: number;
  /** Window centre (chunk); default the bot's chunk. */
  cx?: number;
  cz?: number;
  /** Only tiles changed after this rev (inside `win`). */
  since?: number;
  /** The caller's previous window: tiles outside it are always sent. */
  win?: { cx0: number; cz0: number; cx1: number; cz1: number };
}

const MAX_ENTITIES = 256;
const TRAIL = 600;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** {x,y,z} or [x,y,z] -> Vec3. */
export function asVec3(v: unknown): Vec3 | null {
  if (Array.isArray(v) && v.length >= 3 && finite(v[0]) && finite(v[1]) && finite(v[2])) return { x: v[0], y: v[1], z: v[2] };
  if (isRec(v) && finite(v.x) && finite(v.y) && finite(v.z)) return { x: v.x, y: v.y, z: v.z };
  return null;
}

/** Waypoints in any of the shapes a status may carry: [{name, x, y, z}], [{name, pos | p}], {name: vec}. */
export function asWaypoints(v: unknown): { name: string; x: number; y: number; z: number }[] {
  const out: { name: string; x: number; y: number; z: number }[] = [];
  const push = (name: unknown, p: unknown) => {
    const q = asVec3(p);
    if (typeof name === 'string' && q) out.push({ name, ...q });
  };
  if (Array.isArray(v)) {
    for (const w of v) if (isRec(w)) push(w.name, asVec3(w) ? w : (w.pos ?? w.p ?? w.position));
  } else if (isRec(v)) {
    for (const [name, p] of Object.entries(v)) push(name, isRec(p) && !asVec3(p) ? (p.pos ?? p.p ?? p.position) : p);
  }
  return out.slice(0, 500);
}

const b64 = (a: Uint8Array | Int16Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

/** Assigns palette indices to block names (a response's own palette, or the map screen's global one). */
export interface PaletteIndex {
  index(name: string): number;
}

/** Track PC: the response palette (block names in first-seen order). */
class PaletteBuilder implements PaletteIndex {
  readonly entries: MapPaletteEntry[] = [];
  private readonly ids = new Map<string, number>();
  private readonly colours: MapColourSource | null | undefined;

  constructor(colours: MapColourSource | null | undefined) {
    this.colours = colours;
  }

  index(name: string): number {
    let i = this.ids.get(name);
    if (i === undefined) {
      i = this.entries.length;
      const c = this.colours?.peek(name);
      this.entries.push({ name, rgb: typeof c === 'number' ? hexColour(c) : null });
      this.ids.set(name, i);
    }
    return i;
  }
}

/** Track PC: floor and depth of a layer, only when it has a liquid column. */
function liquidFields(l: SurfaceLayer): { f: string; d: string } | undefined {
  for (let i = 0; i < 256; i++) if (l.depth[i]! > 0 || l.floor[i] !== NO_NAME) return { f: b64(l.floor), d: b64(l.depth) };
  return undefined;
}

/** 2-bit classes, 4 columns per byte, low bits first. */
export function packClasses(cls: ArrayLike<number>): string {
  const c = Buffer.alloc(64);
  for (let i = 0; i < 256; i++) c[i >> 2] = c[i >> 2]! | ((cls[i]! & 3) << ((i & 3) * 2));
  return c.toString('base64');
}

const Y_NONE_TILE = -32768;

/** Decision 0062: heights as `yb` + 256 x u8 offsets (255 = nothing) when the tile's range fits in 0..254. */
function compactYs(y: Int16Array): { yb: number; y8: string } | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 256; i++) {
    const v = y[i]!;
    if (v === Y_NONE_TILE) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) lo = hi = 0;
  if (hi - lo > 254) return undefined;
  const b = new Uint8Array(256);
  for (let i = 0; i < 256; i++) b[i] = y[i] === Y_NONE_TILE ? 255 : y[i]! - lo;
  return { yb: lo, y8: b64(b) };
}

/** Decision 0062: the surface y as int8 offsets from the heights (`sd`) when every shown column fits in -127..127. */
function compactSurfaceY(sy: Int16Array, idx: Uint8Array, y: Int16Array): string | undefined {
  const b = new Int8Array(256);
  for (let i = 0; i < 256; i++) {
    if (idx[i] === NO_NAME) continue;
    const d = sy[i]! - y[i]!;
    if (y[i] === Y_NONE_TILE || d < -127 || d > 127) return undefined;
    b[i] = d;
  }
  return b64(new Uint8Array(b.buffer));
}

/**
 * One tile as JSON. `compact` (decision 0062, the map screen): heights as `yb` / `y8` and the surface y
 * as `sd` when they fit (docs/map.md "Wire"); `pal` is then the global palette.
 */
export function packTile(t: MapTile, pal: PaletteIndex, compact = false): MapTileJson | CompactTileJson {
  const cy = compact ? compactYs(t.y) : undefined;
  const out: CompactTileJson = { cx: t.cx, cz: t.cz, live: t.live, rev: t.rev, updatedAt: t.updatedAt, ...(cy ?? { y: b64(t.y) }), c: packClasses(t.cls) };
  const sd = t.surf; // Track PC: the surface layer (names compacted by the cache)
  if (sd) {
    out.p = sd.names.map((n) => pal.index(n));
    out.s = b64(sd.top.idx);
    for (let i = 0; i < 256; i++) {
      if (sd.top.idx[i] !== NO_NAME && sd.top.y[i] !== t.y[i]) {
        const d = compact ? compactSurfaceY(sd.top.y, sd.top.idx, t.y) : undefined;
        if (d !== undefined) out.sd = d;
        else out.sy = b64(sd.top.y);
        break;
      }
    }
    Object.assign(out, liquidFields(sd.top));
    if (sd.under) out.u = { s: b64(sd.under.idx), sy: b64(sd.under.y), ...liquidFields(sd.under) };
  }
  return out;
}

/** A window of chunks (inclusive). */
export interface ChunkWindow {
  cx0: number;
  cz0: number;
  cx1: number;
  cz1: number;
}

/**
 * Decision 0062: the map screen's palette, one for every response and stream message of a process, so a
 * client receives each name once (append-only; `entriesFrom(n)` = what a client that knows n entries
 * lacks). The colour of a name is read when it is sent: the sender waits for the colours first
 * (`ready`), so an entry's colour does not change after a client has it.
 */
export class GlobalPalette implements PaletteIndex {
  static readonly MAX = 4096;
  readonly names: string[] = [];
  private readonly ids = new Map<string, number>();
  private readonly colours: MapColourSource | null | undefined;

  constructor(colours: MapColourSource | null | undefined) {
    this.colours = colours;
  }

  get size(): number {
    return this.names.length;
  }

  index(name: string): number {
    let i = this.ids.get(name);
    if (i === undefined) {
      if (this.names.length >= GlobalPalette.MAX) return 0; // a 4097th name shows as the first (a world has a few hundred)
      i = this.names.length;
      this.names.push(name);
      this.ids.set(name, i);
    }
    return i;
  }

  /** Waits (at most waitMs) for the colours of the names from index `from` on. */
  async ready(from: number, waitMs = 3000): Promise<void> {
    const c = this.colours;
    if (!c) return;
    const miss = this.names.slice(from).filter((n) => c.peek(n) === undefined);
    if (miss.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([c.load(miss).catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
  }

  entriesFrom(from: number): MapPaletteEntry[] {
    return this.names.slice(Math.max(0, from)).map((name) => {
      const c = this.colours?.peek(name);
      return { name, rgb: typeof c === 'number' ? hexColour(c) : null };
    });
  }
}

/** Decision 0062: the overlays of the map screen (the `map-live` stream topic); short keys and arrays keep the deltas small. */
export interface MapLiveJson {
  dim: number;
  /** [x, y, z, yaw] of the feet, or null. */
  bot: [number, number, number, number] | null;
  /** [x, z] feet positions about once a second, newest last (at most LIVE_TRAIL). */
  trail: [number, number][];
  /** The planned path ([x, y, z] blocks) when the navigator report has one, else null. */
  path: [number, number, number][] | null;
  goal: [number, number, number] | null;
  busy: boolean;
  result: string | null;
  /** Entities by runtime id: [kind, type, x, y, z, name?] (the nearest LIVE_ENTITIES). */
  ents: Record<string, (string | number)[]>;
  home: [number, number, number] | null;
  shelter: [number, number, number] | null;
  /** [name, x, y, z]. */
  wps: [string, number, number, number][];
}

export const LIVE_TRAIL = 300;
export const LIVE_ENTITIES = 64;
const r1 = (v: number): number => Math.round(v * 10) / 10;

function goalPoint(goal: unknown, botY: number): Vec3 | null {
  if (!isRec(goal)) return null;
  const p = asVec3(goal.p) ?? asVec3(goal.pos) ?? asVec3(goal.target);
  if (p) return p;
  if (finite(goal.x) && finite(goal.z)) return { x: goal.x, y: finite(goal.y) ? goal.y : botY, z: goal.z };
  return null;
}

function entityKind(e: EntityInfo): MapEntityJson['kind'] {
  const k = entityClass(e.type);
  return k === 'player' || k === 'hostile' || k === 'neutral' || k === 'passive' || k === 'item' ? k : 'other';
}

/** Builds /map.json; keeps the bot trail between calls. */
export class MapBuilder {
  private readonly src: MapSource;
  private readonly trail: Vec3[] = [];
  private lastTrailAt = 0;

  constructor(src: MapSource) {
    this.src = src;
  }

  /** Samples the bot position into the trail (at most once per 900 ms). */
  sample(now = Date.now()): void {
    const p = this.position();
    if (!p || now - this.lastTrailAt < 900) return;
    this.lastTrailAt = now;
    const last = this.trail.at(-1);
    if (last && Math.hypot(last.x - p.x, last.y - p.y, last.z - p.z) < 0.25) return;
    this.trail.push({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) });
    if (this.trail.length > TRAIL) this.trail.shift();
  }

  /** The bot's feet (the input loop's simulation, else the world model). */
  position(): Vec3 | undefined {
    return this.src.position?.() ?? this.src.world?.self.pos;
  }

  /** The window of a query: radius (0..`maxR`) and centre (default the bot's chunk). */
  windowOf(q: MapQuery, maxR = 64): { center: { cx: number; cz: number }; radius: number; window: ChunkWindow } {
    const pos = this.position();
    const radius = Math.max(0, Math.min(maxR, Math.floor(q.r ?? 12)));
    const ccx = Number.isInteger(q.cx) ? q.cx! : pos ? Math.floor(pos.x) >> 4 : 0;
    const ccz = Number.isInteger(q.cz) ? q.cz! : pos ? Math.floor(pos.z) >> 4 : 0;
    return { center: { cx: ccx, cz: ccz }, radius, window: { cx0: ccx - radius, cz0: ccz - radius, cx1: ccx + radius, cz1: ccz + radius } };
  }

  /** Tiles of `window` changed after `since` (every one outside `win`, the caller's previous window). */
  tiles(window: ChunkWindow, pal: PaletteIndex, since = -1, win?: ChunkWindow, compact = false): (MapTileJson | CompactTileJson)[] {
    const cache = this.src.cache;
    const tiles: (MapTileJson | CompactTileJson)[] = [];
    if (!cache) return tiles;
    for (let cx = window.cx0; cx <= window.cx1; cx++) {
      for (let cz = window.cz0; cz <= window.cz1; cz++) {
        const inOld = win !== undefined && cx >= win.cx0 && cx <= win.cx1 && cz >= win.cz0 && cz <= win.cz1;
        const t = cache.tile(cx, cz);
        if (!t) continue;
        if (inOld && t.rev <= since) continue;
        tiles.push(packTile(t, pal, compact));
      }
    }
    return tiles;
  }

  /** The goto, the entities (nearest `max`), waypoints, home and shelter, from the statuses. */
  private extras(max = MAX_ENTITIES): {
    skills: Rec | undefined;
    task: Rec | undefined;
    path: Vec3[] | null;
    goal: Vec3 | null;
    result: string | null;
    plans: number;
    entities: MapEntityJson[];
    waypoints: { name: string; x: number; y: number; z: number }[];
  } {
    const { world } = this.src;
    const pos = this.position();
    const sk = this.src.skillsStatus?.();
    const ts = this.src.taskStatus?.();
    const skills = isRec(sk) ? sk : undefined;
    const task = isRec(ts) ? ts : undefined;
    const lastGoto = isRec(skills?.lastGoto) ? skills.lastGoto : undefined;
    const rawPath = lastGoto?.path;
    const path = Array.isArray(rawPath) ? rawPath.map(asVec3).filter((p): p is Vec3 => p !== null) : null;
    const result = isRec(lastGoto?.result) ? (lastGoto.result.ok === true ? 'ok' : typeof lastGoto.result.reason === 'string' ? lastGoto.result.reason : 'failed') : lastGoto ? 'running' : null;
    const entities: MapEntityJson[] = [];
    if (world) {
      const all: { e: EntityInfo; feet: Vec3; d: number }[] = [];
      for (const e of world.entities.values()) {
        const feet = entityFeet(e);
        const d = pos ? Math.hypot(feet.x - pos.x, feet.z - pos.z) : 0;
        all.push({ e, feet, d });
      }
      all.sort((a, b) => a.d - b.d);
      for (const { e, feet } of all.slice(0, max)) {
        entities.push({
          id: e.runtimeId.toString(),
          type: bareType(e.type),
          ...(e.username ? { name: e.username } : e.item ? { name: `${e.item.name} x${e.item.count}` } : {}),
          kind: entityKind(e),
          x: +feet.x.toFixed(2),
          y: +feet.y.toFixed(2),
          z: +feet.z.toFixed(2),
        });
      }
    }
    return {
      skills,
      task,
      path,
      goal: goalPoint(lastGoto?.goal, pos?.y ?? 0),
      result,
      plans: Array.isArray(lastGoto?.plans) ? lastGoto.plans.length : 0,
      entities,
      waypoints: asWaypoints(task?.waypoints ?? skills?.waypoints),
    };
  }

  /** Decision 0062: what the map screen draws over the tiles (the `map-live` topic). */
  live(now = Date.now()): MapLiveJson {
    this.sample(now);
    const pos = this.position();
    const x = this.extras(LIVE_ENTITIES);
    const v3 = (p: Vec3 | null): [number, number, number] | null => (p ? [r1(p.x), r1(p.y), r1(p.z)] : null);
    const ents: MapLiveJson['ents'] = {};
    for (const e of x.entities) ents[e.id] = e.name ? [e.kind, e.type, r1(e.x), r1(e.y), r1(e.z), e.name] : [e.kind, e.type, r1(e.x), r1(e.y), r1(e.z)];
    return {
      dim: this.src.world?.self.dimension ?? 0,
      bot: pos ? [r1(pos.x), r1(pos.y), r1(pos.z), Math.round(this.src.world?.self.yaw ?? 0)] : null,
      trail: this.trail.slice(-LIVE_TRAIL).map((p): [number, number] => [r1(p.x), r1(p.z)]),
      path: x.path ? x.path.map((p): [number, number, number] => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]) : null,
      goal: v3(x.goal),
      busy: x.skills?.busy === true,
      result: x.result,
      ents,
      home: v3(asVec3(x.task?.home)),
      shelter: v3(asVec3(x.task?.shelter)),
      wps: x.waypoints.map((w): [string, number, number, number] => [w.name, w.x, w.y, w.z]),
    };
  }

  build(q: MapQuery = {}, now = Date.now()): MapJson {
    this.sample(now);
    const { world, cache } = this.src;
    const pos = this.position();
    const { center, radius, window } = this.windowOf(q);
    const rev = currentRev();
    const pal = new PaletteBuilder(this.src.colours); // Track PC
    const tiles = this.tiles(window, pal, q.since ?? -1, q.win) as MapTileJson[];
    const x = this.extras();
    const st = cache?.stats;
    const info = cache?.info();
    return {
      v: MAP_JSON_VERSION,
      ts: now,
      server: this.src.server ?? null,
      dimension: world?.self.dimension ?? 0,
      rev,
      center,
      radius,
      window,
      tiles,
      palette: pal.entries,
      bot: pos ? { x: +pos.x.toFixed(3), y: +pos.y.toFixed(3), z: +pos.z.toFixed(3), yaw: +(world?.self.yaw ?? 0).toFixed(1) } : null,
      trail: [...this.trail],
      nav: {
        busy: x.skills?.busy === true,
        running: typeof x.skills?.running === 'string' ? x.skills.running : null,
        path: x.path,
        goal: x.goal,
        result: x.result,
        plans: x.plans,
      },
      entities: x.entities,
      home: asVec3(x.task?.home),
      shelter: asVec3(x.task?.shelter),
      waypoints: x.waypoints,
      cache:
        cache && st && info
          ? {
              dir: cache.dir,
              live: info.live,
              decoded: info.decoded,
              regions: info.regions,
              approxBytes: info.approxBytes,
              lookups: st.lookups,
              corrections: st.corrections,
              errors: st.errors,
            }
          : null,
    };
  }
}

/**
 * Track PC: `build`, then the colours of palette names not computed yet are computed (at most
 * `waitMs`: the first request after a start reads the art) and filled in.
 */
export async function buildWithColours(b: MapBuilder, colours: MapColourSource | null | undefined, q: MapQuery = {}, waitMs = 3000): Promise<MapJson> {
  const j = b.build(q);
  if (!colours) return j;
  const missing = j.palette.filter((e) => colours.peek(e.name) === undefined).map((e) => e.name);
  if (missing.length > 0) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([colours.load(missing).catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
    for (const e of j.palette) {
      const c = colours.peek(e.name);
      if (typeof c === 'number') e.rgb = hexColour(c);
    }
  }
  return j;
}

/** Parses the /map.json query string. */
export function parseMapQuery(search: URLSearchParams): MapQuery {
  const n = (k: string): number | undefined => {
    const v = search.get(k);
    if (v === null || v === '') return undefined;
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };
  const q: MapQuery = {};
  const r = n('r');
  if (r !== undefined) q.r = r;
  const cx = n('cx');
  const cz = n('cz');
  if (cx !== undefined && cz !== undefined) {
    q.cx = Math.floor(cx);
    q.cz = Math.floor(cz);
  }
  const since = n('since');
  if (since !== undefined) q.since = since;
  const win = search.get('win')?.split(',').map(Number);
  if (win?.length === 4 && win.every(Number.isFinite)) q.win = { cx0: win[0]!, cz0: win[1]!, cx1: win[2]!, cz1: win[3]! };
  return q;
}
