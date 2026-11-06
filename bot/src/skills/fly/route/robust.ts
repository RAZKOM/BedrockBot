// Track F2: robustness to the rocket's burn. A rocket burns 12 to 18 ticks at random and the plan is flown on
// the nominal 15. Every plan with rockets is re-flown open loop (its controls as planned) with every burn end
// in [BURN.min, BURN.max] of each rocket (the others nominal), plus the branches where every rocket burns
// shortest and longest; a branch that sweeps into a solid, or that no longer passes the goals, is reported.
// The tracker flies closed loop and corrects most of the drift (the benchmark measures that); the open-loop
// check is the conservative statement the plan carries (`robust`, `robustClearance`).
import { sweep, type RouteGrid } from './grid.ts';
import { crossesFloor, landsOn, passes, stepState, sweepGridFor } from './primitives.ts';
import { BURN, RISK_RANGE, cloneState, type RouteGoal, type RoutePlan, type RouteState } from './types.ts';

export interface BranchResult {
  /** The burn of each rocket in this branch. */
  burns: number[];
  hit: boolean;
  /** The tick of the hit. */
  hitAt?: number;
  clearance: number;
  /** Goals passed along this branch. */
  reached: number;
}

export interface RobustReport {
  robust: boolean;
  /** Every branch passes all the goals too. */
  reaches: boolean;
  clearance: number;
  branches: BranchResult[];
  /** Ticks of fire in the plan. */
  fireTicks: number[];
}

/** Fly the plan's controls from `start` with the burns given per rocket (in fire order); sweep every tick. */
export function flyBranch(start: Readonly<RouteState>, plan: RoutePlan, grid: RouteGrid, margin: number, goals: readonly RouteGoal[], burns: readonly number[], stackRockets: boolean): BranchResult {
  let s = cloneState(start);
  let fired = 0;
  let clearance = RISK_RANGE;
  for (let i = 0; i < plan.controls.length; i++) {
    const c = plan.controls[i]!;
    const burn = c.fire ? (burns[fired] ?? BURN.nominal) : BURN.nominal;
    const r = stepState(s, c, stackRockets, burn);
    if (r.fired) fired++;
    const next = r.next;
    const g = goals[next.wp];
    let landed = false;
    if (crossesFloor(g, s.pos, next.pos)) {
      if (!landsOn(g!, s.pos, next.pos, next.vel)) return { burns: [...burns], hit: true, hitAt: i + 1, clearance: 0, reached: next.wp };
      next.wp++;
      landed = true;
    }
    if (!landed) {
      const sw = sweep(sweepGridFor(grid, goals[s.wp], s.pos), s.pos, next.pos, margin);
      if (sw.hit) return { burns: [...burns], hit: true, hitAt: i + 1, clearance: 0, reached: next.wp };
      if (sw.clearance < clearance) clearance = sw.clearance;
    }
    while (next.wp < goals.length && passes(goals[next.wp]!, s.pos, next.pos)) next.wp++;
    s = next;
    if (landed || s.wp >= goals.length) break;
  }
  return { burns: [...burns], hit: false, clearance, reached: s.wp };
}

/** Check a plan over the burn range (see the file comment); `plan.robust` / `plan.robustClearance` are set from the result. */
export function checkRobust(start: Readonly<RouteState>, plan: RoutePlan, grid: RouteGrid, margin: number, goals: readonly RouteGoal[], stackRockets = false): RobustReport {
  const fireTicks: number[] = [];
  plan.controls.forEach((c, i) => {
    if (c.fire) fireTicks.push(i);
  });
  const n = fireTicks.length;
  const branches: BranchResult[] = [];
  if (n === 0) {
    plan.robust = true;
    return { robust: true, reaches: true, clearance: plan.clearance, branches, fireTicks };
  }
  const nominal = Array<number>(n).fill(BURN.nominal);
  for (let i = 0; i < n; i++) {
    for (let b = BURN.min; b <= BURN.max; b++) {
      if (b === BURN.nominal) continue;
      const burns = [...nominal];
      burns[i] = b;
      branches.push(flyBranch(start, plan, grid, margin, goals, burns, stackRockets));
    }
  }
  if (n > 1) {
    branches.push(flyBranch(start, plan, grid, margin, goals, Array<number>(n).fill(BURN.min), stackRockets));
    branches.push(flyBranch(start, plan, grid, margin, goals, Array<number>(n).fill(BURN.max), stackRockets));
  }
  const robust = branches.every((b) => !b.hit);
  const reaches = branches.every((b) => b.reached >= plan.reached);
  const clearance = Math.min(plan.clearance, ...branches.map((b) => b.clearance));
  plan.robust = robust;
  plan.robustClearance = clearance;
  return { robust, reaches, clearance, branches, fireTicks };
}
