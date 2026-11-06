// Track CB (ADR 0066, docs/coarse.md "Following a corridor on foot"): how the navigator follows a
// coarse corridor. The corridor's waypoints (portal centres lowered to their floors, the goal last)
// become the fine planner's intermediate goals a window at a time: the farthest waypoint within
// WINDOW_BLOCKS of corridor ahead of the body, as a `near` goal; the real goal once the rest of the
// corridor is short. A waypoint within WAYPOINT_REACH of the body is passed.
import type { Vec3 } from '../../world/types.ts';
import type { CoarseMode, Corridor, Portal } from '../coarse/types.ts';
import type { NavGoal } from './goals.ts';

/** A waypoint within this many blocks (3D) of the body counts as passed. */
export const WAYPOINT_REACH = 4;
/** The fine goal is the farthest waypoint within this much corridor ahead of the body (the segment planner's comfortable reach). */
export const WINDOW_BLOCKS = 32;
/** The real goal is the fine goal once the corridor left is at most this long. */
export const GOAL_DIRECT = 48;
/** The `near` radius of a waypoint goal (portal centres sit between cells; a 2-wide gap's centre is on a cell edge). */
export const WAYPOINT_RADIUS = 2;

export interface CorridorState {
  corridor: Corridor;
  /** The waypoints after the start: portal centres on their floors, the goal last when the corridor reaches it. */
  wps: Vec3[];
  /** The portal each waypoint stands at (undefined for the goal). */
  portals: (Portal | undefined)[];
  /** The leg mode at each waypoint (the mode that crosses its portal). */
  modes: CoarseMode[];
  /** Index of the next waypoint not yet passed. */
  next: number;
  /** The last waypoint is the goal (a `found` corridor); a `partial` one ends short of it. */
  toGoal: boolean;
}

/** The corridor as a list of fine waypoints, or undefined when it has none to follow (none, or a single leg from start to goal). */
export function corridorState(c: Corridor): CorridorState | undefined {
  if (c.status === 'none' || c.legs.length === 0) return undefined;
  const wps: Vec3[] = [];
  const portals: (Portal | undefined)[] = [];
  const modes: CoarseMode[] = [];
  const toGoal = c.status === 'found';
  c.legs.forEach((leg, li) => {
    const ps = leg.portals.slice(leg.entry ? 1 : 0);
    const lastLeg = li === c.legs.length - 1;
    for (let k = 1; k < leg.waypoints.length; k++) {
      const w = leg.waypoints[k]!;
      const isEnd = k === leg.waypoints.length - 1;
      const p = isEnd && lastLeg && toGoal ? undefined : ps[k - 1];
      wps.push({ x: w.x, y: p?.floorY ?? w.y, z: w.z });
      portals.push(p);
      modes.push(leg.mode);
    }
  });
  if (wps.length === 0 || (toGoal && wps.length === 1)) return undefined;
  return { corridor: c, wps, portals, modes, next: 0, toGoal };
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** A body within this of an upcoming waypoint re-aims at it (a re-plan from somewhere along the corridor, past waypoints it never came within reach of). */
export const REAIM_REACH = 2 * WAYPOINT_REACH;
/** How many waypoints ahead `advance` looks. */
const LOOK_AHEAD = 8;

/**
 * Mark the waypoints the body has reached as passed: the farthest of the next few within WAYPOINT_REACH;
 * otherwise the nearest one within REAIM_REACH becomes the next target (the body got past the ones
 * before it another way).
 */
export function advance(st: CorridorState, pos: Vec3): void {
  const look = Math.min(st.wps.length, st.next + LOOK_AHEAD);
  let nearest = -1;
  let nearestD = REAIM_REACH;
  for (let i = st.next; i < look; i++) {
    const d = dist(pos, st.wps[i]!);
    if (d <= WAYPOINT_REACH) {
      st.next = i + 1;
      nearest = -1;
      nearestD = REAIM_REACH;
    } else if (d <= nearestD && i >= st.next) {
      nearest = i;
      nearestD = d;
    }
  }
  if (nearest > st.next) st.next = nearest;
}

/** Corridor length left from `pos`: to the next waypoint, then along the rest. */
export function remainingBlocks(st: CorridorState, pos: Vec3): number {
  if (st.next >= st.wps.length) return 0;
  let len = dist(pos, st.wps[st.next]!);
  for (let i = st.next + 1; i < st.wps.length; i++) len += dist(st.wps[i - 1]!, st.wps[i]!);
  return len;
}

/**
 * The waypoint the fine planner should aim at from `pos` (after advancing): the farthest within
 * WINDOW_BLOCKS of corridor; undefined when the real goal should be used (the corridor is walked, or
 * what is left of it is short and it reaches the goal).
 */
export function fineTarget(st: CorridorState, pos: Vec3): { index: number; p: Vec3 } | undefined {
  advance(st, pos);
  if (st.next >= st.wps.length) return undefined;
  if (st.toGoal && remainingBlocks(st, pos) <= GOAL_DIRECT) return undefined;
  let k = st.next;
  let len = dist(pos, st.wps[k]!);
  while (k + 1 < st.wps.length) {
    const d = dist(st.wps[k]!, st.wps[k + 1]!);
    if (len + d > WINDOW_BLOCKS) break;
    len += d;
    k++;
  }
  if (st.toGoal && k === st.wps.length - 1) return undefined;
  return { index: k, p: st.wps[k]! };
}

/** The fine goal for a target waypoint. */
export function waypointGoal(p: Vec3): NavGoal {
  return { type: 'near', p: { x: p.x, y: p.y, z: p.z }, r: WAYPOINT_RADIUS };
}

/** Did a change in one of `chunks` touch the corridor still ahead (a chunk of, or next to, a remaining waypoint)? */
export function touches(st: CorridorState, chunks: readonly { cx: number; cz: number; dim: number }[], dim: number): boolean {
  for (let i = Math.max(0, st.next - 1); i < st.wps.length; i++) {
    const w = st.wps[i]!;
    const cx = Math.floor(w.x) >> 4;
    const cz = Math.floor(w.z) >> 4;
    for (const c of chunks) if (c.dim === dim && Math.abs(c.cx - cx) <= 1 && Math.abs(c.cz - cz) <= 1) return true;
  }
  return false;
}
