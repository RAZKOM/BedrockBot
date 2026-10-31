// Navigation grid (PLAN.md tasks 3.5 / 7.1): where can the body stand, is a column of cells free for
// it, can it cross a door or gate cell, and is a cell under the open sky? A node is the integer cell
// (x, y, z) that contains the feet: feet height in [y, y + 1). The floor is either a partial block
// inside that cell (slab, carpet, snow layer, soul sand ...) or a block with a top of exactly 1 in the
// cell below. See docs/pathfinding.md.
import { classify, type TerrainClass } from '../terrain/classify.ts';
import { boxesAtCell, type TerrainSource } from '../terrain/query.ts';
import { blockInfoOf, doorBoxes, partialBoxes } from '../terrain/shapes.ts';
import { PHYSICS } from '../input/physics.ts';
import type { Box } from '../../world/types.ts';
import { YES, avoidWalkingInto, canWalkOn, canWalkThroughClass, fullFloor, isClimbable, isStillWater } from './baritone/helper.ts'; // Track BB: the shared rule set
import { handUsable } from '../interact/use.ts'; // Track BB: iron doors / trapdoors are redstone only (UseSkill refuses them at run time)

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
/** Track BG: a trapdoor (open or closed) was classified (the planner's hatch moves run from then on). */
export const VARIETY_TRAPDOOR = 8;

/**
 * Track BG: an open trapdoor whose panel stands at one side of its cell (one box, full height, at most 0.25
 * thick): the body passes it like a ladder's thin box (decision 0048). Measured on BDS 1.26.60: it is not
 * climbed (not even right above a ladder), and minecraft-data's per-direction boxes match the server.
 */
export function isPanel(c: TerrainClass): boolean {
  if (c.openable !== 'trapdoor' || !c.open || c.boxes.length !== 1) return false;
  return thinPanel(c.boxes[0]!);
}

/** Track BG: a full-height box at most 0.25 thick along x or z (an open trapdoor's panel). */
function thinPanel(b: Box): boolean {
  if (b[1] > EPS || b[4] < 1 - EPS) return false;
  return b[3] - b[0] <= 0.25 + EPS || b[5] - b[2] <= 0.25 + EPS;
}

/**
 * Track BG: thin boxes let a cardinal walk along (dx, dz) enter (`enter`) or leave their cell through the
 * cell's centre (Track AJ's `climberLets` rule: a box on the far side when entering is fine, the body
 * stops in front of it; leaving towards it is not).
 */
