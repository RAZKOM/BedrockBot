# 0107: A flight never outlasts its elytra (Track F20)

Date: 2026-11-19. Status: accepted; no setting (see decision 9). Builds on [0042](0042-elytra-flight.md) (the kit rule:
the worn limit, the landing at once when the uses reach it; the cruise's rocket economy), [0055](0055-terrain-safe-cruise.md)
(the high cruise, the dive descent), [0049](0049-long-falls-and-clutch.md) (the fall guard's water bucket clutch) and
[0083](0083-open-air-kit-burn.md) (a burning rocket capped at a height: `capPitch`). A new record rather than an
addendum to 0042: the kit rule there is one fixed number, and what replaces it is a rule over the trip, the height and
the server's own count. Details and numbers: [../flight.md](../flight.md) "A flight never outlasts its elytra (Track F20)".

## Context

An elytra loses a use for every second of gliding. At one use left the server ends the glide in the air and starts no
other, whatever the client asks.

On the Realm (2026-11-18) four trips in 14 minutes took the live bot's elytra from 323 uses to 58. The owner then sent
it to a goal 141 km away. The takeoff was allowed (the worn limit is 30). The flight climbed to y 741 for a cruise of
512, took its worn landing at 30 uses about 600 over the ground, flew the forced landing's descent circle and, 27 s
later and still 460 over the ground, lost the glide: 13 glide requests refused, a fall, a death. Two days later an
ordinary trip of 2 252 blocks was started at 100 uses (it needs about 110), held over a goal whose ground had not
loaded, took the worn landing and lost the glide some 57 over the ground; it took no damage by luck.

Measured before anything was changed (bds-fly, BDS 1.26.60.6, and the glide formula):

- **The bot did not know its elytra's uses.** The server does not send the armour slot again when a worn piece takes a
  use: it sends `player_armor_damage` with the piece's new damage value, once a use, and the bot did not read that
  packet. After 58 s of flight its count was 53 uses behind; on the Realm it read 232 where the elytra had 204.
- **The fixed limit does not cover the way down.** The forced landing comes down on a circle that loses 3.8 blocks of
  height a use. From the limit's 30 uses, less the 1 the elytra cannot spend, that is about 110 blocks. A long trip
  cruises 150 to 250 over the ground. Offline, a landing begun at the limit 150 or more over the ground lost the glide
  every time.
- **The takeoff asked nothing about the trip.** Any elytra over the limit took off for any distance.
- **The cruise had no ceiling.** Its rocket economy buys height whenever the body is under the glide line to its goal.
  The glide line of a goal 141 km away is some 14 000 blocks up, so the economy bought a whole rocket at the climb
  pitch each time a burn ended: nine in 12 s on the Realm. This is none of the three causes of overshoot 0083 named;
  it is nearest its third (a whole rocket whenever the glide ahead is long), with no end to it.
- **A dive loses 56 blocks a use** (the look 75 down), fifteen times the circle, and is pulled out in 20 blocks.

## Decisions

1. **The server's count is read.** `player_armor_damage` sets the worn piece's damage in the inventory model
   (`world/inventory.ts handleArmorDamage`): every worn piece, not only the elytra, since the fault is the model's.
   The slot is half the byte the entry carries, as measured with four pieces at four damage values; an odd byte is left
   alone. This and not a count kept by the flight alone: the takeoff's decision, the status line and the supply line
   read the same model, and armour hit in a fight was stale in it too.
2. **The brain keeps its own count where the server's word is late** (`wear.ts UsesCount`): the count it is told, less
   a use for every 20 gliding ticks since that count last changed. With the packet read it is at most a use ahead of
   the server; with no word at all it is the takeoff's count less the flight's seconds; with Unbreaking it is at most
   the gap between two of the server's uses on the safe side. This and not trust in the packet alone: a lost packet
   or a server that sends less must cost a few uses of margin, not a fall.
3. **The takeoff asks whether the elytra covers the trip** (`wear.ts tripCover`): the trip's seconds as the bot
   already estimates them (`flightSeconds`), 15 % longer, a go-around, a hold where the goal's ground is not loaded,
   the part of a climb over 120 blocks, at 1.2 uses a second, and 4; against the uses left over the worn limit. Asked
   where the trip is decided (`!goto`, `!come`, the trip home, `!fly`), again when the flight is prepared, and once more
   with the elytra on the back, where the count is the server's.
4. **A trip the elytra does not cover is not flown: the bot walks, and says why.** Refused, not flown in part. A flight
   ended by the worn landing comes down on ground nobody chose, under terrain that was not loaded when the trip was
   decided, and the walk from there is the walk from the start less that part. The flights that have killed this bot
   ended on such landings. A goal no elytra covers (more than about 7 200 blocks to a held goal) gets a line that says
   so. A trip the elytra covers is decided and flown as before.
5. **The way down is always covered** (`wear.ts wornLimitAt`, `brain.ts wornAt`): the worn landing begins when the uses
   left are at or under the fixed limit plus whatever the descent from the height the body will reach needs beyond the
   20 uses that limit has always kept for the landing, with 5 of margin. The height is measured to the lowest column
   within 32 blocks; a rocket's rise still to come counts. No rocket is fired for height the uses left would not cover
   the way down from: the worn landing begins instead. A landing forced for another reason (`!land`, the health) goes
   on by the dive once its circle is no longer covered.
6. **The worn descent from 64 or more over the ground is a dive** (`brain.ts flyWornDive`): the look 75 down with the
   yaw turning 6 degrees a tick, so that the body comes down on a helix a few blocks wide over ground the model knows,
   then the look 30 up from 44 over the highest column within 32 blocks, still turning. The pull leaves the body
   level at about 1 block a tick some 24 over that ground, and the forced landing takes it from there. This and not
   the planned dive of 0055: that one needs a landing known 48 to 72 blocks ahead and gives up for the circle when it
   has none, and a worn elytra has no uses for the circle.
7. **The cruise is flown no higher than 64 over the higher of its cruise height and the high cruise's (y 328)**
   (`brain.ts CRUISE_OVER`): the economy buys nothing while the body is less than a whole rocket's height under that,
   and a burning rocket is flown no higher. Over the build limit nothing is cleared by height; a glide held at a ceiling
   costs the rockets a climb to the glide line would (a rocket buys 31 blocks of height or 310 of glide either way).
   The highest flight on record before the track was 39 under the bound.
8. **A glide lost in the air on an elytra at its last use ends the flight** (`controller.ts`, `glide_lost`): nothing
   asks for the glide again. Each request was predicted for ten ticks and taken back (the local body up to 37 blocks
   from the server's), and the fall guard of 0049 arms only when nothing asks for the glide. With a water bucket in
   the hotbar the guard then clutches the fall. Nothing else is done for a body that falls: steering to water was not
   built.
9. **No setting.** These are rules that stop a death, they change no trip the elytra covers (the offline bench flies
   the same ticks on both trees), and a switch would only be a way to turn the death back on. The brain has two code
   switches (`wornCover`, `cruiseCap`) for the tests' reproduction.

## Consequences

- A trip started with an elytra near its limit is walked where it used to be flown and, sometimes, ended in the air.
  With 100 uses a flight of 1 500 blocks is refused; the same elytra still flies 500.
- An elytra's last 30 uses (44 with Mending) are never flown, as before; of the rest, one trip may leave up to its own
  margin unused (a go-around, a hold and 15 % it did not need).
- Over rough ground the limit is higher: the dive is pulled out over the highest column near the body and the
  landing after it may have the relief still to come down on its circle. Counted, not avoided.
- The inventory model's armour wear is right for every worn piece. Code that reads it (the armour pass, the mending
  reserve) now sees the server's values.
- The test kit's line for a replaced elytra names the count as the old one's.
- Not on the Realm yet. An upkeep rule (a mended or a fresh elytra before a trip) can ask `wear.ts tripUses` for what
  a trip needs.

## Addendum, 2026-11-20 (Track F21): Unbreaking at the takeoff

Decision 2 counted every elytra as bare, so an Unbreaking elytra was refused trips it covers. The rate was measured on
the test server for each level (docs/flight.md "Unbreaking at the takeoff (Track F21)": I 0.528 to 0.546 uses a second,
II 0.250 to 0.339, III 0.199 to 0.257, three flights or more each; the server's chance that a use counts is
1 / (level + 1)).

- **The need of a trip takes the level's share of the bare rate** (`wear.ts useShare`): the most measured for that
  level rounded up to the hundredth, never under 1 / (level + 1) (I 0.55, II 0.34, III 0.26; over III as III). The
  other margins (15 %, a go-around, a hold, the climb, 1.2 uses a second, 4 on top) are those of decision 2. The level
  is read from the item (enchantment 17), wherever the cover is asked, and the refusal names it.
- ~~**The worn limit is unchanged** (decision 3): the descent's uses are counted bare, which with Unbreaking holds more
  than the way down costs.~~ Wrong; corrected the same day (below).
- **The stock rule of 0108 compares pieces by what they fly** (uses over the limit over the share), and the flight's
  second cover check, with the climb known and the elytra on the back, asks that rule for a spare before it refuses.

### Correction, 2026-11-20 (Track F21, the follow-up): the takeoff and the flight count the same

On the Realm an Unbreaking III elytra with 60 uses was let go for 883 blocks and landed as worn 4 s after its takeoff,
again at every re-check of the walk (hops of about 70 blocks). The flight's worn limit (decision 3) and its rocket rule
added the way down at the bare rate (over rough ground the circle: 47 uses from 137 over the ground, so a limit of 62
for the next rocket), while the takeoff counted the trip at the share; the brain's own count also ran a use a second.
A bare elytra has the same fault after a hold: the held flight comes down from the cruise by the landing's spiral (0.15
blocks a tick, offline), which decision 2 counted as 8 s. Offline, 30 of 200 trips the takeoff allowed (levels 0 to 3,
150 to 3 000 blocks, cruises 20 to 300 over flat ground, held and not) ended on the worn landing.

- **The flight counts the level** (brain option `elytraUnbreaking`): the way down of the worn limit and of the rocket
  rule, and a rocket's burn, at the level's share; the brain's own count between the server's words at the share (a
  use every 20 / share gliding ticks). The margin and the reserve stay whole.
- **The takeoff asks for the flight's limit at the cruise and for the spiral** (`TripShape.over`, the cruise's height
  over the ground): the flight's worn limit there beyond the fixed one (`cruiseKeep`), after a hold the spiral from the
  cruise, and for a trip shorter than 3.5 times that height the climb and the spiral where they take longer. Asked
  wherever the cruise is known: the preparation, the walk's re-check and `!goto`'s second question (the cruise the
  preparation will plan), a new trip in the air.
