# 0078: A recorded flight as the way out of a cave (flight v2, Track F9b; learned paths as guides, part 1)

Date: 2026-11-10. Status: accepted. Builds on [0077](0077-cave-exit.md) (a takeoff from under a roof is first out, then to the
goal, as one proven plan), [0064](0064-route-landings-and-takeoffs.md) (the route takeoff), [0069](0069-cave-flight.md) (no powered
flight underground without `flyCave`). Details and numbers: [../flight.md](../flight.md) "Learned exits (Track F9b)".

## Context

After 0077 the takeoff from inside the owner's cave is refused by its proof, correctly, and the bot walks 102 blocks to open sky
(35 s) before it flies; the Realm's `!test goto home from cave_start 3` takes 90.6 s a run. The owner flies the same stretch in 3 to
4 s on one rocket, and recorded seven takes of it with `!learn`. Their words: "It doesn't have to follow me to a tee but it should
be able to recognize the flight path (like through the cave entrance)", and "it has to pathfind its way out from underground and
then it can head home."

The searched way out of 0077 (`flyCaveExit`) is found there every time and refused every time: "clear at the nominal burn; hits a
solid 1 time at a burn of 9 ticks". What was measured on the cave's fixture before anything was built:

- **Its waypoints are not a line anybody would fly.** They are cut every 24 cells from the flood's way, and a flood of unit steps
  has no idea of a slope: the first two lie at the floor, 3 to 6 blocks beside the owner's line and 1 to 4 under it; the third is 5
  over the owner's line and 11 over the second, 9 blocks farther on (a climb of 50 degrees inside the passage); the fourth is level
  with the third again. Each is a box of 3 x 3 x 3.
- **Four rockets, because the search buys time with them.** Each goal is its own search (pieces of one goal), the first plan that
  reaches the goal is taken, and the heuristic counts the way left at the boosted speed with a weight of 2: a rocket's 20 ticks of
  cost are earned back in about 24 ticks of flight, one waypoint's spacing, and a rocket may be fired again from the ninth tick of
  a burn. The plan burns 47 of its 57 ticks, flies 80 blocks to get 67 from the start, and turns six times by 29 to 87 degrees,
  left and right in turn.
- **The burn of 9 ends a rocket in the turn after the steep climb.** The third rocket is fired as the body comes out of the climb
  at 46 degrees with a turn of 45 to make; when it ends 6 ticks early the tracker asks for a new plan seven times in twelve ticks,
  the body is 1.7 to 2.0 off the reference, and it meets the passage's wall 4 ticks past the third goal, 17 over the start where
  the owner is 10 to 13 over it.
- **The proof flew a kinder planner than the bot has.** The fixture's probe searched in its own thread, where an answer comes
  within the tick that asks; the bot's planner is a worker whose answer comes later. With the answer a tick late (`--async`) the
  same way out is the Realm's line for line: refused at a burn of 9, and flown anyway it is out after 56 to 164 ticks on 3 to 9
  rockets with 6 to 25 plans a takeoff. In the bot a search of 250 to 600 ms answers 5 to 12 ticks late, and a simulation that
  waits for every answer shows none of that.

## Decisions

1. **A recorded flight is matched by where it left the ground, never by its name** (`learn/match.ts matchExits`): a flight of a
   recording (a stretch off the ground of 12 blocks or more, cut at every gap in what the recorder saw) that began on the ground
   within 4 blocks of the body (3 in height), began under a roof, and comes out under open sky (four points of its line in a row
   with nothing over them up to the cruise height). Several takes of one line are several candidates: the nearest takeoff first, but a take whose own line passes within the follower's berth of a block (the owner's nearest does, at a quarter of a block beside its start) after those that keep it.
2. **The line is flown by a follower, not by the route search** (`learn/follow.ts`). Both were built and measured on the owner's
   seven takes. As waypoints for the search (a box every 12 blocks of the line): three of six takes had no plan in 2 s; the three
   plans needed 3 to 4 rockets and zigzagged between the boxes as the flood's did; flown with the planner answering a tick late
   37 of 39 burns came out clean, on 2 to 9 rockets, 70 blocks out after 3.0 to 8.3 s. The follower: six of six takes proven, 78 of
   78 burns out with no hit, 1 to 2 rockets, 70 blocks out after 3.2 to 3.5 s, a quarter of a second for a proof at five burns. It asks nothing of
   a planner, so what the proof simulates is what flies.
3. **The follower flies the line's place, not its timetable.** Every tick: the body's place on the line, an aim on the line as far
   ahead as the body flies in six ticks, and of 54 looks round that aim the one whose glide of the next six ticks stays nearest
   the line and clear of every solid by 0.3, for the burn as the body reports it and for the burn ending as early and as late as
   a rocket's can. No search, no memory of a plan: a correction from the server or a burn of another length changes nothing in
   what it does next.
4. **The rockets go where the recording's went, and one more when the body is slow.** The first one as long after the jump as the
   recording fired it (8 to 11 ticks in the owner's takes: after the glide is on, which is what 0077's wait for the server's flag
   is for); a later one at its place on the line; another whenever the body is under 1.0 a tick with line ahead and none burning
   (a burn of 9 ticks where the recording had a longer one).
