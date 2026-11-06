# 0058: The kinodynamic flight planner (routes through the voxel grid)

Date: 2026-11-05. Status: accepted (flight v2, Track F2; builds on [0042](0042-elytra-flight.md),
[0047](0047-flight-landing-v3.md), [0054](0054-glide-down-and-ledge-takeoff.md), [0055](0055-terrain-safe-cruise.md)
and the planner worker of [0023](0023-planner-worker.md)). Server: BDS 1.26.60.6 (`bds-fly3`, udp/19212, strict
movement). Details and numbers: [../flight.md](../flight.md) "Route planner".

## Context

The flight of Track AU flies the open sky: a climb, a cruise along the glide line, a planned landing. The owner
wants the bot to fly like a skilled player: through a random tunnel with curves and turns, out of a tight place
(the stretch goal: up and out of a diagonal staircase), and at the end through an obstacle course. None of the
existing pieces searches a path in the air: `pathAhead` looks 20 ticks along one heading and `steerClear` tries
a handful of fixed dodges, the `ApproachPlanner` optimises a four-parameter profile for one landing and the
descent geometry picks a circle by the columns. A tunnel needs a search over the body's state in the voxel grid
with the real physics as its edges.

The physics is known: `glideVelocity` matches the server within 0.002 a tick (0042). Under a rocket the body is
a drone at about 1.6 blocks a tick whose velocity follows the look with a two-tick lag; without one a 90-degree
turn needs a radius of 6 (look 90 off, half the speed lost) to 15 blocks. The real uncertainties are the rocket's
burn (12 to 18 ticks at random, its end known about 3 ticks late through `remove_entity`), the cells the model
has not loaded, and anything the server does differently for manoeuvres not yet measured (Track F0's job).

## Decisions

1. **The problem** (`fly/route/types.ts`). The state is the feet position, the velocity, the look yaw, the
   boost ticks left as a range (`min`, `max`, the `nom` the plan is simulated with), the gliding flag, the
   rockets in the hand and the goals passed. A control is a tick's yaw, pitch and rocket use (plus the jump and
   glide request of a takeoff). The body is the 0.6 x 0.6 x 0.6 gliding box over the feet. A goal is a region
   with a constraint: a waypoint box to pass through, or a landing cell to touch at under 0.3 blocks a tick.
   A takeoff is a start state that stands. Unknown cells are solid (the sky check's rule, not the cruise's).
2. **Swept collision in moveBody's order** (`grid.ts sweep`). A tick moves the box up to 2.5 blocks, and
   moveBody moves it along y, then x, then z: the sweep samples the box every quarter block along those three
   legs (not the straight line, not the hull) against the solid cells of the move's hull, with a margin round
   the box and the least distance as the risk term. The hull alone failed every diagonal bore (its corners),
   the straight line passed a 45-degree staircase the real body hit at its step's ceiling.
3. **Hybrid A\* over the glide state with manoeuvres as edges** (`search.ts`, `primitives.ts`). The closed set
   lives on a lattice (half-block cells, 15-degree headings, speed, sink and boost buckets, the rockets, the
   goals passed); each expansion flies every primitive of the library from the node's exact state for 3 ticks
   on the formula through the grid. Cost: ticks + 20 per rocket + the risk. Heuristic: the chained distance
   through the remaining goals over the boosted speed, plus the rockets a climb beyond the energy height
   (vy^2 / 0.08 + 11 h^2) needs, infinite when the hand cannot buy it; a landing adds the ticks to bleed the
   speed and to come down at 0.2 a tick (a weighted A*, not strictly admissible: a steep dive is faster than
   the boosted speed and the bleed is an estimate). Budgets in nodes and ms; the best partial plan (most goals,
   then nearest the next) comes back when they run out.
4. **The primitives are a `Maneuver` interface, the minimal library is temporary.** A manoeuvre is a pure
   control law (`control(start, now, tick)`), an applicability test, a duration and an optional early end; the
   planner simulates it and takes the swept boxes, ticks, rockets and clearance from the simulation, never from
   the manoeuvre's own estimate. The library here: steady glides, coordinated turns (the look held 25 / 50 / 90
   degrees off the velocity), powered snaps (a rocket with the look snapped 45 / 90 off), straight boosts at
   several pitches, the boost held, the 180 brake, the hover flip, the settle onto a landing cell and the jump
   takeoff. Track F1's manoeuvres plug in through the same interface (the list in flight.md).
5. **Robust to the burn by construction, then checked** (`primitives.ts` burn branches, `robust.ts`). From
   every rocket the search carries two shadow bodies, the burn at its shortest and its longest, stepped with
   the same controls and swept like the nominal: an edge is taken only when all three clear, until the
   shadows converge back onto the nominal. When no complete plan exists that way the search runs once more
   without the branches and the plan says `robust: false`. A finished plan is re-flown open loop with every
   burn end 12..18 of every rocket (and all shortest, all longest) and reports the least clearance. The
   alternative, the continuous boost (re-firing before the earliest end), waits for F0's measurement of
   stacked rockets.