function thinLets(boxes: readonly Box[], dx: number, dz: number, enter: boolean): boolean {
  const axis = dx !== 0 ? 0 : 2;
  const dir = dx + dz;
  for (const b of boxes) {
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

const toggledTrapdoors = new Map<string, readonly Box[]>();

/** Track BG: boxes of a trapdoor with `open_bit` flipped (minecraft-data's shape, else the donor's by name suffix). */
export function toggledTrapdoorBoxes(c: TerrainClass): readonly Box[] {
  const key = `${c.name}|${JSON.stringify(c.states)}`;
  let hit = toggledTrapdoors.get(key);
  if (!hit) {
    const states = { ...c.states, open_bit: c.open ? 0 : 1 };
    try {
      hit = blockInfoOf(c.name, states).boxes;
    } catch {
      hit = partialBoxes(c.name, states) ?? [[0, 0, 0, 1, 1, 1]];
    }
    toggledTrapdoors.set(key, hit);
  }
  return hit;
}

/** Track AJ: a block the body climbs on BDS 1.26.60 (terrain/query.ts CLIMBERS). Track BB: the helper's `isClimbable`. */
export const isClimber = (c: TerrainClass): boolean => isClimbable(c);
/** Track AJ: scaffolding (stood on unless sneaking, climbed by jump / sneak: not modelled; an obstacle). */
const isScaffold = (c: TerrainClass): boolean => c.name === 'scaffolding';
/**
 * Track AJ: the body may occupy the cell: no collision box (a climber's thin box aside), no liquid, no
 * hazard, no scaffolding. Track BB: Baritone's `canWalkThrough` class rule (nav/baritone/helper.ts); a
 * still water source answers MAYBE there and is entered by the swim moves only (`swim`). Track BG: an
 * open trapdoor's panel is a thin box like a ladder's (`isPanel`; the helper's rule is unchanged).
 */
const passable = (c: TerrainClass): boolean => canWalkThroughClass(c) === YES || isPanel(c);
/** Track AJ: water the body swims on: a source (or a waterlogged plant without depth), not a bubble column. Track BB: helper `isStillWater`. */
const stillWater = (c: TerrainClass): boolean => isStillWater(c);
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
    // Track BG: trapdoors; an open one's panel is a thin box the ladder checks (climberLets) look at
    if (c.openable === 'trapdoor') this.variety |= isPanel(c) ? VARIETY_TRAPDOOR | VARIETY_LADDER : VARIETY_TRAPDOOR;
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
      if (a.boxes.length || avoidWalkingInto(a)) return BLOCKED; // Track BB: helper avoidWalkingInto (liquids, hazards)
    }
    for (const [dx, dz] of SIDES) {
      const n = this.cls(x + dx, y, z + dz);
      if (!n) return UNKNOWN;
      // a still water neighbour is fine (the lane); lava, flowing water (a push the physics does not model) and hazards are not
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
    if (!c || !(isClimber(c) || isPanel(c)) || !c.boxes.length) return true; // Track BG: an open trapdoor's panel too
    return thinLets(c.boxes, dx, dz, enter);
  }

  /** Track AJ: the cell holds a climber with a collision box (a ladder). Track BG: or an open trapdoor's panel. */
  thinClimber(x: number, y: number, z: number): boolean {
    const c = this.cls(x, y, z);
    return !!c && ((isClimber(c) && c.boxes.length > 0) || isPanel(c));
  }

  // ---- Track BG: trapdoors in floors and ceilings (hatches; decision 0048) -----------------------------

  /**
   * Track BG: how the body passes vertically through trapdoor cell (x, y, z): CROSS_CLEAR (open: its panel
   * stands at one side and the 0.6-wide body fits beside it and beside a ladder's box above or below),
   * CROSS_TOGGLE (closed, opened by hand, and open it would be CROSS_CLEAR), CROSS_BLOCKED (not a trapdoor,
   * a closed iron one, no room). undefined = not loaded.
   */
  hatch(x: number, y: number, z: number): Crossing | undefined {
    const c = this.cls(x, y, z);
    if (!c) return undefined;
    if (c.openable !== 'trapdoor' || c.liquid || c.danger) return CROSS_BLOCKED;
    const open = c.open ? c.boxes : toggledTrapdoorBoxes(c);
    if (open.length !== 1 || !thinPanel(open[0]!) || !this.hatchRoom(x, y, z, open[0]!)) return CROSS_BLOCKED;
    if (c.open) return CROSS_CLEAR;
    return handUsable(c.name) ? CROSS_TOGGLE : CROSS_BLOCKED; // an iron trapdoor is redstone only
  }

  /** Track BG: the free width beside panel `b` and beside a ladder's box in the cells above / below fits the body (+0.02). */
  private hatchRoom(x: number, y: number, z: number, b: Box): boolean {
    for (const axis of [0, 2] as const) {
      let lo = 0;
      let hi = 1;
      const cut = (box: Box): void => {
        const a0 = axis === 0 ? box[0] : box[2];
        const a1 = axis === 0 ? box[3] : box[5];
        if (a1 - a0 > 0.5) return; // spans this axis: not a strip at one of its sides
        if (a0 < EPS) lo = Math.max(lo, a1);
        else if (a1 > 1 - EPS) hi = Math.min(hi, a0);
      };
      cut(b);
      for (const dy of [-1, 1]) {
        const n = this.cls(x, y + dy, z);
        if (n && isClimber(n)) for (const box of n.boxes) cut(box);
      }
      if (hi - lo < PHYSICS.width + 0.02) return false;
    }
    return true;
  }

  /**
   * Track BG: a cardinal walk along (dx, dz) entering (`enter`) or leaving trapdoor cell (x, y, z) is not
   * stopped by its panel once the trapdoor is open (its boxes now, or toggled when it is closed). True for
   * other cells.
   */
  hatchLets(x: number, y: number, z: number, dx: number, dz: number, enter: boolean): boolean {
    const c = this.cls(x, y, z);
    if (c?.openable !== 'trapdoor') return true;
    return thinLets(c.open ? c.boxes : toggledTrapdoorBoxes(c), dx, dz, enter);
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
    if (c.boxes.length && !(through && isPassage(c)) && !isClimber(c) && !isPanel(c)) { // Track BG: a panel is a thin box
      // a partial block in the cell itself is the floor (slab, carpet, snow layers, soul sand ...): Track BB helper canWalkOn
      if (!canWalkOn(c) || c.top >= 1) return BLOCKED;
      feet = y + c.top;
    } else {
      if (avoidWalkingInto(c)) return BLOCKED; // Track BB: liquids and hazards (magma, berry bushes, powder snow, fire ...)
      const below = this.cls(x, y - 1, z);
      if (!below) return UNKNOWN;
      if (!fullFloor(below)) return BLOCKED; // Track BB: a floor whose top is exactly 1 (helper fullFloor)
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
    if (c.boxes.length === 0) return avoidWalkingInto(c) ? CROSS_BLOCKED : CROSS_CLEAR; // Track BB
    if (!isPassage(c)) return CROSS_BLOCKED;
    const now = boxesAtCell(this.source, x, y, z, c) ?? c.boxes;
    if (!blocksCorridor(now, axis)) return CROSS_CLEAR;
    if (!handUsable(c.name)) return CROSS_BLOCKED; // Track BB: an iron door in the way cannot be opened by hand
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
