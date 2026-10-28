/*
 * Ported from Baritone (src/main/java/baritone/process/MineProcess.java@23723891: `coalesce` with its
 * GoalThreeBlocks and `internalMiningGoal`, `prune`, `plausibleToBreak`, `isNextToAir`, `droppedItemsScan`,
 * the rescan interval and `blacklistClosestOnFailure` of `onTick`; src/api/java/baritone/api/Settings.java@23723891:
 * the mine settings, fixed here as constants), LGPL-3.0.
 *
 * This file is part of Baritone.
 *
 * Baritone is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Baritone is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Baritone.  If not, see <https://www.gnu.org/licenses/>.
 * The licence text is in ../../nav/baritone/LICENSE (./LICENSE points there); the port is listed in
 * THIRD_PARTY_NOTICES.md at the repo root.
 */
// Track BD (wave 11, docs/mining.md "Mining v4: MineProcess"): Baritone's MineProcess as pure functions.
// Baritone puts every known ore into one GoalComposite of GoalThreeBlocks / GoalTwoBlocks / GoalBlock
// ("get the feet into the ore's column: in its cell, one or two below it") and lets the normal pathfinder,
// where digging is a move cost, pick the cheapest reachable one. Here:
//
//   candidates  come from the ore memory (mine/seen.ts, Baritone's WorldScanner and cached world) under
//               the CURRENT `mineSeenOnly` setting (Baritone `allowOnlyExposedOres`): the miner passes them in
//   world       every read goes through the world model (`blockAt`: Baritone's BlockStateInterface reads);
//               a position outside it (an unloaded column the cache remembers) is kept as a candidate but
//               never read (Baritone keeps unloaded positions too: `!worldContainsLoadedChunk`)
//   rules       `plausibleToBreak` is the shared rule set (nav/baritone/helper.ts `avoidBreaking` through the
//               miner's `breakRule`: the owner's protectRadius, built blocks, liquids beside, gravity above) plus
//               Baritone's bedrock-above-and-below rule; ours on top: the shaft hazards under a candidate below
//               the feet (mine/tunnel.ts `shaftHazard`: a liquid 1 to 2 below, dripstone within 3 below)
//   goals       nav/goals.ts `twoBlocks` / `threeBlocks` / `block` / `any` are GoalTwoBlocks / GoalThreeBlocks /
//               GoalBlock / GoalComposite
//   settings    Baritone's defaults as constants (decision 0043); where ours differ it says so
//
// The loop that walks, digs, counts and explores is ours (mine/miner.ts, mode `baritone`); nothing here
// moves the bot or reads a block outside the world model.
import type { BlockInfo, EntityInfo, Vec3 } from '../../../world/types.ts';
import { classify } from '../../terrain/classify.ts';
import { octile, type AnyGoal, type NavGoal } from '../../nav/goals.ts';
import { isExposed } from '../seen.ts';

// ---- settings (Baritone Settings.java defaults, fixed here) --------------------------------------------

/**
 * Baritone `mineGoalUpdateInterval` (5 ticks): ticks between re-scans of the candidates while the bot is on
 * its way. Ours: 40 (2 s). Baritone re-prunes a list every 5 ticks on another thread and re-validates the
 * goal; our scan is 2 ms on the main thread and a changed composite cancels the goto (a re-plan in the
 * worker), so every 5 ticks would cost more than it finds.
 */
export const MINE_GOAL_UPDATE_TICKS = 40;
/** Baritone `mineMaxOreLocationsCount` (64): candidates in one composite at most (the heuristic is the minimum over them). */
export const MINE_MAX_ORE_LOCATIONS = 64;
/** Baritone `blacklistClosestOnFailure` (true): a goto that finds no path blacklists the nearest candidate instead of giving up. */
export const BLACKLIST_CLOSEST_ON_FAILURE = true;
/** Baritone `minYLevelWhileMining` (0 above the dimension's floor) / `maxYLevelWhileMining` (2031): ours the overworld's -64 .. 320. */
export const MIN_Y_WHILE_MINING = -64;
export const MAX_Y_WHILE_MINING = 320;
/** Baritone `mineScanDroppedItems` (true): dropped items of the asked kind are goals too. */
export const MINE_SCAN_DROPPED_ITEMS = true;
/** Baritone `forceInternalMining` (false): `coalesce`'s branch that reads the neighbours above and below. */
export const FORCE_INTERNAL_MINING = false;
/** Baritone `internalMiningAirException` (true): an air neighbour counts as a goal cell in that branch. */
export const INTERNAL_MINING_AIR_EXCEPTION = true;
/** Baritone `allowOnlyExposedOresDistance` (1): the radius of `isNextToAir`; ours is the memory's 6-neighbour exposure rule (seen.ts). */
export const EXPOSED_ORES_DISTANCE = 1;
/** Baritone `prune`: a dropped item within this (squared blocks) of a plausible candidate ore is not a goal of its own (the ore's collect takes it). */
export const DROP_NEAR_ORE_SQ = 9;
/** Baritone `exploreForBlocks` (true): with nothing known, explore instead of giving up (ours: branch mining, mine/branch.ts). */
export const EXPLORE_FOR_BLOCKS = true;

