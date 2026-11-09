# 0076: Land by time, not by precision (flight v2, Track L1)

Date: 2026-11-09. Status: accepted. Builds on [0047](0047-flight-landing-v3.md) (Track BF, the walk landing: only a live, dry,
sound cell with a confirmed walk), [0057](0057-flight-manoeuvres.md) (the brake / elevator family), [0074](0074-cave-entry.md)
(the rim, the hold over a covered goal). Details and numbers: [../flight.md](../flight.md) "Landing by time (Track L1)".

## Context

The owner (2026-11-09): "It literally takes me one rocket to go to and from the xp farm and my home. But since the bot is trying
to land super precisely it does a few go arounds even when it's about to land at a very walkable spot. It should try to land as
close as it can but it shouldn't waste a whole 10 s of go-around to save 2 s of walking."

The live bot's log (the Realm, 2026-10-30 to 2026-11-09): 131 flights ended, 91 with no go-around, 34 with exactly the four
`flyGoArounds` allows, each then "no go-around left: the nearest safe ground", 12 to 43 blocks off. All 34 flew to the owner's
underground goal (cave_start, a feet cell about 50 under a hill, the cave's mouth off to the side). The landing search had ranked its
candidates by the straight distance plus three a block of height (the hill over the cave first), its probes ran out on the hill's
cells, and the eighth found a walk of 46 blocks from a cell in a valley under the hill; no approach onto that cell had been simulated,
and every approach from the go-around's height (80 above it, the hill's) ended `brake wall`. Measured from the same log:

- a go-around costs 6.2 s (the median between two go-around decisions, 91 pairs; 6.0 from the last one to the forced landing) and
  1.13 rockets (152 rockets over 135 go-arounds);
- a go-around after a `wall` miss landed 3 times in 16, after `none` 0 in 19, after one that had failed the same way 1 in 91.

## Decisions

1. **Every landing decision is priced in seconds** (`skills/fly/landprice.ts`): a landing costs the walk from its cell (a confirmed
   probe path at `WALK_S_PER_BLOCK`; an unconfirmed one at 1.5 times the estimate plus 15 s of risk) and, switched to in the air,
   the height it still has to lose; a go-around costs `GOAROUND_S` 6.2 s plus `GOAROUND_ROCKETS` 1.13 at 1 s a rocket, and buys
   the chance `goAroundChance` (by the miss's kind, and the miss before) of landing on the target. A missed approach goes round only
   when that chance times the walk saved beats the circuit's cost (`decideGoAround`), and says so in one line (`landing price: ...`).
2. **Safety is not priced.** The landings offered at a miss are the target's `alternatives` (cells the search confirmed: dry, sound,
   hazard-free, a walk probed, the approach simulated) and the nearest safe ground ahead (the forced landing's `emergencyTarget`, the
   same rules as before: dry, no hazard, level); nothing else. An exact landing (`!fly x y z`, no `walkS` on the target) keeps the
   go-arounds as before.
3. **A covered goal ranks its candidates by the walk** (`walkFlood`: a breadth-first flood over the live model's floors from the
   goal's own floor, steps of a block, a block up, three down, no hazard): the cave mouth's open ground before the hill over it. The
   probe still confirms the walk; a cell the flood never reached ranks behind every one it did.
4. **An open cell is offered only when its approach lands** (`approachLands`): the flight's own planners (the flare, and the brake
   under `auto`) from the approach entry along four bearings, the body's side first, at the height the flight will come in (the
   entry, or 3 over the highest floor on that line out to 56: the go-around's height over a hill), landed under CORRIDOR_COST.
   Cells within 3 of one that did not land are not tried. 24 simulations a search; past them a cell is taken unsimulated and the
   line says so.
5. **Up to three alternatives ride on the chosen landing**, each at least 6 blocks from it and from each other, priced, simulated;
   the search spends at most two probes more on them past its stop rule. The brain switches to one in the air (the cruise's descent
   and approach start over for it; the controller's target and the fly process follow).
6. **The hold prices waiting** (`holdWorth`): the hold's look answers from the loaded part of a partly loaded window (`partial`, at
   least half of it live), and lands on that part's confirmed cell unless an unloaded column (the nearest is no closer than its
   straight distance) could save more walk than the next look's wait.

## Consequences

- On the Realm the flights to cave_start should no longer fly four go-arounds: either the cell the search takes has a landing
  approach, or the first miss prices the go-around (a `wall` miss: 0.19 to land) against the nearest safe ground and the
  alternatives, and the second miss of the same kind lands (0.02).
- More CPU in a search: the flood (about 10 000 floors, 70 ms on the test host for the owner's cave) and up to 24 approach
  simulations (about 10 ms each). The hold's look runs on a partly loaded window, at most every LOOK_EVERY.
- `WALK_S_PER_BLOCK` is a constant measured on the replica; the navigator's own path cost would be better (an open point).
- No new setting: the price's constants are the measurement's; a knob ("how many seconds a go-around must save") can come if the
  owner wants one.
