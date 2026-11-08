// Track R1 (docs/pathfinding.md "Reachability (Track R1)"; decisions/0072-reachability.md): the reachability
// oracle. An exhaustive search, with no time or node limit, over the navigator's move set at the cell level,
// written apart from the planner (nav/astar.ts, nav/grid.ts and baritone/*) on purpose: it reads the bench's
// voxel palette (vox.ts), not the terrain classes, so a planner bug cannot hide itself. It answers "can the body
// get from this feet cell to that one" under the owner's rules, and with each rule relaxed in turn, which tells a
// world that is closed (a) from a rule that closes it (b) and names the rule.
//
// The moves (what the navigator can do on a `!goto`, docs/pathfinding.md "Nodes and moves"):
//   walk      to the next cell at the same level (a door on the way is opened)
//   jump      one block up, the head room over the start free
//   drop      down: the two cells ahead free, then the fall to the first floor (no damage within 3 blocks;
//             deeper drops onto a floor within the fall budget; into water only within 3 blocks)
//   swim      on still water's surface (2 free cells over it), down into it, across it, out onto a bank at the
//             water level or one higher; dive under water within the air budget, up, down, across, out
//   dig       Baritone's traverse / ascend / descend through cells the break rules allow, `digBudget` cells a goto
//             at most; the dig-out of the water (the lip and the head room over it)
//   parkour   over a gap of 1 or 2 cells (water or a floor within 3 under it) to a floor at the level or 1 lower
//   pillar    (only with the place rule relaxed: `!goto` never places) jump and place a block under the feet
// The break rules: natural terrain only (palette), a break of at most `maxBreakTicks` with the best tool, never
// in the protected sphere, never the floor of the move, no liquid beside the cell, no gravity block over it or
// unsupported beside it, no ascend under a gravity block 3 over the start.
import { breakTicks } from '../../dig/breakTime.ts';
import { fallDamage } from '../../fall/damage.ts';
import type { Vec3 } from '../../../world/types.ts';
import { MIN_Y, V, VOX_BLOCKS, type Vox, doorAxis, isBuiltVox, isDoor, isDoorLower, isGravityVox, isLiquid, isNaturalVox, isSolid } from './vox.ts';

/** The owner's rules the oracle can relax one at a time (`OracleRules`). */
export type RuleName = 'protected_area' | 'built' | 'liquid' | 'gravity' | 'falls' | 'dig_budget' | 'place';
export const RULE_NAMES: readonly RuleName[] = ['protected_area', 'built', 'liquid', 'gravity', 'falls', 'dig_budget', 'place'];

export interface OracleRules {
  /** Cells a goto may dig in all (the dig way's budget, DIG_WAY_MAX_BLOCKS 12). */
  digBudget: number;
  /** Slowest break the dig way takes (DIG_WAY_MAX_TICKS 200); the dig-out from water has the same limit with the x5 water factor. */
  maxBreakTicks: number;
  /** Built blocks may be broken (relaxed `built`). */
  builtBreakable: boolean;
  /** The base: no cell within r of (x, y, z) (block centres) is dug. */
  protect: { x: number; y: number; z: number; r: number } | undefined;
  /** No cell with a liquid beside it is dug. */
  liquidRule: boolean;
  /** No cell under a gravity block (or beside an unsupported one) is dug, no ascend under one. */
  gravityRule: boolean;
  /** HP all the falls of a trip may cost together (health - fallMargin = 12; relaxed: anything that does not kill). */
  fallBudget: number;
  /** Pillar up (relaxed `place`). */
  place: boolean;
  /** Ticks the head may stay under water in one stretch ((AIR_MAX - AIR_KEEP) / AIR_MARGIN). */
  airBudget: number;
  /** The hotbar the break times are read with (best tool per block; empty = the hand). */
  tools: readonly string[];
}

export const OWNER_RULES: Readonly<OracleRules> = Object.freeze({
  digBudget: 12,
  maxBreakTicks: 200,
  builtBreakable: false,
  protect: undefined,
  liquidRule: true,
  gravityRule: true,
  fallBudget: 12,
  place: false,
  airBudget: (300 - 110) / 1.5,
  tools: [],
});

