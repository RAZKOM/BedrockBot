# 0081: A line drawn from the flood as the way out of a cave (flight v2, Track F9d)

Date: 2026-11-10. Status: accepted. Builds on [0078](0078-learned-exits.md) (a recording as a line, the follower, its
proof), [0080](0080-learned-entries.md) (the way in along a recording), [0077](0077-cave-exit.md) (the takeoff proven as
one plan; out first, then to the goal), [0069](0069-cave-flight.md) (no flight underground without `flyCave`). Details
and numbers: [../flight.md](../flight.md) "Drawn lines (Track F9d)".

## Context

After 0078 and 0080 the bot flies in and out of the owner's cave along lines the owner recorded. The owner asked what
that amounts to: "Does this mean that if we get it working, it can fly in and out of caves? or is this just that it can
follow a learned path and adapt it?" It was the second. Without a recording the takeoff under a roof had only the
searched way out of 0077 (`flyCaveExit`): waypoints cut from a flood of unit steps, a search in pieces, the route
tracker. Its own proof refuses it in the owner's cave every time, for reasons 0078 measured (a 50 degree climb in the
passage, six turns, four rockets, a tracker that answers a tick late), and 0078's scratch experiment said what would
mend it: the same follower on a line drawn from the flood flew 12 of 13 burns clean.

The owner's rule for a takeoff under a roof stands: "the human nature part is first getting out of the cave then flying
home ... Like even if the way out of the cave is straight up as soon as it has open sky above it, it can then just glide
home."

Two faults of other parts were on this track's list as well, both found by the same method (the flight flown offline at
every burn, tick for tick): the route landing that was handed over too high, and the learned entry's missed first pass.

## Decisions

1. **The way out is a line, not waypoints.** `learn/draw.ts` draws what a recording would have given: points a block
   apart from the body's feet to 16 blocks past the roof. It is a `Guide` like a recorded one (`drawn` set, for the
   log's words), proven by the same proof (every burn from 9 to 21, two mixes, a first rocket that fires nothing: 18
   simulations) and flown by the same `GuideFollower`. Nothing about a drawn line is trusted more or less than a
   recorded one: the proof is the gate for both.
2. **The flood is a search by cost.** From the body's cell through the air under the roof to the cells under the real
   sky, 26 neighbours, a step beside a solid dearer than one in the middle of a passage. The flood of unit steps ran
   along the floor and knew no slope; this one finds the way a body has room in.
3. **One slope from the takeoff to the exit.** The flood's cells say where the passage runs, not how high to fly in it.
   Each point is put on the straight slope from the takeoff's height to the exit's and kept inside its own passage,
   then the way is pulled straight with a berth and its corners rounded. The owner's seven recorded exits climb 12 to
   19 degrees all the way; the line drawn at the same place climbs 13 to 15.
4. **Two kinds of height, and the roll and the proof choose.** Heights that keep a berth from what juts out beside the
   line fly the deep cave's narrow places; heights between the floor and the roof alone fly the takeoff from under a
   lip, where every height with a whole berth lies under the lip and the body that has just jumped is over it. Both
   are drawn for each berth (0.9, 0.6, the follower's own), each is rolled (the follower on the physics at the nominal
   burn), and the lines whose roll gets out are proven in the order of their time to open sky, three at most.
5. **A drawn line carries one rocket, the takeoff's.** Every later one is the follower's own rule (slower than a block
   a tick with line ahead). A rocket "where the roll fired one" would be fired at a place whatever the burn before it
   had been; the rule fires where the body is slow, at whatever burn the flight happens to get.
6. **Straight up out of a pit.** A way out may end at the bottom of a pit or a shaft. The line then goes on up the open
   column, and the climb after a proven route takeoff looks straight up on rockets back to back while every heading has
   a wall at the climb's pitch and the sky over the body is open. It begins only where all eight headings are walled
   (a cliff across one heading is turned away from as before) and, once begun, goes on until the held heading is clear.
7. **The order at a takeoff under a roof: a recording, then a drawn line, then as before.** Behind `flyCaveExit`
   (default off, needs `flyCave`), which asked for the searched way out before. The searched way out is no longer asked
   for by the bot; `route/takeoff.ts` keeps it (`far`, `waysOut`) for the probe's comparison. No new setting: the
   switch means what it meant (fly out of a cave nobody recorded), with a way that proves.
