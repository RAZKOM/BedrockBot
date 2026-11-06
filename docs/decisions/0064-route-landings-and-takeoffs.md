# 0064: Route landings and takeoffs (the planner in the flight)

Date: 2026-11-05. Status: accepted (flight v2, Track F3; builds on [0057](0057-flight-manoeuvres.md) (the manoeuvre
library and the brake landing, Track F1), [0058](0058-flight-planner.md) (the route planner, Track F2) and
[0056](0056-flight-envelope.md) (the envelope, Track F0)). Server: BDS 1.26.60.6 (`bds-fly3`, udp/19212, FLAT, strict
movement). Details and numbers: [../flight.md](../flight.md) "Route landings and takeoffs (Track F3)".

## Context

Track F1 lands where the flare cannot (a pillar top, a shaft floor, a cell under a roof 3 above) with the brake /
elevator family, and Track F2 plans and flies routes through tunnels, but nothing in the flight calls the planner:
`flyRoute` was the e2e's entry, the landing families still refuse every cell with less than 3 blocks of room
(`PRECISE_HEADROOM`), and the takeoff chain ends with the walk-out legs. The owner's headline case is exactly such a
cell: a 3 x 3 platform with another 3 x 3 directly over it, 2 blocks of air between them (the gliding box is 0.6
high; Track F0 measured that a 2-high bore flown in at pitch -10 keeps the glide and at pitch 0 the box sinks onto
the floor, which on a cell is the touchdown). Two more things were open: the route search missed the floor of a
1 x 1 shaft 10 deep within 60 000 nodes although the edge chain exists, and the live route driver duplicated the
controller's rocket plumbing.

Track F0's envelope arrived during the track and changed the takeoff model: the glide takes from the 2nd airborne
input of a jump (not once the body falls), a rocket works only from the input after the glide's first, the burn is
9 to 21 ticks and two rockets are the union of their lifetimes, and no jump glides under a 2-high ceiling.

## Decisions