/** The rules with one relaxed. */
export function relaxed(r: OracleRules, rule: RuleName): OracleRules {
  switch (rule) {
    case 'protected_area':
      return { ...r, protect: undefined };
    case 'built':
      return { ...r, builtBreakable: true };
    case 'liquid':
      return { ...r, liquidRule: false };
    case 'gravity':
      return { ...r, gravityRule: false };
    case 'falls':
      return { ...r, fallBudget: 19 };
    case 'dig_budget':
      return { ...r, digBudget: 4096, maxBreakTicks: 100_000 };
    case 'place':
      return { ...r, place: true };
  }
}

export function relaxedAll(r: OracleRules): OracleRules {
  let o = r;
  for (const n of RULE_NAMES) o = relaxed(o, n);
  return o;
}

const MODE_LAND = 0;
const MODE_SWIM = 1;
const MODE_DIVE = 2;
const MODE_DOOR = 3;

/** One step of a witness path. */
export interface OracleStep {
  x: number;
  y: number;
  z: number;
  mode: 'land' | 'swim' | 'dive' | 'door';
  move: string;
  dug: number;
  dmg: number;
}

export interface OracleResult {
  reachable: boolean;
  /** States expanded. */
  expanded: number;
  /** The witness (start first) when reachable. */
  path?: OracleStep[];
  /** Totals along the witness. */
  dug?: number;
  dmg?: number;
}

export interface OracleOptions {
  /** Only cells with x / z in this box are searched (the dig search of a long trip; default the whole world). */
  box?: { x0: number; z0: number; x1: number; z1: number };
  /** Give up (reachable false, `capped` true) after this many expansions (default unlimited). */
  maxExpanded?: number;
  /** Keep the witness path (default true). */
  witness?: boolean;
}

const CARD: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const MODES = ['land', 'swim', 'dive', 'door'] as const;
/** Ticks of the moves under water (nav/costs.ts: dive 10.5 a block across, diveUp 8, diveDown 6). */
const DIVE_ACROSS = 10.5;
const DIVE_UP = 8;
const DIVE_DOWN = 6;
const LONG_DROP_SCAN = 48;

/**
 * The search. States are (cell, mode) with labels (dug, dmg, wet): a bucket queue on `dug` (fewest dug cells
 * first), each state keeping the non-dominated (dmg, wet) pairs it was reached with, so a cheaper way in HP or
 * air is never pruned by one with fewer digs.
 */
export function oracle(vox: Vox, start: Vec3, goal: Vec3, rules: OracleRules, opts: OracleOptions = {}): OracleResult & { capped?: boolean } {
  const o = new Oracle(vox, rules, opts.box);
  return o.run(start, goal, opts.maxExpanded ?? Infinity, opts.witness ?? true);
}

interface Label {
  key: number;
  dug: number;
  dmg: number;
  wet: number;
  parent: Label | undefined;
  move: string;
  /** Cells (Vox.index) the move into this label dug. */
  digs?: number[];
}

class Oracle {
  private readonly v: Vox;
  private readonly r: OracleRules;
  private readonly box: { x0: number; z0: number; x1: number; z1: number };
  private readonly ticksCache = new Map<number, number>();
  private readonly seen = new Map<number, number[]>();
  private readonly buckets: Label[][] = [];
  private goalFloor: [number, number, number] = [Number.NaN, Number.NaN, Number.NaN];
  private lastDug: number[] = [];

  constructor(vox: Vox, rules: OracleRules, box?: { x0: number; z0: number; x1: number; z1: number }) {
    this.v = vox;
    this.r = rules;
    this.box = box ?? { x0: 0, z0: 0, x1: vox.sx - 1, z1: vox.sz - 1 };
  }

  private id(x: number, y: number, z: number): number {
    if (x < this.box.x0 || x > this.box.x1 || z < this.box.z0 || z > this.box.z1) return -1;
    return this.v.get(x, y, z);
  }

  /** Free for the body: air (a door only through `MODE_DOOR`). */
  private free(x: number, y: number, z: number): boolean {
    return this.id(x, y, z) === V.air;
  }

  /** A land node: feet and head cells air, a full block under the feet. */
  private stand(x: number, y: number, z: number): boolean {
    return this.free(x, y, z) && this.free(x, y + 1, z) && isSolid(this.id(x, y - 1, z));
  }

