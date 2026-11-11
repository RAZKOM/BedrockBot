# 0082: Longer drawn lines, a drawn way in, and flights under one roof (flight v2, Track F9e)

Date: 2026-11-11. Status: accepted. Builds on [0081](0081-drawn-lines.md) (a line drawn from the flood as the way out),
[0080](0080-learned-entries.md) (the way in along a recording: the line with its lead-in, the flier, the proof from
every state the hand-over allows), [0078](0078-learned-exits.md) (the follower and its proof), [0077](0077-cave-exit.md)
(out first, then to the goal), [0069](0069-cave-flight.md) (no flight underground without `flyCave`). Details and
numbers: [../flight.md](../flight.md) "Drawn lines, the way in and under one roof (Track F9e)".

## Context

After 0081 the bot flew out of a cave along a line nobody recorded from five of the nineteen roofed places of the
owner's cave it can stand at; into a cave only along a recording; and between two places under one roof not at all.
The owner's words for the three: "fly through caves and land underground", "fly from cave_start to cave_end, taking
the shortcut if able, else 100% through the waypoints", and "if it's pathfinding from underground to another spot
underground, I should try to find it without having to get out first".

The lines 0081 could not fly were traced first, at a burn of 9 ticks. Each was lost at the same kind of place: where the
line fell away in front of a body that had a rocket's speed. One line dived 31 to 39 degrees from its start and the body
left it upwards, faster every tick. The others went up over a sill and down its far side: the line hugged the floor up
one side (28 degrees) and down the other (46), the short burn ended on the top, and a glide at 1.65 a tick turned its
path down by two degrees a tick where the line turned by thirty in six blocks. Nothing but gravity bends a glide
downwards, and how far that bends its path depends on its speed. The follower had one speed rule (a rocket under a
block a tick) and the drawing one slope from the first height to the last, pressed into the passage point by point.

## Decisions

1. **The heights are the taut line through the passage** (`draw.ts taut`). Each cell of the flood's way has a band of
   heights a body fits at; the line through the bands from the takeoff's height to the end's is straight wherever the
   bands allow and bends only where it touches one. Over a sill that is one slope up to it and one down from it, not the
   floor's own shape. Where nothing is in the way it is 0081's one slope.
2. **A top is rounded wide** (`DRAW_ROUND_OVER` 40 blocks where the air allows, other corners 8 as before): the bend a
   glide can follow downwards is set by gravity.
3. **A speed for every point** (`lineSpeeds`, `Guide.speeds`). A line that falls steeper than 12 degrees is flown at
   about a block a tick (a faster body flies flatter than the line whatever it looks at); a top no faster than the root
   of 0.045 times its radius; a tight corner by its radius; before a slow place the speed comes down 0.07 a block. The
   follower takes speed off a body with no rocket burning by a tick of looking straight back (level; down, when the body
   rises steeper than the line ahead of it), never two ticks running. Under a burn nothing is taken off.
4. **The next rocket is held where it would hurt**: before a slow place it waits until the body is slower than nine
   tenths of the least speed the line has for the next 12 blocks; over a line that falls there is none (the glide gains
   its speed by itself); and the look of the tick a rocket goes on is chosen again for the burn.
5. **The proof stays what it was**: the nominal burn, every burn from 9 to 21, two mixes, a first rocket that fires
   nothing. Flights with a burn of its own for every rocket are flown by the probes (719 of 720 out with no hit over the
   seventeen long exits of the fixture) and are not part of the proof: six more simulations a line would not find a
   failure of one flight in seven hundred, and cost a second. Losing a line under a roof brakes and lands, as before.
6. **The climb out of a pit ends over its rim** (`brain.ts climbUp`): besides the path ahead being clear for the burn as
   the brain is told it, a line from the body rising 0.3 a block along the held heading must be free for 20 blocks. The
   brain does not know when a burn ends; a path that cleared the rim on four more ticks of burn met it on a short one.
7. **The lines are drawn at once and rolled and proven one after another** (`drawWays`, `rollDraft`): the first that
   clears is flown, the widest berth first. The flood's cells and the follower's looks are remembered in numbers and
   bytes, not in text keys: the decision at the far end of the owner's cave went from 8.5 s to 3.4 s on the same host.
8. **A drawn way in is a drawn way out, reversed** (`drawin.ts`, setting `flyCaveEntry`, default off; it needs `flyCave`
   and `flyRoute`). The flood runs from a standable cell by the goal to the sky; the line is drawn as a way out's, carried
   on 50 blocks into the open along the freest heading rising 20 degrees, and reversed. It must come down all the way: a
   line that climbs more than 1.5 blocks under its roof is refused, because a glide climbs only on speed it has and no
   rocket is fired near a touchdown under a roof. Its speeds are the line's own (decision 3), a block a tick and a fifth
   in the open and three quarters on the touchdown. From there on it is a recorded entry: `entryLine` cuts the window
   and draws the lead-in, `proveEntry` flies its 39 states, `EntryFlier` flies it. The order at a covered goal: a
   recording that matches (`flyLearnedEntry`), then the drawn line, then as before.
9. **A hop is one line, flown by two fliers** (`hop.ts`, setting `flyCaveHop`, default off; it needs `flyCave` and
   `flyRoute`). The flood by cost is aimed at a standable cell by the goal and stays in the cave (a hole in the roof over
   the way is passed, the open air beyond it is not). The line is the taut line between the two heights; it may climb,
   and climbs on its burns. The follower flies it from standing; 14 blocks before the touchdown the entry's flier takes
   the body on the same line, committed. The proof is the whole flight from standing to standing at the proof's burns,
   each ending within 2 of the goal with no hit over 0.15 a tick of speed. With a first rocket that fires nothing the
   flight may come down short of the goal instead, with no hit: that is said and the hop is flown (the body stands by
   its start again). It is drawn and proven on the live model with the world cache behind it, and asked by its line,
   not by the straight distance: before the `flyMin` test, for a goal more than 48 blocks off.
