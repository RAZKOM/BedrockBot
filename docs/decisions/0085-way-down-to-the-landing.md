# 0085: A landing lies under the sky and has a way down to it (flight v2, Track F14)

Date: 2026-11-14. Status: accepted, `flyWayDown` default off; on on the Realm since 2026-11-14 (decision 10). Builds on
[0047](0047-flight-landing-v3.md) (the landing search: a live, dry, sound cell with a confirmed walk),
[0057](0057-flight-manoeuvres.md) (the brake / elevator landing, a floor under a rim), [0076](0076-land-by-time.md)
(the walk flood, the approach simulated before a cell is offered, the priced miss) and
[0084](0084-landing-over-what-stands-round-it.md) (a landing flown in over what stands round it and straight down).
Details and numbers: [../flight.md](../flight.md) "The way down to the landing (Track F14)".

## Context

On the Realm (2026-11-14) a sweep flew to every saved waypoint. 13 of about 40 flights ended `landed_off` by the
priced `land now`, far from the landing the search had chosen: ten to goals deep in a cave under a mountain, where
the flight came down on the mountain's top 65 to 70 blocks over the chosen landing and the walk from there took 85 to
180 s, and three short flights over open ground, 11 to 36 blocks from a landing that was a few seconds from the goal.
The price rule did what its measured chances say. The question was why no approach was planned to those landings.

