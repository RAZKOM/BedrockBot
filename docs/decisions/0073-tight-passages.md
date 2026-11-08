# 0073: Tracking in tight passages (flight v2, Track F7)

Date: 2026-11-07. Status: accepted, shipped OFF (`flyCave off`, as [0069](0069-cave-flight.md) and [0071](0071-tight-cave-flight.md)
left it). Builds on [0071](0071-tight-cave-flight.md) (the search in pieces, the re-timed reference, the bail-out within the
commit horizon), [0069](0069-cave-flight.md) (the cave style, the proofs, the bail-out) and [0058](0058-flight-planner.md)
(the planner, the tracker). Details and numbers: [../flight.md](../flight.md) "Tight passages (Track F7)".

## Context

Track F6 left the cave style flying 44 to 50 % of the owner's cave with 0 to 0.35 of damage a trip, and the generator set 84 to
93 % clean with a worst hit of 11 to 13 and one fatal trip in the nodes-bound run: in 3 to 4 wide passages the tracker lost a
proven plan under a burn other than the plan's nominal faster than the bail-out stopped it, and nearly every window ended in a
bail-out rather than on its landing cell. Measured first, window by window, with the tracker's own view of every tick (the
bench's trace: the reference matched, the plan's control, the burn believed):

- **The windows were not lost to the walls but to the reference.** A burn read as ended early re-flew the plan with that burn
  (F6's `retime`); where the re-flown controls hit, the reference stayed nominal, boosted on away from the unboosted body, and
  the error bail (1.0) stopped a body that was tracking at 0.00 three ticks before, in the open (5 of 5 bail-outs of one
  tight-107 trip). Where it was adopted, the next re-timing gave the rockets read earlier their nominal back and the reference
  jumped 1.5 off the body.
- **The plans' rockets were never fired when they were planned.** The search fires a rocket in a burn's tail (F4a: from 9 ticks
  after the one before) and plans a fresh boost from it; the corridor driver and the bench held every rocket until the running
  burn's end. The plan's reference boosted on, the body did not, and the window bailed out "off the plan".
- **"Robust by construction" was not robust.** The proofs' plans re-flown open loop hit at the burn's own extremes (tight-107's
  first window: 9 and 21 both hit about 20 ticks after the first rocket), because the search in pieces started every piece from
  a plain replay of the one before, without the burn branches; and even in one search the burns between the branches hit the
  margin (the controls are a timetable: a body the burn carried farther takes a bend late).
- **The bail-out was decided on the reference, not the body**, and it dropped the body wherever it stopped: on the owner's cave
  13 of 25 bail-outs sank into pools, and a body in a pool has no takeoff.
- **The landing was replayed, not flown.** The plan's last edges are the brake landing's station-keeping law recorded open loop;
  the real body, a little off, hovered down 0.5 to 1.6 beside its cell and bailed out or sank into the pool next to it.

## Decisions

1. **The tube controller** (`tracker.ts`, `TrackerRules.tube`, on in the style). The body is matched to the plan by POSITION
   (up to LOCATE_AHEAD 8 states ahead of the time index, never behind the last match), the horizon's tracking cost is the
   distance to the nearest reference point round the tick (the path, not the timetable), the candidates hold a yaw or pitch
   offset over the whole horizon besides the first tick, and when the plan's own control collides within the horizon, wider
   offsets (25 to 70 degrees, held) are tried before the brake.
2. **The body's own forecast decides the bail-out.** Every tick the control chosen is re-flown at PLAN_CLEAR_MIN (a collision,
   not the margin) over the horizon with the plan's controls after it; a collision within the commit horizon, at any speed,
   brakes now (a brake 3 ticks before a wall halves the hit; a slow touch may be a pool). The reference's own collision course
   (F6) no longer bails under the tube; the re-timed reference is adopted also where the plan's controls hit (the hazard asks
   for a complete plan once), and every candidate hitting the margin asks for a plan once per plan.
3. **The burns read are remembered per rocket** (`burnsRead`): a re-timing re-flies the plan with every burn read so far.
4. **A plan asked from ahead is dropped when it starts over NEXT_PLAN_FAR (1.5) from the body** when it is due or comes back
   late: the reference moved since (a re-timing), and adopting it put the body 4.5 off at once.
