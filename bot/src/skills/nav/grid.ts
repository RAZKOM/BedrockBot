// Navigation grid (PLAN.md tasks 3.5 / 7.1): where can the body stand, is a column of cells free for
// it, can it cross a door or gate cell, and is a cell under the open sky? A node is the integer cell
// (x, y, z) that contains the feet: feet height in [y, y + 1). The floor is either a partial block
// inside that cell (slab, carpet, snow layer, soul sand ...) or a block with a top of exactly 1 in the
// cell below. See docs/pathfinding.md.
import { classify, type TerrainClass } from '../terrain/classify.ts';
import { CLIMBERS, boxesAtCell, type TerrainSource } from '../terrain/query.ts'; // Track AJ: CLIMBERS
import { blockInfoOf, doorBoxes } from '../terrain/shapes.ts';
import { PHYSICS } from '../input/physics.ts';
import type { Box } from '../../world/types.ts';

/** Packs integer block coordinates into one exact double (x, z within +-2^20, y within +-512). */
export function cellKey(x: number, y: number, z: number): number {
  return ((x + 1048576) * 2097152 + (z + 1048576)) * 1024 + (y + 512);
}

/** Result of `stand()`: a feet height, `BLOCKED`, or `UNKNOWN` (some block is not loaded). */
export const BLOCKED = Number.NaN;
export const UNKNOWN = undefined;

/** `crossing()`: the body passes, passes after toggling the door / gate, or not at all. */
export const CROSS_CLEAR = 0;
export const CROSS_TOGGLE = 1;
export const CROSS_BLOCKED = 2;
export type Crossing = typeof CROSS_CLEAR | typeof CROSS_TOGGLE | typeof CROSS_BLOCKED;

/** The body's half width plus nothing: the corridor a body walking along a cell's centre line sweeps. */
const CORRIDOR_LO = 0.5 - PHYSICS.width / 2;
const CORRIDOR_HI = 0.5 + PHYSICS.width / 2;
const EPS = 1e-6;
/** Column top sentinels of the sky cache. */
const SKY_UNSET = -2147483648;
const SKY_NONE = -1000000;

const chunkKey = (x: number, z: number): number => ((x >> 4) + 65536) * 131072 + ((z >> 4) + 65536);

/** Some box blocks a body walking through the cell's centre line along `axis` (0 = x, 2 = z). */
function blocksCorridor(boxes: readonly Box[], axis: 0 | 2): boolean {
  for (const b of boxes) {
    if (b[1] >= 1 - EPS || b[4] <= EPS) continue;
    const lo = axis === 0 ? b[2] : b[0];
    const hi = axis === 0 ? b[5] : b[3];
    if (lo < CORRIDOR_HI - EPS && hi > CORRIDOR_LO + EPS) return true;
  }
  return false;
}

/** A door or fence gate: a cell the body may stand in once it is open. */
const isPassage = (c: TerrainClass): boolean => c.openable === 'door' || c.openable === 'gate';

/** Track AJ: NavGrid.variety bits: water, a climber, a climber with a collision box (ladder) was classified. */
export const VARIETY_WATER = 1;
export const VARIETY_CLIMBER = 2;
export const VARIETY_LADDER = 4;

/** Track AJ: a block the body climbs on BDS 1.26.60 (terrain/query.ts CLIMBERS). */
export const isClimber = (c: TerrainClass): boolean => c.climbable && CLIMBERS.has(c.name);
/** Track AJ: scaffolding (stood on unless sneaking, climbed by jump / sneak: not modelled; an obstacle). */
const isScaffold = (c: TerrainClass): boolean => c.name === 'scaffolding';
/** Track AJ: the body may occupy the cell: no collision box (a climber's thin box aside), no liquid, no hazard. */
const passable = (c: TerrainClass): boolean => (c.boxes.length === 0 || isClimber(c)) && !c.liquid && !c.danger && !isScaffold(c);
/** Track AJ: water the body swims on: a source (or a waterlogged plant without depth), not a bubble column. */
const stillWater = (c: TerrainClass): boolean => c.liquid === 'water' && c.name !== 'bubble_column' && Number(c.states.liquid_depth ?? 0) === 0;
const SIDES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const closedGateBoxes = new Map<string, readonly Box[]>();

/** Boxes of a gate with `open_bit` flipped. */
function toggledGateBoxes(c: TerrainClass): readonly Box[] {
  if (!c.open) return [];
  const key = `${c.name}|${JSON.stringify(c.states)}`;
  let hit = closedGateBoxes.get(key);
  if (!hit) {
    try {
      hit = blockInfoOf(c.name, { ...c.states, open_bit: 0 }).boxes;
    } catch {
      hit = [[0, 0, 0, 1, 1.5, 1]];
    }
    closedGateBoxes.set(key, hit);
  }
  return hit;
}

