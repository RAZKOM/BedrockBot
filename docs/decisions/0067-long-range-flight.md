# 0067: Long-range flight (flight v2, Track F4)

Date: 2026-11-06. Status: accepted (flight v2, Track F4; builds on [0066](0066-coarse-layer.md) (the coarse layer,
Track CB), [0064](0064-route-landings-and-takeoffs.md) (route landings and takeoffs, Track F3), [0058](0058-flight-planner.md)
(the route planner, Track F2) and [0055](0055-terrain-safe-cruise.md) (the server holding the body at chunk edges)). Server: BDS 1.26.60.6
(`bds-fly3`, udp/19212, FLAT, strict movement). Details and numbers: [../flight.md](../flight.md) "Corridor flight
(Track F4b)".

## F4b: corridor flight

### Context

The owner's case: the bot at 0 100 0, the goal at 1000 0 1000, reachable only through a cave entrance part of the
way along. The cruise (FlyProcess, the takeoff chain, the landing families) flies to a point and lands there; the
route planner (Track F2) flies a bore from a state it plans from, within one snapshot of at most 256 blocks a side
and a budget that gives partial plans past about 100 blocks; the walk navigator walks, and since Track CB it
follows the coarse layer's corridors on foot. Nothing put them together: the flight landed over the goal and the
walk could not find the entrance. The coarse layer answers "which way, in which mode" over everything the bot has
seen, as legs of walk / mine / fly through volumes and portals; the flight has to price its mode on that graph and
follow its fly legs.

### Decisions

