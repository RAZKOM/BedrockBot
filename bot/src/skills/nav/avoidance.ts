// Mob and spawner avoidance as planner cost (PLAN.md task 7.11, Track S, docs/survival.md). A cell
// near a hostile mob or a spawner stays passable but costs extra ticks, so A* bends the path around
// it when a detour exists and still goes through when it is the only way (a wall would make goals
// next to a mob unreachable).
//
//   const avoid = new Avoidance({ entities: () => world.entities, spawners: () => finder.spawners(),
//                                 mobRadius: () => 4, spawnerRadius: () => 8 });
//   navigator.cellCost = () => avoid.costFn();      // a fresh snapshot for every plan
//
// Cost of a feet cell (ticks, added to the move into it; see `penalty`): for every source within
// reach, with d the distance from the cell centre (x + 0.5, y, z + 0.5) to the source and r its
// radius, `base + slope x (r + margin - d)` while d < r + margin, capped at `max` per source:
//   hostile mob  r = avoidMobRadius (4),     horizontal d, only within 3 blocks of height; base 8, slope 12
//   spawner      r = avoidSpawnerRadius (8), 3D d to the block centre;                    base 8, slope 12
// margin 1 (the follower cuts corners by up to half a block), max 80 per source. A sprinted block is
// 3.56 ticks, so crossing an 8-block spawner zone through its middle costs about 1 100 extra ticks
// and any detour shorter than about 300 blocks wins; a single cell at the edge costs 8 to 20.
//
// Track AT (docs/nether.md): lava. Every lava cell with no lava above it (a pool's surface, a flow)
// within 20 blocks of the bot is a source of kind 'lava'; a feet cell with such lava at the floor
// level, the feet or the head level (y - 1 .. y + 1) in its column or a neighbour column costs
// `lavaNear` (60) at Chebyshev distance 1 (or 0) and `lavaFar` (8) at distance 2 (the largest one
// counts, not the sum). Walking along a lava lake therefore keeps one free block between the body and
// the lava when any detour exists (a cell at distance 1 costs as much as 17 sprinted blocks).
import { classify, entityFeet } from '../combat/hostiles.ts';
import type { EntityInfo, Vec3 } from '../../world/types.ts';

export const DEFAULT_AVOID_MOB_RADIUS = 4;
export const DEFAULT_AVOID_SPAWNER_RADIUS = 8;

export interface AvoidanceCosts {
  /** Ticks for a cell just inside the zone (r + margin). */
  base: number;
  /** Extra ticks per block closer than r + margin. */
  slope: number;
  /** Zone margin beyond the radius, blocks. */
  margin: number;
  /** Cap per source, ticks. */
  max: number;
  /** Mobs farther than this many blocks above or below the cell are ignored. */
  mobHeight: number;
  /** Track AT: ticks for a cell next to lava (Chebyshev distance 0 or 1, y - 1 .. y + 1). Default 60. */
  lavaNear?: number;
  /** Track AT: ticks for a cell 2 blocks from lava. Default 8. */
  lavaFar?: number;
}

export const DEFAULT_AVOIDANCE_COSTS: Readonly<AvoidanceCosts> = Object.freeze({ base: 8, slope: 12, margin: 1, max: 80, mobHeight: 3, lavaNear: 60, lavaFar: 8 });
/** Track AT: lava within this many blocks of the bot becomes a source. */
export const LAVA_RADIUS = 20;

/** Block names that count as spawners. */
export const SPAWNER_BLOCKS: ReadonlySet<string> = new Set(['mob_spawner', 'trial_spawner']);

export interface AvoidanceDeps {
  /** Tracked entities (World.entities). */
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  /** Spawner block positions currently known (e.g. a SpawnerIndex). */
  spawners?: () => readonly Vec3[];
  /** avoidMobRadius (setting); 0 = off. */
  mobRadius?: () => number;
  /** avoidSpawnerRadius (setting); 0 = off. */
  spawnerRadius?: () => number;
  /** Runtime ids never avoided (the mob being fought, a followed mob). */
  exclude?: () => Iterable<bigint>;
  /** Only mobs within this distance of `origin` are considered (default 96). */
  origin?: () => Vec3 | undefined;
  range?: number;
  /** Track AT: the world to find lava in (an own LavaIndex around `origin`); omit for no lava costs. */
  lavaWorld?: LavaWorld;
  costs?: Partial<AvoidanceCosts>;
}

