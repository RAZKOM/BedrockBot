// Ported from Baritone (src/api/java/baritone/api/pathing/goals/GoalTwoBlocks.java@23723891 and
// src/main/java/baritone/process/MineProcess.java@23723891 `GoalThreeBlocks`), LGPL-3.0.
//
// This file is part of BedrockBot and contains code translated from Baritone. Baritone is free
// software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
// See the GNU Lesser General Public License (./LICENSE) for more details.
//
// Track BD (docs/mining.md "Mining v4: MineProcess"): the done tests of Baritone's column goals, the
// mine process' goal for an ore (`coalesce`). nav/goals.ts names the shapes (`twoBlocks`, `threeBlocks`)
// and adds our heuristic (octile plus the levels to the feet range: `columnH`); the planner worker uses the same goalTest.

/**
 * Baritone GoalTwoBlocks.isInGoal: the feet cell is the goal cell (gx, gy, gz) or the cell below it (the
 * goal block at head height).
 */
export function inTwoBlocks(gx: number, gy: number, gz: number, x: number, y: number, z: number): boolean {
  return x === gx && z === gz && (y === gy || y === gy - 1);
}

/**
 * Baritone MineProcess.GoalThreeBlocks.isInGoal: GoalTwoBlocks plus the cell two below the goal cell (the
 * goal block right over the head: mined looking up, the vertical shaft case).
 */
export function inThreeBlocks(gx: number, gy: number, gz: number, x: number, y: number, z: number): boolean {
  return x === gx && z === gz && (y === gy || y === gy - 1 || y === gy - 2);
}
