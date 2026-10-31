# 0047: Flight landing v3: land only where a walk is confirmed, never in water, under overhangs

Date: 2026-10-30. Status: accepted (Phase 7, wave 11 Track BF; builds on [0042](0042-elytra-flight.md)).
Server: BDS 1.26.60.6 (`bds-fly`, udp/19204, strict movement). Details: [../flight.md](../flight.md) "Landing v3".

## Context

Two Realm failures on 2026-10-30 with the owner's mob farm (a 9 x 7 platform 70 up, under a spawning
box that overhangs it, a room with a ladder and an open trapdoor under the platform; the waypoint
`gunpowder` is in the room):

- 18:52Z `!fly gunpowder` aimed at the waypoint itself (in the box's shadow), flew 4 go-arounds,
  then the emergency landing picked the nearest "ground" ahead: the sea floor at -73 48 2156, under
  water. Every goto after that failed with `no standable node` (the planner swims on the surface only)
  and the bot sat on the bottom for minutes (alive by Protection IV, Respiration and eating); pve
  logged the drowning damage as `probably <some mob>`.
- 00:04Z `!goto gunpowder`: the landing cell came from the world cache (40 176 60, the box's roof);
  once the chunks loaded `landingNear` returned the same roof cell (its probe plan failed, but the
  roof still won the walk estimate) and the flight silently kept it. The goto from the roof:
  `no path (exhaustive search, 1832 nodes)`.

The owner added: a landing that is only a stop on the way to a walk was still flown as a precision
landing ("loop after loop" of go-arounds for being off-centre), and asked to try sneak at the
touchdown.

## Decisions

1. **A landing near a goal is chosen only with a confirmed walk** (skills/fly/landing.ts
   `findLanding`). Candidates are dry, sound cells (open sky, or under a roof with a corridor) in
   rings around the goal; they are tried by estimated walk (path blocks lower bound) with a bounded
   probe plan each (reach.ts `probePath`, 6000 nodes, 400 ms, at most `flyLandProbes`, 6 s in all);
   the first found path whose cost the remaining lower bounds cannot beat wins. Cells come from the
   live world model only: a column the cache alone knows is never landed on; under 85 % of the
   columns around the goal loaded the answer is `unknown`, and the flight **holds** (circles high,
   rockets as needed) until it is loaded (`flyHoldS`, then the nearest dry ground). The choice is
   re-checked every 40 ticks until 6 blocks out (not only until 15 out). With nothing confirmed the
   flight lands on the nearest dry ground, says so, and still tries the walk. One log line per search
   names every probe and its result.
2. **Dry ground only.** Water, lava, bubble columns, kelp and seagrass within 3 blocks over a column's
   top make it unlandable for every landing path: the walk landing, `groundAt` (the emergency
   landing and the descent picks), the hazard list (cactus, magma, fire, powder snow, dripstone,
   lily pads, scaffolding).
3. **Overhangs are landed under along a simulated corridor.** A cell with at least `flyHeadroom` (4)
   free over the feet is landable when a corridor of free cells leads from it to open sky within
   `flyOverhangDepth` (10) blocks and then 40 blocks out along a gently rising line; the approach
   along it is simulated with the ApproachPlanner on stepBody before the cell is offered. The brain
   then flies to the corridor's entry (64 out), comes in along its bearing (tangent descent circles on
   that line only, the go-around out and back along it, the go-around height ignoring the roof's own
   columns).
4. **A walk landing accepts any safe cell of the plateau** (the `cells` of the target, scored by the
   walk cost): the planner's touchdown cost for such a target weighs being off-centre at 0.3 per
   block, the slide out of the set at 30 per block; a go-around only when the touchdown is unsafe.
   `!fly <x y z>` keeps the exact landing when the goal itself is landable. Every go-around logs its
   reason (`flight: go-around 2: no landing plan for 16 ticks (best: short, cost 82, ...)`).
5. **`!fly` flies, then walks** like `!goto` (block goals, waypoints, home, a player).
6. **Underwater recovery is a swim straight up.** A goto that fails with the head under water swims
   up (the jump key; 0.135 blocks a tick) and plans once more (BotSkills.goto); an auto process above
   flee (`surface`) swims up and walks to the nearest dry ground when the head stays under water for
   3 s (or the server's air drops under 100 of 300). Damage with the head under water and the air out
   is logged as drowning, not as a mob.
7. **Sneak through the touchdown** (`flySneakLand`, on): from 2.5 blocks over the landing cell in the
   approach / land phase until the flight ends; released then (the walk sets its own keys).

## Consequences

- A farm-like goal (a room under a platform) is landed near and walked to; a goal under a roof wider
  than the corridor depth lands outside it on the ground; the sea floor is never a landing.
- The hold costs time when the goal is far beyond the view distance (circling until the chunks come),
  capped by `flyHoldS`.
- The open trapdoor over the farm's ladder is not passable for the planner (canWalkThroughClass: it
  has boxes and is not climbable); the probe fails there, so the owner's real farm falls back to the
  nearest dry ground until Track BG's trapdoor moves land. The e2e replica uses a bare hole.
- astar.ts / grid.ts are unchanged.
