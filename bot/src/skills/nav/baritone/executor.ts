// Ported from Baritone (src/main/java/baritone/pathing/path/PathExecutor.java@23723891 and
// src/api/java/baritone/api/Settings.java@23723891 (`movementTimeoutTicks`)), LGPL-3.0.
//
// This file is part of BedrockBot and contains code translated from Baritone. Baritone is free
// software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
// See the GNU Lesser General Public License (./LICENSE) for more details.
//
// Track BE, the path executor's off-path checks (docs/pathfinding.md "Segments, re-planning and
// stuck handling"): the pure rules PathExecutor.onTick applies between movements, over our node list
// and the body's feet position. `distanceFromPath` (closestPathPos, but to the polyline of node
// centres in a bounded window around the current node instead of every position of the path),
// `offPathState` (possiblyOffPath with MAX_DIST_FROM_PATH / MAX_MAX_DIST_FROM_PATH and the ticks-away
// grace), `nodeOverrun` (the ticksOnCurrent > cost + movementTimeoutTicks rule), `nodeAt` /
// `skipAhead` (the pathPosition snap to the movement whose valid positions hold the feet). The
// navigator calls them per tick (nav/navigator.ts, `// Track BE`); when they apply (not during a dig,
// a place, a swim, a climb, a jump or fall, a glide) is the follower's and the navigator's business.
// No allocation: plain numbers in, plain numbers out.

/** The node fields these rules read (nav/astar.ts PathNode). */
export interface ExecNode {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Feet height standing in the node. */
  readonly feet: number;
  readonly move: string;
}

/** The body's feet position. */
export interface ExecBody {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Baritone PathExecutor.MAX_DIST_FROM_PATH: farther than this (blocks) from the path is "possibly off path". */
export const MAX_DIST_FROM_PATH = 2;

/** Baritone PathExecutor.MAX_MAX_DIST_FROM_PATH: farther than this (blocks) from the path: off it, re-plan at once. */
export const MAX_MAX_DIST_FROM_PATH = 3;

/**
 * Baritone PathExecutor.MAX_TICKS_AWAY: ticks "possibly off path" before the path is cancelled (10 s).
 * Not our default: the follower walks back to the path at 0.2 blocks per tick, so a body still more
 * than 2 blocks off after OFF_PATH_GRACE_TICKS is not coming back (see `offPathState`).
 */
export const MAX_TICKS_AWAY = 200;

/** Ours: the grace (ticks) a "possibly off path" body gets to come back within MAX_DIST_FROM_PATH. */
export const OFF_PATH_GRACE_TICKS = 20;

/** Baritone Settings.movementTimeoutTicks: a movement taking this many ticks more than its estimate fails. */
export const MOVEMENT_TIMEOUT_TICKS = 100;

/** Nodes behind / ahead of the current one that `distanceFromPath` looks at (Baritone looks at the whole path). */
export const PATH_WINDOW_BACK = 8;
export const PATH_WINDOW_AHEAD = 16;

/**
 * Baritone PathExecutor: skip forward only to a movement at least this many past the current one
 * ("dont check pathPosition+1 ... also don't check pathPosition+2"); ours counts from the follower's
 * aim, which is already the farthest node it walks to.
 */
export const SKIP_MIN_AHEAD = 1;

/** Nodes past the aim `skipAhead` looks at. */
export const SKIP_WINDOW = 64;

/** A body within this of a node's feet height stands in it (the follower's `inNode`). */
const FEET_TOLERANCE = 0.6;

export type OffPathState = 'fine' | 'possibly_off' | 'off';

/** Distance (blocks) from p to the segment a -> b (node centres at feet height). */
function segmentDistance(p: ExecBody, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 0 ? ((p.x - ax) * dx + (p.y - ay) * dy + (p.z - az) * dz) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy), p.z - (az + t * dz));
}

/**
 * Baritone PathExecutor.closestPathPos: the body's distance (blocks) from the path. Ours: to the
 * polyline of node centres at feet height (pure pursuit cuts between nodes, a jump rises along a
 * segment) over nodes `from` .. `to` (clamped to the list), not the distance to every block centre.
 */
