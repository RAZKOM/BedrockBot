# 0071: Tight cave flight (flight v2, Track F6)

Date: 2026-11-07. Status: accepted, shipped OFF (`flyCave off`, as [0069](0069-cave-flight.md) left it). Builds on
[0069](0069-cave-flight.md) (the cave style: proofs before takeoff, the bail-out, the rules), [0068](0068-real-cave-benchmark.md)
(the owner's cave as a fixture and a replica), [0067](0067-long-range-flight.md) (the corridor executor, the windows) and
[0058](0058-flight-planner.md) (the planner, the tracker). Details and numbers: [../flight.md](../flight.md) "Tight cave
flight (Track F6)".

## Context

Track F5b made cave flight safe and left it mostly walking: on the owner's cave 39 blocks of 186 were flown, route A
flew 2 of 22 legs, the shortcut was never proven, and on the generator set 80 % of the flown windows were clean against
a bar of 95 %, with a worst hit of 10.7. The owner asked whether the bot flies the cave or only finds its way through it,
and wants it to fly. Measured first on the owner's cave (the fixture, `scripts/cave-real-bench.ts`):

- The proofs failed for want of search, not of plans. A 75-block window with 7 goals has a complete, burn-robust plan,
  but one search through all its goals needed about 100 000 expansions (30 s on this PC) to find it, against the 80 000
  nodes (2 000 to 4 500 expansions) of the proof's budget: the lattice holds every speed and heading of every half-block
  cell the body may be in, and a landing right after a fast passage sends the search back through all of them.
- The hits of a proven plan came from the burn. The plan is robust to the burn's extremes (the branches at 9 and 21
  ticks); a 12-tick burn carries the body between them, where the plan's controls run into a wall the nominal path
  misses, and the tracker had no way to know (tight-107: 12 of damage, 3 ticks after the burn's end was read).
- A standing body next to a wall takes off through the margin (a proven plan with clearance 0.09 took 5.2 on the way
  out), and the planner flew through the cave's pools because water was air to it (3 of 6 windows of one trip ended in
  the water floors).
- The M4 the live bot runs on expands the same searches 1.2 to 1.3 times faster than this PC (`scripts/route-speed-bench.ts`,
  the same requests on both machines: 244 against 277 to 329 ms, 999 against 1 204 to 1 355 ms), so this PC's millisecond
  budgets are the conservative ones for it; the bench keeps them.

## Decisions

