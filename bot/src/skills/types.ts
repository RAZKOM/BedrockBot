// Skills interface (PLAN.md section 4.3).
import type { ContainerView, ItemStack, Vec3 } from '../world/types.ts';
import type { DigOptions, DigResult } from './dig/digger.ts';
import type { Goal } from './nav/goals.ts';
import type { PathNode } from './nav/astar.ts';

export type { Goal, DigOptions, DigResult };

export type SkillResult =
  | {
      ok: true;
      /** Track R6: arrived, with something to say (the goal's cell is a top no move goes onto: where the walk stopped). */
      note?: string;
    }
  | {
      ok: false;
      reason: 'unreachable' | 'timeout' | 'corrected' | 'interrupted' | 'no_tool' | (string & {});
      /** Track BI: why, in words (a refused long fall). Track R1: an `unreachable` goto with `explain`: its cause in words. */
      note?: string;
      /** Track R1 (nav/reach.ts): an `unreachable` goto's cause class: `world`, `rule:<rule>[+<rule>]`, `unloaded`, `budget`. */
      cause?: string;
    };

export interface GotoOptions {
  /** Give up with 'timeout' after this many ticks. Default 6000 (5 min). */
  timeoutTicks?: number;
  /** Re-plan from the corrected position after a server correction. Default true. */
  replanOnCorrection?: boolean;
  /** Sprint on long straight runs. Default true. */
  sprint?: boolean;
  /** Track M9: jump while sprinting on straight level runs (follower.ts sprintJumpOk; the flight on foot's `sprintJump` rule). Default false. */
  sprintJump?: boolean;
  /** Plan dig-through moves (needs the navigator's `dig` action). Default false. */
  allowBreak?: boolean;
  /** Plan pillar-up moves (needs the `place` action and throwaway blocks). Default false. */
  allowPlace?: boolean;
  /**
   * Track EF1 (decision 0127, docs/pathfinding.md "A near walk has a bound"): the walk is worth at most this many blocks
   * of flat walking (its way's cost; a climb, a dig or a detour counts at its price). The search is bounded to it, so a
   * goal it does not reach within it ends `unreachable` in a few ticks instead of searches of the whole loaded world
   * until the timeout. For walks to something near that is not worth a long way round: a pickup, a stand cell by a
   * tree. Default none.
   */
  maxWay?: number;
  /** Close doors and gates the goto opened, once through. Default false. */
  closeDoors?: boolean;
  /** Track BG: close a trapdoor (hatch) the goto opened in a floor or ceiling, once the body is clear of it. Default true. */
  closeTrapdoors?: boolean;
  /** Plan around falls onto farmland (PathOptions.farmlandDropCost: the farmer, a terraced field). Default false. */
  avoidFarmlandDrops?: boolean;
  /**
   * Track R1 (nav/reach.ts): before it ends `unreachable`, ask why (a few searches with the owner's rules lifted) and
   * say it: SkillResult `cause` and `note`. The `!goto` command sets it. Default false.
   */
  explain?: boolean;
  /**
   * Track R7 (docs/pathfinding.md "A block goal nobody stands in"): a `block` goal whose cell cannot be stood on (inside a
   * built block or a fence, no head room, open air up to 5 over a floor) ends `ok` next to it (under it for the air),
   * with a `note` saying so, instead of `unreachable`. Only for walks whose caller only wants to get there (`!goto`, its
   * waypoints, the `!test goto` series through it); a caller that acts on being in the cell (a pickup in a hole, a
   * tunnel's next step) leaves it off. Default false.
   */
  beside?: boolean;
  /**
   * Track W2 way (docs/pathfinding.md "A walk keeps to its way"): a whole walk found just before by a plan of the same
   * kind (the landing probe's path from the cell a flight landed on): the goto walks it from the node the body stands on
   * instead of planning, and keeps to it. Not walked when the body stands on none of its first nodes (and is not within
   * a few blocks of one to rejoin it) or a node of it is no longer standable: the goto plans as before. Default none.
   */
  way?: readonly PathNode[];
  /**
   * Track W2 way: the walk is taken up again after something else had the body (GotoProcess's resume after the guard): the
   * way the interrupted goto to the same goal was walking is walked on, as a handed `way`. Default false.
   */
  resume?: boolean;
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
