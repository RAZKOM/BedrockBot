# 0074: Cave entry from above (flight v2, Track F8)

Date: 2026-11-08. Status: accepted, shipped OFF in the code (`flyCave off`, as [0069](0069-cave-flight.md), [0071](0071-tight-cave-flight.md)
and [0073](0073-tight-passages.md) left it; the coordinator turned it on live the same evening once the owner had set keepInventory).
Builds on [0073](0073-tight-passages.md) (the tube controller, the burns read per rocket), [0071](0071-tight-cave-flight.md) (the search in
pieces), [0069](0069-cave-flight.md) (the cave style, the proofs), [0068](0068-real-cave-benchmark.md) (the owner's cave as a fixture and a
replica), [0067](0067-long-range-flight.md) (the corridor executor, the coarse corridor's budget) and [0057](0057-flight-manoeuvres.md) (the
brake / elevator landing, the rim). Details and numbers: [../flight.md](../flight.md) "Cave entry (Track F8)".

## Context

The owner's `!fly cave_start` from home failed again on 2026-11-08 ("it's like not flying into the cave no matter what"). The Realm's
log: the coarse corridor was partial at the 4 000 ms search limit, 32 blocks short of the goal; the cruise flew to the partial end
over the cave, held over a ground "not loaded yet", found no landing it could confirm and came down 29 blocks off on the surface;
the second corridor from there was found in 2 s and, `flyCave` being off, walked, and the walk failed. On the replica no flyC run
had arrived (Track R1: 0 of 9). Measured first:

- The partial corridor is structural. The layer's heuristic is the straight line at the flight's slope; the way underground costs
  160 ticks through a mouth or 60 and a sink through an opening, then 1.7 a block. For a covered goal every sky node within a few
  hundred blocks is cheaper than the way in, and the sweep pays for every chunk it touches (1 548 chunks and 2 778 border portals in
  4 s on the replica's world, 3 of the 4 s in the graph build; 8 878 chunks in 20 s, still short). From the partial end the way in
  is found in 30 to 50 ms.
- The landing search could not see a pit. `preciseGoal` knows a shaft only where its walls touch the cell and scans the rim 20 up;
  the dry floor under a wide, deep opening (46 under the rim, 11 across) read as a plain open cell or a precision cell under open
  sky, whose approach along the glide line meets the pit's wall.
- The replica was a mesa on a flat world 160 blocks below its surface: the box's edge slices the cave open and the layer's
  corridor into cave_start went in (and flyC's went out) through that cut face, where the fixture and the Realm have rock.
- Track F7's open point: a plan robust at the burn's extremes (9 and 21) hit the margin open loop for the burns in between.

## Decisions

1. **A partial corridor is searched again from its end before anything flies** (`executor.ts CORRIDOR_JOIN_MS` 2 500, `joinCorridors`).
   The second search starts in the last leg's mode (no takeoff charged); when it is found the two corridors are joined (two fly legs
   become one, the waypoints and portals in order, the totals summed), so the cruise aims at the real change into the cave. A partial
   second search leaves the first as it was. Rejected: a bigger first budget (20 s still ends short on this PC, and the time is the
   graph's, not the search's); a goal-aware heuristic in the layer's search (Track CB's file; proposed in the report).
