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
import { MAP_JSON_VERSION, type MapEntityJson, type MapJson, type MapPaletteEntry, type MapTileJson } from './schema.ts';

/** Track PC: map colours of block names (health/panel/icons/colours.ts BlockColours satisfies it). */
export interface MapColourSource {
  /** `0xRRGGBB`, null = no art (the class colour), undefined = not computed yet. */
  peek(name: string): number | null | undefined;
  /** Computes the colours of these names. */
  load(names: Iterable<string>): Promise<void>;
}

export interface MapSource {
  /** The world model (self, entities). */
  world?: { self: { pos: Vec3; yaw: number; dimension: number }; entities: ReadonlyMap<bigint, EntityInfo> };
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

/** Track PC: the response palette (block names in first-seen order). */
class PaletteBuilder {
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

function packTile(t: MapTile, pal: PaletteBuilder): MapTileJson {
  const c = Buffer.alloc(64);
  for (let i = 0; i < 256; i++) c[i >> 2] = c[i >> 2]! | ((t.cls[i]! & 3) << ((i & 3) * 2));
  const out: MapTileJson = { cx: t.cx, cz: t.cz, live: t.live, rev: t.rev, updatedAt: t.updatedAt, y: b64(t.y), c: c.toString('base64') };
  const sd = t.surf; // Track PC: the surface layer (names compacted by the cache)
  if (sd) {
    out.p = sd.names.map((n) => pal.index(n));
    out.s = b64(sd.top.idx);
    for (let i = 0; i < 256; i++) {
      if (sd.top.idx[i] !== NO_NAME && sd.top.y[i] !== t.y[i]) {
        out.sy = b64(sd.top.y);
        break;
      }
    }
    Object.assign(out, liquidFields(sd.top));
    if (sd.under) out.u = { s: b64(sd.under.idx), sy: b64(sd.under.y), ...liquidFields(sd.under) };
  }
  return out;
}

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

  private position(): Vec3 | undefined {
    return this.src.position?.() ?? this.src.world?.self.pos;
  }

  build(q: MapQuery = {}, now = Date.now()): MapJson {
    this.sample(now);
    const { world, cache } = this.src;
    const pos = this.position();
    const radius = Math.max(0, Math.min(64, Math.floor(q.r ?? 12)));
    const ccx = Number.isInteger(q.cx) ? q.cx! : pos ? Math.floor(pos.x) >> 4 : 0;
    const ccz = Number.isInteger(q.cz) ? q.cz! : pos ? Math.floor(pos.z) >> 4 : 0;
    const window = { cx0: ccx - radius, cz0: ccz - radius, cx1: ccx + radius, cz1: ccz + radius };
    const rev = currentRev();
    const since = q.since ?? -1;
    const win = q.win;
    const tiles: MapTileJson[] = [];
    const pal = new PaletteBuilder(this.src.colours); // Track PC
    if (cache) {
      for (let cx = window.cx0; cx <= window.cx1; cx++) {
        for (let cz = window.cz0; cz <= window.cz1; cz++) {
          const inOld = win !== undefined && cx >= win.cx0 && cx <= win.cx1 && cz >= win.cz0 && cz <= win.cz1;
          const t = cache.tile(cx, cz);
          if (!t) continue;
          if (inOld && t.rev <= since) continue;
          tiles.push(packTile(t, pal));
        }
      }
    }

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
      for (const { e, feet } of all.slice(0, MAX_ENTITIES)) {
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

    const waypoints = asWaypoints(task?.waypoints ?? skills?.waypoints);
    const st = cache?.stats;
    const info = cache?.info();
    return {
      v: MAP_JSON_VERSION,
      ts: now,
      server: this.src.server ?? null,
      dimension: world?.self.dimension ?? 0,
      rev,
      center: { cx: ccx, cz: ccz },
      radius,
      window,
      tiles,
      palette: pal.entries,
      bot: pos ? { x: +pos.x.toFixed(3), y: +pos.y.toFixed(3), z: +pos.z.toFixed(3), yaw: +(world?.self.yaw ?? 0).toFixed(1) } : null,
      trail: [...this.trail],
      nav: {
        busy: skills?.busy === true,
        running: typeof skills?.running === 'string' ? skills.running : null,
        path,
        goal: goalPoint(lastGoto?.goal, pos?.y ?? 0),
        result,
        plans: Array.isArray(lastGoto?.plans) ? lastGoto.plans.length : 0,
      },
      entities,
      home: asVec3(task?.home),
      shelter: asVec3(task?.shelter),
      waypoints,
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
