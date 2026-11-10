# 0080: A recorded flight as the way into a cave (flight v2, Track F9c; learned paths as guides, part 2)

Date: 2026-11-10. Status: accepted. Builds on [0078](0078-learned-exits.md) (a recording as a line, the follower, the
matcher), [0076](0076-land-by-time.md) (the landing is chosen by time), [0074](0074-cave-entry.md) (the corridor's way in
from a landing outside), [0069](0069-cave-flight.md) (no flight underground without `flyCave`). Details and numbers:
[../flight.md](../flight.md) "Learned entries (Track F9c)".

## Context

After 0078 the bot leaves the owner's cave along a recorded line (59 s a run on the Realm, 90.6 s before). The way in is
as it was: the flight lands on a cell beside the cave's mouth, the corridor proves windows underground for about 14 s, one
window flies and bails out, and the rest is walked: 81.8 s a run, 25.6 s of it after the landing. The owner flies the same
stretch without landing at all: seven recorded takes that come down from a hill, pass the mouth at 1.3 to 1.8 blocks a
tick, glide 65 to 76 blocks under the roof with no rocket and stand beside the goal after 4.3 to 5.3 s. Their words: "fly
through caves and land underground", and of the recordings, "It doesn't have to follow me to a tee but it should be able
to recognize the flight path (like through the cave entrance)."

0078's matcher already finds five of those takes at the goal (`matchEntries`). What flying one needs that the way out did
not, measured on the cave's fixture before anything was built:

- **The follower catches a wide set of states, once it is given three things.** Started on a recorded line in the open and
  left alone, 0078's follower flew it to the roof and under it, and then arrived at the line's end half again as fast as
  the recording (1.6 to 1.8 a tick where the owner had 1.0 to 1.1: a follower tracks the place, and the owner's pull-up
  before the touchdown is a matter of speed), met the wall behind the goal, or, slower, sank into the dip the slower
  takes cross before the goal and stood 3 to 4 blocks under it. With a speed governor, a touchdown and the goal's own cell
  as the touchdown (below), two of the five takes are flown to standing from 3 blocks beside the line, 5 over and 2
  under it, at 0.8 to 2.0 a tick, 25 degrees off its heading, anywhere in 24 blocks of open air; one of them from up to 8
  beside it, 8 over it and 60 degrees off.
- **The other three takes are not flyable by this body, and the proof says so.** They cross a dip 4 blocks under the goal
  and stall-climb out of it onto the goal's floor at 0.2 a tick. The follower keeps the recording's speed there and has
  no stall climb: it stands in the dip, 2 to 6 blocks from the goal.
- **A recording's last blocks are its recorder's landing, not a line.** One take rises onto a ledge 5 over the goal,
  stalls against it and drops; two stand on a ledge 2 over the floor, 2.1 and 2.2 from the goal. All five pass within 2
  blocks of the goal's own cell.
- **The line lies along the ground it comes down.** The owner takes off from a hilltop and glides down its flank: the
  recorded line's open part is 1 to 4 blocks over the ground on one side, and its first 30 to 40 blocks are a jump and a
  slow start, not a glide. A cruise crosses that hilltop with its terrain clearance, 10 to 15 over the line.

## Decisions