2. **The executor names the rim over a cell under a y opening** (`SkyHint.rim`: the opening's plane when it lies 2 or more over the
   cell), and the landing search takes it (`LandingOptions.rim`): the plain goal is skipped, the cell is a pit floor that deep, the
   brake landing is simulated in over the rim along four bearings and the elevator sinks down inside (`brakeMaxTicks` grows the
   simulation's horizon with the depth). The hint rides on the held target (`LandingHint`), so the hold circles over the rim and
   every look from the air is asked with it. Rejected: a route-planner window from the rim down to the floor (a 46-block sink is 300
   ticks of plan; the brake's law is closed loop and needs no plan).
3. **The replica's surroundings are the Realm's** (`fly-cave.test.ts buildSurroundings`, `cave.ts replicaCoarse`, `replicaTerraces`): a
   stone shell round the box's sides and the real terrain's heights round it from the extract's column tops, a chunk at a time, sent
   as fills from teleport stops; the same world for the layer offline (`scripts/cave-entry-probe.ts --source replica`). The fixture
   (solid outside the box), the replica and the Realm now agree on where the cave can be entered.
4. **The planner sweeps the burns between the extremes** (`types.ts MID_BURNS` 12 and 18, `RouteState.mids`): a rocket starts four branches
   next to the nominal body, each boosted for its own burn; an edge is taken only when all clear; a rocket in a burn's tail extends
   each branch's burn (the union); the pieces carry them across their seams and a re-plan's start drops them with the extremes. The
   benches' `nomids` variant measures the planner without them (the tables in flight.md). They are the cave style's only
   (`CaveStyle.midBurns`, `RouteRequest.midBurns`): the open-air drivers plan as before, since with them a clean 3 x 3 bore in the
   corridor unit test landed short on one seed.
5. **Speed by clearance in the planner is in the code, measured, and OFF** (`types.ts SPEED_RULE`, applied per tick in
   `primitives.ts edgeOf`): a tick flown with the swept box within `clear` of a solid beyond the margin may not be faster than
   `slow` at clearance 0, rising to `fast` at `clear`; a faster tick refuses the edge (Track F7's open point in its own words).
   Measured at 0.6 / 0.8 / 1.6 on the two generator caves that still hit with the mids it took the 8.3 to 0 and doubled the
   landed windows for the same flown distance, and cost the owner's cave nothing; but the sweep's clearance counts floors and
   ceilings as walls, so in a 3-high bore it refused the takeoff and the landing approach (fly-route's tunnels and the shortcut
   proof through a 3 x 3 bore in the unit tests). It ships off until the sweep gives a wall-only clearance.
6. **`flyCave` stays default off in the code.** The live setting is the coordinator's.

## Consequences

The numbers are in flight.md "Cave entry (Track F8)". In short: on the replica, trip C (home to cave_start, 660 blocks) arrived
5 of 5, four times down through the roof opening onto the floor under it by the brake and the elevator (0.01 to 0.02 from the
cell, 0 damage) and once by the layer's walk way (landed off, walked in, 2.7 of damage); before this track every run came down
on the surface beside the cave. flyC (cave_start to cave_end) still arrives 0 of 10: the replica's layer takes the corridor out
through the roof and back in (the cruise lands inside the second opening every time), and the walk through the pools after it
fails (Track R2's), with the first window's proof running out of its 2 s. The generator set with the mids: 96 of 96 arrived,
0 fatal, 96 % of legs clean (the bar is 95), 42 % of windows landing on their cell (13 % before), 0.18 of damage a trip (1.08),
one hit of 8.3 left (the bar is 4), 86 blocks a trip flown against 121; the speed rule, measured on the two caves that
still hit, takes the 8.3 to 0 for the same flown distance but refuses 3-high bores, so it ships off. The owner's cave: the corridor at 0 damage over 8 burns
(a hit of 5.0 before) at a flown share of 50 % (64 %); route A's hit of 4.3 to 4.4 stays. The regressions (fly-route 3 of 3,
fly-corridor 5 of 5, fly-land 5 of 5) are green; fly-course is in the tables.

## Not done

- flyC on the replica: the walk through the pools after the landed window (Track R2); why the replica's layer prefers the roof
  where the fixture's layer stays underground (the fly-over's cache against the extract); a climb's proof within 2 s.
- The speed rule on: it needs a wall-only clearance from the sweep (floors and ceilings are not what the rule is for); then the
  whole generator set with it on. Wide-106's 8.3 is what it is for.
- Route A's hit of 4.3 to 4.4 (the same window, with or without the mids and the speed rule) and wide-109's 2.9: the next trace.
- The flown share of the owner's cave (50 %): the proofs after a landed window (F6's chunk-border climb) and the executor's walk
  target (R2's), as F7 found; the mids make it lower, not higher.
- A goal-aware heuristic in the layer's search (the way underground priced into h for a covered goal) would make the first
  corridor complete instead of partial-then-joined; the search is Track CB's file.
- Server corrections of 1.2 to 1.3 (F7's open point): not measured here; the replica's trips showed 5 to 8 corrections a cruise
  and one window bailing 1.4 off after a correction of 0.34.
- The shortcut: untouched.