8. **A route landing near its cell is handed over at its line whatever the burns.** Offline the gate's flight is the
   same tick for tick on the commit before 0080 and after it; what differs from run to run is how long the first two
   rockets burn, and with that the hand-over's height went from 10 to 27 over the cell. Within 204 blocks of such a
   landing a burning rocket now climbs only as far as its coast will carry to the hand-over's line, the coast is counted
   as it is on a level look (a third more than `climbMomentum`), and a body on or over the line bleeds its speed by a
   tick of looking back and not by a pull-up. The search is untouched.
9. **A cell under a rim is the brake's alone.** The flare's simulated settle "lands" in a 1 x 1 hole with a tenth of a
   block to spare and can cost less than the brake's plan for a tick after a correction of the server; flown, it stands
   on the rim. `plan.ts` already said of `rim` that only the brake comes down inside it; the choice now does.
10. **The way down onto a lead-in is flown by the fall, not by the look.** A glide's fall a tick depends on its look
    alone, so the slope a body flies is that fall over its speed: looking down makes a fast body faster, not steeper.
    The cruise onto a learned entry's lead-in begins its descent as soon as it is lined up, flies the pitch whose fall
    is the slope needed at the speed it has, and takes speed off by a tick of looking back where that is not enough. A
    circle of no whole lap is no longer flown by a body that comes in along the line. Where the lead-in is steeper
    away than the steepest slope this flies, it is not flown at all: the lap beside the lead-in's start follows
    whatever is done, and a body slowed down first only came to it later.
11. **The hand-over is a height and a speed together, and both are measured, not quoted** (round 2). The cap of
    decision 8 alone was sent back: it handed a cell under a roof over 10.6 over the cell at 1.03 a tick, and the
    landing took 8 rockets where the code before took none. The band the tracker lands from had been quoted from the
    earlier tracks ("5 to 13 over at 0.65 to 1.3 a tick"). Measured state by state (one search each, then the tracker
    on the physics to standing) it is 8 to 10 over the cell at 0.7 to 1.2 a tick for every cell tried, and beside
    that a high hand-over needs a slow one (a slow body sinks more a block) and a low one a fast one. So the cruise
    aims at the planner's own entry height, comes down straight along the corridor's line (no S-turns inside the
    range: they hand the body over beside the line), and in the last 12 blocks flies a body that is still high at the
    speed whose glide sinks what is left. `ROUTE_HAND_BAND` names the band; a guard test searches from its corners.
12. **The tracker checks a landing plan's corridor in the search's own grid.** The search treats the landing cell's
    floor as no obstacle near the cell (`sweepGridFor`); the open-air tracker's check swept the whole grid, so every
    landing plan was "blocked" two ticks before its end by its own touchdown and was searched again from the middle
    of its last manoeuvre, five to eight times a landing. Where such a search found nothing the tracker fired a
    rocket and flew round the cell: that, not the hand-over, was what was left of the gate's failures (4 of 126
    landings of the stacked platforms' slot from hand-overs inside the band). The check now uses the grid the plan
    was searched in, for a route landing only; the margin, the other drivers' check and the search are as they were.
    Weighed against it: a higher price for flying near a solid in the landing's searches (2 or 5 for 0.5) left 3 of
    144 where there were 7, and changes which plans every landing chooses; not taken.

## Consequences

- With `flyCaveExit` on, a takeoff under any roof with a flood to the sky may fly: a room, a base under a roof, a cave.
  It flies only what its proof cleared, and a lost line lands, as a recorded one does.
- The decision costs the drawing (a flood, the lines, their rolls) before any proof: about a second by the cave's mouth
  and two to four in the deep cave on the test host. The takeoff's budget (6 s) bounds the proofs, not the drawing.
- Lines of 150 blocks and more through the deep cave roll at the nominal burn and are refused by the proof at a burn of
  9: the generality ends where the follower's does. Underground to underground is the next track and needs the same
  line with a touchdown at its end.
- The way in without a recording is designed, not built ("Drawn lines", the last part).
- A route landing now lands on one or two searches where it had six to eight: its end no longer depends on the wall
  clock a loaded host leaves the planner. The band is measured straight in on the bearing; a hand-over from beside the
  line (a flight that comes to its corridor late) is outside what was measured.