// ---- types ---------------------------------------------------------------------------------------------

/** A candidate: an ore the memory knows (Baritone `knownOreLocations`) or a dropped item of the asked kind. */
export interface MineCandidate {
  kind: 'ore' | 'drop';
  p: Vec3;
  /** The block name (ore) or the item name (drop). */
  name: string;
  /** An unloaded position the world cache remembers (never read). */
  cached?: boolean;
}

/** Why a candidate was left out of the composite. */
export interface MineSkip {
  p: Vec3;
  why: string;
}

/** What the rules read (the miner wires the world model and the shared rule set). */
export interface MineGoalContext {
  blockAt(p: Vec3): BlockInfo | undefined;
  /**
   * Why the block at p may not be broken (the shared rule set, nav/actions.ts `breakBlocker` without the
   * under-feet rule), `air` when nothing is there, undefined when it may.
   */
  breakRule(p: Vec3): string | undefined;
  /** Ours: the shaft hazards under p (mine/tunnel.ts `shaftHazard`), applied to a candidate below the feet. */
  belowRule?(p: Vec3): string | undefined;
  /** The block names asked for (the kinds still below their quota). */
  names: ReadonlySet<string>;
  /** The bot's feet cell. */
  feet: Vec3;
  /** The blacklists (the miner's own, the session's unreachable set, Track R's navigator blacklist). */
  blocked?(p: Vec3): boolean;
  /** Baritone `allowOnlyExposedOres`: our `mineSeenOnly`. The memory already filters; this re-checks loaded candidates. */
  exposedOnly?: boolean;
  minY?: number;
  maxY?: number;
  /** Candidates at most (MINE_MAX_ORE_LOCATIONS). */
  max?: number;
  forceInternalMining?: boolean;
}

