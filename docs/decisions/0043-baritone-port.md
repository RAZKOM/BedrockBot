# 0043: Port Baritone's planner rules under LGPL-3.0 (wave 11, Tracks BA, BB, BC, BE, BD)

Date: 2026-10-30. Status: accepted (BA, BB, BC, BE, BD merged). Supersedes decision 0005's
"no code copied" line. Details and numbers: [../pathfinding.md](../pathfinding.md) (BA, BB, BC, BE) and
[../mining.md](../mining.md) (BD). Licence and file list: [../../THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## Context

Mining and pathfinding had grown three planners joined by hand-tuned thresholds: the walk probe, the
"3x straight line + 8" detour rule, and a separate straight tunnel / shaft planner, plus a sight-dig
fallback. Partial paths were pure greedy (one best node scored `h + trap`) and often ended against a wall.
The owner's Realm sessions showed the cost: a bot stuck in a 1x1 hole over a chest, a mine job walking
1500 blocks home, ore left unreached. Baritone (cabaletta/baritone, LGPL-3.0) solves the same problems
with one planner whose moves dig, several partial-path bests and an executor that notices when the body
leaves the path. The owner asked for a port ("In order to fix our pathfinding stuff and mining issues").

## Decision

1. **Port behaviour, under LGPL, in separate files.** Baritone `1.21.11` at commit
   `23723891da460ef15797b02fe5b385b0c5b163cc` is cloned read-only at `.work/baritone` (git-ignored).
   Translated code lives only under `bot/src/skills/nav/baritone/` and `bot/src/skills/mine/baritone/`,
   each file with Baritone's LGPL header adapted as `Ported from Baritone (<upstream path>@23723891),
   LGPL-3.0`, the licence text next to it, and a row in THIRD_PARTY_NOTICES.md. Our files import these
   modules and never paste translated code. Java plumbing (`IBlockState`, `BlockStateInterface`,
   `CalculationContext`) is mapped onto our `TerrainClass`, `NavGrid` and `PathCosts`; Baritone's
   movement numbers are not taken where ours are measured on BDS (`nav/costs.ts`, the input loop).
2. **What was ported.**
   - BA, `bestSoFar.ts` (AbstractNodeCostSearch, AStarPathFinder): seven partial-path bests scored
     `h + g / k`, k = 1.5, 2, 2.5, 3, 4, 5, 10, plus our `trap` term; the first best more than
     `MIN_DIST_PATH` 5 from the start is the partial path; the failing budget x4.
   - BB, `helper.ts` (MovementHelper, Ternary, ToolSet): one rule set for stand / walk-through /
     break / break cost shared by the planner, the worker, the follower, the Digger and the miner.
   - BE, `executor.ts` (PathExecutor): off the path by more than 3 blocks re-plans at once, by more than
     2 for over 20 ticks re-plans; the body standing in a later node skips ahead; an action running past
     its cost + 100 ticks fails (`overrun`).
   - BC, `moves.ts` (MovementTraverse, Ascend, Descend, Downward, Pillar `cost` functions): the moves
     that dig, with Baritone's break sets and refusals over our ticks; execution stays ours.
   - BD, `mine/baritone/mineProcess.ts` (MineProcess: `coalesce`, `internalMiningGoal`, `prune`,
     `plausibleToBreak`, `isNextToAir`, the dropped-items scan, `blacklistClosestOnFailure`, the settings as
     constants) and `nav/baritone/goals.ts` (GoalTwoBlocks / GoalThreeBlocks done tests): every known ore
     becomes one composite goal and the normal planner, whose moves dig, picks the cheapest reachable one.
     Setting `mineMode` (`baritone`, the default since BD's gate; `v3` the old probe / tunnel planner).
     Ours instead of Baritone's: the rescan every 40 ticks re-plans only when the heading member is gone
     (Baritone 5 ticks); candidates sorted by octile + height (walk-cost estimate) not straight line;
     `mineSeenOnly` for `allowOnlyExposedOres`; branch mining (`branchMore`) round after round for
     `exploreForBlocks` ("mine until n": `!get iron 1000` is one job); `markUnreachable` is broader than
     Baritone's in-process blacklist (session-wide and Track R's navigator blacklist); the harvest rule
     (an ore no carried tool harvests is no candidate, a walk-dug ore counts only with a harvesting tool);
     `legitMine` not ported. Composite gotos pass `allowPlace` (the pillar back up replaces v3's
     staircase) but never place inside `protectRadius`.
3. **The owner's rules win where Baritone is less careful**, by name: `digPenalty` (60 ticks per dug
   block), `protectRadius` 48 around home, built blocks never dug, the break rules (nothing beside water or
   lava, no gravity block above, never the block under the feet, unknown blocks refused), the shaft rules
   of `mine/tunnel.ts` (known solid floor, no liquid in or 1 to 2 below the column, no dripstone within 3
   below, no gravity above, a guaranteed way back up). `allowGravityAbove` exists but is off: BDS does not
   send a block update for a landed falling block, so the model would miss it.
4. **Ours kept or added.** Diagonals stay ours (Baritone breaks nothing there either); no bridge
   traverse, `dynamicFallCost`, bucket clutch, corner edging or `jumpPenalty`; the dig-down move only
   towards a goal below the node (goal-below gate, which also stops an `xz` goal from digging down);
   the sneak-through move for 1.5-high gaps is ours (a Java body does not fit there either).
5. **Every move, cost and rule is mirrored in the planner worker** (`nav/worker.ts`, `worker-grid.ts`)
   and the worker unit test proves main thread and worker agree on status, cost, expansions, length and
   break sets.

## Consequences

- Mining is one `goto(composite of ore goals, { allowBreak })` (Track BD; mine-baritone e2e: 12 ores in
  85.9 s against v3's 114.4 s with `mineSeenOnly` off, 3 in 26.8 s against 33.5 s with it on). The v3
  probe, detour ratio, `SHAFT_SAVES` and tunnel planner (`planTunnel` / `chooseTunnel` / `runTunnel`,
  `mineDirect`) stay until a cleanup track deletes them; the step helpers branch mining and `returnUp`
  use stay.
- The pillar is refused inside `protectRadius` for every goto, so a natural pit 2+ deep inside the base
  is no longer pillared out of (nothing is dug there either).
- Dig-heavy searches cost 10 to 20 times more per expansion than walks: they need the planner worker's
  2 s budget, not the 40 ms in-thread plan.
- Any later change to a ported file keeps its header and its THIRD_PARTY_NOTICES row; a newer Baritone
  commit is a deliberate re-port, not an automatic update.
- 2026-10-30, Track BI ([0049](0049-long-falls-and-clutch.md)): long falls and the water bucket clutch
  came back as ours, not as a port of `dynamicFallCost` / `MovementFall`: the Bedrock fall damage, the
  waterloggable blocks and the click timing were measured on BDS and differ from Java. No Baritone code
  was added; the ported files and THIRD_PARTY_NOTICES.md are unchanged.