  /** A doorway node: the door's lower half in the feet cell, its upper half over it, a full block under it. */
  private doorNode(x: number, y: number, z: number): boolean {
    const id = this.id(x, y, z);
    return isDoorLower(id) && isDoor(this.id(x, y + 1, z)) && isSolid(this.id(x, y - 1, z));
  }

  /** A surface swim node: still water in the feet cell, air in the two cells over it, no lava beside it. */
  private swim(x: number, y: number, z: number): boolean {
    if (this.id(x, y, z) !== V.water || !this.free(x, y + 1, z) || !this.free(x, y + 2, z)) return false;
    for (const [dx, dz] of CARD) if (this.id(x + dx, y, z + dz) === V.lava) return false;
    return true;
  }

  /** A dive node: water in the feet cell, water or air in the head cell, not a swim node. */
  private dive(x: number, y: number, z: number): boolean {
    if (this.id(x, y, z) !== V.water) return false;
    const h = this.id(x, y + 1, z);
    if (h !== V.water && h !== V.air) return false;
    return !this.swim(x, y, z);
  }

  /** The head is under water (the air runs down). */
  private submerged(x: number, y: number, z: number): boolean {
    return this.id(x, y, z) === V.water && this.id(x, y + 1, z) === V.water;
  }

  private breakTicksOf(id: number): number {
    const hit = this.ticksCache.get(id);
    if (hit !== undefined) return hit;
    const name = VOX_BLOCKS[id]![0];
    let best = breakTicks(name, null) ?? Infinity;
    for (const t of this.r.tools) best = Math.min(best, breakTicks(name, t) ?? Infinity);
    this.ticksCache.set(id, best);
    return best;
  }