/** Track AB: a cost function that carries its snapshot (the planner worker rebuilds it with costFunction). */
export type AvoidanceCostFn = ((x: number, y: number, z: number) => number) & { avoidance?: { sources: AvoidanceSource[]; costs: AvoidanceCosts } };

export interface AvoidanceSource {
  x: number;
  y: number;
  z: number;
  /** Zone radius (r + margin). */
  zone: number;
  r: number;
  /** true: horizontal distance with a height window (mob); false: 3D (spawner). */
  flat: boolean;
  /** Track AT: a lava cell (block position in x, y, z; zone and r unused). */
  lava?: true;
}

/** Penalty for distance d from a source with radius r (0 outside r + margin). */
export function penalty(d: number, r: number, c: AvoidanceCosts = DEFAULT_AVOIDANCE_COSTS): number {
  const zone = r + c.margin;
  if (r <= 0 || d >= zone) return 0;
  return Math.min(c.max, c.base + c.slope * (zone - d));
}

/** A cost function over a fixed list of sources (one snapshot). */
export function costFunction(sources: readonly AvoidanceSource[], c: AvoidanceCosts = DEFAULT_AVOIDANCE_COSTS): AvoidanceCostFn | undefined {
  if (sources.length === 0) return undefined;
  const mobs = sources.filter((s) => !s.lava); // Track AT: lava sources go to a column index
  const lava = lavaColumns(sources);
  const near = c.lavaNear ?? DEFAULT_AVOIDANCE_COSTS.lavaNear ?? 60;
  const far = c.lavaFar ?? DEFAULT_AVOIDANCE_COSTS.lavaFar ?? 8;
  const fn = (x: number, y: number, z: number): number => {
    const cx = x + 0.5;
    const cz = z + 0.5;
    let sum = lava ? lavaPenalty(lava, x, y, z, near, far) : 0;
    for (const s of mobs) {
      const dx = cx - s.x;
      const dz = cz - s.z;
      if (dx > s.zone || dx < -s.zone || dz > s.zone || dz < -s.zone) continue;
      let d: number;
      if (s.flat) {
        if (Math.abs(y - s.y) > c.mobHeight) continue;
        d = Math.hypot(dx, dz);
      } else {
        d = Math.hypot(dx, y - s.y, dz);
      }
      if (d < s.zone) sum += Math.min(c.max, c.base + c.slope * (s.zone - d));
    }
    return sum;
  };
  // Track AB: the sources and costs ride along, so the planner worker can rebuild the function
  return Object.assign(fn, { avoidance: { sources: [...sources], costs: { ...c } } });
}

export class Avoidance {
  private readonly d: AvoidanceDeps;
  private readonly c: AvoidanceCosts;
  /** Track AT: lava cells near the bot (when `lavaWorld` is given). */
  readonly lava: LavaIndex | undefined;
  /** Sources of the last snapshot (for logs and tests). */
  last: { mobs: number; spawners: number; lava?: number } = { mobs: 0, spawners: 0 };

  constructor(deps: AvoidanceDeps) {
    this.d = deps;
    this.c = { ...DEFAULT_AVOIDANCE_COSTS, ...deps.costs };
    this.lava = deps.lavaWorld ? new LavaIndex(deps.lavaWorld, deps.origin ?? (() => undefined)) : undefined; // Track AT
  }

