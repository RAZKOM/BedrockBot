# 0077: Taking off from inside a cave: first out, then to the goal, as one proven plan (flight v2, Track F9a)

Date: 2026-11-09. Status: accepted. Builds on [0054](0054-glide-down-and-ledge-takeoff.md) (the jump takeoff simulated before it is
chosen), [0064](0064-route-landings-and-takeoffs.md) (the route takeoff), [0069](0069-cave-flight.md) (no powered flight underground
without `flyCave`), [0074](0074-cave-entry.md) (the way in). Details and numbers: [../flight.md](../flight.md) "Cave exit (Track F9a)".

## Context

The owner (2026-11-09): "What are we doing wrong that the bot can't fly from start to finish? I can do it in the realm." They take
off inside their cave, fly out of its mouth and climb away. The bot, from the same spot, hit the roof once or twice on every trip out
(the Realm's `!test goto home from cave_start 3`: 3 of 3 arrived, 136 s a run, 20 to 30 s of each lost to it).

What the log, the cave's fixture and the owner's recorded exits show:

- The route takeoff's "exit under open sky" is a cell with 16 of air over it. The hall of a cave has that too. The plan to it was
  sound (21 ticks, one rocket); nothing was known about what followed it. The climb turned to the goal's heading at the exit, 6 over
  the exit cell, and its straight glide met the hall's wall 14 ticks on: "nothing clears the solid ahead in the climb ... (roof)". The
  flight came down 11 to 18 blocks lower than it had started. Offline on the fixture the same takeoff ends the same way, line for line.
- The jump and the vertical takeoff simulate their whole climb before they are chosen. The route takeoff did not.
- The owner's exits (seven recorded takes): one rocket once the glide is on, out along the passage, and no turn at the exit: the
  heading curves to the goal's over the next 35 blocks while the climb steepens; 70 blocks out after 3.0 to 3.7 s.
- Every route takeoff asked for its own plan a second time on its first tick ("the corridor ahead is blocked", on a plan 300 ms old).
- Seven rockets "fired nothing" in the same log, none of them the first rocket of a takeoff: all in the climb or the cruise.

## Decisions

1. **A takeoff from under a roof is two phases: first out, then to the goal.** The owner: "the human nature part is first getting
   out of the cave then flying home, not just flying home from within the cave. It doesn't have to pathfind its way home from
   underground, it has to pathfind its way out from underground and then it can head home." Phase 1 ends when the body has open
   sky over it (the sky check's 3 x 3, free up to the cruise height); until then the goal's bearing steers nothing: not the exit
   chosen, not the plan, not the climb's heading. Phase 2 is the flight as it always was. (A trip from underground to underground
   that should stay underground is the corridor's, and is not touched.)
2. **A route takeoff is offered only with a proof of the whole of it** (`glide.ts routeTakeoff`, wired in `commands-fly.ts
   routeTakeoffFor`): the takeoff simulated from standing with the flight's own options and the flight's own view of the world (the
   live model, the cache where it has nothing), the tracker flying the plan out to the exit and the brain's climb after it, for 300
   ticks past the plan. It clears when the tracker came out through the exit, nothing was hit, the body stayed dry and is still
   flying, at the nominal burn (15 ticks) and at 9, 21, 12 and 18. A plan without that is refused with what its climb met, and the
   takeoff chain goes on as it does after any refusal (a takeoff site, the walk out). Of the proven plans the one that is out under
   open sky soonest wins; the time to the goal only breaks a tie.
3. **After the exit the climb keeps the exit's line until the sky is open, then turns to the goal as the path ahead clears**
   (`brain.ts climbYaw`, for a proven route takeoff): under open sky the heading turns `CURVE_STEP` (4 degrees) a tick towards the
   target when the glide of the next 20 ticks on the new heading meets no solid, else it stays. This is the owner's recorded line.
   A fixed heading held until a sky check passes and then released to the goal was built first and measured worse: at a burn of 11
   ticks the body left the mouth 40 degrees off the held heading and the release's intermediate headings met the shore's hill.
4. **The exits tried lie apart** (`exitsToTry`, 8 blocks) and an exit beside one whose climb was refused is not tried: three cells
   of one hall were three plans to the same end.
5. **Where no exit's climb clears, the ways out under the roof** (`route/takeoff.ts waysOut`; `flyCave` and the new `flyCaveExit`
   on): a flood that stays under the roof (a cell under the real sky, no solid up to the cruise height, is a way out and is not
   flooded past), through cells with a block of room each side, with the flood's way to each; the plan goes through a waypoint every
   24 cells of that way, the exit, and a point in the open 12 blocks out along the heading with the longest run of open sky,
   searched in pieces of one goal. It is proven as in 2 and flown by the same tracker. Should the tracker lose its plan under the
   roof, the body lands; it never goes on as a climb nobody planned.
6. **`flyCaveExit` ships off.** The way out is powered flight under a roof that has only flown offline (the fixture, the unit
   worlds). On the replica its proof passed at the nominal burn and refused it at a burn of 9, so it never flew on a server. It is
   to be turned on after a `!test goto` series on real terrain.
7. **The plain tracker flies the way out, not the cave style's rules.** Measured on the owner's cave at burns 9 to 21: with the cave
   rules (the bail-out a block off the reference) 2 of 7 came out and 5 bailed out in a passage 14 wide; plain, all 7 came out
   with no hit. `PLAN_CLEAR_MIN` (no rocket on a plan that grazes) holds in both.
8. **The second plan at a route takeoff's start is explained and left in** (`route/tracker.ts` is unchanged): the burn hazard's
   index is -1 when there is none and the body matches index -1 while it still stands on the plan's start, so `-1 >= -1` asks for
   every plan from the worker again; and a plan from standing beside a wall, which keeps less than the margin on its first edges
   by construction, is checked against the full margin. The second search returns the same plan. Correcting the comparison, for
   every driver and then only for the route takeoff, was built and taken out: with either in the tracker fly-course's rings did
   not complete a run in six whole-course runs, and with the file as it was the course was 8 of 8 twice. The cause was not found.
9. **No rocket before the server confirms the glide** (`controller.ts`, `ROCKET_GLIDE_WAIT`), in every takeoff of the flight
   controller, as the route driver and the corridor's driver already did. After 6 predicted gliding ticks without the flag the rocket
   goes as before (a flag that late would cost the takeoff its glide).
10. **A rocket entity is matched where the rocket was used** (`rocket.ts`), not only where the body is when its packet is read: the
    server spawns it at its own body and the local body is a round trip of ticks farther on. One that comes after its use was written
    off is logged ("that rocket did fire"). This is a hypothesis for the Realm's mid-flight "fired nothing" lines, built so the
    Realm's log can confirm or refute it; it cannot be reproduced on a local server.

## Consequences

- From inside the owner's cave the hall's exits are refused before anything flies, in one log line, and the bot walks out and takes
  off outside, as after any refusal. The Realm's roof flight, its landing 11 to 18 blocks lower and the walk out of that hollow
  (44 to 73 s a run) are gone; what the trip then costs is the walk from the start to open sky.
- With `flyCaveExit` on the takeoff goes out through the mouth in one flight where its proof passes (offline on the fixture: out
  after 54 to 76 ticks on 3 to 4 rockets, 70 blocks out after 3.0 to 4.0 s, no hit at any burn from 9 to 21, on three different
  plans). The owner does it on one rocket in the same time.
- A route takeoff costs its proof: up to 5 simulations a candidate (about 0.1 s each), the ways out a flood and a search of up to
  2 s. The whole decision is bounded by `TAKEOFF_BUDGET_MS` (6 s) of starting new work; on the fixture it took 4.1 s on the
  development PC and 4.3 s on the Mac.
- The proof flies the nominal burn and four others, not every burn, and the simulated server has no latency. A takeoff can still
  fail live where its proof passed; it then ends as before (`roof`, or a landing under the roof) and the trip walks on.
- A route takeoff that used to fly and bump into something on the way up is now refused (a head bump under the takeoff's own roof
  excepted). The room, the stack and the holes of Track F3 still take off (fly-route-land).
- Learned paths (the owner's recordings) are not used by the planner. What it would need: `TakeoffRouteOptions` taking a preferred
  way (its cells in place of the flood's, so `wayGoals` cuts the waypoints from the recorded line) and a heading profile for the
  climb in place of `climbYaw`'s turn; the proof stays as it is.
