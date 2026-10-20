// Goals (PLAN.md section 4.3) as pathfinder predicates and heuristics.
import type { Vec3 } from '../../world/types.ts';

export type Goal = { type: 'block'; p: Vec3 } | { type: 'near'; p: Vec3; r: number } | { type: 'xz'; x: number; z: number };

const SQRT2 = Math.SQRT2;

/** Octile distance between columns: the cheapest horizontal walk cost (straight 1, diagonal sqrt 2). */
export function octile(dx: number, dz: number): number {
  const ax = Math.abs(dx);
  const az = Math.abs(dz);
  return ax > az ? ax + (SQRT2 - 1) * az : az + (SQRT2 - 1) * ax;
}

export interface GoalTest {
  /** The node (feet cell x, y, z with feet height) satisfies the goal. */
  done(x: number, y: number, z: number, feet: number): boolean;
  /** Admissible estimate of the remaining cost. */
  h(x: number, y: number, z: number): number;
}

export function goalTest(goal: Goal): GoalTest {
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
  }
}