1. **An entry is matched by where it stood again, never by its name** (`learn/match.ts matchEntries`, 0078's): a flight
   that stood again within 4 blocks of the goal (3 in height) under a roof and came from under open sky. Several takes
   are several candidates.
2. **The line has a hand-over window and a lead-in** (`learn/entry.ts entryLine`). The window is 24 blocks of the line's
   open air that end 20 before its last open sky and that the recording itself flew at 0.9 a tick or more: a body is taken
   onto the line there or not at all. Before it the recording is replaced by a lead-in: the window's first 8 blocks drawn
   backwards as a straight descent (6 to 20 degrees), up to 40 blocks, as far as the air is free. The recorder's own
   takeoff is not flown.
3. **The touchdown is the goal's own cell**, and the line ends where it comes nearest that cell on its last 14 blocks.
   What a recording does after that point is not followed.
4. **The flier is 0078's follower with an entry mode, then the brake landing's station keeping** (`learn/follow.ts`,
   `learn/entry.ts EntryFlier`). No jump and no rocket. A speed governor: a body faster than 1.1 times the recording at
   its place looks straight back along its velocity for one tick (the brake's look: a fifth of the speed, the direction
   kept), never two ticks running, so the line is still steered along. The follower's aim lies at least 2.5 times the
   body's distance from the line ahead, so a body that joins from above comes onto the line at a slant and keeps its
   speed. On the line's last blocks the touchdown begins as late as its brake still stops the body over the goal's cell
   (the station keeping's own law rolled out on the glide formula each tick), or a tick before that brake would meet a
   solid; then `keepLook` (brake.ts): the look back while fast, the creep onto the cell, the sink at 0.15 a tick.
5. **The proof is the gate, it ends standing, and it flies the hand-over's whole box** (`proveEntry`). 39 flights on the
   body's physics from the hand-over to standing: the recording's own state at the window's middle, start and end, and at
   each of those every single extreme (3 beside the line either way, 5 over, 2 under, 0.5 and 1.25 of the recording's
   speed within 0.8 to 2.0 a tick, the heading 25 degrees off either way) and the four corners that stack them. Every
   one must meet no solid and no water, never lose the line, stand within 2 blocks of the touchdown and come down slower
   than 0.45 a tick. A take whose own three states do not fly is refused for three simulations. Of the takes that clear
   (three whole proofs at most, 8 s at most), the one whose flights kept the most room from a block is flown.
6. **A contact that costs less than 0.15 a tick of speed is a touch, not a hit.** The goal's cell has a wall beside it;
   the station keeping's creep at 0.25 a tick brushes it in some flights. Flying into a wall costs health from a loss
   of 0.3 a tick; half of that is the proof's line, and touches are counted apart.
7. **The hand-over is in two steps, and only the second is under the proof.** The brain gives the body to the flier on
   the lead-in, in the open (`entryJoin`: within 8 beside the line, heading within 45 degrees of it, and over it by 4
   blocks plus 0.35 for every block of line left to the window's end). In the window the flier commits when the body is
   inside the proof's box (`entryCatch`) and the proof stands; from then on the line under the roof is the proven one. A
   body that leaves the window uncommitted has missed: a go-around out along the line and back onto the lead-in, at most
   twice, then the fallback. Nothing dives at the mouth from where it happens to be.
8. **The cruise comes to the lead-in as it comes to a route landing's corridor** (0064's and 0065's machinery: the
   corridor's entry, the line in, the sink to the hand-over's height), with three additions for an entry: the height it
   aims for is no lower than its terrain clearance over the ground under the lead-in; the height still to lose on the way
   in goes in a dive along the line (up to 40 degrees) instead of S-turns, because the flier takes a fast body and slows
   it; and a body that reaches the lead-in more than the join allows over it comes down a helix of 14 blocks beside the
   lead-in's start that touches the line there, every lap a pass along the line, the first one low enough the hand-over.
   The helix's sink is steered so that the body crosses the start 8 blocks over it (the laps counted once when it
   begins, the pitch each tick from the height left and the blocks left): a glide cannot fly level, a lap costs 20
   blocks at the least, and a helix that dived to a height and then "levelled" ended its last lap wherever the arrival
   height put it (one replica run in nine: under the line and onto the hill beside it). The last pass is flown along
   the line; passed with no hand-over, one more lap when the height pays for one, else a miss at once. A go-around for
   an entry climbs a lap's worth over the pass height before it turns back in: the band between what the flier takes
   (22 over the start) and what a lap costs (20) is where passes are missed, and a go-around that comes back into it
   misses again.
9. **The decision is made in the air, and a proof on the world cache is confirmed on the live world.** The goal's chunks
   are not loaded when the flight starts far away. Matching and proving run after the takeoff (they yield to the
   input loop every 12 simulated ticks), on the live model with the world cache where the live model has nothing; every
   cell the proof asked is remembered. The flight is retargeted to the entry while it is still 60 blocks from the line.
   Before the flier may commit, the live model must answer every one of those cells as the proof was answered
   (`entryWorldSame`, the cells in the world cache's own four classes so that a live block and its stand-in are the same
   cell): the same answers are the same flights. One cell different: the entry is given up.
10. **Losing the line, a refusal and a miss all end as flights do today.** A line lost after the commit lands on the
    nearest ground (`roof`), as a learned exit does. An entry refused, missed twice or not confirmed falls back to the
    landing the flight had before it; given up beside the line, the body first climbs away (a rocket on the first look
    whose boosted path is clear: turning back along the line, or straight on and up; 24 up), and where no look is
    clear (low between the hill behind and the roof ahead) it lands at once on the nearest ground before the line's
    roof instead of gliding on towards it.
11. **One setting, `flyLearnedEntry`, default off, needs `flyCave` and the route planner on.** Not `flyLearned`: that one
    is on for the exit and the two are tried apart. With it on, `!fly` to a goal with a recorded way in takes the plain
    flight (which carries the entry) rather than a corridor trip.
12. **The learned exit's proof flies a first rocket that fires nothing** (`glide.ts simulateFlight dud`,
    `LEARNED_PROOF_DUDS`): the body unboosted, the brain shown for 5 ticks the body the input loop predicted, then the
    real one behind it. The follower notices a burn shorter than any rocket's, finds its place on the line again from the
    line's start (it never looked behind before: the Realm's one failed exit flew its second rocket 6.5 off the line
    from a place it was not at) and asks for the rocket again on that tick. A take that clears everything but the dud is
    kept in hand and flown only when no other take tried survives one.

## Consequences

- The way in is one flight: no landing outside, no window proofs, no walk. From the line's last open sky to standing in
  3.0 to 4.2 s offline and 3.0 to 3.5 s on the replica (the owner: 4.3 to 5.3 s), 6.9 s from the slowest corner of the
  proof's box.
- Two of the owner's five matched takes are flyable. A cave whose only recordings stall-climb onto their touchdown has no
  learned entry until the flier learns that climb.
- The approach in the open is not proven, only the entry from the commit on. It is guarded by the commit's test, the
  path-ahead check of every cruise pitch, and the go-around.
- The helix and the dive are new ways for the cruise to lose height; they are flown only for a target that carries an
  entry.
- `flight.md` has what a drawn line (no recording) would need from this code.
