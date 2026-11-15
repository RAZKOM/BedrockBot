// Track L2 (docs/flight.md "Landing by time", "L2"; decisions/0076-land-by-time.md, the L2 addendum): the landing search's
// probe (landing.ts LandingDeps.probe) over the navigator: a bounded walking plan from a landing cell to within 1.5 of the
// goal (reach.ts probePath: no digging, no pillars, no long falls), its answer with the path's blocks and the walk's
// planned ticks (landprice.ts probeTicks: the move costs without the preference terms that are no time), so a confirmed
// walk is priced by its own plan. The caller's budget, or the longer one findLanding asks for the walk flood's first cells.
//
// `surface: false` plans without the surface preference (nav/costs.ts `underground`, 6 ticks a node under a roof): the walk
// to a covered goal is under a roof by its nature, and the preference makes the search expand the open ground round a
// cave's mouth before it goes in. Whether a walk exists does not depend on it; its ticks are taken out of the price either way.
import type { Vec3 } from '../../world/types.ts';
import { pathBlocks, probePath, type ProbeNav } from '../home/reach.ts';
import { DEFAULT_COSTS } from '../nav/costs.ts';
import { MAX_JUMP_RISE, type PathNode } from '../nav/astar.ts';
import type { ProbeBudget, ProbeOutcome } from './landing.ts';
import { probeTicks } from './landprice.ts';

export interface LandingProbeOptions {
  /** The probe's own budget (commands-fly.ts LAND_PROBE_NODES / LAND_PROBE_MS) when findLanding asks none. */
  budget: ProbeBudget;
  /** Plan with the surface preference (the navigator's default); false: without it (see the file comment). */
  surface?: boolean;
  /** Called after each probe with what it cost (the bench's and the log's numbers). */
  onProbe?: (s: { from: Vec3; budget: ProbeBudget; outcome: ProbeOutcome; expanded: number; ms: number; wallMs: number; cost: number }) => void;
  /** Track W2: each found path, with the cell it starts from (the flight hands the chosen landing's path to the walk after it). */
  onPath?: (path: PathNode[], from: Vec3) => void;
}

/** The navigator as the probe plans with it: `surface: false` sets the surface preference to 0 for this plan only. */
export function landingProbeNav(nav: ProbeNav, surface: boolean): ProbeNav {
  if (surface) return nav;
  return {
    grid: nav.grid,
    planOptions: (o) => {
      const p = nav.planOptions(o);
      return { ...p, costs: { ...p.costs, underground: 0 } };
    },
  };
}

/** The landing search's probe to `goal` (feet cell) over `nav`. */
export function landingProbe(nav: ProbeNav, goal: Vec3, o: LandingProbeOptions): (from: Vec3, budget?: ProbeBudget) => Promise<ProbeOutcome> {
  const target = { type: 'near' as const, p: { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 }, r: 1.5 };
  const planNav = landingProbeNav(nav, o.surface ?? true);
  return async (from, budget) => {
    const b = budget ?? o.budget;
    const t0 = performance.now();
    const r = await probePath(planNav, target, from, { nodes: b.nodes, ms: b.ms, noLongFalls: true });
    let outcome: ProbeOutcome;
    if (!r) outcome = { status: 'nostart' };
    else if (r.status === 'found') {
      const costs = { ...DEFAULT_COSTS, ...planNav.planOptions({ allowBreak: false, allowPlace: false, sprint: false }).costs };
      const ticks = probeTicks(r.path, { underground: costs.underground, isUnderground: (x, z, feet) => nav.grid.underground(x, z, feet), irreversibleDrop: costs.irreversibleDrop, jumpRise: MAX_JUMP_RISE });
      outcome = { status: 'found', blocks: pathBlocks(r.path), ticks };
      o.onPath?.(r.path, from);
    } else outcome = r.status === 'none' ? { status: 'none' } : { status: 'limited' };
    o.onProbe?.({ from, budget: b, outcome, expanded: r?.expanded ?? 0, ms: r?.ms ?? 0, wallMs: performance.now() - t0, cost: r?.cost ?? 0 });
    return outcome;
  };
}