  /**
   * Cell (x, y, z) may be dug (the break rules), with `floors` the move's floors, `factor` on the break time (5
   * from the water). Air is not "dug" (the caller skips it).
   */
  private breakable(x: number, y: number, z: number, floors: readonly (readonly [number, number, number])[], factor = 1): boolean {
    const id = this.id(x, y, z);
    if (id <= 0 || isLiquid(id) || id === V.bedrock) return false;
    if (isBuiltVox(id)) {
      if (!this.r.builtBreakable) return false;
    } else if (!isNaturalVox(id) && this.r.maxBreakTicks < 100_000) return false; // obsidian: natural to the rules, never in time
    // the goal's floor is never dug (the navigator keeps it: nav/navigator.ts goto)
    if (x === this.goalFloor[0] && y === this.goalFloor[1] && z === this.goalFloor[2]) return false;
    const p = this.r.protect;
    if (p && Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y, z + 0.5 - p.z) <= p.r) return false;
    for (const [fx, fy, fz] of floors) if (fx === x && fy === y && fz === z) return false;
    if (this.r.liquidRule) {
      for (const [dx, dy, dz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ] as const) {
        const n = this.id(x + dx, y + dy, z + dz);
        if (n < 0 || isLiquid(n)) return false;
      }
    }
    if (this.r.gravityRule) {
      if (isGravityVox(this.id(x, y + 1, z))) return false;
      for (const [dx, dz] of CARD) if (isGravityVox(this.id(x + dx, y, z + dz)) && this.id(x + dx, y - 1, z + dz) === V.air) return false;
    }
    const t = this.breakTicksOf(id) * factor;
    return t <= this.r.maxBreakTicks;
  }

  /** Cells to dig for a move through `cells` (each air or breakable), or -1 when one is refused. */
  private digCount(cells: readonly (readonly [number, number, number])[], floors: readonly (readonly [number, number, number])[], factor = 1): number {
    const dug: number[] = [];
    for (const [x, y, z] of cells) {
      const id = this.id(x, y, z);
      if (id === V.air) continue;
      if (!this.breakable(x, y, z, floors, factor)) return -1;
      dug.push(this.v.index(x, y, z));
    }
    this.lastDug = dug;
    return dug.length;
  }

  /** A cell dug by a move on the way to `l` (it is air when the body gets there: never a floor). */
  private dugOnTheWay(l: Label | undefined, cell: number): boolean {
    for (let c = l; c && c.dug > 0; c = c.parent) if (c.digs?.includes(cell)) return true;
    return false;
  }

  private key(x: number, y: number, z: number, mode: number): number {
    return this.v.index(x, y, z) * 4 + mode;
  }

  private decode(key: number): [number, number, number, number] {
    const mode = key % 4;
    let i = (key - mode) / 4;
    const x = i % this.v.sx;
    i = (i - x) / this.v.sx;
    const z = i % this.v.sz;
    const y = (i - z) / this.v.sz + MIN_Y;
    return [x, y, z, mode];
  }

  private push(parent: Label | undefined, x: number, y: number, z: number, mode: number, dug: number, dmg: number, wet: number, move: string, digs?: number[]): void {
    if (dug > this.r.digBudget || dmg > this.r.fallBudget || wet > this.r.airBudget) return;
    // a floor dug earlier on the way is air (the witness must be walkable as the world will be)
    if ((mode === MODE_LAND || mode === MODE_DOOR) && parent && parent.dug > 0 && this.dugOnTheWay(parent, this.v.index(x, y - 1, z))) return;
    const key = this.key(x, y, z, mode);
    const labels = this.seen.get(key);
    if (labels) {
      // a label already queued with no more dug cells, HP and air spent dominates
      for (let i = 0; i < labels.length; i += 3) if (labels[i]! <= dug && labels[i + 1]! <= dmg && labels[i + 2]! <= wet) return;
      labels.push(dug, dmg, wet);
    } else this.seen.set(key, [dug, dmg, wet]);
    (this.buckets[dug] ??= []).push({ key, dug, dmg, wet, parent, move, ...(digs ? { digs } : {}) });
  }

  run(start: Vec3, goal: Vec3, maxExpanded: number, witness: boolean): OracleResult & { capped?: boolean } {
    const sx = Math.floor(start.x);
    const sy = Math.floor(start.y);
    const sz = Math.floor(start.z);
    const gx = Math.floor(goal.x);
    const gy = Math.floor(goal.y);
    const gz = Math.floor(goal.z);
    this.goalFloor = [gx, gy - 1, gz];
    if (this.stand(sx, sy, sz)) this.push(undefined, sx, sy, sz, MODE_LAND, 0, 0, 0, 'start');
    else if (this.swim(sx, sy, sz)) this.push(undefined, sx, sy, sz, MODE_SWIM, 0, 0, 0, 'start');
    else if (this.dive(sx, sy, sz)) this.push(undefined, sx, sy, sz, MODE_DIVE, 0, 0, 0, 'start');
    let expanded = 0;
    for (let b = 0; b < this.buckets.length; b++) {
      const q = this.buckets[b];
      if (!q) continue;
      for (const l of q) {
        const [x, y, z, mode] = this.decode(l.key);
        if (x === gx && y === gy && z === gz && (mode !== MODE_DIVE || l.wet + this.riseTicks(x, y, z) <= this.r.airBudget)) return this.done(l, expanded, witness);
        if (++expanded > maxExpanded) return { reachable: false, expanded, capped: true };
        this.expand(l, x, y, z, mode);
      }
      this.buckets[b] = [];
    }
    return { reachable: false, expanded };
  }

  private done(l: Label, expanded: number, witness: boolean): OracleResult {
    const res: OracleResult = { reachable: true, expanded, dug: l.dug, dmg: l.dmg };
    if (witness) {
      const path: OracleStep[] = [];
      for (let c: Label | undefined = l; c; c = c.parent) {
        const [x, y, z, mode] = this.decode(c.key);
        path.push({ x, y, z, mode: MODES[mode]!, move: c.move, dug: c.dug, dmg: c.dmg });
      }
      res.path = path.reverse();
    }
    return res;
  }

  /** Ticks from a dive node straight up to air (the column of water over it); Infinity when the column ends in anything but air (a flooded cave's roof). */
  private riseTicks(x: number, y: number, z: number): number {
    let k = 0;
    while (this.id(x, y + 1 + k, z) === V.water) k++;
    return this.id(x, y + 1 + k, z) === V.air ? k * DIVE_UP : Infinity;
  }

  /** Into water cell (x, y, z) from land: a swim or a dive node. */
  private enterWater(l: Label, x: number, y: number, z: number, move: string): void {
    if (this.swim(x, y, z)) this.push(l, x, y, z, MODE_SWIM, l.dug, l.dmg, 0, move);
    else if (this.dive(x, y, z)) this.push(l, x, y, z, MODE_DIVE, l.dug, l.dmg, this.submerged(x, y, z) ? DIVE_ACROSS : 0, move);
  }

  /** Out of the water onto a bank at y or y + 1 (the body rises with the head room over the start). */
  private outOfWater(l: Label, x: number, y: number, z: number, nx: number, nz: number): void {
    if (this.stand(nx, y, nz)) this.push(l, nx, y, nz, MODE_LAND, l.dug, l.dmg, 0, 'swimOut');
    else if (this.stand(nx, y + 1, nz) && (this.free(x, y + 1, z) || this.id(x, y + 1, z) === V.water)) this.push(l, nx, y + 1, nz, MODE_LAND, l.dug, l.dmg, 0, 'swimOut');
  }

  private underwater(l: Label, x: number, y: number, z: number, ticks: number, move: string): void {
    if (this.swim(x, y, z)) this.push(l, x, y, z, MODE_SWIM, l.dug, l.dmg, 0, move);
    else if (this.dive(x, y, z)) this.push(l, x, y, z, MODE_DIVE, l.dug, l.dmg, this.submerged(x, y, z) ? l.wet + ticks : 0, move);
  }

  private expand(l: Label, x: number, y: number, z: number, mode: number): void {
    if (mode === MODE_SWIM) {
      for (const [dx, dz] of CARD) {
        const nx = x + dx;
        const nz = z + dz;
        this.underwater(l, nx, y, nz, DIVE_ACROSS, 'swim');
        this.outOfWater(l, x, y, z, nx, nz);
        this.digOut(l, x, y, z, nx, nz);
      }
      this.underwater(l, x, y - 1, z, DIVE_DOWN, 'diveDown');
      return;
    }
    if (mode === MODE_DIVE) {
      for (const [dx, dz] of CARD) {
        const nx = x + dx;
        const nz = z + dz;
        this.underwater(l, nx, y, nz, DIVE_ACROSS, 'dive');
        this.outOfWater(l, x, y, z, nx, nz);
      }
      this.underwater(l, x, y + 1, z, DIVE_UP, 'diveUp');
      this.underwater(l, x, y - 1, z, DIVE_DOWN, 'diveDown');
      return;
    }
    if (mode === MODE_DOOR) {
      const axis = doorAxis(this.id(x, y, z));
      for (const s of [1, -1]) {
        const nx = axis === 0 ? x + s : x;
        const nz = axis === 2 ? z + s : z;
        if (this.stand(nx, y, nz)) this.push(l, nx, y, nz, MODE_LAND, l.dug, l.dmg, 0, 'door');
        else if (this.doorNode(nx, y, nz) && doorAxis(this.id(nx, y, nz)) === axis) this.push(l, nx, y, nz, MODE_DOOR, l.dug, l.dmg, 0, 'door');
      }
      return;
    }
    // land
    const dig = l.dug < this.r.digBudget;
    for (const [dx, dz] of CARD) {
      const nx = x + dx;
      const nz = z + dz;
      // (the dig moves below run whatever the plain moves found: a descend digs down beside a plain walk)
      if (this.stand(nx, y, nz)) this.push(l, nx, y, nz, MODE_LAND, l.dug, l.dmg, 0, 'walk');
      else if (this.doorNode(nx, y, nz) && doorAxis(this.id(nx, y, nz)) === (dx !== 0 ? 0 : 2)) this.push(l, nx, y, nz, MODE_DOOR, l.dug, l.dmg, 0, 'door');
      // the jump: one up, the head room over the start
      if (this.stand(nx, y + 1, nz) && this.free(x, y + 2, z)) this.push(l, nx, y + 1, nz, MODE_LAND, l.dug, l.dmg, 0, 'jump');
      const ahead = this.id(nx, y, nz);
      if (ahead === V.water && (this.free(nx, y + 1, nz) || this.id(nx, y + 1, nz) === V.water)) this.enterWater(l, nx, y, nz, 'swimIn');
      if (ahead === V.air && this.free(nx, y + 1, nz)) {
        this.drop(l, y, nx, nz);
        this.parkour(l, x, y, z, dx, dz, 1);
        this.parkour(l, x, y, z, dx, dz, 2);
      }
      if (dig) this.digMoves(l, x, y, z, nx, nz);
    }
    if (this.r.place && this.free(x, y + 2, z)) this.push(l, x, y + 1, z, MODE_LAND, l.dug, l.dmg, 0, 'pillar');
  }

  /**
   * The jump over a gap of g = 1 or 2 cells to a floor g + 1 out at the same level or one lower: the gap cells
   * free from the feet to the jump's head height (y + 3) with no floor at the feet level, water or a floor at
   * most 3 blocks under the takeoff below each (never lava), the head room over the takeoff, a run-up of 2
   * standable cells behind it for g = 2, and the cell after the landing a floor or a wall (it stops the run).
   */
  private parkour(l: Label, x: number, y: number, z: number, dx: number, dz: number, g: 1 | 2): void {
    if (!this.free(x, y + 2, z) || !this.free(x, y + 3, z)) return;
    if (g === 2 && !(this.stand(x - dx, y, z - dz) && this.stand(x - 2 * dx, y, z - 2 * dz))) return;
    for (let k = 1; k <= g; k++) {
      const gx = x + k * dx;
      const gz = z + k * dz;
      for (let yy = y; yy <= y + 3; yy++) if (!this.free(gx, yy, gz)) return;
      if (this.id(gx, y - 1, gz) !== V.air) return; // a floor at the feet level: a walk, not a gap
      let safe = false;
      for (let d = 0; d <= 4; d++) {
        const id = this.id(gx, y - 1 - d, gz);
        if (id === V.lava || id < 0) return;
        if (id === V.water) {
          safe = true;
          break;
        }
        if (id !== V.air) {
          safe = d <= 3;
          break;
        }
      }
      if (!safe) return;
    }
    const lx = x + (g + 1) * dx;
    const lz = z + (g + 1) * dz;
    for (let ny = y; ny >= y - 1; ny--) {
      if (!this.stand(lx, ny, lz)) continue;
      for (let yy = ny + 2; yy <= y + 3; yy++) if (!this.free(lx, yy, lz)) return;
      const ox = lx + dx;
      const oz = lz + dz;
      const stops = this.stand(ox, ny, oz) || (isSolid(this.id(ox, ny, oz)) && isSolid(this.id(ox, ny + 1, oz)));
      if (stops) this.push(l, lx, ny, lz, MODE_LAND, l.dug, l.dmg, 0, `parkour${g}`);
      return;
    }
  }

  /** The fall from the feet level y in column (nx, nz) (its two cells free). */
  private drop(l: Label, y: number, nx: number, nz: number): void {
    for (let d = 1; d <= LONG_DROP_SCAN; d++) {
      const ny = y - d;
      const id = this.id(nx, ny, nz);
      if (id === V.air) {
        if (this.stand(nx, ny, nz)) {
          const dmg = fallDamage(d, VOX_BLOCKS[this.id(nx, ny - 1, nz)]![0]);
          this.push(l, nx, ny, nz, MODE_LAND, l.dug, l.dmg + dmg, 0, d <= 3 ? 'drop' : `fall${d}`);
          return;
        }
        continue;
      }
      if (id === V.water && d <= 3) this.enterWater(l, nx, ny, nz, 'dropIn');
      return;
    }
  }

  private digMoves(l: Label, x: number, y: number, z: number, nx: number, nz: number): void {
    // traverse: the floor ahead a full block, its two body cells dug
    if (isSolid(this.id(nx, y - 1, nz))) {
      const n = this.digCount(
        [
          [nx, y, nz],
          [nx, y + 1, nz],
        ],
        [
          [x, y - 1, z],
          [nx, y - 1, nz],
        ],
      );
      if (n > 0) this.push(l, nx, y, nz, MODE_LAND, l.dug + n, l.dmg, 0, 'digWalk', this.lastDug);
    }
    // ascend: onto the full block ahead, the head room over the start and the two cells over that block dug
    if (isSolid(this.id(nx, y, nz)) && !(this.r.gravityRule && isGravityVox(this.id(x, y + 3, z)))) {
      const n = this.digCount(
        [
          [x, y + 2, z],
          [nx, y + 1, nz],
          [nx, y + 2, nz],
        ],
        [
          [x, y - 1, z],
          [nx, y, nz],
        ],
      );
      if (n > 0) this.push(l, nx, y + 1, nz, MODE_LAND, l.dug + n, l.dmg, 0, 'digUp', this.lastDug);
    }
    // descend: one down ahead, the floor two under the feet level a full block, the column's three cells dug
    if (isSolid(this.id(nx, y - 2, nz))) {
      const n = this.digCount(
        [
          [nx, y + 1, nz],
          [nx, y, nz],
          [nx, y - 1, nz],
        ],
        [
          [x, y - 1, z],
          [nx, y - 2, nz],
        ],
      );
      if (n > 0) this.push(l, nx, y - 1, nz, MODE_LAND, l.dug + n, l.dmg, 0, 'digDown', this.lastDug);
    }
  }

  /** Out of the water over a lip: the lip block a floor at the water level, the two cells over it dug (x5 from the water). */
  private digOut(l: Label, _x: number, y: number, _z: number, nx: number, nz: number): void {
    if (l.dug >= this.r.digBudget || !isSolid(this.id(nx, y, nz))) return;
    const n = this.digCount(
      [
        [nx, y + 2, nz],
        [nx, y + 1, nz],
      ],
      [[nx, y, nz]],
      5,
    );
    if (n > 0) this.push(l, nx, y + 1, nz, MODE_LAND, l.dug + n, l.dmg, 0, 'digOut', this.lastDug);
  }
}

