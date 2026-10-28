// Ported from Baritone (src/main/java/baritone/pathing/calc/AbstractNodeCostSearch.java@23723891 and
// src/main/java/baritone/pathing/calc/AStarPathFinder.java@23723891), LGPL-3.0.
//
// This file is part of BedrockBot and contains code translated from Baritone. Baritone is free
// software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
// See the GNU Lesser General Public License (./LICENSE) for more details.
//
// Track BA, partial-path selection (docs/pathfinding.md "Segments, re-planning and stuck handling"):
// the node a partial path (search limit hit, or unloaded world touched) ends at. Instead of the one
// node with the lowest straight-line distance to the goal, 7 bests are kept, best i scored
// `h + g / COEFFICIENTS[i]` (plus our `trap`, the accumulated irreversible-drop penalty, so a partial
// path never prefers the bottom of a cliff); `best()` is the first (lowest coefficient) best farther
// than MIN_DIST_PATH from the start, else none: the search made no progress worth walking; while
// that holds (`failing`) the search may run on past its node budget (FAILURE_NODES_FACTOR). No
// allocation per node: plain numbers in typed arrays (the worker expands up to 500 000 nodes).

/**
 * Baritone AbstractNodeCostSearch.COEFFICIENTS: the weights of the path cost against the heuristic.
 * A low coefficient favours cheap paths that get somewhat closer, a high one paths that get much
 * closer at any cost (a long detour round a wall).
 */
export const COEFFICIENTS: readonly number[] = [1.5, 2, 2.5, 3, 4, 5, 10];

/** Baritone AbstractNodeCostSearch.MIN_DIST_PATH: a partial path shorter than this (blocks, straight line from the start) is not worth walking. */
export const MIN_DIST_PATH = 5;

/** Baritone AbstractNodeCostSearch.MIN_IMPROVEMENT: a best is replaced only by a score lower by more than this (ticks; float noise of diagonal / cardinal mixes). */
export const MIN_IMPROVEMENT = 0.01;

/**
 * Baritone AStarPathFinder `failing` with Settings failureTimeoutMS / primaryTimeoutMS (2000 / 500):
 * while no best is farther than MIN_DIST_PATH from the start, a search goes on past its node budget
 * up to this many times it. Ours applies to the node budget only: the time budget (`maxMs`) stays a
 * hard cap (the worker client gives up on a search at its maxMs + 2 s).
 */
export const FAILURE_NODES_FACTOR = 4;

const K = COEFFICIENTS.length;
const MIN_DIST_SQ = MIN_DIST_PATH * MIN_DIST_PATH;

/** The best partial-path ends of one search (Baritone `bestSoFar[]` + `bestHeuristicSoFar[]`). */
export class BestSoFar {
  /** Node index of best i (-1: none yet). */
  private readonly node = new Int32Array(K).fill(-1);
  /** Score of best i: h + g / COEFFICIENTS[i] + trap. */
  private readonly score = new Float64Array(K).fill(Infinity);
  /** Squared distance of best i's cell from the start cell. */
  private readonly distSq = new Float64Array(K);
  private sx = 0;
  private sy = 0;
  private sz = 0;
  /**
   * Baritone AStarPathFinder `failing`: no best is yet farther than MIN_DIST_PATH from the start (the
   * search goes on past its node budget, up to FAILURE_NODES_FACTOR times it).
   */
  failing = true;

  /** The start node (index `i`, cell x y z, heuristic h): every best starts there (Baritone calculate0). */
  reset(i: number, x: number, y: number, z: number, h: number): void {
    this.sx = x;
    this.sy = y;
    this.sz = z;
    this.node.fill(i);
    this.score.fill(h);
    this.distSq.fill(0);
    this.failing = true;
  }

  /**
   * Node `i` at cell (x, y, z) with heuristic `h`, path cost `g` and irreversible-drop penalty `trap`
   * (called at expansion; Baritone AStarPathFinder: at relax, after a neighbour's cost improved).
   */
  consider(i: number, x: number, y: number, z: number, h: number, g: number, trap: number): void {
    const score = this.score;
    let d = -1;
    for (let k = 0; k < K; k++) {
      const s = h + g / COEFFICIENTS[k]! + trap;
      if (score[k]! - s > MIN_IMPROVEMENT) {
        if (d < 0) {
          const dx = x - this.sx;
          const dy = y - this.sy;
          const dz = z - this.sz;
          d = dx * dx + dy * dy + dz * dz;
        }
        score[k] = s;
        this.node[k] = i;
        this.distSq[k] = d;
        if (this.failing && d > MIN_DIST_SQ) this.failing = false;
      }
    }
  }

  /**
   * Baritone AbstractNodeCostSearch.bestSoFar: the node of the first best (lowest coefficient) farther
   * than MIN_DIST_PATH from the start, else -1 ("no path found": nothing worth walking).
   */
  best(): number {
    for (let k = 0; k < K; k++) {
      if (this.node[k]! >= 0 && this.distSq[k]! > MIN_DIST_SQ) return this.node[k]!;
    }
    return -1;
  }

  /** The coefficient of the best `best()` returns (undefined with none), for logs and tests. */
  coefficient(): number | undefined {
    for (let k = 0; k < K; k++) {
      if (this.node[k]! >= 0 && this.distSq[k]! > MIN_DIST_SQ) return COEFFICIENTS[k];
    }
    return undefined;
  }
}
