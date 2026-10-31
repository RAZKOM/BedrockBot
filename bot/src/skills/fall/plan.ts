// Track BI (docs/pathfinding.md "Long falls"): the planner's drops deeper than `maxDrop` (3). nav/astar.ts
// calls `longDrops` for a cardinal neighbour whose column is free from the feet down past maxDrop (the
// plain drop found nothing to land on) when the search has a FallPolicy; the planner worker runs the
// same code. Per landing it takes the cheapest of:
//
//   harmless   the landing does no damage (hay up to 12 blocks, honey up to 6): the drop's ticks
//   damage     the damage (damage.ts, enchantments included) within hpBudget: + damage x hpCost
//   clutch     a damage drop the FallGuard will clutch (policy.ts clutchHelps: more than half the budget; a
//              water bucket in the hotbar, the landing block takes a clutch, the fall at most clutchMax,
//              outside the no-water area): + clutchCost + a quarter of the HP cost (the risk it fails).
//              Never beyond the budget: a failed clutch must not kill (review B1).
//
// Every long drop also pays the irreversible-drop penalty (as a trap: a partial path does not end at the
// bottom of it when the rim is as close). Never onto slime or a bed (the body bounces) and not into water
// (the follower's swim move holds forward through the fall; the reactive clutch and the water landing
// are the FallGuard's).
import { dropCost, type PathCosts } from '../nav/costs.ts';
import type { NavGrid } from '../nav/grid.ts';
import { fallDamage } from './damage.ts';
import { clutchHelps, type FallPolicy } from './policy.ts';
import { clutchTarget } from './waterlog.ts';

/** One long drop the planner may relax: into feet cell (x, y, z) of the scanned column. */
export interface LongDrop {
  y: number;
  feet: number;
  /** The drop's ticks (walk off, fall, land): the move's base cost. */
  base: number;
  /** HP cost or the clutch's ticks. */
  extra: number;
  /** The irreversible-drop penalty. */
  trap: number;
  /** How the fall is survived. */
  how: 'harmless' | 'clutch' | 'damage';
  /** Predicted damage (0 for a clutch). */
  damage: number;
}

const BOUNCY = new Set(['slime', 'bed']);

/**
 * Long drops from feet `f0` in cell level `cy` into column (x, z): appended to `out`. Returns true when the
 * scan reached unloaded world (the search's `sawUnknown`).
 */
export function longDrops(grid: NavGrid, costs: PathCosts, p: FallPolicy, x: number, cy: number, z: number, f0: number, out: LongDrop[]): boolean {
  // the plain drop's cells (cy - 1 .. cy - maxDrop) must be free with nothing to land on (cached in the grid)
  for (let d = 1; d <= costs.maxDrop; d++) {
    const f = grid.stand(x, cy - d, z);
    if (f === undefined) return true;
    if (!Number.isNaN(f) || grid.free(x, cy - d, z) !== true) return false;
  }
  for (let d = costs.maxDrop + 1; d <= p.maxScan; d++) {
    const y = cy - d;
    const f1 = grid.stand(x, y, z);
    if (f1 === undefined) return true;
    if (Number.isNaN(f1)) {
      if (grid.free(x, y, z) !== true) return false; // water, an obstacle, a hazard: no landing here
      if (grid.climbable(x, y, z) === true) return false; // a ladder / vine catches the body: no fall (the climb moves)
      continue;
    }
    const fall = f0 - f1;
    const own = f1 > y + 1e-6; // a partial floor in the feet cell (a bottom slab), else the block below
    const fy = own ? y : y - 1;
    const floor = grid.cls(x, fy, z);
    const name = floor?.name;
    if (name === undefined) return true;
    if (BOUNCY.has(name) || name.endsWith('_bed')) return false;
    const damage = fallDamage(fall, name, p.factor);
    const base = dropCost(costs, fall);
    let best: LongDrop | undefined;
    const take = (how: LongDrop['how'], extra: number, dmg: number): void => {
      if (!best || extra < best.extra) best = { y, feet: f1, base, extra, trap: costs.irreversibleDrop, how, damage: dmg };
    };
    if (damage <= 0) take('harmless', 0, 0);
    // the damage must fit the budget even with a bucket: a clutch only saves HP, never a life (it can fail)
    else if (damage <= p.hpBudget + 1e-9) {
      take('damage', damage * p.hpCost, damage);
      // the FallGuard clutches this fall by itself (clutchHelps): priced as the clutch plus a quarter of the HP
      // (the risk it fails); the plain damage drop wins a tie
      if (p.clutch && clutchHelps(damage, p) && fall <= p.clutchMax + 1e-6 && !inArea(p.noWater, x, fy, z)) {
        const t = clutchTarget(x, fy, z, floor, own ? undefined : grid.cls(x, y, z));
        if (t.ok) take('clutch', p.clutchCost + 0.25 * damage * p.hpCost, damage);
      }
    }
    if (best) out.push(best);
    return false;
  }
  return false;
}

/**
 * The live policy still takes the planned long drop from node `from` into node `to` (the same scan the planner
 * ran; the navigator asks every tick before the body steps off: health, hostiles, the bucket and the landing
 * may have changed since the plan). Undefined policy: no.
 */
export function acceptsDrop(grid: NavGrid, costs: PathCosts, p: FallPolicy | undefined, from: { y: number; feet: number }, to: { x: number; y: number; z: number }): boolean {
  if (!p || costs.maxDrop < 3) return false;
  const out: LongDrop[] = [];
  longDrops(grid, costs, p, to.x, from.y, to.z, from.feet, out);
  return out.some((o) => o.y === to.y);
}

function inArea(a: FallPolicy['noWater'], x: number, y: number, z: number): boolean {
  if (!a) return false;
  return Math.hypot(x + 0.5 - a.x, y - a.y, z + 0.5 - a.z) <= a.r;
}
