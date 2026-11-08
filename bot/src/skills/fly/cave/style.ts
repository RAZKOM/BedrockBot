// Track F5b (docs/flight.md "Cave flight (Track F5b)", decisions/0069): the cave flying style. A cave is not an
// open-air flight made smaller: a skilled player flies it in short committed pieces, each one he can see the end
// of, stops when he is not sure, and walks the bits he cannot see through. The style is a set of parameters on
// the pieces that already fly a corridor's underground stretch (corridor/stretches.ts windows, corridor/drive.ts
// chain, route/tracker.ts) plus two rules: every window is PROVEN before its takeoff (a complete plan from
// standing at the live budget; a partial one cuts the window back to what it reached, none at all walks to the
// next goal), and a body in the air without a plan, or with a planner that keeps answering short partial plans,
// BAILS OUT (the 180 brake, the hover's sink to the floor) instead of gliding on. The setting `flyCave` (default
// off) is the only way powered underground flight is turned on; with it off the executor walks underground as
// the 2026-11-06 hotfix left it.
import type { ExecutorOptions } from '../corridor/executor.ts';
import type { StretchOptions } from '../corridor/drive.ts';
import type { Window } from '../corridor/stretches.ts';
import type { TrackerRules } from '../route/tracker.ts';

export interface CaveStyle {
  /** A window at most this long (blocks): F4b's 320 was cut by the chunks only; a cave window is what one plan from standing can prove. */
  windowBlocks: number;
  /** The tail after a bend that is walked rather than flown out of (blocks). */
  tailMin: number;
  /** Goals per tracker of the chain (F4b's CHAIN_WINDOW 5); a proven window's first tracker takes every goal of it. */
  chainWindow: number;
  /** The search's risk weight (ticks of cost per tick flown within a block of a solid; route/types.ts RISK_COST 0.5). */
  riskCost: number;
  /** Added to the window's bore margin (the planner keeps farther from the irregular walls where there is room). */
  marginExtra: number;
  /** Every window proven before its takeoff (executor.ts `prove`), with this search budget (the body stands meanwhile: more than the 600 ms a plan gets in flight). */
  prove: boolean;
  proveRobust: boolean;
  proveMs: number;
  proveNodes: number;
  /**
   * Track F6: the searches measure the way through the air (route/field.ts), not the straight line through rock. Measured
   * off: with the search in pieces the straight line completed the proofs in fewer expansions (docs/flight.md "Tight cave
   * flight"), and the field's plan touched the wall of a clean 3 x 3 bore at burn 9 where the straight line's did not.
   */
  geodesic: boolean;
  /** Track F6: the searches run in pieces of this many goals, each from the end of the piece before (search.ts planPieces; 0: one search). */
  pieces: number;
  /**
   * Track F6: the standable cells within this of a window's landing cell a touchdown may end in (stretches.ts landingGoal).
   * Measured at 4: in a 3-wide bore the zone is the whole floor and the plan lands beside the wall (7 scrapes at burn 21
   * in the clean 3 x 3 bore), so the style keeps LANDING_REACH.
   */
  landReach: number;
  /** Track F6: `marginExtra` is added only in a bore at least this high (a 3-high passage keeps the bore margin: the extra cost the tight proofs). */
  marginExtraFrom: number;
  /** Track F6: a proof's plan must keep this much from every solid (executor.ts ExecutorOptions.proveClearMin): a body standing against a wall does not take off there. */
  proveClearMin: number;
  /** The tracker's rules. */
  rules: TrackerRules;
}

/**
 * The cave style's numbers, measured on the procedural cave set (docs/flight.md "Cave flight", the tables). The rocket
 * refusals the brief suggested (no rocket over a speed, none on a partial plan) are off: measured, they made the body
 * leave the plan it was flying (the plan's rocket was its turn) and hit the wall it was turning from.
 */
export const CAVE_STYLE: Readonly<CaveStyle> = Object.freeze({
  windowBlocks: 96,
  tailMin: 24,
  chainWindow: 6,
  riskCost: 2,
  marginExtra: 0.1,
  prove: true,
  proveRobust: true,
  proveMs: 2000,
  proveNodes: 80_000,
  geodesic: false,
  pieces: 3,
  landReach: 2,
  marginExtraFrom: 4,
  proveClearMin: 0.15,
  rules: Object.freeze<TrackerRules>({
    commitTicks: 12,
    bailAfter: 6,
    partialStop: true,
    completeOnly: true,
    replanLead: 12,
    // Track F6: 1.0 (F5b's 1.5): on the generator set with the proofs completing, 1.5 gave 79 % clean legs and 2 fatal trips, 1.0 gave 84 % and none
    bailError: 1.0,
    retime: true,
  }),
});

/** The executor's options for a cave trip with the style on (`flyCave on`); `off` is today's executor (the windows walked). */
export function caveExecutorOptions(on: boolean, style: Readonly<CaveStyle> = CAVE_STYLE): ExecutorOptions {
  return on ? { underFly: true, windowBlocks: style.windowBlocks, tailMin: style.tailMin, prove: style.prove, proveRobust: style.proveRobust, landReach: style.landReach, proveClearMin: style.proveClearMin } : { underFly: false };
}

/** Track F6: the window's margin in the style: the bore's own, plus `marginExtra` where the bore is `marginExtraFrom` high or more. */
export function caveMargin(w: Pick<Window, 'margin'> & Partial<Pick<Window, 'height'>>, style: Readonly<CaveStyle> = CAVE_STYLE): number {
  return w.margin + ((w.height ?? Infinity) >= style.marginExtraFrom ? style.marginExtra : 0);
}

/** The stretch options (drive.ts flyStretch) the style adds to a window: the margin, the goals per tracker, the rules, the risk weight, the search's pieces. */
export function caveStretchOptions(w: Pick<Window, 'margin'> & Partial<Pick<Window, 'height'>>, style: Readonly<CaveStyle> = CAVE_STYLE): Pick<StretchOptions, 'margin' | 'window' | 'rules' | 'riskCost' | 'geodesic' | 'pieces'> {
  return { margin: caveMargin(w, style), window: style.chainWindow, rules: style.rules, riskCost: style.riskCost, ...(style.geodesic ? { geodesic: true } : {}), ...(style.pieces > 0 ? { pieces: style.pieces } : {}) };
}
