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
