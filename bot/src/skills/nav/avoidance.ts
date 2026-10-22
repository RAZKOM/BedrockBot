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
}

export const DEFAULT_AVOIDANCE_COSTS: Readonly<AvoidanceCosts> = Object.freeze({ base: 8, slope: 12, margin: 1, max: 80, mobHeight: 3 });

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
  costs?: Partial<AvoidanceCosts>;
}

interface Source {
  x: number;
  y: number;
  z: number;
  /** Zone radius (r + margin). */
  zone: number;
  r: number;
  /** true: horizontal distance with a height window (mob); false: 3D (spawner). */
  flat: boolean;
}

/** Penalty for distance d from a source with radius r (0 outside r + margin). */
export function penalty(d: number, r: number, c: AvoidanceCosts = DEFAULT_AVOIDANCE_COSTS): number {
  const zone = r + c.margin;
  if (r <= 0 || d >= zone) return 0;
  return Math.min(c.max, c.base + c.slope * (zone - d));
}

/** A cost function over a fixed list of sources (one snapshot). */
export function costFunction(sources: readonly Source[], c: AvoidanceCosts = DEFAULT_AVOIDANCE_COSTS): ((x: number, y: number, z: number) => number) | undefined {
  if (sources.length === 0) return undefined;
  return (x, y, z) => {
    const cx = x + 0.5;
    const cz = z + 0.5;
    let sum = 0;
    for (const s of sources) {
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
}

export class Avoidance {
  private readonly d: AvoidanceDeps;
  private readonly c: AvoidanceCosts;
  /** Sources of the last snapshot (for logs and tests). */
  last: { mobs: number; spawners: number } = { mobs: 0, spawners: 0 };

  constructor(deps: AvoidanceDeps) {
    this.d = deps;
    this.c = { ...DEFAULT_AVOIDANCE_COSTS, ...deps.costs };
  }

  /** The sources right now: hostile mobs (not excluded, not players) and known spawners. */
  sources(): Source[] {
    const out: Source[] = [];
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
    this.last = { mobs, spawners };
    return out;
  }

  /** A cost function for one plan (undefined when there is nothing to avoid). */
  costFn(): ((x: number, y: number, z: number) => number) | undefined {
    return costFunction(this.sources(), this.c);
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