export class NavGrid {
  readonly source: TerrainSource;
  private readonly cells = new Map<number, TerrainClass>();
  /** stand() results (feet or NaN); unknown results are not cached. */
  private readonly stands = new Map<number, number>();
  /** Track AJ: swim() results (feet or NaN), like `stands`. */
  private readonly swims = new Map<number, number>();
  /** Highest roof block per column, 16 x 16 per chunk (SKY_UNSET = not computed). */
  private readonly sky = new Map<number, Int32Array>();
  private readonly minYOpt: number | undefined;
  /** Lookups served (for perf reports). */
  lookups = 0;
  /** Sky columns scanned (for perf reports). */
  skyScans = 0;
  /** Track AJ: VARIETY_* bits of the cells classified so far (sticky). */
  variety = 0;

  constructor(source: TerrainSource, opts: { minY?: number } = {}) {
    this.source = source;
    this.minYOpt = opts.minY;
  }

  /** Classification of a cell, cached; undefined = not loaded. */
  cls(x: number, y: number, z: number): TerrainClass | undefined {
    this.lookups++;
    const k = cellKey(x, y, z);
    const hit = this.cells.get(k);
    if (hit) return hit;
    const b = this.source.blockAt(x, y, z);
    if (!b) return undefined; // not cached: chunks arrive later
    const c = classify(b);
    this.cells.set(k, c);
    // Track AJ: what kinds of movement-variety cells this grid has seen (the planner skips the checks until then)
    if (c.liquid === 'water') this.variety |= VARIETY_WATER;
    if (c.climbable && isClimber(c)) this.variety |= c.boxes.length ? VARIETY_CLIMBER | VARIETY_LADDER : VARIETY_CLIMBER;
    return c;
  }

  /** Forget a cell (block update). */
  invalidate(x: number, y: number, z: number): void {
    this.cells.delete(cellKey(x, y, z));
    // stand(x, y', z) reads cells y' - 1 .. y' + 2 of its column
    for (let dy = -2; dy <= 1; dy++) this.stands.delete(cellKey(x, y + dy, z));
    const col = this.sky.get(chunkKey(x, z));
    if (col) col[(x & 15) * 16 + (z & 15)] = SKY_UNSET;
    // Track AJ: swim(x, y', z) reads cells y' .. y' + 2 of its column and the 4 cells beside y'
    if (this.swims.size) {
      for (let dy = -2; dy <= 0; dy++) this.swims.delete(cellKey(x, y + dy, z));
      for (const [dx, dz] of SIDES) this.swims.delete(cellKey(x + dx, y, z + dz));
    }
  }

  clear(): void {
    this.cells.clear();
    this.stands.clear();
    this.swims.clear(); // Track AJ
    this.sky.clear();
  }

  /** The body may occupy this cell: no collision (a ladder's thin box aside), no liquid, no hazard. undefined = unknown. */
  free(x: number, y: number, z: number): boolean | undefined {
    const c = this.cls(x, y, z);
    if (!c) return undefined;
    return passable(c);
  }

  // ---- Track AJ: movement variety (docs/pathfinding.md "Movement variety") ----------------------

  /** Track AJ: the cell holds a block the body climbs (ladder, vines; not scaffolding). undefined = unknown. */
  climbable(x: number, y: number, z: number): boolean | undefined {
    const c = this.cls(x, y, z);
    return c && isClimber(c);
  }

  /**
   * Track AJ: feet height (y) of a body climbing in cell (x, y, z): the cell holds a climber and the
   * body's cells (y, y + 1) are passable. BLOCKED / UNKNOWN as for `stand`.
   */
  climb(x: number, y: number, z: number): number | undefined {
    const c = this.cls(x, y, z);
    if (!c) return UNKNOWN;
    if (!isClimber(c) || c.liquid || c.danger) return BLOCKED;
    const h = this.cls(x, y + 1, z);
    if (!h) return UNKNOWN;
    return passable(h) ? y : BLOCKED;
  }

  /**
   * Track AJ: feet height (y) of a body swimming on the surface of cell (x, y, z): a still water cell
   * (a source: no flow push, which the physics does not model, and no bubble column) with free air
   * in the two cells above (the body bobs up to 0.6 out of the water), and no flowing water or lava
   * next to it. Depth-1 water over a floor (wading) counts too. BLOCKED / UNKNOWN as for `stand`.
   */
  swim(x: number, y: number, z: number): number | undefined {
    const k = cellKey(x, y, z);
    const hit = this.swims.get(k);
    if (hit !== undefined) return hit;
    const f = this.computeSwim(x, y, z);
    if (f !== undefined) this.swims.set(k, f);
    return f;
  }