  /** The sources right now: hostile mobs (not excluded, not players) and known spawners. */
  sources(): AvoidanceSource[] {
    const out: AvoidanceSource[] = [];
    const mobR = this.d.mobRadius?.() ?? DEFAULT_AVOID_MOB_RADIUS;
    const spawnR = this.d.spawnerRadius?.() ?? DEFAULT_AVOID_SPAWNER_RADIUS;
    let mobs = 0;
    let spawners = 0;
    if (mobR > 0) {
      const skip = new Set(this.d.exclude?.() ?? []);
      const o = this.d.origin?.();
      const range = this.d.range ?? 96;
      for (const e of this.d.entities().values()) {
        if (skip.has(e.runtimeId) || e.username !== undefined) continue;
        if (classify(e.type) !== 'hostile') continue;
        const f = entityFeet(e);
        if (o && Math.hypot(f.x - o.x, f.z - o.z) > range) continue;
        out.push({ x: f.x, y: Math.floor(f.y + 1e-3), z: f.z, r: mobR, zone: mobR + this.c.margin, flat: true });
        mobs++;
      }
    }
    if (spawnR > 0) {
      for (const p of this.d.spawners?.() ?? []) {
        out.push({ x: p.x + 0.5, y: p.y, z: p.z + 0.5, r: spawnR, zone: spawnR + this.c.margin, flat: false });
        spawners++;
      }
    }
    let lava = 0; // Track AT
    for (const p of this.lava?.cells() ?? []) {
      out.push({ x: p.x, y: p.y, z: p.z, r: 0, zone: 0, flat: false, lava: true });
      lava++;
    }
    this.last = { mobs, spawners, ...(this.lava ? { lava } : {}) };
    return out;
  }

  /** A cost function for one plan (undefined when there is nothing to avoid). */
  costFn(): ((x: number, y: number, z: number) => number) | undefined {
    return costFunction(this.sources(), this.c);
  }
}

/** Track AT: lava cells by column (x, z) -> their y values. */
type LavaColumns = Map<number, number[]>;

const colKey = (x: number, z: number): number => (x + 1048576) * 2097152 + (z + 1048576);

function lavaColumns(sources: readonly AvoidanceSource[]): LavaColumns | undefined {
  let m: LavaColumns | undefined;
  for (const s of sources) {
    if (!s.lava) continue;
    m ??= new Map();
    const k = colKey(s.x, s.z);
    const ys = m.get(k);
    if (ys) ys.push(s.y);
    else m.set(k, [s.y]);
  }
  return m;
}

/** Track AT: the lava cost of feet cell (x, y, z): `near` with lava at Chebyshev distance <= 1, `far` at 2 (levels y - 1 .. y + 1). */
export function lavaPenalty(cols: ReadonlyMap<number, readonly number[]>, x: number, y: number, z: number, near: number, far: number): number {
  let best = 0;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const ys = cols.get(colKey(x + dx, z + dz));
      if (!ys) continue;
      const cost = Math.max(Math.abs(dx), Math.abs(dz)) <= 1 ? near : far;
      if (cost <= best) continue;
      if (ys.some((ly) => ly >= y - 1 && ly <= y + 1)) {
        best = cost;
        if (best >= near) return best;
      }
    }
  }
  return best;
}

/** Track AT: the parts of World the lava index reads. */
export interface LavaWorld {
  find(pred: (b: { name: string }, p: Vec3) => boolean, opts: { origin: Vec3; radius: number; max: number }): Vec3[];
}

const LAVA_NAMES: ReadonlySet<string> = new Set(['lava', 'flowing_lava']);

/** Track AT: the world model's dimension when the object is a World (`self.dimension`), else undefined. */
function dimensionOf(world: object): number | undefined {
  return (world as { self?: { dimension?: number } }).self?.dimension;
}

/**
 * Track AT: the lava cells near the bot that matter for walking (no lava right above them: a pool's
 * surface, a flow), rescanned at most every `rescanMs` once the bot moved 6 blocks, and at least every
 * 5 s (flows change). One scan of a 20-block sphere visits about 34 000 blocks.
 */
export class LavaIndex {
  private readonly world: LavaWorld;
  private readonly origin: () => Vec3 | undefined;
  private readonly radius: number;
  private readonly rescanMs: number;
  private cellsNow: Vec3[] = [];
  private scannedAt: Vec3 | undefined;
  private scannedMs = -Infinity;
  private dim: number | undefined;
  scans = 0;

  constructor(world: LavaWorld, origin: () => Vec3 | undefined, opts: { radius?: number; rescanMs?: number } = {}) {
    this.world = world;
    this.origin = origin;
    this.radius = opts.radius ?? LAVA_RADIUS;
    this.rescanMs = opts.rescanMs ?? 1000;
  }