5. **The proof stays the gate, and for a learned line it flies more than the five burns** (`glide.ts routeTakeoff`): the whole
   takeoff from standing, the follower out and the climb after it, at burns of 15, 9, 21, 12 and 18 as for every route takeoff;
   then at the eight between them (`LEARNED_PROOF_BURNS`: the five are not the whole range: on the replica the take nearest
   cave_start cleared the five and met a solid at a burn of 14, and with the five-burn proof one run of five came down for
   it; a line drawn from the flood cleared the five and met a wall at 11); then with the burns mixed, which no single
   burn flies (`LEARNED_PROOF_MIXES`: a first rocket of 21 ticks with 9 for every later one, the flight with the least energy,
   and 9 with 21 after it); and in every one of them the brain sees a burn's end two ticks late, as the input loop does
   (`simulateFlight`'s `endLag`, `GLIDE.boostEndLag`), so the climb's rockets have the gaps between them that they have on a
   server. A simulation without a search costs a twentieth of a second, so the fifteen cost less than five did with one.
   Nothing learned is offered without the proof (a caller that asks for no proof gets no learned way). The first take that
   proves clear is taken, of at most three. The other route takeoffs' proofs are as Track F9a left them.
6. **Out is open sky over the body, and then the climb is 0077's.** Past the line's first point under open sky the takeoff is over
   as soon as the body has open sky over it (or at the line's end); the climb keeps the heading the body has and turns to the goal
   as the path ahead clears. The recording's own curve after the mouth is not flown: it leads where the recorder was going, and
   the bot is going somewhere else.
7. **A body that loses the line under the roof lands; it never goes on as a climb nobody proved**, as 0077's ways out. The line
   is lost 5 blocks off it for 5 ticks, with no glide 30 ticks after the jump, with no block of progress along it in 30 ticks,
   and when every look ends in a solid within the horizon two ticks running (the bare box, not the berth: a graze is flown,
   a crash is not). In that last case no rocket goes and the body brakes first (the look turned round until it is under 0.25 a
   tick): a wall put across the passage after the proof is stopped 2 blocks short of, where the follower as first built
   held the body against it on four rockets.
8. **A learned way is tried before the exits and the ways out.** It needs no search (the hall's exits cost the fixture 1.6 s of
   searches that run out their budget), and it is the way somebody showed. Refused, the takeoff goes on exactly as it would
   without a recording.
9. **A new setting, `flyLearned`, default off, needing `flyCave`.** Not `flyCaveExit`: that switch turns on the searched ways out,
   which cost the Realm 2.4 s a takeoff and are refused there every time, and the two must be tried apart. It is powered flight
   under a roof that has flown on the replica and never on the Realm: it is turned on after a `!test goto` series there.
10. **The searched way out is left as it is.** No small change mends it: the owner's own line as its waypoints (the best any
    waypoints can be) still gave no plan for half the takes and 3 to 4 rockets for the rest. What would is the follower on a line
    drawn from the flood. A first, crude one (the flood's way pulled straight wherever a line with a block of berth is clear,
    its corners rounded; twenty minutes of work, not in the repository) was proven at the five burns and flew 12 of 13 burns
    clean on 1 to 2 rockets, 70 blocks out after 2.9 to 3.0 s, with one hit at a burn of 11. That is a track of its own.
11. **The loader and the matcher know entries too.** A recording is read into its flights (`learn/guide.ts guidesOf`: every flight,
    whether it left the ground or stood again), and `matchEntries` finds the flights that came from under open sky and stood
    again under a roof near a goal. Nothing flies them yet.
12. **The recordings never leave the config directory.** The bot reads `<config dir>/paths` (`learn/store.ts PathStore`, a file
    read again only when it changed). The offline probe is given a folder by argument and prints positions relative to the
    start only; the replica's test is given one by environment variable and moves the recordings with the replica into a
    temporary folder. The unit tests fly synthetic recordings through synthetic caves.

## Consequences

- With `flyCave` and `flyLearned` on, a takeoff where somebody recorded a way out flies it from where the bot stands: offline on
  the owner's cave out after 55 to 62 ticks on 1 to 2 rockets at every burn from 9 to 21 and at four mixes of them, each of six
  takes, 70 blocks from the start after 3.2 to 3.5 s (the owner: 3.0 to 3.7 s). On the replica every run of the final series
  left the ground at cave_start and was home in 59.9 to 65.4 s (72 to 73 with the walk out); the Realm's walk out is three
  times the replica's.
- Without a recording that matches, with the setting off, or where the proof refuses: nothing changes (the unit tests compare the
  decision's lines).
- The decision costs fifteen simulations for a take that clears and no search: 0.8 s on the development PC for the owner's cave
  offline, 0.5 to 0.6 s on the test host for the unit test's cave, 1.3 to 1.8 s on the replica's bot (its cells are the live
  model's). Each take refused before it costs up to fifteen more.
- A recording is trusted for its line and for nothing else: a world that changed since (a wall across the passage) is refused by
  the proof in one line, and a wall that comes after the proof is stopped short of; a pillar on the line is flown round and
  proven so.
- The proof has the limits 0077 named (a simulation, no network latency, the model's world), less two: no planner answers late
  in it or in the flight, and it flies every burn. It has no margin: a climb that clears a solid by half a block is "clear",
  which the replica's shell showed (one flight of 31 did not get over it, on a take the five-burn proof had passed). A berth
  for the climb, or refusing a climb that had to steer, is the owner's to decide: either refuses every take on the replica
  and none on the cave's fixture.
- The line is the recorder's and so are its limits: a recording made out of the recorder's view has gaps and is cut at the first;
  one whose takeoff was more than 4 blocks from where the bot stands is not used (a walk to its start is a later track's).