1. **The planner decides what is landable; the families keep what they have** (`landing.ts preciseGoal`). An
   exact goal (`!fly <x y z>`) that is no plain floor is tried as before (the brake from above or along a
   corridor); when that fails, or the room over it is only 2 (`ROUTE_HEADROOM`), `route/landing.ts
   planLandingRoute` searches a plan from an entry state onto the cell's floor cells, bearing by bearing (the body's
   side first, under a roof the corridors' bearings), each at the greedy weight then the plain A*
   (`ROUTE_WEIGHTS` 2 then 1), in the worker. The first complete plan makes the cell a precision target carrying
   `route` (the bearing, the entry, the goals, the margin, the plan's effort) and the bearing as a Track BF
   corridor. Nothing is simulated twice: the plan found before the takeoff is the proof, the tracker re-plans from
   the real state in flight.
2. **The entry is where the cruise puts the body** (`ROUTE_ENTRY_OUT` 40, `ROUTE_ENTRY_UP` 9 over the top or the
   rim, 1.0 a tick heading in): the glide line's own arrival, so the plan found offline is the plan the tracker
   starts near. The brain hands over within `ROUTE_HANDOVER` (44) on the bearing's side (`route` phase) and the
   RouteTracker flies the rest with Track F1's edges (`library: 'landing'`), the search in the worker
   (`RoutePlannerClient`); a rocket burning at the hand-over is seeded into the tracker's burn range. No plan for
   40 ticks or no touchdown in 400: a go-around, which hands over again. The flight ends as any other once the body
   stands (`outcome`: on the floor's cells counts for a precision target with cells).
3. **The search gets three things it lacked** (`route/types.ts`, `search.ts`, `primitives.ts`):
   - a landing goal with **cells** (the floor's: a touchdown in any of them lands; the settle aims at the centre
     one);
   - a **`via` hint** for the heuristic: over the rim for a shaft (the way down at the hover's sink), beside the
     mouth of a low room at the slot's height (the creep in): the heuristic no longer flies straight at a floor it
     cannot reach straight, which is why the 1 x 1 shaft was never found;
   - a **heuristic weight** (`f = g + weight x h`, default 1): the greedy search finds a landing's long edges
     (an approach of 40 ticks, the settles) in a few hundred nodes where the plain A* drowns in the open air over
     the cell; the pocket in a cliff face wants the plain one (the dive before the turn in).

   The margin follows the passage's narrower side (`specMargin`: a 1-wide shaft 0.1, a 2-high slot 0.12, a 3-high
   room 0.2, the open 0.4); a shaft had been getting the open-air 0.4 and could not be entered at all.
4. **The route takeoff is the last step of the takeoff chain** (`route/takeoff.ts`, `commands-fly.ts
   takeoffFor`): after the ledge, the jump on every heading and the vertical takeoff are refused, the air around the
   start is flooded for the nearest cells under open sky and a plan from standing (the jump, the glide from the 2nd
   airborne input, a rocket from the glide's second input) to a waypoint box 2 to 6 over such a cell is searched; the
   brain flies it with the tracker as its takeoff phase and the climb goes on from the exit. Under a 2-high ceiling
   the planner refuses at once (the jump never glides: F0), so the owner's inner platform is left by the ledge
   takeoff (a small platform) as before.
5. **Track F0 in the route code**: the burn range 9..21 (`BURN`), `GLIDE_DELAY` 1 (one input of plain physics after
   the jump), the driver and the harness request the glide from the first airborne tick (the loop holds it one
   input), the tracker re-issues a rocket the body could not use yet on its first gliding tick, and the brain's
   route takeoff fires from the second gliding tick.
6. **One rocket hand** (`fly/rocket.ts RocketHand`): the controller and the live driver share the item use, the
   cooldown and the rocket entity's life, with F0's rules: the own rockets are a set (the boost ends with the last
   removal, never while a newer use waits for its entity), a use with no entity within 5 ticks fired nothing and its
   boost is taken back, the loop's own refusal of a glide request is no glide end.
7. **One setting**, `flyRoute auto|off`: `off` keeps the Track F1 search and chain (no route landing, no route
   takeoff). The planner runs only for a precision goal the brake refuses and for a takeoff everything else refuses,
   so a plain flight never pays for it.

## Consequences

- **Offline (stepBody).** From the planned entry (40 out, 9 up) the planner finds every case in 76 to 1 118 nodes
  (the stacks 2 and 3 high, the holes 2 deep, the 1 x 1 shaft 10 deep, the room at ground level, the pocket in the
  cliff face) and the tracker lands each with 0 hits in 3 of 3 seeds, error 0.00. Whole trips of the brain land on
  the goal cell of the 2-high stack through the hand-over (149 ticks on the tracker: the cruise hands over 26 high
  and slow, the tracker comes down); the 3-high stack and the room are Track F1's brake corridor landings (the
  planner is not asked). The route takeoff flies out of the 3-high stack, a hole and a low room on the model (1
  rocket, 7 to 11 ticks) and refuses the 2-high slot. The numbers are in flight.md.
- **On bds-fly3** (`fly-route-land.test.ts`, every case twice plus the takeoff out): the owner's inner platform
  under 2 of air is landed by the route twice, 0.05 and 0.41 from the centre, 0 damage, 1 rocket, 1 correction (63
  and 77 ticks on the tracker), and left by the ledge takeoff; the 3-high stack, the holes, the shaft, the room and
  the pocket are landed by Track F1's brake or flare, 0.02 to 0.11 off, 0 damage, and left by the ledge or the
  vertical takeoff. The route takeoff out of the room flew out in 9 ticks but its rocket went one input early and
  the climb's path check ended the flight `roof` on the ground outside (0 damage): the rocket now goes from the
  third gliding tick and the climb's path checks wait for 6 of height after a route takeoff (run 2 in flight.md).
- **The search's cost** in flight: the tracker's first request in the worker, 40 000 nodes / 600 ms; the plan before
  the takeoff up to 6 bearings x 2 weights x 800 ms when nothing fits (a cell that is not landable is then said so
  after a few seconds; a landable one is found on the first bearing in tens of milliseconds).
- **Not done**: a `!goto` onto such a cell (the walk-landing search keeps its 4 of headroom); the cruise's descent
  before a corridor target still arrives high and circles; the tracker in a 1-wide bore; a route into a staircase
  from its flat section (F2's benchmark, not re-flown here); the wall-damage rule of F0 is not a cost in the
  search; the continuous boost (the union of lifetimes) is known but no manoeuvre uses it.
