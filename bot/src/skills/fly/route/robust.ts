// Track F2: robustness to the rocket's burn. A rocket burns 12 to 18 ticks at random and the plan is flown on
// the nominal 15. Every plan with rockets is re-flown open loop (its controls as planned) with every burn end
// in [BURN.min, BURN.max] of each rocket (the others nominal), plus the branches where every rocket burns
// shortest and longest; a branch that sweeps into a solid, or that no longer passes the goals, is reported.
// The tracker flies closed loop and corrects most of the drift (the benchmark measures that); the open-loop
// check is the conservative statement the plan carries (`robust`, `robustClearance`).
import { sweep, type RouteGrid } from './grid.ts';
import { crossesFloor, floorless, landsOn, passes, stepState, sweepGridFor } from './primitives.ts';
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
  /** A rocket still burns where the branch ends. */
  burning?: boolean;
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

export interface BranchOptions {
  /** Track F18: the ticks before this (a standing start's takeoff edge, which the search sweeps on the bare box, search.ts startMarginFor) are swept at margin 0 and their clearance is not counted. */
  from?: number;
  /** Track F18: the branch ends once it has passed this many goals (default all of them). */
  until?: number;
}

/** Fly the plan's controls from `start` with the burns given per rocket (in fire order); sweep every tick. */
export function flyBranch(start: Readonly<RouteState>, plan: RoutePlan, grid: RouteGrid, margin: number, goals: readonly RouteGoal[], burns: readonly number[], stackRockets: boolean, o: BranchOptions = {}): BranchResult {
  let s = cloneState(start);
  let fired = 0;
  let clearance = RISK_RANGE;
  const nom = (start.kit ?? BURN).nominal;
  const from = o.from ?? 0;
  const until = Math.min(goals.length, o.until ?? goals.length);
  if (s.wp >= until) return { burns: [...burns], hit: false, clearance, reached: s.wp };
  for (let i = 0; i < plan.controls.length; i++) {
    const c = plan.controls[i]!;
    const burn = c.fire ? (burns[fired] ?? nom) : nom;
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
      // (the jump tick of a takeoff leaves the floor the body stands on: swept as the search sweeps it, primitives.ts edgeOf)
      const jump = c.jump === true && !s.gliding;
      const sg = jump ? floorless(grid, Math.floor(s.pos.y + 1e-6)) : sweepGridFor(grid, goals[s.wp], s.pos);
      const sw = sweep(sg, jump ? next.pos : s.pos, next.pos, i < from ? 0 : margin);
      if (sw.hit) return { burns: [...burns], hit: true, hitAt: i + 1, clearance: 0, reached: next.wp };
      if (i >= from && sw.clearance < clearance) clearance = sw.clearance;
    }
    while (next.wp < goals.length && passes(goals[next.wp]!, s.pos, next.pos)) next.wp++;
    s = next;
    if (landed || s.wp >= until) break;
  }
  return { burns: [...burns], hit: false, clearance, reached: s.wp, ...(s.boost.max > 0 ? { burning: true } : {}) };
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
  // (Track F10: the range is that of the rockets in the hand, `RouteState.kit`; none: the plain rocket's)
  const kit = start.kit ?? BURN;
  const nominal = Array<number>(n).fill(kit.nominal);
  for (let i = 0; i < n; i++) {
    for (let b = kit.min; b <= kit.max; b++) {
      if (b === kit.nominal) continue;
      const burns = [...nominal];
      burns[i] = b;
      branches.push(flyBranch(start, plan, grid, margin, goals, burns, stackRockets));
    }
  }
  if (n > 1) {
    branches.push(flyBranch(start, plan, grid, margin, goals, Array<number>(n).fill(kit.min), stackRockets));
    branches.push(flyBranch(start, plan, grid, margin, goals, Array<number>(n).fill(kit.max), stackRockets));
  }
  const robust = branches.every((b) => !b.hit);
  const reaches = branches.every((b) => b.reached >= plan.reached);
  const clearance = Math.min(plan.clearance, ...branches.map((b) => b.clearance));
  plan.robust = robust;
  plan.robustClearance = clearance;
  return { robust, reaches, clearance, branches, fireTicks };
}
