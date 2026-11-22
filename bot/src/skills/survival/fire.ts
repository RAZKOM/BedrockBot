// Fire and lava reactions (wave 10, Track AT; docs/nether.md "Fire"): when the bot burns (its own
// `set_entity_data` flag `onfire`, or the body touches lava / fire) and loses health, it walks to the
// nearest cell that is not burning and not next to fire or lava, then eats (tasks/process/portal.ts
// FireProcess runs it as a process above flee). No water bucket: it would evaporate in the Nether and the
// bot carries none on purpose.
// Track M11 (docs/survival.md "The fire escape (Track M11)"): fireOuts ranks every way out (clear cells, water, powder
// snow), fireToPutOut lists the fire to strike out (the own cell, the straight line to a way out), straightWalk says
// whether a straight walk through fire has floor and room; BurnWatch also reads the bot's fire resistance.
//
//   const watch = new BurnWatch(conn, { selfRuntimeId, health: () => world.self.health });
//   if (watch.hurtByFire()) { const to = fireEscape(grid, pos); ... }
import type { PacketSource, Vec3 } from '../../world/types.ts';

/** Blocks that set the body on fire or hurt it by heat (the planner already never stands in or on them). */
export const HOT_BLOCKS: ReadonlySet<string> = new Set(['fire', 'soul_fire', 'lava', 'flowing_lava', 'magma', 'campfire', 'soul_campfire', 'lava_cauldron']);

/** Track M11: the fire blocks a strike puts out (start_break on the fire block: gone at once; measured on BDS 1.26, docs/survival.md "The fire escape"). */
export const FIRE_BLOCKS: ReadonlySet<string> = new Set(['fire', 'soul_fire']);

/** What fireEscape reads (NavGrid satisfies it). */
export interface FireGrid {
  /** Feet height of a body standing in cell (x, y, z); NaN = blocked, undefined = not loaded. */
  stand(x: number, y: number, z: number): number | undefined;
  /** Track M11: `boxes` (empty = the body passes) and `floorShape` (a box top to stand on) when the grid knows them (NavGrid's TerrainClass). */
  cls(x: number, y: number, z: number): { name: string; liquid?: string | undefined; boxes?: readonly unknown[]; floorShape?: boolean } | undefined;
}

function hot(grid: FireGrid, x: number, y: number, z: number): boolean {
  const c = grid.cls(x, y, z);
  return !!c && (c.liquid === 'lava' || HOT_BLOCKS.has(c.name));
}

/** Track M11: the cell holds fire or soul fire (a strike puts it out). */
export function isFireCell(grid: FireGrid, p: Vec3): boolean {
  const c = grid.cls(p.x, p.y, p.z);
  return !!c && FIRE_BLOCKS.has(c.name);
}

/** Track M11: no block of the 3 x 3 x 3 cells round the feet cell burns (the escape's own test for a cell). */
export function clearOfFire(grid: FireGrid, cell: Vec3): boolean {
  for (let ax = -1; ax <= 1; ax++) for (let az = -1; az <= 1; az++) for (let ay = -1; ay <= 1; ay++) if (hot(grid, cell.x + ax, cell.y + ay, cell.z + az)) return false;
  return true;
}

/** Track M11: the centre and the corners of the body's 0.6 x 0.6 footprint (0.29 off the centre: a corner on a cell edge stays inside the cell). */
const BODY_CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.29, 0.29],
  [-0.29, 0.29],
  [0.29, -0.29],
  [-0.29, -0.29],
];

/** Track M11: one way out of a fire, ranked by `rank` (lower first). */
export interface FireOut {
  /** The feet cell. */
  p: Vec3;
  /** cell: a cell clear of fire to stand in; water: a water cell (the flames go out at once); snow: powder snow (the same). */
  kind: 'cell' | 'water' | 'snow';
  /** Distance from the body's cell. */
  d: number;
  /** The ranking key: the distance, a water or snow cell 2 nearer (it ends the burning, worth a short detour). */
  rank: number;
}

