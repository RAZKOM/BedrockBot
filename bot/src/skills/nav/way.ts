// Track W2 way (docs/pathfinding.md "A walk keeps to its way"; decisions/0088-a-walk-keeps-to-its-way.md): the whole way a
// goto walks, kept. A way handed in (GotoOptions.way: the landing probe's path from the cell a flight landed on), the
// way of an interrupted goto taken up again (GotoOptions.resume), or the goto's own plan once it reaches the goal. A
// re-plan after a correction or off the path walks on along it from the node the body stands on, or rejoins it a few
// nodes on by a small search; a fresh plan replaces it only when it is shorter by a clear margin.
//
// Why (the Realm, a cave under a mountain, 12 walks from a landing at its mouth): with hostiles round the way their
// costs (avoidance.ts) pushed the walk's main plan past its budget, the partial plans and plan-aheads went into side
// passages and came back (in the closed loop over the same cave with one zombie on the way: 342 blocks of path for a
// probed 149, three turns back), while the landing search had already found the whole way the body could walk.
//
// The helpers here are pure (the path, the grid, the body's feet); the navigator does the walking (navigator.ts keepWay,
// onRejoinResult, onKeepResult).
import type { Vec3 } from '../../world/types.ts';
import type { PathNode } from './astar.ts';
import type { NavGrid } from './grid.ts';

/**
 * The body stands on a node of its way when its feet are within these of the node: by the plane its cell or the next
 * one's centre, by height its level (Track BE's skip-ahead, 0.6). Not a level off: a body 1 block over a node that is
 * left by a drop of 3 falls 4 and is hurt (the closed loop over the cave, a resume after a detour: 1 HP every run with
 * 1.1 here).
 */
export const WAY_ON_H = 1;
export const WAY_ON_V = 0.6;
/** Nodes behind the last node passed where the body may be found on its way again (a knock back). */
export const WAY_BACK = 4;
/** Nodes ahead of the last node passed where the body may stand on its way again or rejoin it. */
export const WAY_AHEAD = 48;
/**
 * A body off its way by up to this (the straight line from the feet to the way's nearest node in the window) rejoins it
 * by a search to any of those nodes; farther (a fight 10 blocks off, a fall to another floor) a fresh plan, as before.
 */
export const REJOIN_MAX = 8;
/** The rejoin search's budget (in-thread: a few blocks round the body; 8 blocks of walk expand some hundreds of nodes). */
export const REJOIN_NODES = 6000;
export const REJOIN_MS = 120;
/**
 * A fresh plan replaces the kept way only when it is shorter, in blocks of path, than the way's rest by this share of it
 * and by at least KEEP_MIN_BLOCKS. Why 20 %: the walk's own plans and the landing probe's differ by up to 8 % in blocks on
 * the same ground (the probe plans with no surface preference and no long falls; the cave's five goals: 3 to 8 %), and the
 * walk's own plans differ from search to search with their budget; 20 % is over twice that, so the two never take turns.
 * Why 8 blocks: on a short way 20 % is a few blocks, which the moves' own costs (a diagonal against two straights, a drop
 * against a stair) make either way.
 */
export const KEEP_MARGIN = 0.2;
export const KEEP_MIN_BLOCKS = 8;
/** How long the way of an interrupted goto is kept for its resume (a guard fight, a meal, a respawn's walk back). */
export const RESUME_KEEP_MS = 180_000;

/** Blocks of path from node `from` to node `to` (the polyline of the node centres, as reach.ts pathBlocks counts a probe's). */
export function wayBlocks(path: readonly Pick<PathNode, 'x' | 'z' | 'feet'>[], from = 0, to = path.length - 1): number {
  let len = 0;
  for (let i = Math.max(1, from + 1); i <= to && i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    len += Math.hypot(b.x - a.x, b.feet - a.feet, b.z - a.z);
  }
  return len;
}

/** The index (from `lo` to `hi`) of the node the feet `pos` stand on: the nearest within WAY_ON_H / WAY_ON_V, the later on a tie; -1 none. */
export function nodeOnWay(path: readonly PathNode[], pos: Vec3, lo: number, hi: number): number {
  let on = -1;
  let best = WAY_ON_H;
  for (let i = Math.max(0, lo); i <= Math.min(hi, path.length - 1); i++) {
    const n = path[i]!;
    if (Math.abs(n.feet - pos.y) >= WAY_ON_V) continue;
    const d = Math.hypot(n.x + 0.5 - pos.x, n.z + 0.5 - pos.z);
    if (d <= best) {
      best = d;
      on = i;
    }
  }
  return on;
}