export function distanceFromPath(body: ExecBody, nodes: readonly ExecNode[], from: number, to: number): number {
  const lo = Math.max(0, from);
  const hi = Math.min(nodes.length - 1, to);
  if (hi < lo) return Infinity;
  const first = nodes[lo]!;
  let best = Math.hypot(body.x - (first.x + 0.5), body.y - first.feet, body.z - (first.z + 0.5));
  for (let i = lo; i < hi; i++) {
    const a = nodes[i]!;
    const b = nodes[i + 1]!;
    const d = segmentDistance(body, a.x + 0.5, a.feet, a.z + 0.5, b.x + 0.5, b.feet, b.z + 0.5);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Baritone PathExecutor.possiblyOffPath with the two leniencies: `off` beyond MAX_MAX_DIST_FROM_PATH,
 * or beyond MAX_DIST_FROM_PATH for more than `grace` ticks in a row (`ticksAway`, counted by the
 * caller, includes this tick); `possibly_off` beyond MAX_DIST_FROM_PATH within the grace; else `fine`
 * (the caller resets `ticksAway`). Baritone's grace is MAX_TICKS_AWAY (200); ours OFF_PATH_GRACE_TICKS.
 * Baritone's MovementFall exception (flat distance to the landing) is the caller's: the checks do not
 * run while the body is in the air.
 */
export function offPathState(distance: number, ticksAway: number, grace = OFF_PATH_GRACE_TICKS): OffPathState {
  if (distance > MAX_MAX_DIST_FROM_PATH) return 'off';
  if (distance > MAX_DIST_FROM_PATH) return ticksAway > grace ? 'off' : 'possibly_off';
  return 'fine';
}

/**
 * Baritone PathExecutor: `ticksOnCurrent > currentMovementOriginalCostEstimate + movementTimeoutTicks`:
 * the movement (ours: an action's node, its planned cost) has overrun its estimate and fails.
 * `factor` scales the estimate (Baritone: 1).
 */
export function nodeOverrun(ticksOnNode: number, moveCost: number, factor = 1, margin = MOVEMENT_TIMEOUT_TICKS): boolean {
  return ticksOnNode > factor * moveCost + margin;
}

/** The body stands in node n: its cell (x, z) and within FEET_TOLERANCE of its feet height (Baritone: Movement.getValidPositions holds playerFeet). */
export function inNodeCell(body: ExecBody, n: ExecNode): boolean {
  return Math.floor(body.x) === n.x && Math.floor(body.z) === n.z && Math.abs(body.y - n.feet) < FEET_TOLERANCE;
}

/**
 * The node in `from` .. `to` (clamped) the body stands in, or -1. Two nodes of one column within
 * FEET_TOLERANCE of the feet (a climb, a half-block step) both match: the one nearest the feet wins
 * (the first on a tie).
 */
export function nodeAt(body: ExecBody, nodes: readonly ExecNode[], from: number, to: number): number {
  const hi = Math.min(nodes.length - 1, to);
  let found = -1;
  let best = Infinity;
  for (let k = Math.max(0, from); k <= hi; k++) {
    const n = nodes[k]!;
    if (!inNodeCell(body, n)) continue;
    const dy = Math.abs(body.y - n.feet);
    if (dy < best) {
      best = dy;
      found = k;
    }
  }
  return found;
}

/**
 * Baritone PathExecutor.onTick's "Skipping forward" loop: the body already stands in a node past
 * node `i` (the follower's aim) by at least SKIP_MIN_AHEAD (pushed along the path, or a corner cut
 * short): the index of such a node within SKIP_WINDOW, else -1. Only standing nodes count (walk,
 * diag, jump, drop: the body on their floor). Path cells are unique but for same-column nodes: the
 * one nearest the feet wins (the farthest on a tie); Baritone takes the first match.
 */
export function skipAhead(body: ExecBody, nodes: readonly ExecNode[], i: number): number {
  const hi = Math.min(nodes.length - 1, i + SKIP_WINDOW);
  let found = -1;
  let best = Infinity;
  for (let k = i + SKIP_MIN_AHEAD; k <= hi; k++) {
    const n = nodes[k]!;
    if (n.move !== 'walk' && n.move !== 'diag' && n.move !== 'jump' && n.move !== 'drop' && n.move !== 'start') continue;
    if (!inNodeCell(body, n)) continue;
    const dy = Math.abs(body.y - n.feet);
    if (dy <= best) {
      best = dy;
      found = k;
    }
  }
  return found;
}