/** The oracle's verdict on a pair: the class of an unreachable goal and the rule(s) that close it. */
export interface Verdict {
  /** 'reachable': under the owner's rules; 'rule': only with a rule relaxed (class b); 'world': not even with all relaxed (class a). */
  verdict: 'reachable' | 'rule' | 'world';
  /** The plain walk (no dig, no hurting fall) gets there. */
  plain: boolean;
  /** Rules each of which, relaxed alone, opens the way (class b); empty with 'rule' = only all of them together. */
  rules: RuleName[];
  /** Totals of the owner's-rules witness. */
  dug?: number;
  dmg?: number;
  /** The owner's-rules witness, when reachable. */
  path?: OracleStep[];
  expanded: number;
  ms: number;
}

/**
 * The verdict: the plain walk first (cheap), then the owner's rules, then each rule relaxed alone, then all.
 * `digBox` bounds the digging searches (cells within `margin` of the start / goal box; default the world).
 */
export function verdict(vox: Vox, start: Vec3, goal: Vec3, rules: OracleRules, opts: { margin?: number } = {}): Verdict {
  const t0 = performance.now();
  const plainRules: OracleRules = { ...rules, digBudget: 0, fallBudget: 0 };
  const p = oracle(vox, start, goal, plainRules);
  let expanded = p.expanded;
  const ms = (): number => +(performance.now() - t0).toFixed(1);
  if (p.reachable) return { verdict: 'reachable', plain: true, rules: [], dug: 0, dmg: 0, ...(p.path ? { path: p.path } : {}), expanded, ms: ms() };
  const m = opts.margin;
  const box =
    m === undefined
      ? undefined
      : { x0: Math.min(start.x, goal.x) - m, z0: Math.min(start.z, goal.z) - m, x1: Math.max(start.x, goal.x) + m, z1: Math.max(start.z, goal.z) + m };
  const own = oracle(vox, start, goal, rules, box ? { box } : {});
  expanded += own.expanded;
  if (own.reachable) return { verdict: 'reachable', plain: false, rules: [], dug: own.dug!, dmg: own.dmg!, ...(own.path ? { path: own.path } : {}), expanded, ms: ms() };
  const open: RuleName[] = [];
  for (const n of RULE_NAMES) {
    if (n === 'protected_area' && !rules.protect) continue;
    const r = oracle(vox, start, goal, relaxed(rules, n), { ...(box ? { box } : {}), witness: false });
    expanded += r.expanded;
    if (r.reachable) open.push(n);
  }
  if (open.length) return { verdict: 'rule', plain: false, rules: open, expanded, ms: ms() };
  const all = oracle(vox, start, goal, relaxedAll(rules), { ...(box ? { box } : {}), witness: false });
  expanded += all.expanded;
  return { verdict: all.reachable ? 'rule' : 'world', plain: false, rules: [], expanded, ms: ms() };
}