1. **The search runs in pieces** (`route/search.ts planPieces`, `RouteRequest.pieces`; the style's `pieces` 3). The
   goals are searched a few at a time, each piece from the state the piece before ends in, the plans joined into one
   (the controls in order, the states re-flown from the start). A piece that comes back partial is searched once more
   together with the piece before it, from the state before them (room to come in slower), then the joined plan is the
   partial plan. The 75-block window above completes in 300 to 1 200 ms in pieces of 3 against 30 s in one search; the
   straight-line heuristic in pieces completed every window of the corridor's first half. The pieces are each robust to
   the burn by construction (a burn still running at a boundary is branched from the boundary); the first piece's
   takeoff edges keep the standing start's rule.
2. **A geodesic distance field for the heuristic was built and measured off** (`route/field.ts`, `RouteRequest.geodesic`,
   the style's `geodesic` false). A breadth-first distance through the cells the body fits in, one field per goal,
   chained. It was first pulled into one-cell cracks of the cave's walls (the field over every air cell), then, over the
   cells the body fits in, it still completed fewer proofs than the straight line with the search in pieces (the 96-block
   window: 2 764 expansions against 886; the whole stretch 14 of 22 goals against 18) and its plan touched the wall of a
   clean 3 x 3 bore at burn 9 where the straight line's did not. It stays in the code, off, with its guard tests.
3. **The tracker re-times the plan to the burn it reads, when that is safe** (`tracker.ts retime`, `rules.retime`). A
   burn read off the body as ended early or running on re-flies the plan's controls with that burn (`primitives.ts
   replayBurns`) and, when the re-flown reference sweeps clear, the body is tracked against it (error 0.00 in the guard
   test where the nominal reference drifts away). When it hits a wall ahead, the reference stays nominal and the plan
   counts as blocked at that tick (`burnHazard`). Adopting the re-timed reference without the check made the set worse
   (2 fatal trips: the body followed a reference into a wall).
4. **A plan on a collision course within the commit horizon bails out at once** (`tracker.ts`, with `completeOnly`):
   the worker's answer comes 12 ticks later and the horizon's perturbations cannot steer round a wall in a 3-wide
   passage, so a complete plan whose reference hits a solid (within PLAN_CLEAR_MIN, not the margin: a re-timed reference
   that grazes the floor before its settle must not stop the body) `commitTicks` (12) or fewer ticks ahead brakes now.
   A re-plan asked because the plan's tail hits for an end of the burn (`burnUnsafe`) wants a complete answer (a partial
   one bails), as a blocked plan does; F4a's held candidates for that case (a yaw up to 90 off the heading) are not
   flown under the cave rules (they took a body tracking at 0.00 off its plan by 1.3 in one tick), and the burn's ends
   are judged on half the margin there. `bailError` is 1.0 (F5b's 1.5): on the set with the proofs completing, 1.5 gave
   79 % clean legs and 2 fatal trips, 1.0 gave 84 % and none at the same flown fraction. The burn read's off-by-one is
   fixed: the last nominal tick no longer reads as "burns on past the plan" (two spurious re-plans a nominal burn
   before), and a rocket the driver held (`TrackerChain.fireHeld`) no longer burns in the belief.
5. **A proof must keep clear of the walls at the takeoff** (`executor.ts proveClearMin`, the style's 0.15): a complete
   plan whose least clearance is under it is no proof; the executor walks to the window's first goal and asks again
   from there (a body standing against a wall does not take off there).
6. **The bore margin in a 3-high passage, the extra only where there is room** (`style.ts caveMargin`, `marginExtraFrom`
   4): F5b's extra 0.1 on every window cost the tight proofs (the shortcut window: 496 expansions at 0.3, 27 000 at 0.4;
   tight-107 walked at 0.4 everywhere and flew at 0.3). A wider landing zone (`landReach` 4) was measured and refused: in
   a 3-wide bore the zone is the whole floor and the plan lands beside the wall (7 scrapes at burn 21 in a clean bore).
7. **Water is an obstacle to the flight, and no floor** (`corridor/cave.ts`, `commands-fly.ts` route grid and ports,
   `stretches.ts standable(..., floor)`): the planner's grid has water as solid (a glide ends in it: no plan through or
   into a pool, the margin kept over its surface), the windows' standing cells (`standable`, `mouthCell`, `landingGoal`,
   `standableNear`) take a separate `floor` query for what the body stands on, so a cell over a pool is no landing and a
   body in a pool no takeoff (ADR 0068's rule). The shortcut's branch waypoint stands in a pool: the proof from it finds
   no edge at all until the body walks to a dry cell.
8. **The shortcut proof proves the plan first** (`cave/proof.ts`): each window's plan from standing (in pieces, at the
   proof budget) is the first plan of the proof flights, which fly it over the burn's nominal, shortest and longest. Before,
   the proof flights planned in the air with 2-second plans 40 ticks late and never landed.
9. **The e2e flies the brief's two trips** (`fly-cave.test.ts` flyC, flyS): cave_start to cave_end on the layer's
   corridor FLY_CAVE_RUNS (5) times, and the shortcut as a waypoint route (cave_5, cave_shortcut, cave_end) 3 times
   after the model's proof of it.

## Consequences

The numbers are in flight.md "Tight cave flight (Track F6)" (the owner's cave over 8 burns, the generator set, the
e2e tables). In short: the owner's cave corridor flies 44 to 50 % of its length (F5b: 18 %) with 95 % of its windows
clean and a worst hit of 2.8 over 8 burns; route A as hints 28 to 46 % (F5b: 19 %); the generator set, with the proofs
now completing in the tight caves, is 84 % clean with no fatal trip and a worst hit of 11.1 against the bar of 95 % and
under 4; the shortcut is still not proven (its branch stands in a pool, and from a dry cell the climb to cave_shortcut
has no complete plan with a landing within the budget). The bars not met are the tracker's in 3-wide passages and the
landing after a climb; the proofs are no longer what limits the flying. `flyCave` stays off.

On the replica (bds-fly2) neither new run arrived: the layer's corridor there enters through the open top over the
cave, the cruise lands on the surface by it and no window is laid from the surface (the executor walks to a cell 20
blocks down and the walk fails); the shortcut's branch stands in a pool. The open-air suites (fly-route, fly-corridor,
fly-land, fly-course on three pinned areas against main) are not worse.

## Not done

- The replica's entry: a corridor whose underground stretch starts on the surface over a y opening (the cruise's landing
  cell) lays no window; the executor should land inside (the shaft floor under the opening, as `changeCell` names it for
  a shaft) or let the cruise come down into the opening. The owner's cave on the Realm is entered at cave_start inside.
- The proof of the whole stretch at once (the funnel of the brief): the pieces prove windows of up to 96 blocks; a
  22-goal stretch of 204 blocks reached 18 of 22 goals in 20 s.
- A brake that may be flown while the burn may still run (`brake180.applies` needs `boost.max` 0: no brake for 21 ticks
  after any rocket), which is what a landing a few blocks after a climb needs; the rocket brake and the hover under boost
  are unmeasured on the server.
- Trip C's cruise landing ("no walking path from any landing cell"): not touched.
- The coarse layer's fly switch costs: not changed (the owner's cave is one fly leg of 186 already; the generator caves
  the layer walks outright, 101, 102, 104, 105 and 106, are walked for its corridor, not for the proofs).
- GPU work: none (the benches run in minutes on worker threads).
