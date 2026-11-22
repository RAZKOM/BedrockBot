// Track EF1 (decision 0127, docs/pathfinding.md "A near walk has a bound"): how long a way a walk to something near is
// worth. A pickup or a stand cell by a tree that no short way reaches is not worth a search of the whole loaded world:
// the benchmark's wood runs spent 6 of every 10 seconds in such searches (135 000 to 200 000 nodes each, repeated while
// the navigator waited for far chunks), until each walk's timeout. Bounded (GotoOptions.maxWay), the search answers in a
// few ticks and the caller goes on (the next drop, a pillar, the next tree).
import type { Vec3 } from '../../world/types.ts';

/** The bound: at least `min` blocks of flat walking, else `factor` x the distance + `plus`. */
export const NEAR_WAY = Object.freeze({ min: 24, factor: 3, plus: 16 });

/** The `maxWay` (blocks of flat walking) for a walk from `from` to something at `to`. */
export function nearWay(from: Vec3, to: Vec3): number {
  const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  return Math.max(NEAR_WAY.min, Math.ceil(NEAR_WAY.factor * d + NEAR_WAY.plus));
}