10. **A hop's last rocket has its place.** A rocket burns 9 to 21 ticks, 15 to 35 blocks of flight, and nobody knows
    which: none is fired later than 44 blocks before the touchdown (it could still burn where the brake begins), and a
    body 56 to 44 blocks before it with none burning fires one (what flies the rest is that burn's speed). So a line
    shorter than 48 blocks is not flown: it is walked, as before.
11. **One line the whole way, not hops from waypoint to waypoint.** Measured on the owner's cave: the legs between its
    waypoints are 13 to 49 blocks of line: 16 of the 22 are under the 48 a hop needs, four start in water, one under 2 of
    air, and one is flown; lines over four waypoints are proven from 11 of 19 starts; and the line from the first waypoint to the last, 548 blocks, is proven
    as one. Where the goal is under a roof and the start is too, the hop is tried before anything else; where none is
    proven the trip does what it did, and a watched walk asks again as it gets on.
12. **Two settings, not one.** A way in ends a flight that began in the open; a hop is powered flight that never leaves
    the roof. They are switched on after their own series.

## Consequences

- A drawn way out is proven from 18 of the 19 roofed places of the fixture (5 before); the one left has two of air over
  its start, where no jump takes a glide.
- A flight to a covered goal with no recording ends standing by it where its opening lies over it; where the opening
  lies under the goal the entry is refused in a line and the flight lands by the mouth, as before.
- A trip between two places under one roof is one flight where a line of 48 blocks or more is proven. The shortcut of
  the owner's cave is not: its last piece is a slot one to three cells wide.
- With `flyCaveEntry` and `flyCaveHop` off nothing of 8 to 12 runs. Decisions 1 to 7 change every drawn way out
  (`flyCaveExit`); a recorded line is followed as before (it has no speeds).
- The proof's burns are one length for all the rockets of a flight, and two mixes. A line of five to eleven rockets is
  flown with as many lengths. The probes' flights say that holds; the proof does not.
- On the replica the drawn way in is refused (its shell's wall stands beside the lead-in) and no way is found past the
  water between cave_3 and cave_8 (the server's water lies where the fixture has air): what flew there is the drawn way
  out and the hops on either side of that water. The long line and the way in are offline results on the fixture.

## Addendum: what the Realm showed (round 2, 2026-11-11)

Round 1 flew on the Realm. The drawn way in flew 3 of 3. The way out of the deep cave and the hop from the cave's first
waypoint were not found, and five hop flights lost their line and cost health. Details and numbers:
[../flight.md](../flight.md) "What the Realm showed (Track F9e, round 2)".

What was found. The lost flights were not flown into cells the cache had wrong: the body met a corner the proof knew,
because it was not where the model had it. Every burn this project had measured (9 to 21 ticks) was of the rocket the
script API gives the test kit, which has no flight duration; a crafted rocket burns ten ticks longer (21 to 30 measured
on BDS, n 55). The model's burn ended at 22 ticks and the server's body flew on. With crafted rockets and the old model
the replica shows the Realm's failure in 5 runs of 5; with the kit's burn 8 flights of 10 arrive. The deep cave's way out
was not found because the flood stopped at 128 blocks; the hop's flood ran out of cells across the forest floor round
the cave's mouth, which the fixture's box had cut away. And the probes had not run as the bot runs.

13. **The burn is the burn of the rockets at hand** (`skills/fly/burn.ts`). The item's flight duration is read; the
    model's boost runs to the rocket's removal, at most that rocket's longest burn; a line carries its burn
    (`Guide.burn`), and its follower, its roll and its proof fly that range (19 to 31 for a crafted rocket). The plain
    rocket's numbers are what they were. The flight in the open and the route tracker's plans still think in 9 to 21.
14. **A line is drawn, proven and flown only through cells of the live model.** An unknown cell is a solid for the
    proof's body and for the follower. The way is looked for on what was ever seen (the live model, the cache behind
    it); where it leaves the live model the flight is a piece of it: a hop to a floor under the way, 12 cells short of
    the first cell the live model does not have, proven like any hop; the trip asks again where it stands. This and
    not a confirmation running ahead of the body: a piece ends in a touchdown that was proven and needs no new way of
    flying; a set-down where a confirmation failed has no floor over water.
15. **The decisions are one module for the bot and the probes** (`learn/under.ts`), and the probe's world is the bot's
    two layers (`scripts/cave-under-probe.ts`): the fixture as the cache, the chunks within nine of the body as the
    live model. A number from a probe that runs otherwise is not an acceptance number.
16. **For the search to a cell a roof is a thick one** (8 solid cells over the cell): a tree's canopy is no cave.
17. **The way out is looked for 448 blocks far**, on the live grid; where the live model holds none, the cache's way is
    flown in pieces. A decision under a roof waits up to 3 s for the live model round a body that has just arrived.

Consequences. As the bot, on the wide fixture, with crafted rockets: a way out from 18 of the 19 roofed places (the deep
ones in one or two pieces); cave_start to cave_end in 3 pieces and back in 4 (22 to 26 s of flight, 4 to 5 s of
deciding), where round 1 had one line of 548 blocks on the whole fixture; a crafted rocket's least hop is 65 blocks, so
13 of the 62 pairs fly (21). Cold, nothing is flown. Not solved: two of ten crafted flights of one hop left their line
in the first burn's climb on the replica (braked, no hit); the rest of the flight stack with crafted rockets.
