# 0022: Stairs and partial blocks

Date: 2026-10-29. Status: accepted (Phase 7, wave 7 Track AA; follows [0009](0009-navigation-v2.md)).
Server: BDS 1.26.60.6 (`bds-move`). Details and numbers: [../pathfinding.md](../pathfinding.md)
"Stairs and partial blocks".

## Context

The owner reported on the Realm (1.26.60) that the bot does not walk up stairs and slabs and "gets
confused" on them, and that the home return failed twice from the same spot with `unreachable after
53 ticks, 0.0 blocks, 3 plan(s), 0 segment(s)` and no line saying where the bot stood.

Measured on bds-move: on 1.26.60 every stairs block arrives as an **unknown runtime id**. 1.26.60
added the state `minecraft:corner` (none, inner_left, inner_right, outer_left, outer_right) to all
stairs; the runtime id is the hash of {name, states} and the world registry (1.26.30 block data,
no `minecraft:corner`) cannot resolve it. 0009 decision 8 makes unknown blocks 1.5-high obstacles,
so every stairs block was a wall to the planner and a 1.5-high box to the physics (the local body
disagreed with the server by up to 0.77 blocks on a stairs block). A goto that had to use stairs had
no route; a block goal straight above or below the start (same column) gave a heuristic of 0 at the
start, so a search that hit its node limit returned the start itself as the "closest" node: 3 plans of
1 node, "no progress possible" 3 times, `unreachable` with 0 segments. That reproduces the Realm
report's numbers; whether it was the cause there is not confirmed (no position was logged).

With the stairs known, the planner still saw a stairs block as a 1-block rise (top 1 for the whole
cell): a jump (9 ticks), while the body climbs it by two 0.5 auto-steps.

## Decisions

1. **Resolve the 1.26.60 stairs states in the terrain layer.** `terrain/shapes.ts` hashes every
   stairs state of the 1.26.30 data with each `minecraft:corner` value (the registry's `blockHash`;
   verified against the ids BDS sends) and `classify` maps an unknown runtime id found there to the
   stairs block with that state. The world registry is not changed (another track's file); other
   readers of `world.blockAt` still see `unknown` for stairs (see Consequences).
2. **Corner shapes from Java's StairBlock.** Bedrock names the corners like Java (outer when the block
   behind the high half is a stairs block facing sideways, inner when the block in front is; left =
   counter-clockwise; measured). `stairBoxes(states)` builds slab + quarters; straight stairs give
   minecraft-data's two boxes.
3. **Stairs are walked, not jumped.** A rise into a node whose floor block's half facing the mover is
   within a step (0.5625) of the feet, and whose top is within a step of that half, is a `walk`
   (cost `walk` + `stairs` 1 tick); the same rule down (the start's floor half towards the move) makes
   descending stairs a `walk`, not a drop. Stairs met from the high half or from the side, and
   upside-down stairs, stay jumps. The rule reads the boxes (`halfTop`), not the block name.
4. **Small steps down are walks.** A step down into the cell below that is within the step height
   (onto farmland or a dirt path, 0.0625) was a `drop` (creeping to the edge, fall cost); it is a walk.
5. **Two feet heights on a stairs cell.** A node on a stairs block is the cell above it (feet + 1).
   `locateNode` already accepts a body on the low half (feet 0.5 lower, within its 0.6 tolerance) and
   the follower's "in node" / "arrived" tests use the same 0.6; a block goal whose cell is a stairs
   block (feet saved on the low half floor to the stairs cell) is planned as the node above it.
6. **One WARN line for `unreachable` without a segment**: feet, airborne, the block the feet are in
   and the one under them (with states), the start node or `none`, the goal, the last reason (search
   exhaustive / no progress with expanded count and limits / no standable node / goal not standable)
   and the plans.

7. **A failed pillar / door cell is not planned again in the same goto**, and after 2 failed places a
   goto plans without pillaring. Before, the cell went on the blacklist only at its 3rd failure, which
   was also the goto's 3rd failure: the Realm return (`blacklisted place:105,61,-50`) spent its whole
   failure budget on one pillar cell next to the (then unknown) stairs. Why that place failed is not
   known from the log; with the stairs read as 1.5-high boxes the local body and the server disagreed
   next to them, which would explain a jump that never got the feet above the cell.
8. **The follower does not jump again once the body is at the jump node's height** (it landed
   off-centre on the step): measured on the owner's house layout, a side jump onto the landing was
   followed by repeated jumps and a move timeout (175 ticks); without them 147 ticks, no timeout.

## Consequences

- 6-step oak staircase on bds-move: 53 ticks up (4.60 ticks per step, 0 jumps, 0 corrections) and 59
  down (0 jumps, 0 drops); the same climb on full blocks: 81 ticks, 9.00 per step, 6 jumps,
  2 corrections (the known top-of-climb correction, 0009).
- `PathCosts` gained `stairs` (1 tick).
- The world registry should learn the 1.26.60 stairs (and fence / pane / bars) states; until then
  callers outside `skills/terrain` (finders, the world cache, `!status` block names) see stairs as
  `unknown`. `resolveNewerState` is the place to add other blocks whose 1.26.60 states are known.
- Block-goal heuristics still ignore y, so a goal in the start's column (stairs to another floor)
  ties at 0 with the start; with stairs walkable the search finds the way, and the WARN line now
  says so when it does not.