The ten were flown again offline (the brain on the physics over the world cache's extract of the place, the search
run with the navigator's own probe) and gave the Realm's lines back, word for word. What the extract shows:

- **The chosen landing was under the mountain.** Nine of the ten landings were floors of caverns: 21 or 22 blocks
  of room over the floor, then 38 to 74 blocks of ground. The tenth was a cell under a roof 4 over it whose
  "corridor to the open" ended under such a column. No flight comes down onto any of them.
- **`open` meant 20 blocks of room.** A floor whose first solid block is more than 20 over it has been a landing
  under the open sky since the first landing search (the rule was written for trees and eaves). The walk flood's
  "open sky" and an overhang corridor's end used the same 20.
- **The simulations that knew better ran out.** A cell is offered only when the flight's own planner lands on it in
  simulation, and it refused every one of these floors (`no approach (wall 200)`: the plan meets the roof). But a
  refused cell costs eight simulations, the search has 24, and past them "a cell is taken without one": the fourth
  floor by the walk was the landing in 8 of the ten flights (`N approaches not simulated: budget`), and so was the
  landing of one of the three short ones. The ninth took such a floor as its last resort ("dry ground"), the tenth
  the cell under the low roof.
- **The real way in is farther than the search looks.** Where those caves' walks first come out under the sky is 36
  to 100 blocks from the goals in the plane (50 to 143 steps of the walk flood): outside the 48-block window for eight
  of ten.

In the air nothing could have saved it: 60 to 120 over a floor 45 blocks away the flare's and the brake's simulations
find nothing (`none`), the elevator over the floor's centre meets the roof (`wall`, 0.0 from the centre), and a
go-around comes back at the same height over the mountain.

Two more things turned up on the way. With the search alone corrected, 113 of 120 offline flights stood on the new
landings (at the caves' mouths) and four were hurt (6 to 30): where no descent circle fits round a landing with trees
or a slope beside it, the flight flies S-turns and then the brake's dive from 60 to 80 over it, and that dive's plan
passes a column inside the landing's own near zone at 1.4 to 1.6 a tick. And the three open-ground flights are that
same family of approach: a circle beside the approach line left low and slow, then a plan along the ground into what
stands between (`flare wall`), then the nearest safe ground.

## Decisions

1. **Open sky is the sky** (`landing.ts ColumnView.sky`, `solidOver`). A floor is `open` only with nothing solid over
   it to the top of its column. A floor with any roof is an overhang cell: landable along a corridor from the side,
   and that corridor ends under a column that is open to the top as well, or it is no landing. A goal that is itself
   under a high roof is a covered goal. The look up a column ends at its highest section that is not air
   (`world/chunks.ts topY`): without that bound it is 300 block reads a column.
2. **A covered goal's landing is looked for where its walk comes out** (`walkFloodFar`, `FLOOD_FAR`). The walk flood
   goes on to 128 blocks each way and stops 24 steps past the first floor under the sky; the landing cells it meets
   there are candidates however far from the goal they are. A candidate the flood did not reach ranks behind every
   one it did. The flood is cut into slices so that the event loop runs between them.
3. **No cell is offered without a simulated way down** (`APPROACH_SIMS_SKY` 48). Past the budget a cell is skipped,
   not taken; the line says `not simulated (budget)`.
4. **A landing with something standing round it has a rim from the start** (`plan.ts landingRim`, `OVER`;
   `brain.ts lookRim`). Where a column within 14 blocks of a landing stands more than 2 over its floor, the highest
   of them is the landing's rim as soon as those columns are known: the glide line, the descent circle and a go-around
   are flown over it, the brake comes in over it to the landing's centre and the elevator sinks onto the floor. This is
   0084's landing without waiting for a descent circle to meet a roof: 0084 gives the rim only when a circle fits low
   round the landing, and where none fits (trees or a slope 13 or more over the floor within 10 blocks) the flight fell
   back to the approach along the ground from wherever it was. A rim over 48 is none (the elevator would sink longer
   than anything flown: the deepest is 46), and neither is a roof over the landing's own centre.
5. **The search simulates that same way** (`overLands`). For a cell with a rim the simulation is the brake from a
   circle of radius 10 at the height that circle is left at; for open ground it is the approach along four bearings as
   before. The cell's price gets the seconds straight down (0.25 a block of rim), so that a cell with a short way down
   beats one a few blocks nearer under a slope, and a cell is not probed when its walk and its way down together
   cannot beat the best so far.
6. **The circle round such a landing is the one that was simulated, left where the way in begins** (`OVER.circle`,
   `wayIn`). Radius 10 at the widest, left 3 + 2.5 + 0.26 a block of radius over the rim (0084's numbers for the way
   from a circle to its centre). The circle's own low end is 6 over the rim: from a circle of 24 that met the rim's
   plane 14 blocks before the centre, and every such flight went round once. And any circle round the landing, with a
   rim or without, is flown at pitch 25 (no faster than 1.2 a tick) while it is more than 12 over the height it is
   left at: a flight that held over a goal under a mountain arrives 60 to 100 over the landing, and every column under
   the circle is lower than where it ends.
7. **A missed approach with no rim gets one** (`lookRim` with the miss's reach, `OVER.far`). Best plan `wall` or
   `none`: the columns out to that wall (and 4 more, 44 at the most) are looked at; where they give a rim, a body
   high enough comes in over it at once, else the go-around is flown, and its chance in the price is that of a
   go-around flown back in over a rim (`GOAROUND_P_OVER` 0.9: 14 of 14 offline, before decision 6; with it no first
   approach has missed since), not the 0.19 measured on go-arounds that came back along the ground.
8. **A landing given up says why** (`whyNoWay`, `FlightEnd.why`, whatever the setting): `the landing lies under a roof
   22 over its floor, the ground over it reaches 68 over that floor: no flight comes down onto it`, or what stands
   round it is too high to sink down from.
9. **One setting, `flyWayDown`, default off.** It changes which landing a flight is given and how most landings among
   trees and on slopes are flown; it has flown offline and on the test server, not on real terrain. Off: the search
   and every flight are what they were, tick for tick.

## Rejected

- **Losing the height in a valley beside the flank, then an approach from below the top** (the first idea, from the
  log alone). There was no flank to come down: the landings were inside the mountain. For
  a landing that does lie on a slope the circle round it over its rim does the same job with what is already flown,
  and needs no free valley.
- **A lower hold.** The hold is over the goal, and the goal is under the mountain: it cannot be lower. With a landing
  at the cave's mouth the hold's height is lost on the way there and in the circle.
- **New chances for the go-around alone.** The go-around came back to a landing under a roof: no chance is the right
  one. The chance was changed only for the approach that is new.
- **A bigger simulation budget alone.** It would have refused the fourth cavern floor too, and then the fifth: the
  floors are no landings, and the search should not be asking about them.
- **Raising the rim's limit past 48.** A landing at the foot of a cliff higher than that is flown as before (an
  approach along the ground on the side that is open). An elevator of 60 has flown offline only.

## Consequences

- Offline on the extract (ten goals, four headings, the look for a landing 10 or 30 ticks into the hold or 100 blocks
  out, two seeds: 24 flights a goal, crafted rockets). Before: 24 of 240 on their landing (one goal's, whose landing
  lay under the sky); the other 216 on the mountain or beside it, 45 to 120 s of planned walk from the goal, after
  118 go-arounds and 300 priced misses, 21 of them hurt (0.1 to 5.3). After: 240 of 240 stand on the landing the
  search chose, within 2 of its centre, with no damage, no hit and no go-around, 7 to 25 s after the landing was given
  (17.6 s on average), with 0 to 1 rocket. The landings are the caves' mouths: 27 to 55 s of planned walk from the
  goals.
- A flight to a goal deep in a cave now ends farther from it in a straight line than before (at the mouth, not over
  the goal), and nearer by the walk.
- A landing among trees, beside a house or on a slope is flown by the brake and the elevator from the start whenever
  the flight looks at it from the cruise: slower by the elevator's seconds than a flare that lands, and it does not
  depend on a plan along the ground finding its way between what stands there. On the built wood: 12 of 12 against 8
  of 12, and 377 ticks a flight against 555.
- The search's own work is less (on made-up worlds with a probe that answers at once, on the test host under the live
  bot's CPU policy: 131 ms against 316 for a goal under a mountain, 347 against 993 for a goal in a wood on flat
  ground): the far flood stops at the mouth where the old one fills its window. With the navigator's probes on the
  real place it takes longer: a median of 0.79 s against 0.48 on the same machine (0.35 to 1.2 s against 0.24 to 1.1),
  because the walks from a mouth are 76 to 167 blocks and all 16 probes run where the old search stopped at 6 to 16.
- The brain reads the columns within 14 blocks of a landing once (615 column tops): one tick of 42 ms on the test host
  as the live bot runs, where a column top is a scan of 260 cells (18 ms at its usual priority).
- On the test server (a stepped hill 62 high with a cavern in its heart and a tunnel out to its foot, `!goto` from 250
  blocks): before, the search took a floor of the cavern in 10 trips of 10, every flight missed it, 8 then stood on
  an alternative at the tunnel's mouth and 2 ended off it, 49.8 s a trip; after, 10 of 10 stand on the search's first
  landing with no miss, 39.4 s a trip. An exact landing two blocks from the hill's foot (a rim of 24): 10 of 10.
- The column tops are the model's, as in 0084.

## Addendum: on the Realm (2026-11-14)

10. **The setting is on on the Realm and stays off by default.** 25 trips with it on, at night, no death: the 15
    flights to goals under the mountain all stood on the landing the search chose (a cave's mouth, a rim 8 to 36
    over its floor), 0.00 to 0.01 from its centre; nine of the ten goals took 83 to 126 s a trip against 114 to 247 s;
    the flights home and the waypoints by the cave's mouth landed as before or by the rim. Off by default because it
    has flown in one place, and for three things seen there: the search takes 0.6 to 3.0 s a look where it took 0.2 to
    0.85 s (three looks of about forty 4.7 to 6.4 s), which the hold absorbs; a landing beside something more than 48
    over its floor is still flown as before (one of the three short flights ended off its landing again, and says
    why); and the elevator is where a mob reaches the body: two flights were hit 2 and 4 blocks over the floor (0.9
    and 1.8), pushed off the centre, went round at the rim go-around's chance and landed, which is that chance's
    first count (2 of 2). A look at hostile mobs in the landing is the next track. One trip took 355 s because its
    walk from the mouth, taken up again after three fights, left the way the search had probed (860 blocks walked
    for a path of 112; three repeats 101 to 154 s): the walker's fault, not the landing's.