- **The invariant, as a unit test over that grid:** a trip the takeoff allows, the elytra wearing at its level's most
  measured rate, is flown to its landing with no worn landing: 200 of 200. The F20 grid (no glide lost from 70 to 1 000
  over the ground) holds, at every level. After a worn landing no trip of `flyMin` or more is allowed with that elytra:
  no hop loop.
- ~~Consequence: held trips at height ask much more (2 252 blocks held 250 over: 262 bare, was 155)~~ (calibrated the
  same day, below); over rough ground the limit still grows with the relief the takeoff does not know, so a trip at the
  edge over mountains can end on the covered worn landing.

### Calibration, 2026-11-20 (Track F21): the spiral from where the flight comes in, not from its cruise

The correction counted the spiral after a hold from the cruise's height: the Realm's trip home (2 261 blocks, cruise 226
over home) asked 247 over the limit where it cost 104, and a new elytra would have flown two such trips instead of
three. The Realm's held flights (2026-11-18 to 20) came in 27 to 119 over their goals from cruises 183 to 226 over
them (the cruise is the glide's need, so the flight comes in on the glide line; the trip home higher over a hill near
home), and their holds lasted 2 to 25 ticks (the ground loads some 150 blocks out, before the hold begins at 116). The
offline grid had looked otherwise because it forces the cruise over the glide's need and held each goal 8 s.

- **The takeoff counts the circle from the arrival** (`wear.ts arrivalOver`, `FlyProcess plannedArrival`,
  `TripShape.arrive`): the highest of the glide line at the hold's start with its spare, and up to the climb's top, the
  climb's top glided down and the highest column of the last 200 blocks before the goal plus the terrain floor's
  clearance and lookahead; a held trip asks the larger of decision 2's and the trip, the hold as recorded (3.5 s) and
  the circle from there at 0.15 a tick, less the cruise's last stretch it replaces. The Unbreaking rules above are
  unchanged.
- **Two grids, kept apart:** (a) the invariant, held as a server holds a goal (its ground loads 150 out): a trip the
  takeoff allows lands with no worn landing, 200 of 200 (decision 2's ask: 25 of 200 worn); (b) safety, held until
  `flyHoldS` or never: no glide lost, 200 of 200, the covered worn landing allowed (decision 2's rule for a long hold).
- **The calibration as a test on the recorded flights:** the ask is at or over each one's cost, 1.36 to 1.92 times it
  on the long trips and 2.1 to 2.2 on the short ones, within 25 of decision 2's ask but for a goal under the ground; a
  new elytra flies the three trips the Realm flew on one, as before the correction.
