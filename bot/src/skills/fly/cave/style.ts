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
  rules: Object.freeze<TrackerRules>({
    commitTicks: 12,
    bailAfter: 6,
    partialStop: true,
    completeOnly: true,
    replanLead: 12,
    bailError: 1.5,
  }),
});

/** The executor's options for a cave trip with the style on (`flyCave on`); `off` is today's executor (the windows walked). */
export function caveExecutorOptions(on: boolean, style: Readonly<CaveStyle> = CAVE_STYLE): ExecutorOptions {
  return on ? { underFly: true, windowBlocks: style.windowBlocks, tailMin: style.tailMin, prove: style.prove, proveRobust: style.proveRobust } : { underFly: false };
}

/** The stretch options (drive.ts flyStretch) the style adds to a window: the margin, the goals per tracker, the rules, the risk weight. */
export function caveStretchOptions(w: Pick<Window, 'margin'>, style: Readonly<CaveStyle> = CAVE_STYLE): Pick<StretchOptions, 'margin' | 'window' | 'rules' | 'riskCost'> {
  return { margin: w.margin + style.marginExtra, window: style.chainWindow, rules: style.rules, riskCost: style.riskCost };
}