/** Track M11: a water or powder snow cell the body can get its feet into (the head cell passable). */
function quench(grid: FireGrid, x: number, y: number, z: number): 'water' | 'snow' | undefined {
  const c = grid.cls(x, y, z);
  if (!c) return undefined;
  const kind = c.liquid === 'water' ? 'water' : c.name === 'powder_snow' ? 'snow' : undefined;
  if (!kind) return undefined;
  const head = grid.cls(x, y + 1, z);
  if (!head || head.liquid === 'lava' || HOT_BLOCKS.has(head.name) || (head.boxes !== undefined && head.boxes.length > 0 && head.name !== 'powder_snow')) return undefined;
  return kind;
}

/**
 * Track M11: every way out of a fire within `radius` (Chebyshev rings, feet levels y - 2 .. y + 2), ranked: cells clear
 * of fire (fireEscape's test) and water or powder snow cells, nearest first (water and snow ranked 2 nearer). At most
 * `max`. The own cell is left out (the caller tests it with clearOfFire).
 */
export function fireOuts(grid: FireGrid, from: Vec3, radius = 6, max = 24): FireOut[] {
  const fx = Math.floor(from.x);
  const fy = Math.floor(from.y + 1e-6);
  const fz = Math.floor(from.z);
  const outs: FireOut[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (const dy of [0, 1, -1, 2, -2]) {
        if (dx === 0 && dz === 0 && dy === 0) continue;
        const x = fx + dx;
        const y = fy + dy;
        const z = fz + dz;
        const d = Math.hypot(dx, dy, dz);
        const q = quench(grid, x, y, z);
        if (q) {
          outs.push({ p: { x, y, z }, kind: q, d, rank: d - 2 });
          continue;
        }
        const f = grid.stand(x, y, z);
        if (f === undefined || Number.isNaN(f)) continue;
        if (!clearOfFire(grid, { x, y, z })) continue;
        outs.push({ p: { x, y, z }, kind: 'cell', d, rank: d });
      }
    }
  }
  outs.sort((a, b) => a.rank - b.rank || a.d - b.d);
  return outs.slice(0, max);
}

/**
 * Track M11: the fire to put out: the body's own feet and head cells, then the cells under its footprint along the
 * straight line to `to` (quarter-block steps) or, without `to`, the 3 x 3 columns round it; feet and head levels, nearest
 * first, each within `reach` of the eye (default 4).
 */
export function fireToPutOut(grid: FireGrid, from: Vec3, to?: Vec3, reach = 4): Vec3[] {
  const fx = Math.floor(from.x);
  const fy = Math.floor(from.y + 1e-6);
  const fz = Math.floor(from.z);
  const seen = new Set<string>();
  const cells: { p: Vec3; d: number }[] = [];
  const eye = { x: from.x, y: from.y + 1.62, z: from.z };
  const add = (x: number, y: number, z: number): void => {
    const k = `${x},${y},${z}`;
    if (seen.has(k)) return;
    seen.add(k);
    if (!isFireCell(grid, { x, y, z })) return;
    const d = Math.hypot(x + 0.5 - eye.x, y + 0.5 - eye.y, z + 0.5 - eye.z);
    if (d > reach) return;
    cells.push({ p: { x, y, z }, d: Math.hypot(x + 0.5 - from.x, y - fy, z + 0.5 - from.z) });
  };
  add(fx, fy, fz);
  add(fx, fy + 1, fz);
  if (!to) for (const dy of [0, 1]) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) add(fx + dx, fy + dy, fz + dz);
  else {
    const ex = to.x + 0.5;
    const ez = to.z + 0.5;
    const len = Math.hypot(ex - from.x, ez - from.z);
    for (let s = 0; s <= len + 1e-6; s += 0.25) {
      const k = len < 1e-6 ? 0 : s / len;
      // the body is 0.6 wide: the cells under its corners along the line, at the feet and head levels
      for (const [ox, oz] of BODY_CORNERS) {
        const cx = Math.floor(from.x + (ex - from.x) * k + ox);
        const cz = Math.floor(from.z + (ez - from.z) * k + oz);
        add(cx, fy, cz);
        add(cx, fy + 1, cz);
      }
    }
  }
  cells.sort((a, b) => a.d - b.d);
  return cells.map((c) => c.p);
}

/**
 * Track M11: a straight walk from the body to the cell `to` at the same feet level: every half-block step's feet and head
 * cells have no box and no lava (fire is passed through), and a floor box under the feet. False when the grid does not
 * know the boxes (the fake grids of older tests).
 */