6. **A receding-horizon tracker flies the plan** (`tracker.ts`). Every tick the real body is matched to the
   plan's reference state nearest in time; the plan's next control and small yaw / pitch perturbations are
   each flown 8 ticks on the formula followed by the plan's controls, scored by the distance to the reference
   path and a hit penalty, and the best first tick is flown (the landing planner's way). The burn is read off
   the body's velocity (the boosted and the plain glide step differ by far more than the server's noise), so
   an early end is known a tick after it, not three. A new plan is asked for from the real state when the body
   is a block off the reference, when the corridor of the next 20 plan ticks is blocked in the grid (newly
   loaded chunks, a changed block), when a correction moved the body, when the burn ended before the plan
   assumed, or when the plan runs out; the old plan is flown meanwhile, a level glide held with none. A
   planner answer with no edge from the body's state (within the margin of a wall) is met by an evade rule
   (the control clear of a hit the longest, no margin) while the planner is asked again.
7. **The search runs in a worker when it is heavy** (`worker.ts`). The same file as a `worker_threads`
   Worker (the 0023 pattern), the grid crossing as a dense snapshot of the box around the start and the goals
   (one byte a cell, transferred), one search at a time. The in-thread search answers synchronously for the
   benchmark and short budgets.
8. **The benchmark is the regression** (`courses.ts`, `bench.ts`, `test/unit/skills/fly-route.test.ts`). A
   seeded generator of tunnels (cross-sections 1 x 2, 2 x 2, 3 x 3; curves of radius 4 to 16, 90-degree
   corners, climbs and drops, the 45-degree staircases 3 and 2 high, 1-high slots) and open-air fields, each a
   fully known world over the flat ground and the fill boxes that build it on a server; flown on stepBody by
   the tracker with the burn drawn at random per rocket and its end told 3 ticks late. The unit test asserts
   the 20 courses the planner does with 0 hits and reports the rest; the e2e builds three of them with the
   truth pack on bds-fly3 and flies them twice.

## Consequences

- Offline, 21 of 23 standard courses are flown with 0 hits (the tables in flight.md): every 3 x 3 tunnel
  (curves down to radius 4, corners, climbs, drops, the random ones), the 2 x 2 corner, S-bend and radius-8
  curve, the 1 x 2 straight, the 1-high slots, the 3-high staircase from standing, the three fields. Not done:
  the 2-high staircase (the envelope said 2.2 blocks are needed; the jump is clipped by the ceiling and no
  edge keeps the margin) and one of two random 2 x 2 tunnels (fast diagonal flight in a 2-wide diagonal bore
  collides on the per-axis path).
- A first plan costs 5 to 500 ms in a tunnel, up to 2 s (the budget) on a long random 3 x 3; the tracker's
  per-tick work is under a millisecond. The live driver runs the search with a 300 ms budget in-thread for the
  e2e; the worker is ready for the integration.
- The track does not edit physics.ts, inputLoop.ts, brain.ts, landing.ts, plan.ts or controller.ts. The
  rocket plumbing of the live driver (`live.ts`) duplicates the controller's `fire` / entity match (noted
  there); the integration (Track F3) should lift it into a shared helper.
- On bds-fly3 (flight.md "Measurements (Track F2)", run 6): the 3 x 3 tunnel with a curve and a corner is
  flown from standing to its exit twice with 0 damage (39 ticks, 2 rockets; one wall touch in the second run);
  the 2 x 2 S-bend entered from the open air once in two (0 damage both); the 3-high staircase climbed to its
  top twice but scraped (8 and 13 of flyIntoWall). Four facts the rounds measured drive the driver: the server
  starts a glide only once the body falls (7 ticks after a jump, so the glide is requested on a falling tick
  and the planner models the jump as plain physics until then); a rocket used before the server's gliding
  flag does nothing (the driver holds it); an in-thread search of 300 ms stalls the loop 6 ticks (the e2e
  plans in the worker); the local model is stale right after a truth-pack build (the e2e waits for it).

## Not done

- The landing goal lands on a 1 x 1 cell in open air offline (the brake, then the settle); it is not the brake /
  elevator landing of Track F1 and has not been flown on the server.
- No chat command: `flyRoute` is called by the e2e only; the full integration into the flight (a route mode
  of `!fly`, the takeoffs of Track F3) comes later.
- The heuristic speed and the landing terms are estimates; the lattice's buckets are untuned. The search
  explores up to 40 000 nodes on a hard course; a better heuristic (a distance field through the bore) would
  cut that by an order of magnitude.
- Rockets never stack in the search (`stackRockets` false) until F0 says what the server does.
