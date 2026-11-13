# 0084: A flight comes down on the landing it chose (flight v2, Track F11)

Date: 2026-11-13. Status: accepted, `flyLandOver` default on. Builds on [0042](0042-elytra-flight.md) (the addendum:
the descent geometry, a circle chosen by the columns round the target), [0047](0047-flight-landing-v3.md) (the landing
search: a live, dry, sound cell with a confirmed walk), [0057](0057-flight-manoeuvres.md) (the brake / elevator
landing, a shaft's rim), [0074](0074-cave-entry.md) (a rim the caller knows: the brake over a wide opening and the
elevator down), [0076](0076-land-by-time.md) (the nearest safe ground as a priced landing). Details and numbers:
[../flight.md](../flight.md) "The flight comes down where it planned to (Track F11)".

## Context

On the Realm (2026-11-13) ten flights home of ten ended `landed_off`, 8 to 12 blocks from the centre of the landing
the search had chosen, standing 2 to 9 blocks over its floor on the roofs, a slab and a trapdoor round it. The walk
from there cost up to 1.3 HP and once could not start. Nothing in the log said why.

The landing was a good one: an open floor of 63 cells with a confirmed walk. The flight arrived 62 to 72 blocks over
it (the goal's ground loads late and the flight holds high until the search has answered), and came down in the
descent circle round it. Three things in that circle add up to the ten flights:

- **The circle's fit asks about the wrong height.** `spiralFit` takes the largest circle whose columns are lower than
  the height the circle begins at, less 3: 13 over the landing's floor. Anything whose top is up to 12 over the floor
  under the circle counts as free.
- **The circle is flown to 6 over the floor.** It is left heading at the target at least 28 blocks out, or 10 under its
  exit height whatever the heading. A circle round the target itself has a radius of 24 at most, so the first rule can
  never be met: it is always flown to the second, which is 6 over the floor.
- **Between 6 and 13 over the floor nothing looks under the body.** The path check looks ahead along the look; a body
  that sinks in a level circle meets what is under it from above. On the server a glide ends the tick the body
  touches a block's top, the brain takes "standing after a glide" for the end of the flight, and a flight that ends
  off its target with no reason of its own is `landed_off`. No rule had fired, so no line was written.

A circle of radius 10 was all that fitted there (one thing just outside it is higher than where the circle begins);
roofs 5 to 12 over the landing's floor stand under it.

The same flights offline (the brain on the physics over the world cache's extract of the place, from the Realm's
heading): 0 of 12 on the landing, 9.0 to 10.1 from its centre, 5 to 8 over its floor; round the compass 9 of 48.

The landing search does not look at the descent at all: it simulates the approach from 56 blocks out at the approach
entry's height along four bearings, which is how a flight that arrives low comes in. It was right about that approach.

## Decisions

1. **A descent circle is never flown lower than 3 over the highest column under it** (`plan.ts spiralTops`,
   `spiralFloor`, `SPIRAL_CLEAR.over`; "under it": within the berth of 4 either side of the radius). The fit is left as
   it is: it chooses the radius by where the circle begins; the floor says where it ends. 3 and not 1: the body is 0.6
   high and sinks up to 0.2 a tick, the column tops come from cells, and a fence or a wall stands half a block over its
   cell. A circle beside the approach line (the tangent circles) gets this floor and nothing else.
2. **A circle round the target is left higher still, by the way in**: 2.5 for the quarter turn from the circle's
   heading to the centre's and 0.26 for every block of radius (a glide at 0.65 a tick sinks 0.17), and over the highest
   column inside the circle as well as under it. So the body is still over everything it has to cross when it arrives
   over the landing's own cells.
3. **Left at that floor, the landing is flown as a floor under a rim** (`brain.ts leftOver`): the target gets `rim`,
   the feet height of the highest column under or inside the circle, and the landing family is the brake / elevator's
   alone, as it is for a shaft's floor (0057) and a pit's (0074): in over what stands round the landing, the brake over
   the centre, straight down. A go-around is flown over the rim. This and not a new manoeuvre: the elevator is the
   landing this code already flies where a floor lies under its surroundings, it needs no room round the landing, and
   its touchdown is the softest the bot has (0.15 to 0.34 a tick down, standing still).
4. **Under that rim only over the landing's own cells** (`LandingTarget.rimWithin`, `rimReach`, `RIM_OVER` 1.5): a plan
   of the brake that sinks under the rim plus 1.5 farther from the centre than the nearest column that is not a cell of
   the landing (less the body's half width) is a wall to the planner, whatever the cell model says of the way. Without
   it the planner takes the steepest way in the cells allow (a plan's cost is its time) and passes roofs and fence
   lines at its berth of 0.4; a fence's top is 0.5 over its cell. A shaft and a pit keep the cell model alone: their
   walls are the cells.
5. **Nothing changes where nothing stands under the circle**: columns up to 2 over the landing's floor under a circle
   round it (open ground, a fence on it) leave the circle and the landing as they were, tick for tick (the flare from
   6 over the floor was measured there), and so does a wall inside the circle that is not under it. A flight that
   arrives low and comes straight in is not touched either: its approach is the one the search simulated.
6. **The nearest safe ground is ground** (`ground.ts`, `commands-fly.ts groundAt`): not a block a body does not stand
   on as on a floor (`standsOn`: collision boxes that reach over the cell, as a fence's, a wall's and a gate's do, or a
   top face under half a block wide), and not a perch (`perched`): a top with a dry floor more than a safe fall under
   it within 8 blocks that no walk leads down to (a flood over the column tops, a block up or up to 3 down a step).
   A stepped roof has "level neighbours" as a field has; a hillside walks down; a platform over the sea has no floor
   in reach and stays ground. The takeoff sites ask without these rules (a ledge is a good place to fly from). The
   landing search's cells get the first rule (`Floor.post`): a floor on a fence is a way for the walk and no cell.
7. **A flight that ends off its landing says so in words**: `FlightEnd.why`, on the `flight: ended (landed_off)` line:
   the phase the glide ended in, what the body stands on against the model's top of that column, how far from the
   landing and how high over its floor, and what the phase needed.
8. **One setting, `flyLandOver`, default on.** On by default because the change keeps the descent the flight uses (the
   circle, then a landing family the cost already picks where the flare cannot land), touches down slower than the
   flare does, and takes the body out of the one place it was being hurt; off, the circle and the nearest safe ground
   are what they were. With `flyLandStyle flare` it is off as well (what the circle is left for is the brake's landing).

## Rejected

- **A smaller or offset circle.** The radius is already the largest that fits; a smaller one is under the same roofs,
  and a circle offset to open ground only moves the question to the way from there to the landing.
- **Fitting the circle against the height it ends at.** At 6 over the floor nearly nothing fits round a landing between
  buildings or trees; the flight would fall back to the circle beside the approach line and the flare from 30 to 80
  blocks out along a line that crosses the same roofs low.
- **A landing score that knows the descent.** The descent depends on the height the flight happens to arrive at, which
  the search does not know, and the landing here was the right one. With the elevator every open floor the search
  confirms can be come down on from above.
- **Straight down from the cruise height with no circle.** The elevator would do it (0.34 a tick at pitch 30, faster
  than the circle's 0.18), but 60 blocks of elevator have flown nowhere but offline; the circle is the measured way
  down and is kept for the height that is free.

## Consequences

- Offline on the extract of the place (the Realm's heading and seven more, arriving 60 over the landing and higher,
  crafted and plain burns, told and untold: 180 flights): every flight stands on the landing's floor at its centre
  with no damage and no hit, by the brake, with no go-around; before, 0 of 12 from the Realm's heading and 9 or 10 of
  48 round the compass. The flights are not longer (424 ticks against 416 from the Realm's heading, 488 against 492
  round the compass). On 24 other open cells of the place as the landing: 23 of 24, against 18.
- On the test server, a yard between roofs and real fence lines: 10 flights of 10 to a goal under a roof beside it
  stand on the landing the search chose, 0.00 to 0.02 from its centre, with no damage, and walk in; with the descent
  as it was, 0 of 10 (see the page).
- Flights with nothing over 2 under their circle, and every flight that does not circle, are the same tick for tick
  (14 offline cases, the base commit's tree beside this one).
- A landing with roofs or trees round it is flown by the brake and the elevator, not the flare, whenever the flight
  arrives high. On hills that is most landings: the ground uphill of a landing is "what stands round it" too. The
  elevator's last blocks take 3 to 6 s where the flare's take 1 to 2.
- The elevator comes down on the landing's centre, which for a walk landing is the cell the search chose: the one with
  the shortest walk, often at the landing's edge nearest the goal. On the test server it stood one block from a wall 6
  high and landed 0.02 from the centre.
- The column tops are the model's. A block the live model does not have under the circle (a chunk that loaded wrong, a
  build since the cache was written where only the cache is known) is still flown into; the end's line now says
  that the body stands over or under the model's top.
- Not on the Realm yet.