export function straightWalk(grid: FireGrid, from: Vec3, to: Vec3): boolean {
  const fy = Math.floor(from.y + 1e-6);
  if (to.y !== fy) return false;
  const ex = to.x + 0.5;
  const ez = to.z + 0.5;
  const len = Math.hypot(ex - from.x, ez - from.z);
  if (len > 8) return false;
  // the cells the body stands over now: their floor is not asked in the first half block (the body stands there; a
  // burnt plank under its back edge, seen in Track M11's lava scene, left no line at all); further on it is
  const under = new Set(BODY_CORNERS.map(([ox, oz]) => `${Math.floor(from.x + ox)},${Math.floor(from.z + oz)}`));
  for (let s = 0; s <= len + 1e-6; s += 0.25) {
    const k = len < 1e-6 ? 0 : s / len;
    for (const [ox, oz] of BODY_CORNERS) {
      const x = Math.floor(from.x + (ex - from.x) * k + ox);
      const z = Math.floor(from.z + (ez - from.z) * k + oz);
      for (const y of [fy, fy + 1]) {
        const c = grid.cls(x, y, z);
        if (c?.boxes === undefined || c.liquid === 'lava' || c.boxes.length > 0) return false;
      }
      if (s < 0.5 && under.has(`${x},${z}`)) continue;
      const floor = grid.cls(x, fy - 1, z);
      if (!floor || floor.liquid === 'lava' || floor.floorShape !== true) return false;
    }
  }
  return true;
}

/** Track M11: levels a climb out of lava rises at most (lava 2 deep under the edge: the body swims up 2). */
export const CLIMB_UP = 2;

/**
 * Track M11: a swim and climb out of lava (the planner has no node to start from in it) straight to the cell `to`, the
 * same level up to `CLIMB_UP` levels up, at most 3 off: room over the body's own cell to rise (no box up to the cell
 * over `to`'s head level; lava is swum up through), room for the body at `to`'s level all the way (no box, no lava;
 * fire is passed through) and a floor under `to` (the edge it climbs out onto). With the jump key held the body rises
 * in lava (about 0.04 a tick) and hops out where it pushes against that edge (physics.ts `LIQUID.climbOut`).
 */
export function climbWalk(grid: FireGrid, from: Vec3, to: Vec3): boolean {
  const fy = Math.floor(from.y + 1e-6);
  if (to.y < fy || to.y > fy + CLIMB_UP) return false;
  const fx = Math.floor(from.x);
  const fz = Math.floor(from.z);
  for (let y = fy + 1; y <= Math.max(fy + 2, to.y + 1); y++) {
    const c = grid.cls(fx, y, fz);
    if (c?.boxes === undefined || c.boxes.length > 0) return false;
  }
  const ex = to.x + 0.5;
  const ez = to.z + 0.5;
  const len = Math.hypot(ex - from.x, ez - from.z);
  if (len > 3) return false;
  for (let s = 0; s <= len + 1e-6; s += 0.25) {
    const k = len < 1e-6 ? 0 : s / len;
    for (const [ox, oz] of BODY_CORNERS) {
      const x = Math.floor(from.x + (ex - from.x) * k + ox);
      const z = Math.floor(from.z + (ez - from.z) * k + oz);
      if (x === fx && z === fz) continue;
      for (const y of [to.y, to.y + 1]) {
        const c = grid.cls(x, y, z);
        if (c?.boxes === undefined || c.liquid === 'lava' || c.boxes.length > 0) return false;
      }
    }
  }
  const floor = grid.cls(to.x, to.y - 1, to.z);
  return floor !== undefined && floor.liquid !== 'lava' && floor.floorShape === true;
}

/**
 * The fire / lava reaction's target: the nearest feet cell (Chebyshev rings out to `radius`, feet levels
 * y - 2 .. y + 2) where the body can stand and no block of the 3 x 3 x 3 cells around the feet (floor,
 * feet and head levels) burns. Undefined when none is known (the caller then just eats and waits).
 */
