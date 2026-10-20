# 0005: Pathfinding, path following and the Bedrock rules they depend on

Date: 2026-10-28. Status: accepted (PLAN.md tasks 3.3 to 3.6). Server: BDS 1.26.51.1 (`bds-move`,
flat world, truth pack). Details and numbers: [../pathfinding.md](../pathfinding.md).

## Decisions

1. **Own A\* over feet cells, not mineflayer-pathfinder.** The bot has no mineflayer `Bot` (PLAN.md
   section 2: own thin layers), the planner must use the same block shapes as the movement model,
   and its moves must be ones the follower executes with zero corrections. ~300 lines, struct-of-
   arrays nodes and a binary heap: p50 about 1 ms, max 17 to 28 ms for 1000 random paths on a
   generated 128 x 128 hilly world (budget 50 ms each), after a JIT warm-up (the very first searches
   of a process took up to 74 ms under a parallel test run).

2. **Collision shapes from minecraft-data, read by the skills layer.** prismarine-registry does not
   attach `blockCollisionShapes` to bedrock blocks, so the world model's `BlockInfo.boxes` is a full
   cube for slabs, stairs, fences and carpets. Instead of changing Track B's registry (and its
   `BlockInfo` contract), `skills/terrain/shapes.ts` maps state ids to the 1.26.30 shape table
   (the same block data the registry uses). If the registry ever fills `boxes` correctly, `boxesOf`
   can fall back to it with one line.

3. **Conservative move set.** Cardinal jumps and drops only, diagonals only on exactly flat ground
   with both side cells standable, drops at most 3 blocks, no liquids, no hazards, fences and walls
   are obstacles. Each restriction removes a class of corrections (corner clipping, falling into a
   corner, landing damage) for a small path-length cost. Parkour, swimming and climbing are later work.

4. **Pure-pursuit following with a footprint line check.** Aiming at node centres one by one makes
   the bot zig-zag on diagonals and slow down at every node. Aiming at the farthest node whose
   straight line keeps the 0.62-wide footprint on standable cells of the same height gives smooth
   paths that the planner has already proven safe. The follower never strafes: forward plus yaw
   only, like a keyboard player, so the flags are always plausible.

5. **Model BDS's own sprint rules in the InputLoop** (measured by LiteLDev/bedboo on BDS 1.26.51.1,
   LGPL-3.0, rules ported, no code copied; confirmed here): a sprint is sticky while forward is held
   (also after `stop_sprinting`), and a forward re-press within 6 ticks of the previous press starts
   a sprint on its own. Before this the sprint runs had 2 corrections per goal (server faster than
   the client after the bot "stopped" sprinting); after it 0 over 273 blocks. The follower ends a
   sprint by releasing forward for one tick and never double-taps by accident (`PressGuard`).

6. **Knockback keeps the ground state.** `set_entity_motion` for the own player replaces the
   velocity after the tagged input and re-simulates the later inputs, but does not mark the body
   airborne: BDS's next tick still uses the previous tick's ground friction (a TNT push moved
   0.546 x the push on the second tick, not 0.91 x). With that, 0 corrections on the TNT test.

7. **Unknown world is not "unreachable".** A search that touches unloaded chunks returns a partial
   path to the node closest to the goal; the navigator walks it and re-plans. Only an exhausted,
   fully known search (`none`) or a `block` goal nobody can stand in ends a goto at once. Everything
   else goes through the 3-failure budget (stuck 40 ticks, no standable node, no progress possible).

8. **Re-plan instead of repair.** A re-plan from scratch costs about a millisecond, so every trigger
   (correction, knockback, teleport, block update on the remaining path, partial end, stuck) simply
   plans again from the body's current node. No D\* Lite / incremental search structures: the
   "incremental" part of task 3.5 is the trigger set plus the cell cache invalidated by block
   updates.

## Deviations from PLAN.md

- The 3.5 unit benchmark runs on a generated hilly world (`test/unit/skills/genworld.ts`), not on
  `fixtures/1.26.51/world-chunks.jsonl.gz`: the recorded fixture is a flat world, where every path
  is trivial. The generated world has 1-block terraces, 2..4-block cliffs, water, trees with leaves
  and slabs, and is seeded (reproducible).
- Task 3.6's "3 failures" counts stuck events and failed plans together.
- Leaves are standable with a penalty (4) rather than forbidden; the planner walks around them when
  a detour costs less than the penalty.
