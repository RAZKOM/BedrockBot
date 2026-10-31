// Skills interface (PLAN.md section 4.3).
import type { ContainerView, ItemStack, Vec3 } from '../world/types.ts';
import type { DigOptions, DigResult } from './dig/digger.ts';
import type { Goal } from './nav/goals.ts';

export type { Goal, DigOptions, DigResult };

export type SkillResult =
  | { ok: true }
  | { ok: false; reason: 'unreachable' | 'timeout' | 'corrected' | 'interrupted' | 'no_tool' | (string & {}) };

export interface GotoOptions {
  /** Give up with 'timeout' after this many ticks. Default 6000 (5 min). */
  timeoutTicks?: number;
  /** Re-plan from the corrected position after a server correction. Default true. */
  replanOnCorrection?: boolean;
  /** Sprint on long straight runs. Default true. */
  sprint?: boolean;
  /** Plan dig-through moves (needs the navigator's `dig` action). Default false. */
  allowBreak?: boolean;
  /** Plan pillar-up moves (needs the `place` action and throwaway blocks). Default false. */
  allowPlace?: boolean;
  /** Close doors and gates the goto opened, once through. Default false. */
  closeDoors?: boolean;
  /** Track BG: close a trapdoor (hatch) the goto opened in a floor or ceiling, once the body is clear of it. Default true. */
  closeTrapdoors?: boolean;
}

export interface Skills {
  lookAt(p: Vec3): Promise<void>;
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>; // A* + physics-driven input
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>; // start/continue/predict/stop inside player_auth_input
  collect(radius: number, timeoutTicks: number): Promise<SkillResult>; // walk over item entities
  openContainer(p: Vec3): Promise<ContainerView>;
  deposit(view: ContainerView, filter: (i: ItemStack) => boolean): Promise<SkillResult>; // item_stack_request moves
  cancel(): void;
}