  /** Lava cells (rescanned first when due). */
  cells(): readonly Vec3[] {
    const dim = dimensionOf(this.world);
    if (dim !== this.dim) {
      this.dim = dim;
      this.reset();
    }
    const o = this.origin();
    if (!o) return this.cellsNow;
    const now = performance.now();
    const s = this.scannedAt;
    const moved = !s || Math.max(Math.abs(o.x - s.x), Math.abs(o.y - s.y), Math.abs(o.z - s.z)) > 6;
    if ((moved && now - this.scannedMs >= this.rescanMs) || now - this.scannedMs >= 5000) this.scan(o, now);
    return this.cellsNow;
  }

  /** Forget the cells (a dimension change). */
  reset(): void {
    this.cellsNow = [];
    this.scannedAt = undefined;
    this.scannedMs = -Infinity;
  }

  private scan(o: Vec3, now: number): void {
    this.scans++;
    this.scannedAt = { ...o };
    this.scannedMs = now;
    const found = this.world.find((b) => LAVA_NAMES.has(b.name), { origin: o, radius: this.radius, max: 8192 });
    const all = new Set(found.map((p) => `${p.x},${p.y},${p.z}`));
    this.cellsNow = found.filter((p) => !all.has(`${p.x},${p.y + 1},${p.z}`));
  }
}

/** The parts of World the spawner index reads. */
export interface SpawnerWorld {
  find(pred: (b: { name: string }, p: Vec3) => boolean, opts: { origin: Vec3; radius: number; max: number }): Vec3[];
  onBlockUpdate(fn: (p: Vec3, before: { name: string } | undefined, after: { name: string }) => void): () => void;
}

/**
 * Spawners near the bot: a full scan (world.find, every non-air block within `radius`) at most every
 * `rescanMs` while the bot moved more than 8 blocks since the last scan, plus block updates that add or
 * remove a spawner. Scans are cheap on the surface (about 1 ms per 100 000 blocks, docs/world-model.md).
 */
export class SpawnerIndex {
  private readonly world: SpawnerWorld;
  private readonly origin: () => Vec3 | undefined;
  private readonly radius: number;
  private readonly rescanMs: number;
  private known = new Map<string, Vec3>();
  private scannedAt: Vec3 | undefined;
  private scannedMs = -Infinity;
  private dirty = true;
  private dim: number | undefined; // Track AT
  private readonly off: () => void;
  scans = 0;

  constructor(world: SpawnerWorld, origin: () => Vec3 | undefined, opts: { radius?: number; rescanMs?: number } = {}) {
    this.world = world;
    this.origin = origin;
    this.radius = opts.radius ?? 48;
    this.rescanMs = opts.rescanMs ?? 2000;
    this.off = world.onBlockUpdate((p, before, after) => {
      const k = `${p.x},${p.y},${p.z}`;
      if (SPAWNER_BLOCKS.has(after.name)) this.known.set(k, { x: p.x, y: p.y, z: p.z });
      else if (before && SPAWNER_BLOCKS.has(before.name)) this.known.delete(k);
    });
  }

  dispose(): void {
    this.off();
  }

  /** Mark for a rescan (chunks arrived, teleport). */
  invalidate(): void {
    this.dirty = true;
  }

  /** Spawner positions (rescanned first when due). */
  spawners(): Vec3[] {
    // Track AT: another dimension: the remembered spawners were at these coordinates in the old one
    const dim = dimensionOf(this.world);
    if (dim !== this.dim) {
      this.dim = dim;
      this.known.clear();
      this.dirty = true;
    }
    const o = this.origin();
    if (o) {
      const now = performance.now();
      const moved = !this.scannedAt || Math.hypot(o.x - this.scannedAt.x, o.z - this.scannedAt.z) > 8;
      if (this.dirty || (moved && now - this.scannedMs >= this.rescanMs)) this.scan(o, now);
    }
    return [...this.known.values()];
  }

  private scan(o: Vec3, now: number): void {
    this.scans++;
    this.dirty = false;
    this.scannedAt = { ...o };
    this.scannedMs = now;
    const found = this.world.find((b) => SPAWNER_BLOCKS.has(b.name), { origin: o, radius: this.radius, max: 64 });
    const next = new Map<string, Vec3>();
    for (const p of found) next.set(`${p.x},${p.y},${p.z}`, p);
    // keep spawners seen earlier outside the scanned sphere (the bot may come back)
    for (const [k, p] of this.known) if (Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z) > this.radius) next.set(k, p);
    this.known = next;
  }
}