export interface PruneResult {
  /** Nearest first (by `estimate`), at most `max`. */
  candidates: MineCandidate[];
  skipped: MineSkip[];
}

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`;
const up = (p: Vec3, dy: number): Vec3 => ({ x: p.x, y: p.y + dy, z: p.z });

// ---- rules ----------------------------------------------------------------------------------------------

/** Baritone `coalesce`'s `FallingBlock` test: a gravity block (sand, gravel, concrete powder, an anvil ...) at p. */
export function isFallingBlock(b: BlockInfo | undefined): boolean {
  return !!b && classify(b).gravity;
}

/**
 * Baritone `MineProcess.plausibleToBreak`: `getMiningDurationTicks < COST_INF` and `!avoidBreaking` (both
 * are the shared rule set's answer, `breakRule`), and not bedrock above and below. Ours on top: the shaft
 * hazards under a candidate below the feet (`belowRule`). The reason it is not plausible, undefined when it
 * is. An unloaded candidate (cached) cannot be read and counts as plausible (Baritone keeps it too).
 */
export function plausibleToBreak(ctx: MineGoalContext, c: MineCandidate): string | undefined {
  const b = ctx.blockAt(c.p);
  if (!b) return c.cached ? undefined : 'unloaded';
  const rule = ctx.breakRule(c.p);
  if (rule === 'air') return 'gone';
  if (rule) return rule;
  const above = ctx.blockAt(up(c.p, 1));
  const below = ctx.blockAt(up(c.p, -1));
  if (above?.name === 'bedrock' && below?.name === 'bedrock') return 'bedrock';
  if (ctx.belowRule && c.p.y < ctx.feet.y) {
    const why = ctx.belowRule(c.p);
    if (why) return why;
  }
  return undefined;
}

/**
 * Baritone `isNextToAir` with `allowOnlyExposedOresDistance` 1: a transparent block within 1. Ours is the
 * memory's exposure rule (seen.ts `isExposed`: an open loaded cell among the 6 neighbours), the same radius.
 */
export function isNextToAir(blockAt: MineGoalContext['blockAt'], p: Vec3): boolean {
  return isExposed(blockAt, p);
}

/**
 * Our ranking estimate (Baritone sorts by the squared straight-line distance from the player): the planner's
 * heuristic for the column goals (octile distance of the columns) plus the height difference in blocks, so a
 * candidate 8 blocks down ranks behind one 8 blocks across (both are a dig away, the walk is the same).
 */
export function estimate(feet: Vec3, p: Vec3): number {
  return octile(p.x - feet.x, p.z - feet.z) + Math.abs(p.y - feet.y);
}

/** Baritone `blacklistClosestOnFailure`'s pick: the candidate nearest the feet by straight line (`playerFeet::distSqr`). */
export function nearestCandidate(feet: Vec3, cands: readonly MineCandidate[]): MineCandidate | undefined {
  let best: MineCandidate | undefined;
  let bestD = Infinity;
  for (const c of cands) {
    const d = (c.p.x - feet.x) ** 2 + (c.p.y - feet.y) ** 2 + (c.p.z - feet.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * Baritone `prune`: drop duplicates; drop loaded positions that are not the asked block any more (a dropped
 * item's position is kept); drop what is not plausible to break; with `exposedOnly` drop what is not next to
 * air; keep the Y limits; drop the blacklisted; sort nearest first; cut to `max`. Dropped items within
 * DROP_NEAR_ORE_SQ of a plausible candidate ore are left out (Baritone: the drop lands in the ore's collect).
 * The skipped ores come back with the reason (the miner's `stats.unsafe`).
 */
export function prune(ctx: MineGoalContext, ores: readonly MineCandidate[], drops: readonly MineCandidate[] = []): PruneResult {
  const skipped: MineSkip[] = [];
  const seen = new Set<string>();
  const kept: MineCandidate[] = [];
  const minY = ctx.minY ?? MIN_Y_WHILE_MINING;
  const maxY = ctx.maxY ?? MAX_Y_WHILE_MINING;
  for (const o of ores) {
    const k = key(o.p);
    if (seen.has(k)) continue;
    seen.add(k);
    if (o.p.y < minY || o.p.y > maxY) continue; // outside the Y limits: not a skip to report, never a target
    if (ctx.blocked?.(o.p)) continue;
    const b = ctx.blockAt(o.p);
    if (b && !ctx.names.has(b.name)) continue; // something else there now (the memory forgets it at its next scan)
    const why = plausibleToBreak(ctx, o);
    if (why) {
      skipped.push({ p: { ...o.p }, why });
      continue;
    }
    if (ctx.exposedOnly && b && !isNextToAir((p) => ctx.blockAt(p), o.p)) continue;
    kept.push({ ...o, kind: 'ore' });
  }
  const oreKeys = kept.map((o) => o.p);
  for (const d of drops) {
    const k = key(d.p);
    if (seen.has(k) || ctx.blocked?.(d.p)) continue;
    seen.add(k);
    if (d.p.y < minY || d.p.y > maxY) continue;
    // Baritone prune: a drop within 3 blocks of a plausible ore is taken when that ore is mined
    if (oreKeys.some((p) => (p.x - d.p.x) ** 2 + (p.y - d.p.y) ** 2 + (p.z - d.p.z) ** 2 <= DROP_NEAR_ORE_SQ)) continue;
    kept.push({ ...d, kind: 'drop' });
  }
  kept.sort((a, b) => estimate(ctx.feet, a.p) - estimate(ctx.feet, b.p));
  const max = ctx.max ?? MINE_MAX_ORE_LOCATIONS;
  return { candidates: kept.length > max ? kept.slice(0, max) : kept, skipped };
}

/**
 * Baritone `droppedItemsScan` (`mineScanDroppedItems`): the cells of item entities of the asked kind
 * (`isDrop`: the job's drop names, miner.ts `isJobDrop`) within `radius` of the feet.
 */
export function droppedItems(entities: ReadonlyMap<bigint, EntityInfo> | undefined, isDrop: (name: string) => boolean, feet: Vec3, radius: number): MineCandidate[] {
  if (!MINE_SCAN_DROPPED_ITEMS || !entities) return [];
  const out: MineCandidate[] = [];
  const seen = new Set<string>();
  for (const e of entities.values()) {
    if (e.type !== 'minecraft:item' || !e.item || !isDrop(e.item.name)) continue;
    if (Math.hypot(e.pos.x - (feet.x + 0.5), e.pos.y - feet.y, e.pos.z - (feet.z + 0.5)) > radius) continue;
    const p = { x: Math.floor(e.pos.x), y: Math.floor(e.pos.y + 1e-6), z: Math.floor(e.pos.z) };
    const k = key(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: 'drop', p, name: e.item.name });
  }
  return out;
}

// ---- goals ----------------------------------------------------------------------------------------------

/**
 * Baritone `internalMiningGoal`: the cell at `pos` is one the body may end up in when mining `locs`: another
 * candidate, air (`internalMiningAirException`), or an asked block that is plausible to break.
 */
export function internalMiningGoal(ctx: MineGoalContext, pos: Vec3, locs: ReadonlySet<string>): boolean {
  if (locs.has(key(pos))) return true;
  const b = ctx.blockAt(pos);
  if (!b) return false;
  if (INTERNAL_MINING_AIR_EXCEPTION && b.boxes.length === 0 && b.name === 'air') return true;
  return ctx.names.has(b.name) && plausibleToBreak(ctx, { kind: 'ore', p: pos, name: b.name }) === undefined;
}

/**
 * Baritone `MineProcess.coalesce`: the goal for one ore. Without `forceInternalMining` (the default):
 * GoalThreeBlocks (feet in the ore's cell, one or two below it: the vertical shaft case) unless a falling
 * block sits over the ore, then GoalTwoBlocks (feet or head into it, nothing from below). With it, the
 * neighbours decide (the checkerboard / column cases of the Java comments): symmetric above and below with
 * a goal two below -> three blocks, symmetric -> two blocks, a goal above only -> the ore's cell, a goal
 * below only -> two blocks of the one below with a goal two below, else the cell below.
 */
export function coalesce(ctx: MineGoalContext, loc: Vec3, locs: ReadonlySet<string>): NavGoal {
  const assumeVerticalShaftMine = !isFallingBlock(ctx.blockAt(up(loc, 1)));
  if (!(ctx.forceInternalMining ?? FORCE_INTERNAL_MINING)) {
    return assumeVerticalShaftMine ? { type: 'threeBlocks', p: loc } : { type: 'twoBlocks', p: loc };
  }
  const upwardGoal = internalMiningGoal(ctx, up(loc, 1), locs);
  const downwardGoal = internalMiningGoal(ctx, up(loc, -1), locs);
  const doubleDownwardGoal = internalMiningGoal(ctx, up(loc, -2), locs);
  if (upwardGoal === downwardGoal) {
    return doubleDownwardGoal && assumeVerticalShaftMine ? { type: 'threeBlocks', p: loc } : { type: 'twoBlocks', p: loc };
  }
  if (upwardGoal) return { type: 'block', p: loc };
  if (doubleDownwardGoal && assumeVerticalShaftMine) return { type: 'twoBlocks', p: up(loc, -1) };
  return { type: 'block', p: up(loc, -1) };
}

/** The goal of a candidate: `coalesce` for an ore, the item's cell (Baritone: `coalesce` of its position too; ours stands in the cell) for a drop. */
export function candidateGoal(ctx: MineGoalContext, c: MineCandidate, locs: ReadonlySet<string>): NavGoal {
  return c.kind === 'drop' ? { type: 'block', p: c.p } : coalesce(ctx, c.p, locs);
}

/** Baritone `GoalComposite`: done at any member, heuristic the minimum (nav/goals.ts `any`). */
export function goalComposite(goals: readonly NavGoal[]): AnyGoal {
  return { type: 'any', goals };
}

/** The composite of `candidates` (each through `candidateGoal`), with the goals in the candidates' order. */
export function compositeOf(ctx: MineGoalContext, candidates: readonly MineCandidate[]): { goal: AnyGoal; goals: NavGoal[] } {
  const locs = new Set(candidates.filter((c) => c.kind === 'ore').map((c) => key(c.p)));
  const goals = candidates.map((c) => candidateGoal(ctx, c, locs));
  return { goal: goalComposite(goals), goals };
}

/** The feet cell satisfies a column goal (block / twoBlocks / threeBlocks); false for other kinds. Pure geometry (the navigator's `member` needs its grid). */
export function goalDoneAt(g: NavGoal, feet: Vec3): boolean {
  switch (g.type) {
    case 'block':
      return feet.x === g.p.x && feet.z === g.p.z && feet.y === g.p.y;
    case 'twoBlocks':
      return feet.x === g.p.x && feet.z === g.p.z && (feet.y === g.p.y || feet.y === g.p.y - 1);
    case 'threeBlocks':
      return feet.x === g.p.x && feet.z === g.p.z && (feet.y === g.p.y || feet.y === g.p.y - 1 || feet.y === g.p.y - 2);
    default:
      return false;
  }
}

/** Index of the first member done at the feet cell, -1 when none (what `GotoReport.reached` says, without the grid). */
export function memberAt(goals: readonly NavGoal[], feet: Vec3): number {
  return goals.findIndex((g) => goalDoneAt(g, feet));
}

/**
 * The member the body is heading for from `feet`: the lowest estimate (the navigator blames the same member
 * on a failure: nav/navigator.ts `settleBlacklist`). -1 without members.
 */
export function headingMember(candidates: readonly MineCandidate[], feet: Vec3): number {
  let best = -1;
  let bestE = Infinity;
  candidates.forEach((c, i) => {
    const e = estimate(feet, c.p);
    if (e < bestE) {
      bestE = e;
      best = i;
    }
  });
  return best;
}
