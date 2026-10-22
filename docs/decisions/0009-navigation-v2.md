# 0009: Navigation v2 (tick costs, surface preference, segments, world-changing moves)

Date: 2026-10-29. Status: accepted (PLAN.md tasks 7.1 and 7.2, planner side; the planner half of 7.3).
Server: BDS 1.26.60.6 (`bds-move`, flat world, truth pack). Details and numbers:
[../pathfinding.md](../pathfinding.md). Supersedes parts of [0005](0005-pathfinding.md) (decisions 3
and 8 stay; 7 is refined).

## Context

The v1 planner (0005) cost a walk 1, a diagonal sqrt 2, a jump 2 and a drop 1 per block, had no idea
of "underground", planned one path of up to 40 000 nodes / 250 ms inside a single tick, and only
detected "stuck" after 40 ticks without progress. On the Realm it walked into caves: a cave mouth on
the straight line was the cheapest route, a drop of up to 3 blocks cost almost nothing although it
cannot be climbed back, and a partial path towards unloaded world could end at the bottom of a hole.
Measured on the same 200-block course on bds-move: v1 walked 61 ticks through the cave tunnel on the
line and planned for up to 105 ms in one tick (11 re-plans on block updates).

## Decisions

1. **Costs are ticks, derived from the movement model.** Walking 4.633 and sprinting 3.564 ticks per
   block are the steady speeds of `input/physics.ts` (Baritone's Java numbers are the same: Bedrock
   ground movement matches); a 1-block climb is the 9-tick air time of a standing jump; a fall of n
   blocks is the free-fall time (5 / 7 / 9 ticks for 1 / 2 / 3) plus a walk and a 2-tick landing.
   The server agrees: steady 4.633 and 3.562 to 3.565 ticks per block on 50-block runs, 9.0 ticks per
   staircase step. Flat moves cost the sprint rate when sprinting is allowed (the follower sprints on
   straight runs); the heuristic is that rate times the octile distance, so it stays admissible and
   tight on open ground. Terrain penalties became multipliers (`costFactor` = 1 + penalty).

2. **Surface preference by cost, not by rule.** A node with a roof block anywhere above the head
   (the column's highest non-leaf solid or liquid block, cached per chunk column and reset by block
   updates) costs 6 extra ticks; a drop higher than a jump (1.25 blocks: irreversible without placing)
   costs 30 extra and also counts against a node when the planner picks the end of a partial path, so
   a partial segment never ends in a pit. Both weights are planner options. Leaves are not a roof (tree
   canopies are fine). The sky scan uses the chunk store's highest non-empty subchunk
   (`TerrainSource.columnTop`) so a column costs about 15 lookups, not 380.

3. **Segments with plan-ahead, sliced searches.** `PathSearch` is resumable; the navigator runs it at
   most 8 ms per tick. A main plan (the body waits for it) has 40 ms of search time and 20 000 nodes;
   while the body walks a partial segment, the next one is planned from its end (100 ms, 20 000
   nodes) and spliced on without a stop. A segment that ends at unloaded world waits for the chunks
   (up to 200 ticks, no failure). Block updates that change nothing the planner reads (grass to dirt,
   leaf decay states) no longer re-plan. Result on the 200-block course: 2 segments, at most 9.3 ms in
   any tick, 0 corrections.

4. **Per-move timeouts from the move's own estimate.** Each path node carries the ticks of the move
   into it. The move under way is the straight line from the last node the body was inside to the
   node the follower aims at (pure pursuit skips cells); when it takes longer than 2 x its estimate
   + 10 ticks the navigator re-plans (`timeout`). The 40-tick no-progress check stays as the
   fallback. A failure while the body is not on a safe node (in water, airborne, no standable node)
   first steers back to the last safe node (`retreat`), then re-plans.

5. **World-changing moves through injected actions, off by default.** `NavActions { dig, place,
   useBlock, throwawayItems }` keep the planner free of packet code. Dig-through (`allowBreak`) breaks
   the one or two blocks filling a cardinal neighbour's body cells (the higher one first); its cost is
   the break-time table (`dig/breakTime.ts`, best hotbar tool via `chooseTool`) plus 12 ticks. Pillar-up
   (`allowPlace`, throwaway blocks in the inventory) is "jump and place under the feet" in one move;
   the place action itself jumps and clicks (Track O's PlaceSkill does, measured 6 ticks per step).
   Doors and fence gates are walked through when they are out of the way or can be toggled by
   `useBlock` (no option needed), closed behind with `closeDoors`. The path is walked in legs that end
   before an action node: stop, act, continue.

6. **Baritone's breaking rules.** Never break: a block next to water or lava (6 neighbours), a block
   with a gravity block (sand, gravel, concrete powder, anvil ...) on top, the floor under the feet
   (no dig-down move yet), containers, beds, spawners and the like, doors and gates, anything in
   `protectedBlocks`, unknown blocks. A failed dig marks the cell as not breakable for the rest of the
   goto.

7. **Door and fence shapes the data lacks.** minecraft-data has one collision box for every door
   state and post-only boxes for fences, panes and bars. Doors get their panel from the lower half's
   state (Track O's measured rule: closed = the edge clockwise of the direction, open = the opposite
   edge for hinge 0, the direction's own edge for hinge 1); fences / panes / bars get arms towards
   connecting neighbours in the physics query. The planner decides "can the body cross this cell along
   x / z" from the boxes against the body's 0.6-wide corridor, now and after a toggle.

8. **Unknown blocks are 1.5-high obstacles.** On BDS 1.26.60 every fence, glass pane and iron bars
   block arrives as an unknown runtime id (the block data is 1.26.30). v1 treated unknown as a full
   1-high cube, a floor the planner would jump onto. v2 makes it a 1.5-high box: never a floor, never
   walked through; the physics' box stays inside the cell, so walking next to a fence is unchanged.

## Consequences

- Paths are 1 to 2 % longer than v1's on open ground (they avoid roofs and high drops) and arrive in
  the same number of ticks; the 1000-path benchmark is slower (p50 1.7 ms vs 0.8 ms) because the
  penalties widen the search, still far under the 50 ms budget and now sliced anyway.
- The navigator is bigger (legs, actions, segments). `GotoReport` gained segments, maxTickMs,
  planMs, moveTimeouts, actions, retreats, unloadedWait; `plans[]` entries gained `slices`.
- Pillar-up and the door move are unit-tested with fake actions only until Track O's skills are
  wired (`bot/src/skills/index.ts`); their e2e suite (`nav-place`) skips with a message until then.
- The world model should learn the 1.26.60 fence / pane / bars states (registry); until then the
  fence-arm code only runs in unit tests.
- Not done: bridging (placing a block to walk over a gap), dig-down, digging up through a ceiling
  (jump with head room dug), swimming, ladders, parkour.