  private computeSwim(x: number, y: number, z: number): number | undefined {
    const c = this.cls(x, y, z);
    if (!c) return UNKNOWN;
    if (!stillWater(c) || c.boxes.length) return BLOCKED;
    for (let dy = 1; dy <= 2; dy++) {
      const a = this.cls(x, y + dy, z);
      if (!a) return UNKNOWN;
      if (a.boxes.length || a.liquid || a.danger) return BLOCKED;
    }
    for (const [dx, dz] of SIDES) {
      const n = this.cls(x + dx, y, z + dz);
      if (!n) return UNKNOWN;
      if (n.liquid === 'lava' || (n.liquid === 'water' && !stillWater(n)) || n.danger) return BLOCKED;
    }
    return y;
  }

  /**
   * Track AJ: a cardinal walk along (dx, dz) that enters (`enter`) or leaves cell (x, y, z) through
   * its centre is not stopped by a climber's thin box there (a ladder on the far side when entering is
   * fine: the body stops in front of it; leaving towards it is not).
   */
  climberLets(x: number, y: number, z: number, dx: number, dz: number, enter: boolean): boolean {
    const c = this.cls(x, y, z);
    if (!c || !isClimber(c) || !c.boxes.length) return true;
    const axis = dx !== 0 ? 0 : 2;
    const dir = dx + dz;
    for (const b of c.boxes) {
      const lo = axis === 0 ? b[0] : b[2];
      const hi = axis === 0 ? b[3] : b[5];
      const plo = axis === 0 ? b[2] : b[0];
      const phi = axis === 0 ? b[5] : b[3];
      if (!(plo < CORRIDOR_HI - EPS && phi > CORRIDOR_LO + EPS)) continue; // beside the corridor
      // the body sweeps [-inf, 0.8] entering along +axis, [0.2, +inf] leaving along +axis
      const sweptLo = enter === dir > 0 ? -Infinity : CORRIDOR_LO;
      const sweptHi = enter === dir > 0 ? CORRIDOR_HI : Infinity;
      if (lo < sweptHi - EPS && hi > sweptLo + EPS) return false;
    }
    return true;
  }

  /** Track AJ: the cell holds a climber with a collision box (a ladder). */
  thinClimber(x: number, y: number, z: number): boolean {
    const c = this.cls(x, y, z);
    return !!c && isClimber(c) && c.boxes.length > 0;
  }

  /** Cells y0..y1 (inclusive) of a column are all free. undefined = some unknown. */
  freeColumn(x: number, y0: number, y1: number, z: number): boolean | undefined {
    for (let y = y0; y <= y1; y++) {
      const f = this.free(x, y, z);
      if (f !== true) return f;
    }
    return true;
  }

  /**
   * Feet height of a body standing in node (x, y, z), or BLOCKED (NaN), or UNKNOWN (undefined).
   * Checks the floor, the cell itself and the head room for a 1.8 high body. Door and gate cells are
   * BLOCKED here (see `standThrough`).
   */
  stand(x: number, y: number, z: number): number | undefined {
    const k = cellKey(x, y, z);
    const hit = this.stands.get(k);
    if (hit !== undefined) return hit;
    const f = this.computeStand(x, y, z, false);
    if (f !== undefined) this.stands.set(k, f);
    return f;
  }

  /**
   * Like `stand`, but door and fence gate cells (open or closed) count as free: the feet height of a
   * body standing in a doorway. Only cardinal walks use such nodes (with `crossing`).
   */
  standThrough(x: number, y: number, z: number): number | undefined {
    return this.computeStand(x, y, z, true);
  }

  /** The body cells of a node standing at `feet` hold a door or gate. */
  hasPassage(x: number, y: number, feet: number, z: number): boolean {
    const top = Math.floor(feet + PHYSICS.height - 1e-6);
    for (let cy = y; cy <= top; cy++) {
      const c = this.cls(x, cy, z);
      if (c && isPassage(c)) return true;
    }
    return false;
  }