/** The node (from `lo` to `hi`) nearest the feet `pos` by the straight line, when within REJOIN_MAX. */
export function nearestOnWay(path: readonly PathNode[], pos: Vec3, lo: number, hi: number): { i: number; d: number } | undefined {
  let near: { i: number; d: number } | undefined;
  for (let i = Math.max(0, lo); i <= Math.min(hi, path.length - 1); i++) {
    const n = path[i]!;
    const d = Math.hypot(n.x + 0.5 - pos.x, n.feet - pos.y, n.z + 0.5 - pos.z);
    if (d <= REJOIN_MAX && (!near || d < near.d)) near = { i, d };
  }
  return near;
}

/** Moves whose node the stand rule does not describe (water, ladders, a pillar's air, a dug drop, a sneak's low room): not looked at. */
const UNCHECKED = new Set<PathNode['move']>(['swim', 'swimOut', 'dive', 'climb', 'climbOut', 'pillar', 'downward', 'sneak']);

/**
 * The first node from `from` on that a body can no longer stand in as planned (its floor, its cell or its head room
 * changed, or it is not loaded), or -1 when every node still stands. Nodes with an action (a dig, a door, a place) and
 * the moves above are not looked at: the walk's own checks (a block change on the path, a move timeout) see to them.
 */
export function wayBroken(grid: Pick<NavGrid, 'stand' | 'standThrough'>, path: readonly PathNode[], from: number): number {
  for (let i = Math.max(1, from + 1); i < path.length; i++) {
    const n = path[i]!;
    if (n.act || UNCHECKED.has(n.move)) continue;
    let f = grid.stand(n.x, n.y, n.z);
    if (f !== undefined && Number.isNaN(f)) f = grid.standThrough(n.x, n.y, n.z);
    if (f === undefined || Number.isNaN(f) || Math.abs(f - n.feet) > 0.01) return i;
  }
  return -1;
}

/** World changes the way makes from node `from` on (digs, places, doors): a fresh plan with more of them replaces no way. */
export function wayActions(path: readonly PathNode[], from = 0): number {
  let k = 0;
  for (let i = from + 1; i < path.length; i++) {
    const a = path[i]!.act;
    if (a) k += (a.dig?.length ?? 0) + (a.place ? 1 : 0) + (a.use?.length ?? 0);
  }
  return k;
}

/** A fresh plan of `fresh` blocks replaces a kept way whose rest is `kept` blocks (KEEP_MARGIN, KEEP_MIN_BLOCKS). */
export function clearlyShorter(fresh: number, kept: number): boolean {
  return fresh < kept * (1 - KEEP_MARGIN) && kept - fresh >= KEEP_MIN_BLOCKS;
}

/** How long a way found by a probe is handed to a walk from its start (a flight's landing search, then the flight, then the walk). */
export const FOUND_WAY_MS = 600_000;

/** A whole way a probe found (the landing search's, from a landing cell to `goal`), when. */
export interface FoundWay {
  path: readonly PathNode[];
  goal: Vec3;
  at: number;
}

/**
 * The way to hand a walk to `goal` from feet `pos`: the newest found within FOUND_WAY_MS for the same goal that starts
 * where the body stands (its first node within WAY_ON_H / WAY_ON_V of the feet), else undefined (the walk plans).
 */
export function wayFromHere(ways: readonly FoundWay[], pos: Vec3, goal: Vec3, now: number): readonly PathNode[] | undefined {
  let best: FoundWay | undefined;
  let bd = WAY_ON_H;
  for (const w of ways) {
    if (now - w.at > FOUND_WAY_MS || w.goal.x !== goal.x || w.goal.y !== goal.y || w.goal.z !== goal.z) continue;
    const n = w.path[0];
    if (!n || w.path.length < 2 || Math.abs(n.feet - pos.y) >= WAY_ON_V) continue;
    const d = Math.hypot(n.x + 0.5 - pos.x, n.z + 0.5 - pos.z);
    if (d <= bd) {
      bd = d;
      best = w;
    }
  }
  return best?.path;
}

/** The way from node `i` on, node `i` as its start (the move into it and its action are done). */
export function wayFrom(path: readonly PathNode[], i: number): PathNode[] {
  if (i <= 0) return [...path];
  const { act: _act, gap: _gap, ...n } = path[i]!;
  return [{ ...n, move: 'start', cost: 0 }, ...path.slice(i + 1)];
}
