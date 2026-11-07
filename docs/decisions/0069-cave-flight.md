# 0069: Cave flight (flight v2, Track F5b)

Date: 2026-11-06. Status: accepted, shipped OFF (`flyCave off`). Builds on [0067](0067-long-range-flight.md) (the
corridor executor and its windows, Track F4b; the obstacle course and `PLAN_CLEAR_MIN`, Track F4a; the hotfix that
walks underground stretches), [0066](0066-coarse-layer.md) (the coarse layer the corridor comes from),
[0058](0058-flight-planner.md) (the route planner and the tracker) and [0056](0056-flight-envelope.md) (the burn's
range, the brake, the hover). Details and numbers: [../flight.md](../flight.md) "Cave flight (Track F5b)".

## Context

The owner's goal is a bot that flies through caves and lands underground. On 2026-11-06 the first Realm trip into a
real cave died there: the underground windows flew powered on partial plans at the live 600 ms planner budget,
"corridor ahead is blocked" at clearance 0, a window handed over with no plan, local-to-server errors up to 5.4
blocks, then a wall. The hotfix walks underground stretches (`UNDER_FLY = false`). The e2e bores are clean 3 x 3
tubes; real caves are not. The owner's rule: anything that can kill the bot ships off until it has passed realistic
terrain. The acceptance bar, set during the track: caves in general with no preset waypoints (the coarse layer's
corridor is the plan; the owner's waypoints are the test reference for his cave and an optional `!fly via` hint), at
least 90 % of a procedural cave set arrived, at least 95 % of the flown legs with 0 wall damage, never a fatal one; a
cave the planner cannot prove safe counts as arrived when the bot lands and walks the rest.

## Decisions

1. **A procedural cave set is the benchmark, next to the owner's cave** (`route/caves.ts`). A worm carver in the
   style of the game's own: a smoothed random walk from a mouth in a rock face, the radius swelling and shrinking
   along the way (1.5 to 4), bends, dips and climbs, vertical drops of 7 at DROP_PITCH −65, pillars left standing in
   the rooms, water in the dips. Twelve caves of three widths (tight 3 to 5 across, medium, wide with pillars),
   lengths 140 to 200, every seed fixed; each is a known world for stepBody, the fills for the truth pack, a
   TerrainSource for the coarse layer, floor cells every 20 blocks as the stand-in for the owner's waypoints. The goal
   is "caves", not one cave; the owner's cave is scored by the same bench once Track F5a's replica tooling lands.
2. **The bench flies the trip as the bot does** (`cave/bench.ts`): the corridor executor over the coarse layer's
   own corridor (the layer over the cave's terrain, FlightCost registered, no waypoints) or over a waypoint route
   (`cave/route.ts WaypointProvider`), each underground window flown from standing on stepBody by the chain of
   trackers over a dense snapshot of the window (the worker's grid), the burn drawn per rocket, hits flown through and
   scored as the envelope's wall damage, and **every plan coming back with the worker's latency** (`latencyTicks`:
   one tick per 50 ms of search). Track F4a's and F4b's benches answered plans at once; that is why their numbers and
   the server's differed, and why a style tuned on them flew into a wall on the Realm. The cruises and walks are
   stubs. The score: arrived, legs (windows) flown and clean, the damage distribution per trip, the worst single hit,
   fatal trips (20 of damage), bail-outs, rockets, ticks, blocks flown and walked.
3. **The cave style is "commit only to the cleared horizon", at the takeoff** (`cave/style.ts`, `executor.ts
   prove`). Every window is proven before its takeoff: the plan from standing through every goal of the window, in
   the route worker, at the style's budget (2 s, 80 000 nodes: the body stands meanwhile). A complete plan that is
   robust to the burn by construction flies the window as the first tracker's first plan (`drive.ts firstPlan`, the
   whole window's goals in one tracker). A partial plan cuts the window back to the goals it reached (at most
   PROVE_CUTS 3 times); a complete plan that is not robust cuts it back two goals; a plan that reaches nothing walks
   to the window's first goal and looks again from there (the next goal when it stands at the first, the stretch's end
   after two such walks). Never a takeoff on a partial plan. The windows are 96 blocks at most and the tail after a
   bend under 24 is walked. A stretch whose steps bring the body no 2 blocks nearer its end four times in a row is
   walked out (`STALL_STEPS`): one bench run flew 297 windows between two floors, bailing out onto the one it took off
   from, before this guard.
4. **In the air, a body that cannot see its way stops** (`tracker.ts TrackerRules`, all off by default). `bailAfter`
   6: six gliding ticks without a plan being tracked (the hold, the evade rule) bail out: the 180 brake at the pitch
   of −30 / −15 / 0 / 15 that sweeps clear longest, then the hover's sink to whatever floor is under the body; no more
   plans are asked for; the driver sees the ground and the executor flies again from there or walks. `partialStop`:
   two partial plans in a row shorter than the commit horizon (`commitTicks` 12) for a body with speed bail out too.
   `completeOnly`: a complete plan is never replaced by a partial one (the plan was proven; the tracker's horizon
   re-optimisation absorbs the drift), and when its corridor ahead is blocked and the answer is partial, the bail-out
   instead of the partial plan. `bailError` 1.5: a body that far off its reference stops instead of chasing a plan it
   has left. `replanLead` 12: a re-plan in flight is asked from the plan's reference 12 ticks ahead of the body (the
   worker's latency), as F4a's `lead` does for the first plan, and flies the old plan until the new one's start tick;
   asked from the body now, the answer was for a state 12 ticks old, 15 blocks behind a body that had left the old
   plan, and the tracker turned round to chase it (measured: errors of 20 to 35 blocks, then the wall).
5. **The corridor check uses the plan's own clearance, in the cave style only** (`tracker.ts corridorClear`). A plan
   from a standing start or from a body within the margin of a solid keeps less than the margin on its first edges by
   construction (`startMarginFor`), so the sweep with the full margin found it "blocked" at once and re-planned every
   4 ticks (F4b's open point), and near a landing cell it found the floor the search had excluded; with the rules on
   it is swept with min(margin, the plan's clearance − 0.02), the takeoff tick skipped, the landing's floor excluded
   as in the search. Tried on every driver, it cost the obstacle course on bds-fly2 (the rings and the tunnel
   re-planned less and scraped: ground 1 / 5, 2 / 5 and 4 / 6 twice), so the open-air drivers keep Track F4a's check.
6. **Two rules the brief suggested are measured harmful and left off**: no rocket over a speed cap (`fireSpeedMax`)
   and no rocket on a partial plan short of the commit horizon (`refuseUncommitted`). A plan's rocket is its turn;
   refused, the body leaves the plan it is tracking (1.4 to 1.7 off in 5 ticks) and hits the wall it was turning
   from. Both stay in the code for the record, with guard tests.
7. **A real cave is a sloping bore across section borders, not a chain of shafts** (`corridor/cost.ts`). The coarse
   layer's volumes are 16-high sections; a worm cave crosses their borders through wide y faces, which FlightCost
   priced as shafts (60 ticks and a sink each) and whose bore it priced at the section's least headroom (a nook of 1:
   Infinity). A y face 3 or more across both ways between two cave volumes is now a bore (cost 0 to cross, travel at
   the bore's full headroom); without this no cave of the set had a fly corridor at all.
8. **Waypoints are hints, the corridor is the plan** (`cave/route.ts`, `stretches.ts` via anchors). `!fly via <wp>
   ...` and `!fly route <prefix>` (`<prefix>_start`, `_1 .. _N`, `_end`) hand the executor a provider whose corridor
   is the waypoints in order: one fly leg whose waypoints are via anchors of the windows (a 3 x 3 x 3 box each, the
   bend points between them), with a portal at every change between open sky and cover (the cruise lands 2 inside
   it), everything else the executor's (the proof, the windows, the walk). A re-plan asked from within 4 blocks of the
   last plan's start walks its first segment. An optional `<prefix>_shortcut` is taken only when `cave/proof.ts` has
   flown the stretch from its nearest numbered waypoint through it on the model over the burn's nominal, shortest and
   longest, every window landing (or stopping within 8 blocks of its landing) with no hit and the bore's margin kept;
   a plan alone was no proof (the search from standing to a landing 31 on in a clean 3 x 3 bore came back partial at
   4 s while the chain flies it). The proof runs in a worker over a snapshot of the route grid.
9. **One setting, `flyCave off|on`, default off.** It is the only way powered underground flight is turned on: a
   corridor trip (`!fly <x y z>` to a covered goal) and the waypoint routes fly their underground stretches in the
   style with it on and walk them with it off. The style's executor options and tracker rules go through
   `commands-corridor.ts TripStyle`.

## Consequences

- The procedural set, the layer's corridor, no waypoints, 8 burns a cave (9, 12, 15, 18, 21 and three random draws),
  the live budget (600 ms in flight, 2 s standing), plans with the worker's latency: 96 of 96 trips arrived, 0 fatal
  (F4b's flight as main has it, `underFly` on: 9 fatal of 72), 114 of 143 windows clean (80 %), 1.26 of damage a trip
  (F4b's: 8.19), the worst single hit 10.7, 95 bail-outs; the tight caves and two others walked outright (no window
  proven, or the layer walks them). The 95 % clean-legs bar is **not** met; the open points say where the rest of the
  hits come from (the tables in flight.md).
- The owner's cave (Track F5a's fixture through `scripts/cave-real-bench.ts`: the layer's corridor from cave_start to
  cave_end with no waypoints, route A as hints and leg by leg, route B, trip C, the shortcut proof): the tables in
  flight.md. The shortcut is never proven (the proof flight stops and sinks 13 to 14 blocks short of the landing with
  no hit), so `!fly route cave` would fly the full route; the corridor trip flies two windows clean and walks the
  rest. The walks are stubs offline; on the Realm they are Track W1's water walking now.
- Nothing flies underground unless `flyCave on`: the Realm bot behaves as the hotfix left it.
- The open-air drivers (the brain's route landings and takeoffs, the obstacle course) carry no rules and fly as Track
  F4a left them, the corridor check included.

## Not done

- The server replica runs (fly-cave e2e on bds-fly2 / bds-fly3): F5a's tooling.
- The GPU rollouts the brief offered: not needed; the bench runs 108 trips in about 3 minutes on 12 worker threads.
- `extend(goals)` on the tracker: the chain's shadow trackers and the proven whole-window plan made it unnecessary here.