  private computeStand(x: number, y: number, z: number, through: boolean): number | undefined {
    const c = this.cls(x, y, z);
    if (!c) return UNKNOWN;
    let feet: number;
    if (isScaffold(c)) return BLOCKED; // Track AJ: scaffolding's own rules are not modelled
    if (c.boxes.length && !(through && isPassage(c)) && !isClimber(c)) {
      if (!c.floor || c.top >= 1) return BLOCKED;
      feet = y + c.top;
    } else {
      if (c.liquid || c.danger) return BLOCKED;
      const below = this.cls(x, y - 1, z);
      if (!below) return UNKNOWN;
      if (!below.floor || below.top !== 1) return BLOCKED;
      feet = y;
    }
    const headTop = Math.floor(feet + PHYSICS.height - 1e-6);
    for (let cy = y + 1; cy <= headTop; cy++) {
      const h = this.cls(x, cy, z);
      if (!h) return UNKNOWN;
      if (through && isPassage(h)) continue;
      if (!passable(h)) return BLOCKED; // Track AJ: a ladder's thin box is no obstacle
    }
    return feet;
  }

  /**
   * How a body walking along `axis` (0 = x, 2 = z) through the centre of cell (x, y, z) gets past
   * it: CROSS_CLEAR (nothing in the way: air, an open gate, a door panel along the edge),
   * CROSS_TOGGLE (a door or gate that is in the way now and out of the way once toggled), or
   * CROSS_BLOCKED. undefined = not loaded.
   */
  crossing(x: number, y: number, z: number, axis: 0 | 2): Crossing | undefined {
    const c = this.cls(x, y, z);
    if (!c) return undefined;
    if (c.boxes.length === 0) return c.liquid || c.danger ? CROSS_BLOCKED : CROSS_CLEAR;
    if (!isPassage(c)) return CROSS_BLOCKED;
    const now = boxesAtCell(this.source, x, y, z, c) ?? c.boxes;
    if (!blocksCorridor(now, axis)) return CROSS_CLEAR;
    let toggled: readonly Box[];
    if (c.openable === 'gate') {
      toggled = toggledGateBoxes(c);
    } else {
      const lower = c.doorUpper ? this.cls(x, y - 1, z) : c;
      if (lower?.openable !== 'door') return CROSS_BLOCKED;
      toggled = doorBoxes(c.states, { ...lower.states, open_bit: lower.open ? 0 : 1 });
    }
    return blocksCorridor(toggled, axis) ? CROSS_BLOCKED : CROSS_TOGGLE;
  }

  /** The cell a door / gate at (x, y, z) is used through (a door's lower half). */
  passageBase(x: number, y: number, z: number): { x: number; y: number; z: number } {
    const c = this.cls(x, y, z);
    return c?.doorUpper ? { x, y: y - 1, z } : { x, y, z };
  }

  /**
   * Highest block of the column that blocks the sky (TerrainClass.roof), SKY_NONE-like -1e6 when
   * there is none, undefined when some of the column is not loaded. Cached per chunk; a block update
   * in the column resets it.
   */
  skyTop(x: number, z: number): number | undefined {
    const ck = chunkKey(x, z);
    let col = this.sky.get(ck);
    const i = (x & 15) * 16 + (z & 15);
    if (col) {
      const v = col[i]!;
      if (v !== SKY_UNSET) return v;
    }
    const src = this.source;
    const start = src.columnTop ? src.columnTop(x, z) : (src.maxY ?? 319);
    if (start === undefined) return undefined;
    this.skyScans++;
    let top = SKY_NONE;
    const minY = this.minYOpt ?? src.minY ?? -64;
    for (let y = start; y >= minY; y--) {
      const b = src.blockAt(x, y, z);
      if (!b) return undefined;
      if (classify(b).roof) {
        top = y;
        break;
      }
    }
    if (!col) {
      col = new Int32Array(256).fill(SKY_UNSET);
      this.sky.set(ck, col);
    }
    col[i] = top;
    return top;
  }

  /** A node standing at `feet` in (x, y, z) has a roof somewhere above its head (false when unknown). */
  underground(x: number, z: number, feet: number): boolean {
    const top = this.skyTop(x, z);
    return top !== undefined && top > Math.floor(feet + PHYSICS.height - 1e-6);
  }

  /** Multiplier on the cost of a move that ends standing in node (x, y, z) (leaves, soul sand, ice ...). */
  factor(x: number, y: number, z: number, feet: number): number {
    const floorY = feet > y + 1e-9 ? y : y - 1;
    return this.cls(x, floorY, z)?.costFactor ?? 1;
  }

  /** Extra cost (blocks of walking) of standing in node (x, y, z); kept for callers of the v1 grid. */
  penalty(x: number, y: number, z: number, feet: number): number {
    const floorY = feet > y + 1e-9 ? y : y - 1;
    return this.cls(x, floorY, z)?.penalty ?? 0;
  }
}
