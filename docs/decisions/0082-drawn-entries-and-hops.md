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

## Addendum 2: the hop asked from a walk (Track F22, 2026-11-20)

The hop flew on the Realm between the cave's two end waypoints: one way 6 of 6 in 29 to 31 s, the other 6 of 6 in 31
to 112 s and once 225 s with 16 damage. Details and numbers: [../flight.md](../flight.md) "The hop asked from a walk
(Track F22)".

What was found. (a) A hop's line is proven from where the body stood when the decision began, the decision takes
seconds, and nothing held the body meanwhile: a chore's walk, a fight and a walk begun after a piece of the way each
moved it 3 to 21 blocks, and the answer was thrown away. A walk's own re-check asked for the whole decision from the
walking body, whose answer is stale after six ticks by construction. (b) The walk that was to ask again followed the
process that had the body when it was asked for (the guard) and never asked: 631 blocks on foot. (c) Two of about
twenty hops lost their line and came down on a roof short of the touchdown. Offline on the fresh fixture the cause is
neither the start's place (360 of 360 flights from up to a block beside it) nor the burns (60 of 60) nor the cave's
cells (the decision is the Realm's line for line): it is the burn's end seen late. The loop boosts its body until the
rocket's removal, a round trip after the server's burn ended; for those ticks the looks are chosen for a body that
follows its look and flown by one that does not. Seen 6 ticks late the line is lost where the Realm lost it, with the
Realm's numbers; seen 3 late (a local server) none of 140 flights is lost. The Realm's log has a rocket entity 6
ticks after its use. (d) On the replica two of the first nine hops flown from the held body killed the bot at the
touchdown: the line falls a block a tick down to it, the server counts a glide's fall from the last tick that began
with a sink under 0.5, and the floor came before such a tick.

18. **A flight under a roof is decided standing.** The trip takes the body first with a process of its own rank that
    stands (`tasks/process/stand.ts`), waits for it to rest, and asks from there (`learn/standing.ts`). Flee, the guard
    and the night shelter still take the body: an answer for a place it has left is asked for once more, standing, and
    a second stale answer is given up with a line that says the trip walks. Why a hold and not a wider tolerance: the
    tolerance is the proof's own.
19. **A walking body asks whether a hop may be there** (`scoutHop`: the way and one line, nothing simulated), the walk
    stops where it may (a safe spot with a jump's head room) and the hop is decided once, standing. Why not the proof
    kept by cell or a walk back to the proven cell: the second question came 3 to 13 blocks on, and a walk back costs
    what the decision cost.
20. **A watched walk follows its own process** (the newest user process the walk added).
21. **How late a connection's rockets are seen is measured, and the proof flies it** (`rocket.ts RocketLag`: the usual
    add lag of the last 40 rockets and one; `glide.ts routeHop`, `late`: from 4 ticks on, 8 seeded flights with a burn
    of its own for every rocket and every end seen that late). A line lost in one of them is refused before the
    takeoff with the burns in its line. Why seeded flights and not a burn made to end where the line turns: the second
    was tried and found no more lines than chance, at the same cost.
22. **A hop that lost its line is asked again at once** from where the body came down, when the flight cost no health
    and got 16 blocks from its start, twice a trip at most.
23. **A hop's last blocks are flown with the sink under 0.42 a tick, and the proof counts the fall the server counts**
    (`learn/entry.ts ENTRY_SINK_MAX`; `SimResult.fall`). A flight that lands with more than the free 3 blocks counted
    is a refusal.

Nothing is flown that was not flown before: the old proofs still have to clear a line, the margins are the same, the
new flights of the proof only refuse, and rule 23 only slows a descent. No new setting.

Consequences. Offline on the fixture of 2026-11-20, the hop asked from 43 and 34 places along the way: the answers given
to a walking body were for a place it had left in 38 of 38 and 33 of 33 (3 to 19 blocks); held, in none, and a hop is
one decision where it was two. With rockets seen as on a local server the same hops are flown (38 and 33, where 35 and
32 were). With every rocket seen 2 to 6 ticks late one hop in 34 ended on a roof before; after, none, and 26 of 43 and
9 of 34 places have no hop and are walked. On the replica, with an older walk having the body when the trip is asked
for (10 runs a direction): before, 19 of 20 answers not flown and every trip walked (25 to 29 s); after, the body held
in 20 of 20, every trip flown (17 to 19 s, 98 to 99 % of the way), no line lost, no damage. Before rule 23, 2 of 9 hops
from one of the two places killed the bot at the touchdown; with it 20 of 20 touch down at a sink of 0.13 to 0.17 a
tick. Behind a relay that holds every datagram 75 ms (a round trip of 3 ticks) the rockets' entities come 4 to 5 ticks
after their uses, the lag is taken as 6, and every hop after the first trip is refused and walked with no damage;
with the proof's late flights off 10 of 16 flights lost their line there, two of them with 3 and 11.5 damage.

Not solved: a rocket seen late now and then on a link whose usual lag is a local server's (the Realm's log has one in
about 85) is not foreseen by any proof: such a hop still loses its line, and what changed is what it costs (a question
where the body came down, not a walk).

Not built: rockets timed so that no burn ends at a top (a schedule drawn with the line, for every drawn line, and
every table of Track F9e again); the loop taking back as many boosted ticks as the lag it measures (it changes every
flight with a rocket and needs a server a round trip away to be measured on: `scripts/udp-lag.ts` is that server).