5. **The landing is flown closed loop** (`settleControl`): a slow body (under 0.5) within 4 of its landing cell and above its
   top flies the brake landing's law from its real state: the station keeping at pitch -30 while faster than 0.35 (the height
   held), the look at the cell nose up (pitch -15: 0.4 a tick for 0.07 of sink) while farther than 0.6 from it, the station
   keeping's flip over it.
6. **The bail-out's sink creeps onto a dry floor** (`TrackerOptions.floor`, `sinkTarget`): the first solid under the body's
   column when it is a floor, else the nearest column within SINK_REACH (3) whose first solid is a floor with air at the body's
   height and down to it and no more than 6 below; the creep is the settle's. The corridor wiring and the bench pass the floor
   query (the real solids; water is solid to the grid only).
7. **A rocket goes when the tracker asks for one** (`drive.ts`, the bench), a burn still running or not, as the open-air route
   driver fires: the tracker's belief applies the plans' rule (none before the burn's earliest end) and the loop extends the
   boost to the later end (F0: the union of the two lifetimes). The bench ends the belief's burn with the last rocket's removal,
   as the loop does.
8. **The pieces carry the burn branches** (`search.ts planPieces`, `primitives.ts replay(..., branches)`): a piece starts from
   the piece before re-flown with the branches on, so its edges are swept for the bodies the earlier rockets may have left
   behind or ahead. The in-between burns still hit the margin open loop (the controls are a timetable); the tracker is what
   keeps the body off the walls, and the plans' robustness is a statement about room, not a guarantee.
9. **`blockedBail`** (`TrackerRules`): F5b's bail-out on a blocked complete plan whose re-plan is partial is a rule with a
   switch, measured both ways (flight.md's tables say which the style keeps).
10. **The burn may end now** (`END_FORECAST` 3): while the burn may end, if no candidate (the wide ones included) keeps clear of a
    WALL for 3 ticks without the boost, the brake begins now. A plan's brake or turn flown under the boost met the wall when the
    burn's last tick was plain, 7 to 11 of damage one tick after a clear forecast. The floor is not a wall (the plan's dive in a
    clean bore sinks to it without the boost and a nose-up candidate pulls out of it).
11. **`bailError` needs LOST_TICKS 3 ticks over** under the tube: a re-timing moves the reference, not the body, and the horizon
    converges in a few ticks.
12. **A portal behind the body's progress along the stretch counts as passed** (`stretches.ts progressAlong`, `PROGRESS_FAR`; Track
    R1's file, one rule added and flagged to R1): the owner's corridor crosses a z face and comes back to that z 37 blocks on, and
    every window laid from the landing there flew back to the face and landed where it took off (windows 2 to 6 of a trip).
13. **The bench counts what the brief asks**: windows that landed on their cell (`landed`), the tracker's worst tick (ms), and a
    trace with the tracker's view of every tick (`TrackerOutput.debug`), with a fixed latency for reproducible runs.

## Consequences

The numbers are in flight.md "Tight passages (Track F7)". In short: on the owner's cave the corridor flies with 0 damage in 7 of
8 runs of every row (one hit of 4.2 to 5.0 in one burn when it hits, the same spot) and route A with one hit of 3.0 in one burn,
never fatal; the windows land on their cells 20 to 30 % of the time (13 % before, nearly all bail-outs) and the flown share is 50
to 59 % honest blocks (F6's 44 to 50 % counted windows flown back and forth); the generator set is 92 % clean with 0 fatal trips
(85 %, 1 fatal before), a worst hit of 9.7 (12.8) and 73 % of the flown caves' blocks flown (59 % of the set's); the tracker's tick
costs 5 to 18 ms at worst on this PC. On bds-fly2 route A arrives 22 of 22 three times with 0, 0 and 1.0 of damage, its two flown
windows bailing out before their cells after corrections of 1.2 to 1.3. The 95 % and under-4 bars of the set and the 70 % flown
share of the owner's cave are not met; what caps each is named in the open points, and `flyCave` stays off.

## Not done

- A planner that prices speed by clearance (or refuses rocket edges in tight sections): the hits left are a brake or a turn at
  full speed next to a wall whose margin a burn's last tick eats; the tracker can halve them, not remove them.
- The executor's cut-back and walk target when a proof is partial after a landed window (Track R1): the owner's cave's second
  half is walked for it.
- A bench with the server's corrections; the dry sink's choice read off the server.
- The planner's robustness as a guarantee: the branches now cross the pieces, but the in-between burns hit the margin open loop
  by construction (a timetable of controls); the tracker is what keeps the body off the walls.
