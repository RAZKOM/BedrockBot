// Goals (PLAN.md section 4.3, task 7.10) as pathfinder predicates and heuristics. See
// docs/pathfinding.md "Goals".
//
//   block       stand in the cell                       near     feet within r of a point
//   xz          any cell of the column                  any      the first of several goals (OR)
//   getToBlock  stand next to a block, in reach, a visible face if it has one (dig, chest, door)
//   yLevel      any cell with the feet at that y        runAway  at least r away from point(s)
//   surface     sky above the head and not in a pit (`!top`)
//
// `Goal` stays the three basic goals of PLAN.md 4.3 (callers that switch over it stay exhaustive);
// `NavGoal` is everything `Navigator.goto` accepts.
import type { Vec3 } from '../../world/types.ts';
import { checkReach, EYE_HEIGHT } from '../dig/look.ts';
import { PHYSICS } from '../input/physics.ts';
import type { TerrainClass } from '../terrain/classify.ts';

export type Goal = { type: 'block'; p: Vec3 } | { type: 'near'; p: Vec3; r: number } | { type: 'xz'; x: number; z: number };

/** Composite OR: done at the first member that is done; heuristic = min over the members. */
export interface AnyGoal {
  type: 'any';
  goals: readonly NavGoal[];
}

/**
 * Stand in a cell next to block `p` (Baritone's GoalGetToBlock plus the diagonals: one of the 8
 * columns around it with the block at the feet or the head, on top of it, or 2 below it) with the
 * block within `reach` (eye to the closest point, plus the server's corner limit: docs/digging.md)
 * and, when the block has an exposed face at all, an exposed face turned to the eye (from a
 * diagonal the eye sees two side faces, which walls or glass may cover).
 */
export interface GetToBlockGoal {
  type: 'getToBlock';
  p: Vec3;
  /** Default 4.5. */
  reach?: number;
  /** Require a visible face when the block has one. Default true. */
  face?: boolean;
  /** Track AN: a side cell's feet may be up to this many blocks below p (a chest on a shelf or a pillar above the head; reach still decides). Default 1: p at the feet or the head. */
  low?: number;
}

/** Any cell with the feet cell at `y`, nearest first. */
export interface YLevelGoal {
  type: 'yLevel';
  y: number;
}

export type Threat = Vec3 | readonly Vec3[];

/**
 * At least `r` blocks (horizontally, from the cell centre) from every threat. `from` may be a
 * function (an entity's current position): it is read again for every plan, and a goto that
 * arrives while the threat has followed plans on.
 */
export interface RunAwayGoal {
  type: 'runAway';
  from: Threat | (() => Threat | undefined);
  r: number;
}

/** Sky above the head, and the feet no more than a step (0.5625) below the local ground (the 25th percentile of the 7 x 7 column tops around): out of caves and pits. */
export interface SurfaceGoal {
  type: 'surface';
}

export type NavGoal = Goal | AnyGoal | GetToBlockGoal | YLevelGoal | RunAwayGoal | SurfaceGoal;

const SQRT2 = Math.SQRT2;
export const DEFAULT_GET_TO_REACH = 4.5;
/** Feet within a step (0.5625: slabs, carpets) below the local ground count as on the surface. */
const SURFACE_SLACK = PHYSICS.stepHeight;
const SURFACE_RADIUS = 3;

/** Octile distance between columns: the cheapest horizontal walk cost (straight 1, diagonal sqrt 2). */
export function octile(dx: number, dz: number): number {
  const ax = Math.abs(dx);
  const az = Math.abs(dz);
  return ax > az ? ax + (SQRT2 - 1) * az : az + (SQRT2 - 1) * ax;
}

/** What goals read from the grid (NavGrid has both). */
export interface GoalGrid {
  cls(x: number, y: number, z: number): TerrainClass | undefined;
  skyTop(x: number, z: number): number | undefined;
}

export interface GoalTest {
  /** The node (feet cell x, y, z with feet height) satisfies the goal. */
  done(x: number, y: number, z: number, feet: number): boolean;
  /** Admissible estimate of the remaining cost (blocks; the search multiplies by costs.walk). */
  h(x: number, y: number, z: number): number;
  /** `any`: index of the first member done at this node (-1 when none). */
  member?(x: number, y: number, z: number, feet: number): number;
}

const cell = (p: Vec3) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** Threat positions of a runAway goal now (a function is called). */
export function threatsOf(goal: RunAwayGoal): Vec3[] {
  const t = typeof goal.from === 'function' ? goal.from() : goal.from;
  if (!t) return [];
  return Array.isArray(t) ? [...(t as readonly Vec3[])] : [t as Vec3];
}