1. **Flight prices itself on the coarse graph** (`skills/fly/corridor/cost.ts`, `FlightCost implements
   CoarseCost`, registered once with `setCost('fly', ...)`). Every price is in ticks, calibrated on
   [../flight-envelope.md](../flight-envelope.md) and the measured flights: open sky at the cruise's 1.5 blocks a
   tick plus its top-up rockets (0.67 per 100 blocks); a bore of 3 x 3 or more at 1 block a tick with a rocket
   every 30 blocks (narrower x 1.5, one wide x 2.5); powered flight needs 3 high, a 2-high opening or volume is a
   glide in or a landing only (at most 6 blocks); a y portal down is the brake over it and the hover's sink
   (0.149 a tick), up it is the vertical takeoff; a rocket is the route planner's `ROCKET_COST`; unknown space is
   high but finite (8 a block underground, 2.5 between y 64 and 192, the cruise's price x 1.15 above). Water, a dig
   portal (`dug`) and a portal the flight failed at are Infinity (the layer's marks are per mode and decay, so the
   walk may still take that opening). A takeoff from standing (`switchCost`) is 60 + a rocket + the landing 100,
   refused in a volume under 3 high or unknown. `ticksPerBlock` 0.667 (the cruise's speed alone) for the
   search's heuristic.
2. **A fly leg is cut into stretches where the flight changes how it flies** (`stretches.ts splitLeg`): sky
   volumes are the cruise's, everything else (caves, surface volumes under a roof, unknown sections under y 192)
   the route planner's. At a change the stretch before lands where the next one starts from standing: just inside
   a mouth (2 blocks in, `MOUTH_IN`), on a shaft's floor, or just inside an exit. Waypoints are matched to portals
   by their centres (the layer lists the entry and the exit among the portals, not among the waypoints).
3. **The sky stretch is the cruise to an exact cell**: the `!fly <x y z>` chain (the takeoff chain, `planFlight`
   with the exact goal, FlyProcess, the landing families and the route landing of Track F3). A landing within 64
   blocks of the cell walks the rest (`SKY_WALK_MAX`; the navigator finds the way, along a roof and down its hole or
   round through a mouth): the 1 x 1 shaft took 1 to 4 go-arounds on the e2e and two runs ran out of them 31 and 35
   blocks off, and a cruise from standing that close does not fly (a takeoff, a flare and down on the spot in 14
   ticks; the cruise is made for `flyMin` 200 and up). A cruise that came down whole farther off (`landed_off`) is
   flown once more (`SKY_RETRIES` 1); after that, a crash or a failed walk, the change failed.
4. **An underground stretch is flown from standing a window at a time** (`nextWindow`, `drive.ts`): the portals
   ahead as waypoint boxes, a box every 24 blocks along a clear straight, bend points where the line between two
   anchors leaves the bore (a BFS through air pulled tight and recentred), the landing last. A window is cut at the
   first portal whose chunk is not loaded (it lands on the last loaded portal's floor; the next window starts
   there once the chunks arrive: the server holds a body at the edge of its loaded chunks, ADR 0055), at 320 blocks, and before the last bend when the tail after it is under
   40 blocks (`UNDER_TAIL_MIN`; that tail is walked). A window under 24 blocks is walked. Each window is a chain of
   route trackers (`TrackerChain`: 5 goals each, overlapping by 1, the next planned in shadow 2 goals ahead, the
   last with Track F1's landing library), because one tracker over a whole bore gets partial plans past about 100
   blocks and the tracker has no way to extend its goals. A window runs as its own `fly` process
   (`tasks/process/corridor.ts UnderFlyProcess`, FLIGHT_PRIORITY while in the air).
5. **Walk where flight does not fit**: walk and mine legs go to the navigator's own walk; an underground fly leg
   whose sampled unknown share is over 25 % (`UNKNOWN_FLY_MAX`) is walked, never flown.
6. **Failures go back to the layer**: a failed change, a window that fails three times or a failed walk leg marks
   its portal `failed` for its mode and plans again from where the body stands (at most 4 re-plans); a change
   flown through is marked `ok`. The plan asks for modes walk + fly, starting on foot, ending standing, with 4 s of
   search (`CORRIDOR_PLAN_MS`): flight is cheap in all the sky, so a covered goal makes the search exhaust the sky
   round it before it takes the way in (7 700 volumes, 2.2 s, over cold real chunks on the e2e; the layer's default
   500 ms gave a partial corridor ending in the sky over the goal).
7. **The entry is `!fly`, kept small**: an `!fly <x y z>` farther than 96 blocks whose goal is covered (no open sky
   over it) follows a corridor when the task has a provider (a registered stub, else `skills.nav.coarseLayer`)
   and the new setting `flyCorridor` is `auto` (`off` keeps the plain cruise). `!fly stop` ends the trip after its
   step. walkOut / openSkyLeg are unchanged.

### Consequences

- The flight reaches goals that are only reachable through an opening: the cruise to the opening, the bore flown,
  the rest walked. Measured on bds-fly3 with stub corridors and with the coarse layer's own: with the roof hole
  closed the layer finds the mouth partway along by itself (the fly leg comes down onto the open ground of the
  mouth's chunk and the window flies in through the mouth), with it open the layer takes the hole (found on all 5
  areas). Every case of the two e2e runs on the final code arrived with 0 damage. Two earlier stub `shaft` runs did
  not: the cruise ran out of go-arounds 31 and 35 blocks off and the stub had no other way in. The layer's own
  corridors arrived in all 10 runs, one through a re-plan (docs/flight.md "Corridor flight").
- The real layer's `surface` volumes (open air under a chunk's highest block) are flown as underground: the cruise
  lands where the sky meets them and the route planner flies on from standing.
- A fly leg costs a landing and a takeoff at every sky / underground change; a window ends on a floor. The
  underground part is slower than one continuous flight would be, and safe in its pieces.
- The chestplate goes back on at the end of a trip only; between windows the elytra stays on.
- The route tracker's missing extend / replan-with-new-goals call is worked round by the chain (Track F4a's
  file; a proposal, not a change).

## Hotfix 2026-11-06: underground stretches walked, trips end on low health or a death

The first Realm trip into a real cave died there (`death.attack.flyIntoWall`). The underground windows flew on
partial plans at the live planner budget: "corridor ahead is blocked" at clearance 0, a window handed over with no
plan yet, local-to-server errors up to 5.4 blocks, hits of 6.5 and 2.8. A golden carrot started mid-glide and took the
hotbar, so a rocket fired nothing. The trip carried on at 6 and at 3 health, and after the respawn it tried again.
The e2e bores are clean 3 x 3 tubes; real caves are not.

1. `UNDER_FLY = false` (executor.ts): underground stretches are walked. The cruise to the mouth or the shaft is
   still flown. The windows stay in the code (`underFly: true`) for a cave benchmark first.
2. The trip watches the health every tick and stops on a death or under `CORRIDOR_HEALTH_MIN` 12
   (commands-corridor.ts).
3. No meal, armour or keeper pass while gliding (the survival kit's `inactive` gate, tasks/registry.ts).

## F4a: the obstacle course and the route fixes

Status: accepted (flight v2, Track F4a; builds on [0064](0064-route-landings-and-takeoffs.md), [0058](0058-flight-planner.md),
[0057](0057-flight-manoeuvres.md) (the manoeuvres and the brake, Track F1) and [0056](0056-flight-envelope.md) (the envelope,
Track F0)). Server: BDS 1.26.60.6 (`bds-fly2`, udp/19210, FLAT, strict movement, fall damage on). Details and numbers:
[../flight.md](../flight.md) "Obstacle course (Track F4a)".

### Context

Each flight track measured itself on its own cases: F2's tunnels, F1's brake cases, F3's route landings. Nothing
flew them all in one place on one score, so a change that helped one could break another unnoticed: F0's
corrected takeoff model left F2's `fly-route` 3 x 3 tunnel scraping a wall at 1.7 to 1.9 blocks a tick. Three of
F3's open points were about how a route landing is flown, not whether it is found: the cruise handed over to the
tracker a rocket's height too high after a circle, the route was asked only after F1's brake simulation failed,
and the room at ground level ended `roof` once under load.

### Decisions

1. **The course is data, shared by the server build and the offline bench.** `packs/truth/src/course-layout.ts`
   is a pure module (arithmetic and types only): a layout is the ops that clear the course's volume (air from
   the ground up, dirt and grass under it, so a rebuild is the same world over anything left before) and build
   the stations, and the legs to fly (a start, the goals: boxes to pass or a landing spec, the planner's margin,
   chained or not). `truth:course` build, clear and list (`course.ts`) only execute the ops, in `fillBlocks`
   calls of at most 32 768 blocks inside a `runJob`, holding a ticking area over each piece. The bot's
   `route/courses.ts` imports the same module (as `bridge/commands.ts` imports the pack's protocol) and makes the
   bench's worlds and legs from it (`layoutWorld`, `layoutCourses`, `obstacleCourse`); F2's bore geometry moved
   into the shared module rather than being written twice.
2. **The stations and the full course.** Rings at 7, 12, 6, 14 and 8; a slalom of five gates 3 off the line; the
   3 x 3 S-tunnel; the 45-degree staircase 3 high from standing; a landing on a ledge under a roof 4 over it; the
   owner's stacked platforms (3 x 3 at y+20 and y+23, the inner one landed through the 2-high slot); a 1 x 1 shaft
   10 deep. The full course chains a start pad, the stair, the rings, the slalom, the tunnel, the ledge and a
   finish pad (each leg goes on from the body and the rockets the last one ended with); the stack and the shaft
   are flown from their hand-over entries. The rings, the slalom and the tunnel flown alone start standing on a
   1 x 1 pillar (11 or 9 up in front of them): the server cannot start a body in the air at a speed (a
   teleported body falls, and its glide did not always take), and a body standing still is where the plan was
   made when the worker answers. The stations the full course flies on to have no pillar in the way (a leg whose
   predecessor failed starts gliding there). The landings start gliding at the hand-over's entry at 1.0 a tick,
   the state the brain hands over in: from a pillar there the takeoff 30 up into the stack's slot is another
   problem (3 of 8 offline), and on the server the bare driver starts them from a fall, so their e2e rows are
   measured, not gated (the brain's route landings are `fly-route-land`'s).
3. **The score** (`bench.ts flyLegs`, `scoreOf`): done, clean, ticks, rockets, wall damage, hits, re-plans and
   the least goals passed, over `COURSE_BURNS` (9, 12, 15, 18 and 21 for every rocket of a run, three random
   draws). Offline a hit is flown through (`continueOnHit`) and costs F0's `wallImpactDamage`; on the server the
   damage is the hurt log's and the corrections and re-plans the driver's report.
4. **The route model follows F0 (fix a).** No rocket on the glide's first input after a jump (`glideFresh`). The
   tracker flies each candidate on the burn's earliest and latest end as well as its nominal while the end is
   unknown, adds held candidates with wider turns when the plan's tail hits for one of them and asks once a burn
   for a plan from there; the search branches a burn already running from its start; a burn past the plan's
   nominal asks for a re-plan; a rocket the driver held (`fireHeld`) leaves the belief as it was. None of that
   made the e2e's tunnel safe: no plan robust over 9..21 exists there (20 s and 400 000 nodes did not find one),
   and the plain plan's snap turns rode on the burn's last nominal ticks. Two rules did: **a rocket may be used
   once the burn may be over** (`inBurnTail`: past the burn's earliest end, 9 ticks, in the search and the
   tracker), which F0's union of two lifetimes makes safe, so the plan boosts where it turns instead of hoping
   the old burn still runs or has ended; and **a rocket on a control the tracker skipped** (the body a tick
   ahead of the reference) is fired late instead of lost. The rule from the burn's nominal end was flown first:
   12 of 13 clean offline, but on bds-fly2 both runs drew 19- and 20-tick burns, the belief's nominal moved on
   past the plan's and the plan's corner rocket was held for it (2.2 and 6.5 of damage); from the earliest end
   13 of 13 offline with a max error of 0.00, and 0 damage twice on the server. Full stacking (`stackRockets`,
   any time) made the tunnel clean as well but cost the rings and the S-tunnel their clean runs (more speed in
   the gates), so it stays off. `BURN.nominal` stays 15 (F0's mean 15.7; 10 flew worse). **The first plan of a
   gliding body is asked ahead** (`TrackerOptions.lead`, `flyRoute` with the worker: the ticks of `maxMs` and
   2): it starts where the hold takes the body by the time the worker answers, and the hold flies until then;
   an air start at 0.3 a tick fell off every first plan before.
5. **The hand-over comes down onto the glide line first (fix b).** A route target's cruise no longer circles once
   lined up on the corridor: from APPROACH_DISTANCE + 60 in, the sink still needed to reach the glide line's
   height at the hand-over decides: the level glide up to 0.15 a block, a steeper glide up to 0.2, S-turns
   along the corridor line up to about 0.25 (`routeSink`). A lap of a circle sinks 19 to 31, too coarse for the
   tracker's band (5 to 13 over the cell).
6. **Covered goals ask the route first, from the body's side (fix c).** `landing.ts ROUTE_FIRST = 'covered'`:
   under a roof the route planner before F1's brake when the route comes in within `ROUTE_FIRST_OFF` (30
   degrees) of the body's side, else the brake first and the route after it; under open sky the brake first.
7. **The corridor's entry and the tangent circle (fix d).** Near the entry the cruise follows the corridor line
   (`corridorAim`) instead of aiming at the entry point, which a body arriving more than 60 degrees off passed
   and turned back to; a descent circle tangent to the approach line is left within 7 of its tangent point at
   1.15 a tick or less (bled at pitch -5); `steerClear` climbs out on a rocket before it ends a flight `roof`.
8. **No powered flight without a safe plan** (`tracker.ts PLAN_CLEAR_MIN`, after the Realm cave death the corridor
   hotfix answers). The tracker fires a rocket only on a plan it is tracking whose least clearance is 0.05 or
   more; a plan made with the request's margin clears by more than that, one under it was asked for from a body
   already within the margin of a solid. With no plan (the first not back yet, the lead's hold, a blocked partial
   plan run out, `failed`) no rocket goes, and a held or late rocket is dropped rather than kept for the next
   plan. With no plan the level hold flies only while it sweeps clear for HORIZON ticks, else the evade rule
   steers, unpowered. The tracker does not end the flight on this itself: the drivers keep their own ends (the
   brain's go-around or landing on `failed`, `flyStretch`'s `failed` and tick cap).

### Consequences

- One command builds any course on a server with the truth pack, one bench call scores it offline, and the e2e
  `fly-course.test.ts` flies the same legs with the bare route driver.
- Plans spend a rocket on a running burn where they need the boost: the stations cost up to 0.8 of a rocket
  more each and are clean in every offline run.
- The brain's route phases fire only with no boost left on the loop (their gate), so a rocket the tracker asks
  for on a running burn is held there (`fireHeld`) until the loop's own count runs out.
- Track F4b's corridor windows fly the same `RouteTracker`, so they get the rocket rules too, the refusal on a
  grazing plan and the clear hold included (a window that takes over with no plan steers clear unpowered); the
  lead is off unless a driver sets it (only `flyRoute` does).
- `!goto` / `!come` still never land on a 2-high cell (F3's open point; `commands-fly.ts` is another track's).
- The full course's chain (the weave leg), a hand-over from farther than about 400 blocks (13.7 to 15 over the
  cell) and a covered goal approached from the side are the benchmark's open rows (docs/flight.md).
