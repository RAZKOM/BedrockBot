# 0083: The open-air flight plans with the burn of the rockets at hand (flight v2, Track F10)

Date: 2026-11-12. Status: accepted, behind `flyKitBurn` (default off). Builds on
[0082](0082-drawn-entries-and-hops.md) (the addendum, decision 13: the burn is the burn of the rockets at hand, for the
lines under a roof), [0081](0081-drawn-lines.md) (a burning rocket capped at a height whatever its burn: `capPitch`),
[0064](0064-route-landings-and-takeoffs.md) and [0058](0058-flight-planner.md) (the route planner, its burn branches
and its tracker), [0055](0055-terrain-safe-cruise.md) (the terrain floor), [0042](0042-elytra-flight.md) (the addendum:
the cruise's rocket economy). Details and numbers:
[../flight.md](../flight.md) "The open-air flight on the burn of the rockets at hand (Track F10)".

## Context

A rocket a player crafts burns 19 to 31 ticks; the rocket the script API gives the test kit burns 9 to 21, and every
number of the flight in the open was measured with that one. After 0082 the lines under a roof took the kit's burn. The
climb, the cruise, the route planner with its tracker, and the proofs of a takeoff without a line still planned with 9
to 21, on the Realm with rockets that burn ten ticks longer.

What that did was measured before anything was changed. On the Realm the same trip topped 22 to 67 blocks over the
cruise height its plan named, by a different amount each run, and the runs that topped highest took 5 to 8 s longer
(the height has to be flown off before the landing). Three things add up to it, and only the first is the guess the
track began with:

- **The climb's last rocket is flown at the climb pitch for as long as it burns.** The climb hands over when the
  body's rise will carry it to within 3 of its goal, the rocket still burning; every tick of burn after that is a
  block of height. Ten ticks more of burn are ten blocks more.
- **A top-up's pitch is read off a table for 15 ticks of burn.** Asked for 8 blocks over the terrain floor, a crafted
  rocket gave 16 to 18 (the Realm, 7 top-ups); asked for a whole rocket's 31, it gives 36 to 48.
- **A top-up buys a whole rocket's worth whenever the glide ahead is longer than that height can be glided off**,
  whatever the body is short of. A body a few blocks over its glide line with 400 blocks and more to go is bought 31 (a crafted
  rocket: up to 48) and arrives that much over its landing's entry. This is the largest part of the Realm's highest
  flights, and it is not the burn's doing: it costs the plain rocket 20 blocks too.

The terrain floor is not part of it, though the log reads so: the climb goes for the cruise height or the floor the
terrain ahead asks for, whichever is higher, and over hills the floor is up to 20 over the cruise height by design
(a column 200 blocks ahead is cleared by a glide from that much higher).

What is unsafe and not only slow is where a plan or a proof was flown at 9 to 21 through a narrow place: a route
landing and a searched route takeoff, a corridor's windows underground. Their plans branch at 9 and 21 ticks, their
tracker believes a burn over after 21 and stops reading it off the body, and the rocket burns on for up to ten ticks
more. In the open the per-tick path check has the burn right already (the input loop counts the kit's burn since
0082), so a climb or a go-around near terrain is steered clear as before.

## Decisions

1. **One setting, `flyKitBurn`, default off, turns the kit's range on for everything in the open.** Off, or with
   plain rockets in the hotbar, nothing is told to anything and every flight is tick for tick what it was (13 offline
   cases with a hash of every tick's position, the base commit's tree beside this one). The lines under a roof keep
   the kit's burn whatever the setting says (0082). The owner's rule: what changes how the bot flies ships off until it
   has flown on the real terrain.
2. **A burning rocket is flown to the height it was fired for and no higher, however long it burns**
   (`brain.ts`, `KIT_CAP_OVER`; 0081's `capPitch`, for every flight). The look is the one whose rise, were the burn to
   end this tick, coasts to that height: steep while the height is far, flatter as it comes, never down. The rest of a
   long burn is speed, which the cruise turns into height when it is over 1.7 a tick. This and not a pitch tuned to
   the nominal burn: the burn is 19 to 31 and nobody knows which; a tuned pitch leaves 12 ticks of spread, the cap none.
3. **The height a rocket is fired for is what the flight can use**: the climb's goal; what the terrain will ask over
   the glide a whole rocket's height covers (420 blocks for a crafted one, not the floor's 200); what the glide to the
   target needs with its margin and 8 (`KIT_USE_OVER`, the number the economy's last top-up has always aimed for).
   The highest of them, for the climb's last rocket and for every top-up. A whole rocket's worth is bought only by a
   body that far under what it can use. Without the terrain's part a ridge 300 blocks long cost three top-ups of 8
   where the old model's over-long rocket had carried the body across: the setting must not cost rockets.
4. **A top-up's pitch is the one whose shortest burn buys the height asked** (`burn.ts gainPitch`, `rocketGain`: the
   glide formula flown, which at 15 ticks gives the table the cruise has used since 0042's addendum). A longer burn is capped by 2.
5. **The route planner's state carries the kit** (`RouteState.kit`). Every place a burn begins reads it from the
   state: the step, the burn branches (the kit's shortest and longest, and three ticks in from each where the mids are
   swept), the robust check, the replay. So a request's start is enough: it crosses to the worker with the request and
   every state of the plan has it. The tracker makes its states with it and believes the kit's range after its own
   rocket. This and not a field of the request or a module's variable: a state is copied wherever a burn is flown, the
   request is not, and the search runs in another thread.
6. **A proof flies the kit's burns.** A takeoff's simulation flies the nominal burn the brain is told (the jump, the
   ledge, the vertical takeoff, the takeoff sites, a glide down with rockets); a searched way out is planned on the
   kit's range and proven at its nominal, its two ends and three ticks in from each, as the plain rocket's is at 15,
   9, 21, 12, 18. A corridor's windows and the cave shortcut's proof plan and fly the kit's range.
7. **The path check before a rocket flies the kit's nominal burn** (20 ticks ahead, all of them boosted for a crafted
   rocket where five were a glide).
8. **The log says it**: `planned for rockets that burn 19 to 31 (flight duration 1) ticks` on the flight's first line
   when the setting is on and the kit is not plain; and every landing's line has the flight's first top and what the
   climb went for (`max y N (the climb to N, for N)`), setting or not.

## Consequences

- Offline (the brain on the physics, crafted burns drawn by a seeded generator, 30 flights a case, 19 cases): told the
  kit's burn the flights' tops lie in a band half as wide (14.9 blocks against 29.8 on average) and 17 blocks lower
  at its upper end, on the same rockets (3.61 a flight against 3.62) and 6 ticks fewer a flight.
- On the test server with rockets the bot crafted (18 flights a side, 400 and 650 blocks over flat ground and over a
  hill): every flight tops within 12 of its cruise height (0 to 29 over with the setting off), a top-up the terrain
  asks for gains 9 to 14 (17 to 18), on 40 rockets against 38 and 562 ticks a flight against 575; no flight is as slow
  as the off side's three highest.
- A short flight to a cell the brake lands (150 blocks to a hole) is slower told, 311 ticks against 241 offline: untold,
  a long first burn topped high enough for the dive descent, and told every flight circles down. The descent's choice
  between a dive and a circle by the height the body happens to arrive at is the landing's and was not changed.
- A flight whose target moves up in the air (a line into a cave is found while the flight is under way and starts
  higher than the goal's cell) is topped up for it with what the glide can use; untold, the climb's overshoot sometimes
  covered it. Offline that is 0.35 of a rocket more a flight for 30 ticks fewer.
- The corridor's prices (`corridor/cost.ts`) still count a rocket as 31 blocks of height: a crafted one buys 42, so a
  flown leg is priced a little dear. Not changed: it decides walk against fly at the coarse level and errs to the safe
  side.
- The kit is read when the flight takes off. Rockets of another kind taken from a box in flight are flown on the first
  kit's numbers (the input loop still counts each rocket's own burn).
- Flight durations 2 and 3: see the page.
- Not on the Realm yet. The setting is off there until the coordinator has flown it.