export function goalTest(goal: NavGoal, grid?: GoalGrid): GoalTest {
  switch (goal.type) {
    case 'block': {
      const gx = Math.floor(goal.p.x);
      const gy = Math.floor(goal.p.y);
      const gz = Math.floor(goal.p.z);
      return {
        done: (x, y, z) => x === gx && y === gy && z === gz,
        h: (x, _y, z) => octile(gx - x, gz - z),
      };
    }
    case 'xz': {
      const gx = Math.floor(goal.x);
      const gz = Math.floor(goal.z);
      return {
        done: (x, _y, z) => x === gx && z === gz,
        h: (x, _y, z) => octile(gx - x, gz - z),
      };
    }
    case 'near': {
      const { p, r } = goal;
      return {
        done: (x, _y, z, feet) => Math.hypot(x + 0.5 - p.x, feet - p.y, z + 0.5 - p.z) <= r,
        h: (x, _y, z) => Math.max(0, octile(p.x - (x + 0.5), p.z - (z + 0.5)) - r),
      };
    }
    case 'any': {
      const members = goal.goals.map((g) => goalTest(g, grid));
      const member = (x: number, y: number, z: number, feet: number): number => members.findIndex((m) => m.done(x, y, z, feet));
      return {
        done: (x, y, z, feet) => member(x, y, z, feet) >= 0,
        h: (x, y, z) => {
          let best = Infinity;
          for (const m of members) best = Math.min(best, m.h(x, y, z));
          return best === Infinity ? 0 : best;
        },
        member,
      };
    }
    case 'getToBlock':
      return getToBlockTest(goal, grid);
    case 'yLevel': {
      const gy = Math.floor(goal.y);
      return {
        done: (_x, y) => y === gy,
        h: (_x, y) => Math.abs(gy - y),
      };
    }
    case 'runAway': {
      const threats = threatsOf(goal);
      const r = goal.r;
      const minDist = (x: number, z: number): number => {
        let d = Infinity;
        for (const t of threats) d = Math.min(d, Math.hypot(x + 0.5 - t.x, z + 0.5 - t.z));
        return d;
      };
      return {
        done: (x, _y, z) => minDist(x, z) >= r,
        h: (x, _y, z) => Math.max(0, r - minDist(x, z)),
      };
    }
    case 'surface':
      return surfaceTest(grid);
  }
}

function getToBlockTest(goal: GetToBlockGoal, grid: GoalGrid | undefined): GoalTest {
  const t = cell(goal.p);
  const reach = goal.reach ?? DEFAULT_GET_TO_REACH;
  const low = Math.max(1, goal.low ?? 1); // Track AN
  /** The face across which (dx, dy, dz) points is exposed: the neighbour is not a full cube. undefined = not loaded. */
  const open = (dx: number, dy: number, dz: number): boolean | undefined => {
    const c = grid?.cls(t.x + dx, t.y + dy, t.z + dz);
    if (!c) return undefined;
    return !c.fullCube;
  };
  let needFace: boolean | undefined;
  const wantFace = (): boolean => {
    if (needFace === undefined) {
      if (goal.face === false || !grid) needFace = false;
      else needFace = [open(1, 0, 0), open(-1, 0, 0), open(0, 1, 0), open(0, -1, 0), open(0, 0, 1), open(0, 0, -1)].some((v) => v === true);
    }
    return needFace;
  };
  return {
    done: (x, y, z, feet) => {
      const dx = x - t.x;
      const dz = z - t.z;
      const dy = y - t.y;
      if (Math.abs(dx) > 1 || Math.abs(dz) > 1) return false;
      if (dx === 0 && dz === 0) {
        if (dy !== 1 && dy !== -2) return false; // on top of it, or under it with the block above the head
      } else if (dy > 0 || dy < -low) {
        return false; // a side cell: the block at the feet or at the head
      }
      const eye = { x: x + 0.5, y: feet + EYE_HEIGHT, z: z + 0.5 };
      if (!checkReach(eye, t, reach).ok) return false;
      if (!wantFace()) return true;
      // an exposed face turned to the eye
      if (eye.x < t.x && open(-1, 0, 0)) return true;
      if (eye.x > t.x + 1 && open(1, 0, 0)) return true;
      if (eye.y < t.y && open(0, -1, 0)) return true;
      if (eye.y > t.y + 1 && open(0, 1, 0)) return true;
      if (eye.z < t.z && open(0, 0, -1)) return true;
      if (eye.z > t.z + 1 && open(0, 0, 1)) return true;
      return false;
    },
    h: (x, _y, z) => Math.max(0, octile(t.x - x, t.z - z) - SQRT2),
  };
}

/**
 * The local ground of column (x, z): feet height on top of the 25th percentile of the roof tops
 * (NavGrid.skyTop) in the 7 x 7 columns around. A 1 x 1 to 3 x 3 pit, a ravine floor or a cave are
 * below it; standing next to a cliff or a tree is not. undefined when fewer than 5 columns are known.
 */
export function localGround(grid: Pick<GoalGrid, 'skyTop'>, x: number, z: number, radius = SURFACE_RADIUS): number | undefined {
  const tops: number[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const top = grid.skyTop(x + dx, z + dz);
      if (top === undefined || top < -100_000) continue;
      tops.push(top);
    }
  }
  if (tops.length < 5) return undefined;
  tops.sort((a, b) => a - b);
  return tops[Math.floor(tops.length * 0.25)]! + 1;
}

function surfaceTest(grid: GoalGrid | undefined): GoalTest {
  const memo = new Map<number, number | null>();
  const ground = (x: number, z: number): number | undefined => {
    if (!grid) return undefined;
    const k = (x + 1048576) * 2097152 + (z + 1048576);
    let v = memo.get(k);
    if (v === undefined) {
      v = localGround(grid, x, z) ?? null;
      memo.set(k, v);
    }
    return v ?? undefined;
  };
  return {
    done: (x, _y, z, feet) => {
      if (!grid) return false;
      const top = grid.skyTop(x, z);
      if (top === undefined || top > Math.floor(feet + PHYSICS.height - 1e-6)) return false; // unknown, or a roof above the head
      const g = ground(x, z);
      return g === undefined || feet >= g - SURFACE_SLACK - 1e-6;
    },
    h: (x, y, z) => {
      const g = ground(x, z);
      return g === undefined ? 0 : Math.max(0, g - SURFACE_SLACK - y);
    },
  };
}
