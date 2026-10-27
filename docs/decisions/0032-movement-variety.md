# 0032: Movement variety: swimming, ladders and vines, parkour gaps, edge sneaking

Date: 2026-10-30. Status: accepted (Phase 7, wave 9 Track AJ, PLAN.md task 7.7; follows
[0009](0009-navigation-v2.md) and [0022](0022-stairs-and-partial-blocks.md)). Server: BDS 1.26.60.6
(`bds-move`, and a strict private copy for the physics). Details and numbers:
[../pathfinding.md](../pathfinding.md) "Movement variety".

## Context

The planner treated every liquid as a wall, every ladder as a 1-high obstacle and every gap as a
drop, so a river, a mineshaft ladder or a ravine ended a walk with `unreachable`. The movement model
had no climbing, no sneak edge rule, and a water model that was only good enough for a body that fell
in (swimming out with jump held cost 2 to 3 corrections). On a server-authoritative server a move the
model gets wrong is a correction, so every new move needed the server's own rule first.

## Decisions

1. **Measure the rules on a strict server.** A private copy of bds-move (`bds-movex`, udp 19147,
   `server-authoritative-movement-strict=true`, `player-position-acceptance-threshold=0.001`) answers
   every wrong tick with the server's position; scripted inputs were replayed until the corrections
   carried 0 error. bds-move itself stays on its normal settings (other tracks run their nav suites
   on it).
2. **Water physics only while the box shrunk by 0.4 reaches into a water cell** (whole cells); above
   that air physics. The climb-out lift needs the moved box free of liquid as well as of collisions.
3. **Climbing**: fall clamp 0.2 before the move, sneak holds, the jump key sets vy 0.2 before the move
   (also replacing a faster rise), a wall hit sets vy 0.2 after gravity; no horizontal clamp.
   Ladder, vine, twisting, weeping and cave vines climb; scaffolding does not (obstacle in the grid).
4. **Sneak edge avoidance** as vanilla's back-off in 0.05 steps with a 0.025 inset; the sneak speed
   factor lasts one tick past the key's release.
5. **The horizontal contact tolerance grows with the coordinates** (2^-21 x the larger of |x| and |z|,
   no push-back beyond 1e-4): float32 positions far from the origin snapped past a face and the next
   tick walked into the block.
6. **Swim only on the surface of still water**: swim nodes are surface cells of source water with two
   free cells above and no flowing water / lava beside them. No underwater travel (air is not
   modelled), no flow push (not modelled), no sprint-swimming.
7. **Climb nodes** for ladder / vine columns with entries from the foot, the side and the top, and an
   exit onto a floor beside the column up to 1 higher; a ladder's thin box no longer blocks its cell.
8. **Parkour** over 1-block gaps (walking) and 2-block gaps (a 2-block sprinted run-up behind the
   takeoff, which the follower backs up onto when it arrives without speed), landing at the same
   height or 1 lower, only over water or at most a 3-block drop, never over lava or a hazard; enabled
   because each landed 20 of 20.
9. **Edge sneaking** in the follower: sneak while the body centre is within 0.3 of an edge with a drop
   of more than 3 blocks (or lava) beyond; no sprint for 10 ticks after.
10. **Costs are measured**: swim 8.6 ticks per block, climb 5 per block up and down, parkour g x walk
    + 12 (14 one lower) + a 10-tick risk preference; entering water costs 10 extra (dry paths first).

## Consequences

- A 6-wide river, a 10-block ladder in a 1 x 1 shaft (up and down), a vine wall and 60 parkour
  crossings ran with 0 corrections and no damage; the existing nav suites stay green.
- `state.inWater` now means "moves with water physics" (the shrunk box), not contact; a body knocked
  into water re-plans from its swim node instead of retreating first.
- The planner skips the new checks until its grid has classified water / climbers / ladders, so the
  1000-path benchmark keeps its budget.
- Edge sneaking slows a walk along a deep edge (145 vs 87 ticks on the test bridge) and showed no
  measurable gain there; it is kept as a safety net.
- Not covered: scaffolding, underwater routes, flowing water, diagonal or rising parkour, jumping
  off a ladder, twisting / weeping / cave vine courses in e2e.
