// The data behind the debug map (PLAN.md task 7.15): GET /map.json. Reads the world cache (chunk
// tiles), the world model (bot, entities), the skills status (the last goto: goal, path when the
// navigator report has one) and the task status (home, shelter, waypoints when present). Everything
// is optional, so the page works for any task. See docs/world-cache.md ("Debug map").
import { bareType, classify as entityClass, entityFeet } from '../../skills/combat/hostiles.ts';
import type { WorldCache } from '../../world/cache/cache.ts';
import { currentRev } from '../../world/cache/summary.ts';
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import { MAP_JSON_VERSION, type MapEntityJson, type MapJson, type MapTileJson } from './schema.ts';

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

function packTile(t: { cx: number; cz: number; live: boolean; rev: number; updatedAt: number; y: Int16Array; cls: Uint8Array }): MapTileJson {
  const y = Buffer.from(t.y.buffer, t.y.byteOffset, t.y.byteLength);
  const c = Buffer.alloc(64);
  for (let i = 0; i < 256; i++) c[i >> 2] = c[i >> 2]! | ((t.cls[i]! & 3) << ((i & 3) * 2));
  return { cx: t.cx, cz: t.cz, live: t.live, rev: t.rev, updatedAt: t.updatedAt, y: y.toString('base64'), c: c.toString('base64') };
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
    if (cache) {
      for (let cx = window.cx0; cx <= window.cx1; cx++) {
        for (let cz = window.cz0; cz <= window.cz1; cz++) {
          const inOld = win !== undefined && cx >= win.cx0 && cx <= win.cx1 && cz >= win.cz0 && cz <= win.cz1;
          const t = cache.tile(cx, cz);
          if (!t) continue;
          if (inOld && t.rev <= since) continue;
          tiles.push(packTile(t));
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