export function fireEscape(grid: FireGrid, from: Vec3, radius = 6): Vec3 | undefined {
  const fx = Math.floor(from.x);
  const fy = Math.floor(from.y + 1e-6);
  const fz = Math.floor(from.z);
  let best: Vec3 | undefined;
  let bestD = Infinity;
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1, 2, -2]) {
          const x = fx + dx;
          const y = fy + dy;
          const z = fz + dz;
          const f = grid.stand(x, y, z);
          if (f === undefined || Number.isNaN(f)) continue;
          let burning = false;
          for (let ax = -1; ax <= 1 && !burning; ax++) for (let az = -1; az <= 1 && !burning; az++) for (let ay = -1; ay <= 1 && !burning; ay++) burning = hot(grid, x + ax, y + ay, z + az);
          if (burning) continue;
          const d = Math.hypot(dx, dy, dz);
          if (d < bestD) {
            bestD = d;
            best = { x, y, z };
          }
        }
      }
    }
    if (best) return best; // the nearest ring with a safe cell
  }
  return best;
}

export interface BurnWatchOptions {
  selfRuntimeId: () => bigint;
  health: () => number;
  /** The body touches lava (InputLoop state.inLava), optional. */
  inLava?: () => boolean;
  now?: () => number;
}

/** Track M11: Bedrock's effect id of Fire Resistance (mob_effect effect_id; Poison is 19, hostiles.ts). */
export const FIRE_RESISTANCE_EFFECT = 12;
/** Track M11: the item metadata of a fire resistance potion (`potion`: 12 three minutes, 13 eight minutes). */
export const FIRE_RESISTANCE_POTIONS: readonly number[] = [12, 13];

/** Tracks the bot's own `onfire` flag and its health drops. */
export class BurnWatch {
  /** The server's `onfire` flag for the bot (set_entity_data flags). */
  onFire = false;
  /** now() of the last health drop while burning (or touching lava). */
  lastFireHurtAt = -Infinity;
  /** Track M11: now() when the bot's fire resistance ends (mob_effect), -Infinity with none. */
  fireResistantUntil = -Infinity;
  readonly stats = { burns: 0, fireHurts: 0 };
  private readonly o: BurnWatchOptions;
  private readonly now: () => number;
  private lastHealth: number | undefined;
  private readonly unsubs: (() => void)[] = [];

  constructor(source: Pick<PacketSource, 'on'>, opts: BurnWatchOptions) {
    this.o = opts;
    this.now = opts.now ?? (() => performance.now());
    this.unsubs.push(
      source.on('set_entity_data', (p) => {
        const rid = p.runtime_entity_id;
        if (rid === undefined || BigInt(rid as number | bigint) !== this.o.selfRuntimeId()) return;
        for (const m of (p.metadata ?? []) as { key?: string; value?: { onfire?: boolean } }[]) {
          if (m.key !== 'flags' || typeof m.value?.onfire !== 'boolean') continue;
          if (m.value.onfire && !this.onFire) this.stats.burns++;
          this.onFire = m.value.onfire;
        }
      }),
      source.on('mob_effect', (p) => {
        const rid = p.runtime_entity_id;
        if (rid === undefined || BigInt(rid as number | bigint) !== this.o.selfRuntimeId() || p.effect_id !== FIRE_RESISTANCE_EFFECT) return;
        if (p.event_id === 'remove' || p.event_id === 3) this.fireResistantUntil = -Infinity;
        else this.fireResistantUntil = this.now() + (typeof p.duration === 'number' ? p.duration : 0) * 50;
      }),
      source.on('respawn', (p) => {
        if (p.state === 1) {
          this.onFire = false;
          this.lastHealth = undefined;
          this.fireResistantUntil = -Infinity;
        }
      }),
    );
  }

  /** Track M11: the body touches lava now (InputLoop state.inLava; false without the option). */
  touchesLava(): boolean {
    return this.o.inLava?.() ?? false;
  }

  /** Track M11: the bot has fire resistance now (fire and lava do not hurt it). */
  fireResistant(): boolean {
    return this.now() < this.fireResistantUntil;
  }

  /** Burning: the flag, or the body in lava. */
  burning(): boolean {
    return this.onFire || (this.o.inLava?.() ?? false);
  }

  /** Call every few ticks: notes a health drop while burning. */
  sample(): void {
    const h = this.o.health();
    const prev = this.lastHealth;
    this.lastHealth = h;
    if (prev !== undefined && h < prev && this.burning()) {
      this.lastFireHurtAt = this.now();
      this.stats.fireHurts++;
    }
  }

  /** Burning and hurt by it within the last `ms`. */
  hurtByFire(ms = 3000): boolean {
    return this.burning() && this.now() - this.lastFireHurtAt <= ms;
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
  }
}
