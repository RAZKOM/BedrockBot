# The flight envelope (flight v2, Track F0)

What BDS 1.26.60.6 does for the elytra manoeuvres of flight v2, measured on `bds-fly` (udp/19204, FLAT,
peaceful, fall damage on, strict movement, the truth pack) and set against the bot's flight model. Every
number here comes from a scripted flight: a control sequence per tick (yaw, pitch, a rocket, the hotbar
slot, the jump key, the glide request), the server's own state sampled every tick, and the model stepped
from the server's state and compared tick by tick. Decision record:
[decisions/0056-flight-envelope.md](decisions/0056-flight-envelope.md). The flight itself:
[flight.md](flight.md).

Short version: the glide formula of [flight.md](flight.md) "Physics" holds for every manoeuvre measured
(within 0.0005 a tick, no corrections) except three things the model got wrong and now does right (the
burn length of a rocket, a second rocket, a refused glide request), and the soft blocks it does not know
(slime, powder snow, cobweb, honey, scaffolding).

## Files

| Path | What |
|---|---|
| `bot/test/e2e/fly-envelope-harness.ts` | the harness: `runScript` (a script flown on bds-fly, the server's per-tick samples, rockets, corrections, hurts), `align` (the server sample of each input), `compareRun` (the model stepped from the server's state, with and without a boost), `openLoop`, `presim` (the script flown offline, to place structures), `inferBoosts` / `burnRuns` |
| `bot/test/e2e/fly-envelope-scripts.ts` | script pieces: `withPrelude` (a level glide after one rocket, a stopped body, a dive to a speed), `segments`, `fallThenGlide`, `glideWanted` |
| `bot/test/e2e/fly-envelope-metrics.ts` | `tracks`, `turnMetrics`, `hoverMetrics`, `burns` (the burn from the `fw` samples), `stats` |
| `bot/test/e2e/fly-envelope.test.ts` | the cases below (`FLY_ENV=smoke` by default; `FLY_ENV=all` or a list such as `snap,burn,wall`; `FLY_ENV_N` scales the repetitions; `FLY_ENV_OUT=<dir>` keeps every run's JSON) |
| `packs/truth/src/fly.ts` | `truth:glidelog`: per server tick the position, the velocity, the rotation, `gliding`, `onGround`, the health and `fw` (fireworks rockets within 4 blocks); `glidelog read [since] [until]` |
| `bot/src/skills/input/physics.ts` | `GLIDE.boostMaxTicks`, `boostEndLag`, `fallResetVy`, `confirmTicks`; `boostTicksExpected`, `wallImpactDamage`, `glideFallStep` |
| `bot/src/skills/input/inputLoop.ts` | `boost()` up to the cap and the union of two rockets, no boost for a rocket before the glide, `endBoost()` that also takes back ticks the model boosted after the real end, the glide request held on the input after a jump, the refused glide request (`GlideEvent.refused`), `state.boostTicks` as the expected ticks left |
| `bot/test/unit/skills/flight-envelope.test.ts` | the unit tests of the model changes |

Run it: `BDS_E2E=1 FLY_BDS_PORT=19204 FLY_BDS_CONTAINER=bds-fly FLY_ENV=all pnpm --filter bot exec vitest run
--project e2e fly-envelope` (about 100 minutes; the truth pack with `glidelog` must be deployed). The suite
flies near the origin (400, 400): 60 000 blocks out a float32 position steps by 0.0078, and so do the
server's samples, too coarse for a tick-by-tick comparison.

## How a run is compared

- **The sample of an input.** The truth pack samples once per server tick. A sample's rotation is the
  input before it (the server applies the rotation a tick late), so input t's sample is the one that shows
  input t's yaw. The yaw carries a tag of a few thousandths of a degree (`tick % 50`) to find it. About one
  input in three under load (up to two in three when the input timer drifts against the server tick)
  shares a server tick with a neighbour: its sample is missing, never wrong.
- **The model's error.** For each input with a sample before it, the model steps once from the server's
  state (the velocity from the position delta) and is compared with the server's next position. The run's
  boost is inferred per tick (the model with and without a boost against the server), and checked against
  `fw`, which is 1 on exactly the boosted samples.
- **Corrections** are counted from `correct_player_move_prediction` (strict, threshold 0.001).

## 1. Yaw snaps and the 180 brake

A level glide (one rocket, 20 ticks of coast), then the yaw snapped by 45 / 90 / 135 / 180 in one tick and
held 45 ticks; the 180 also at pitch -15 and -30. Three runs each; the speed after k ticks (the move of
the tick), the heading of the move, and the run until the speed is under 0.2 (or the 45 ticks):

| Snap | Pitch | Speed 0 / 5 / 10 | Heading after 3 / 10 | Stops (under 0.2) | Forward | Height | Model | Corrections |
|---|---|---|---|---|---|---|---|---|
| 45 | 0 | 1.57 / 1.42 / 1.38 | 13 / 30 | no | 49 | -6.7 | the same, within 0.0001 a tick | 0 |
| 90 | 0 | 1.57 / 1.05 / 0.91 | 21 / 57 | no | 12.7 | -6.6 | the same | 0 |
| 135 | 0 | 1.55 / 0.63 / 0.39 | 18 / 73 | no (min 0.36) | -3.9 | -6.7 | the same | 0 |
| 180 | 0 | 1.55 / 0.44 / 0.09 | | 8 ticks | 4.65 | -1.2 | the same | 0 |
| 180 | -15 | 1.46 / 0.48 / 0.16 | | 9 to 10 ticks | 5.1 | +0.5 | the same | 0 |
| 180 | -30 | 1.39 / 0.48 / 0.17 | | 10 ticks | 5.2 | +2.5 | the same | 0 |

No movement check refuses a snap of any size: 18 runs, 0 corrections, the largest model error 0.0005.

## 2. Hover: the look flipped 180 every 1, 2 or 5 ticks

From a stopped glide (the body falling, then gliding without speed), 240 ticks; the window from tick 40
to 239. Two runs each, the model the same in all twelve (0 corrections, error 0.0001):

| Pitch | Flipped every | Sink a tick | Drift over 200 ticks | Largest speed | Mean speed |
|---|---|---|---|---|---|
| 0 | 1 | 0.150 | 0 to 0.01 | 0.008 | 0.008 |
| 0 | 2 | 0.150 | 0 | 0.017 | 0.009 |
| 0 | 5 | 0.150 | 0.05 | 0.045 | 0.022 |
| -15 | 1 | 0.189 | 0.01 | 0.010 | 0.010 |
| -15 | 2 | 0.188 | 0.02 | 0.020 | 0.011 |
| -15 | 5 | 0.184 | 0.03 to 0.08 | 0.051 | 0.025 |

The body hangs in place and sinks at the glide's floor; pitching up only sinks faster here (no speed to
lift with).

## 3. The rocket burn

A level glide, ten rockets per run, each after the last one's removal; the burn read from `fw` (a burn is
exact when the samples before and after it exist). 175 exact single-rocket burns from all cases:

| Boost ticks | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Rockets | 1 | 1 | 10 | 11 | 14 | 18 | 26 | 28 | 21 | 21 | 9 | 13 | 2 |

Mean 15.7, median 16, 90 % at 19 or less.

- **The boost starts on the fire tick** (the input that carries the item use) and runs to the rocket's
  end; the model's boost from the same input fits every boosted tick within 0.0001.
- **add_entity** reaches the client 1 input after the fire in 163 of 242 uses, 2 in 76, 0 in 3. Its
  metadata is the same for every rocket: nothing in it tells the lifetime.
- **remove_entity** reaches the client 3 inputs after the last boosted one in 167 of 215, 4 in 41, 2 in 5,
  1 in 2. It is not tied to the add's delay.
- **The correction** comes 30 ticks after the fire (the server does not correct a rocket's flight before
  that; in the window its samples partly follow the client's positions) or not at all.

| Model | Corrections a rocket | Their size |
|---|---|---|
| before: 15 boosted ticks, the removal cuts a shorter burn (66 rockets) | 46 of 66 | 0.014 to 0.6, growing with the burn past 15 (20 ticks: 0.38) |
| now: boosted until the removal (66 rockets) | 48 of 66 | 0.014 to 0.041 |

The rest (0.04) is the removal's latency: the client keeps boosting the 3 inputs until the removal arrives
and takes them back then, but the server has already seen those positions. 0.04 is below anything a
planner notices.

## 4. A second rocket while one burns

The second rocket 3, 6 or 10 ticks after the first, three runs each, twice (before and after the model
change):

- It is accepted at once (no cooldown beyond the bot's own 4 ticks), `fw` goes to 2.
- The push does not double: during the overlap the single-boost model fits within 0.0001 (the doubled
  boost is 0.02 off a tick).
- The boost runs until the **later** rocket's end, which is usually the second's: from the first fire 15
  to 21 boosted ticks in all with the second after 3 ticks, 21 to 23 after 6, 25 to 28 after 10. Twice in
  18 the first rocket outlived the second (by 1 and 2 ticks).
- So: **the union of the two lifetimes**, neither double nor refresh. The corrections fell from up to 0.48
  to at most 0.041 with the model change (the loop keeps the longer of the two counters and ends with the
  last removal).

## 5. A slot switch mid-rocket; rockets from the offhand

- **A slot switch does not cut the boost.** The hotbar moved to stone 1, 3 or 6 ticks after the fire
  (three runs each): the burns were 17 / 17 / 17, 16 / 13 / 16 and 15 / 17 / 15 ticks, the ordinary
  spread. A burst cannot be cut short: the shortest boost is the rocket's own lifetime (9 to 21).
- **Offhand rockets do nothing through `item_use`.** The use with the offhand as the hand (and with the
  main hand while the offhand holds the rockets): no rocket entity, the offhand stack unchanged, six of six.
  The model boosted anyway and drew five corrections of up to 3.97. Rockets must be in the hotbar.

## 6. Rockets looking up, down and back; the glide start at pitch -90 / +90

| Case | Server | Model (the same inputs, its boost from `fw`) | Corrections |
|---|---|---|---|
| glide started at pitch -90, a rocket, held 41 ticks | the glide starts; +31 (burn 16) and +40 (burn 20) straight up, no drift | +31.4 / +39.7; every tick exact (one tick of 0.005 at the top) | 1 each (0.72 / 1.07, the old burn model) |
| the same at -89 | +34.4 up (burn 17), 0.85 sideways | the same | 1 |
| glide started at pitch +90, no rocket, 30 ticks | -38.7 straight down, 1.99 a tick at the end | the same, every tick exact | 0 |
| a level glide, a rocket at -90 | +32 to +34 | within 0.3 (burn length) | 1 |
| a level glide, a rocket at +90 | -38.5 to -39.3 in 23 ticks | the same | 0 to 1 |
| a level glide, a rocket backwards (yaw 180) | brakes to 0.22, then 1.6 the other way | the same | 1 |

The glide starts with the look straight up or down (the server confirmed both), and the vertical takeoff
of [flight.md](flight.md) "Vertical takeoff" does what the model says: the model-only takeoff is now
measured.

## 7. Walls and ceilings

A stone wall across the path, flown into head-on at 0.1 to 1.5 blocks a tick and at 45 and 70 degrees
(the speed by a dive, then level). The damage is `flyIntoWall`:

| Angle | Speed into it | Speed lost | Damage | The glide | Model |
|---|---|---|---|---|---|
| head-on | 0.10 | 0.10 | 0 | goes on | exact |
| head-on | 0.22 | 0.22 | 0 | goes on | exact |
| head-on | 0.32 | 0.32 | 0.24 | goes on | exact |
| head-on | 0.37 | 0.37 | 0.72 | goes on | exact |
| head-on | 0.42 | 0.42 | 1.18 | goes on | exact |
| head-on | 0.46 | 0.46 | 1.62 | goes on | exact |
| head-on | 0.52 | 0.52 | 2.15 | goes on | exact |
| head-on | 0.61 | 0.61 | 3.13 | goes on | exact |
| head-on | 0.82 | 0.82 | 5.17 | goes on | exact |
| head-on | 1.01 | 1.01 | 7.11 | goes on | exact |
| head-on | 1.22 | 1.22 | 9.19 | goes on | exact |
| head-on | 1.52 | 1.51 | 12.13 | goes on | exact |
| 45 | 0.6 | | 0 | goes on | exact |
| 45 | 1.01 | 0.30 | 0 | goes on | exact |
| 45 | 1.5 | 0.44 | 1.42 | goes on | exact |
| 70 | 1.01 | 0.06 | 0 | goes on | exact |
| 70 | 1.52 | 0.09 | 0 | goes on | exact |

- **The rule** (`wallImpactDamage`): 10 x the horizontal speed the tick's move lost to the wall, minus 3:
  free under a loss of 0.3. The vanilla rule, to the third decimal.
- **A scrape does not end the glide**, nor does a hit: the flag stays, the glide goes on along the wall.
- **The model reproduces the contact exactly** (the move clipped, the speed along the wall kept; 0
  corrections in all 17). The server's own velocity field keeps the blocked component for a tick, the
  position does not.
- **A ceiling bump costs nothing**: a rocket at -40 into a ceiling 4 above, and a rocket straight up (-90)
  into one 8 above: no damage, the glide goes on, the body pinned under it while the rocket burns (two
  runs each). After the burn at -90 the fall is free (no lift with the look straight up): the first run held
  -90 after its script and died from 40 up (35 damage), the second levelled out and landed unhurt.

## 8. Touchdown: fall damage while gliding; touch-and-go; the takeoff

Dives from 3 to 60 blocks over flat ground (teleported, the glide asked for under -0.2, the pitch held to
the ground):

| Pitch | Height | Sink at the end | Damage | The rule |
|---|---|---|---|---|
| 80 | 3 | 0.58 | 0 | 0 |
| 80 | 5 | 0.76 | 2 | 2 |
| 80 | 8 | 0.93 | 4 | 4 |
| 80 | 12 | 1.14 | 9 | 9 |
| 80 | 16 | 1.26 | 12 | 12 |
| 80 | 20 | 1.40 | 16 | 16 |
| 80 | 25 | 1.55 | 21 | 21 |
| 80 | 30 | 1.67 | 26 | 26 |
| 80 | 40 | 1.89 | 37 | 37 |
| 80 | 55 | 2.09 | 51 | 51 |
| 45 | 15 | 0.62 | 8 | 8 |
| 45 | 30 | 0.66 | 23 | 23 |
| 45 | 60 | 0.67 | 53 | 53 |
| 0 | 10 | 0.15 | 0 | 0 |
| 0 | 30 | 0.15 | 0 | 0 |

- **The rule** (`glideFallStep`, then `damageForCounted` of fall/damage.ts): every gliding tick that starts
  with the vertical speed above -0.5 sets the fall distance to 1; every tick adds its drop; the landing
  tick's clipped move does not count; the damage is `ceil(counted - 3)`. 15 of 15 exact, also on the model
  alone (the unit test flies the same dives on `stepBody`).
- **So there is no vertical speed where the damage starts**: it is the drop since the sink last was under
  0.5 a tick. Under 0.5 the whole way (the level glide sinks 0.15) a touchdown is free from any height; a
  sink past 0.5 for more than about 3 blocks hurts.

**Touch-and-go and the glide after a jump.** A low level glide meets the ground, the jump on the contact
tick, the glide request on the first tick the vertical speed is under a threshold; and the same from a
sprint-jump on the ground (two runs each):

| Request on | Its vertical speed (entering) | Server | Glide sample | Confirmed |
|---|---|---|---|---|
| the 1st airborne tick | +0.42 | **refused** (4 of 4) | none: 1 to 2 corrections of 0.94 to 0.99, the model's glide taken back 10 inputs later, the bot near the ground by then | never |
| the 2nd | +0.33 | glides (4 of 4) | on that tick | 1 tick later |
| the 3rd | +0.25 | glides (4 of 4) | on that tick | 1 tick later |
| the 5th | +0.08 | glides | on that tick | 1 tick later |
| the 6th | 0.00 | glides | on that tick | 1 tick later |
| the 7th | -0.08 | glides | on that tick | 1 tick later |
| the 9th | -0.23 | glides | on that tick | 1 tick later |

- The touchdown of the touch-and-go ends the glide (the flag goes, `stop_gliding`); the jump lifts the body
  on the next tick. The same in both: the ground contact and the sprint-jump behave alike.
- Before the fix a refused request left the model gliding and the server falling: 2 corrections of 0.94 in
  the 40 ticks after, and the server never glided (no retry). The loop now takes the model's glide back
  `GLIDE.confirmTicks` (10) inputs after a request no flag confirmed and asks again (`GlideEvent.refused`).
- Only the input right after the jump is refused (the input that lifts the body off). The loop now never
  asks for the glide on that input: a request there waits one input (`lastJumped` in the loop), so a
  script that asks at once glides on the 2nd airborne tick instead of being refused. Flown again with the
  rule: 28 of 28 glide, 0 corrections, the 1st-tick request gliding on the 2nd tick (4 of 4).
- The fewest ticks from the ground to a confirmed glide: the jump on the contact tick, the request on the
  2nd airborne tick, the glide confirmed on the 3rd. Every request from the 2nd tick on was accepted with 0
  corrections (24 of 24 runs).

**The takeoff from a standing jump** (case `takeoff`, two runs each, read from the server's samples: `j` is
the input counted from the jump's, 1 the first airborne one):

| Glide request | Server | Corrections |
|---|---|---|
| the loop's on `j` 1 (held to 2 by the loop) | glides from `j` 2 | 0 |
| `j` 2 / 3 / 4 / 7 | glides from that input | 0 |
| start_gliding by hand on the jump input (`j` 0) or on `j` 1 | never (the jump runs its 11 ticks, top 1.25) | 0 (the model does not glide either) |

| Rocket (the request on `j` 2, pitch -45) | Server | Corrections |
|---|---|---|
| on `j` 1 (not gliding yet) | no rocket entity, nothing | 0 |
| on `j` 2, the input that starts the glide | **no rocket entity**, nothing | 3, up to 8.9 before the fix; 0 now |
| on `j` 3 / 4 / 6 | the entity 1 input later, +36 in 30 ticks | 0 (one 0.27 at fire + 30) |

- **The glide comes on the 2nd airborne input of a standing jump too**, while the body still rises (vy
  0.33). A plain jump is airborne 11 inputs; it is not needed to wait for the fall.
- **The first rocket that works is on the input after the glide start**: the server checks the gliding
  state the body enters the input with. The loop now boosts only then (the rocket on the glide's first
  input boosted the model and drew corrections of up to 8.9). So the fastest takeoff: jump, the request
  on `j` 2, the rocket on `j` 3.
- **A 2-high space clips the jump to 2 airborne inputs** (up 0.2, down 0.12, ground). The only candidate
  is `j` 1, refused (by hand too), so **no glide starts from a jump under a 2-high ceiling**, and a rocket
  there does nothing (not gliding). A jump takeoff needs more headroom: with 3 of it the model keeps the
  body airborne past `j` 2 (1.2 of rise), not flown.
- **After a teleport into the air the server counts the body as on the ground** for its first 2 samples
  (`ground` at the teleport height). A glide request at once carries its jump press, so the server
  **jumps the body (+0.42)** and glides only when the loop asks again, 9 to 10 inputs later: 2
  corrections of 1.76 a run (12 of 12, from 1.6, 3 and 6 above the ground). Asking once the body falls
  (`glideWanted`: vy under -0.2, as every other case here does) glides with no correction. This is a test
  artefact (the bot does not teleport in flight), not a takeoff rule.

**A 2-high bore flown in** (3 wide, 10 long, entered with the box's bottom 0.55 to 0.63 above its floor):

| Speed | Pitch | Through | The glide | Corrections | Model |
|---|---|---|---|---|---|
| 1.4 | -10 | yes, 0.92 after | on the whole way | 0 | exact (0.0004) |
| 0.8 | -10 | yes (0.03 over the floor), 0.78 after | on the whole way | 0 | exact |
| 1.4 | 0 | yes, 0.25 after | **ends**: the sink puts the box on the floor 4 ticks, a touchdown | 0 | the same |

The server ends no glide for the low space: only a floor contact ends it, as on open ground.

## 9. Soft landings; ladders and vines

A 9 x 9 pad of each block, met by a gentle glide (level from 5 above: sink 0.15, 0.39 forward) and a steep
dive (pitch 80 from 22 above: sink 1.47):

| Block | Gentle: damage / the glide / after | Steep: damage / the glide / after | Model |
|---|---|---|---|
| stone | 0 / ends / slides 1.75 | 18 / ends / stops | exact |
| water | 0 / ends / sinks and drifts | 0 / ends / to the bottom | exact (the model ends the glide in water too) |
| slime | 0 / ends / small hops | 0 / ends / **bounces 11.3 up**, the request then glides again | no bounce: 3 corrections up to 1.5 |
| hay | 0 / ends / slides 1.75 | 2 (x 0.2) / ends | exact |
| honey | 0 / ends / slides 1.14 | 8 (x 0.5) / ends | the slide is shorter: 1 correction of 0.61 |
| powder snow | 0 / **goes on**, sinks 0.03 a tick inside | 0 / ends, then glides again inside, sinks 0.11 | no: 2 to 3 corrections up to 1.7 |
| scaffolding | 0 / ends / climbs (the jump press of the request) | 18 (no reduction) / ends | no: 6 to 8 corrections up to 2.3 |
| cobweb | 0 / **goes on** (the flag stays), stops dead | 0 / goes on, stops dead | no: a correction every few ticks (0.7 to 1.5) |

The damage factors are fall/damage.ts `landingFactor`'s (hay 0.2, honey 0.5, water / slime / powder snow
0): a glide's touchdown counts like any fall. Two sessions, the same numbers; the gentle water touchdown had
one correction of 0.31 in the second.

**Ladders and vines.** A band of 13 x 9 ladders (or vines) on a stone wall, met head-on slowly and at 60
degrees fast:

| Block | Approach | Speed at the touch | Damage | The glide | After | Corrections |
|---|---|---|---|---|---|---|
| ladder | head-on | 0.3 | 0 | **ends** on the touch | climbs 0.2 a tick, slides 0.2 a tick down | 4, up to 2.8 |
| ladder | head-on | 0.8 (0.02 left at the touch) | 0 | ends | climbs | 3, up to 1.0 |
| ladder | 60 degrees | 1.0 | 0 | ends, the body stops on it | climbs | 5, up to 5.8 |
| vine | head-on | 0.3 | 0 | ends | climbs, then slides | 4, up to 2.8 |
| vine | head-on | 0.8 | 0 | ends | climbs | 3, up to 1.2 |
| vine | 60 degrees | 1.0 | 0 | ends, the body stops on it | climbs | 5, up to 5.8 |

- A climbable ends the glide at once and catches the body, even at a glancing 1.0 a tick: no damage, no
  slide along the wall. The bot then hangs on it; a glide request there is refused every time (the
  request's jump press climbs instead), so the loop's refusal timeout fires every 11 inputs.
- The model knows no climbable while gliding: it glides on into the wall, hence the corrections.

## 10. Threading a 1 x 1 hole and a 1-high slot

A wall with a hole one block wide and one high (and a slot one high across the wall), flown through level
after a dive (no rocket, so the offline flight says where the body meets the wall). `Bottom`: the box's
bottom above the hole's floor on the last tick before its front reaches the wall:

| Opening | Speed | Bottom | Through | After | Corrections | Model |
|---|---|---|---|---|---|---|
| hole | 1.53 | 0.37 | yes, 1.54 after | glides on | 0 | exact (0.0003) |
| slot | 1.53 | 0.37 | yes | glides on | 0 | exact |
| hole | 1.11 | 0.39 | yes, 1.13 after | glides on | 0 | exact |
| slot | 1.11 | 0.39 | yes | glides on | 0 | exact |
| hole | 1.47 | 0.29 | yes, **the lip under it caught the box**: one ground tick, the glide ended and was asked for again, 0.80 after | glides on | 0 | exact |
| hole | 1.52 | 0.13 | **no**: the body met the wall under the hole, 12.2 damage | goes on | 0 | exact |
| slot | 1.52 | 0.13 | no, 12.2 damage | goes on | 0 | exact |

- The gliding box is 0.6 high, so a 1-high opening passes it; nothing in the server refuses it (no
  pose change, no correction). Two runs each; a second session flew the clean and low shots again (12
  runs) with the same results to the third decimal (the low shot 12.2 damage every time).
- **The Y-first sweep decides.** The server resolves the vertical move first, at the old horizontal
  position: while the box is still inside the wall plane, a sink below the opening's floor lands it on the
  lip. The box must stay inside the opening for every tick it overlaps the wall: at 1.5 a tick that is two
  ticks of sink (0.31), so the bottom between 0.31 and 0.40 above the floor on the tick before; at 1.1 a
  tick three ticks (0.46: more than the 0.4 of room, so a level pass needs a little lift).
- `moveBody` does the same (the model is exact in every case), so the planners' own path checks
  (`pathAhead`, `simulateFlight`) already see it.

## What this means for manoeuvres

For Track F1 (the manoeuvres and the brake landings) and Track F2 (the planner):

- **Snap the yaw freely.** Any step in one tick is accepted. The 180 brake stops a 1.55 glide in 8 ticks
  over 4.7 blocks at pitch 0 (losing 1.2 of height), in 10 ticks over 5.2 at pitch -30 (gaining 2.5); -15
  keeps the height (+0.5). A 90 snap halves the speed in 5 ticks without stopping.
- **Hover by flipping the look every 1 or 2 ticks**: the body stays within 0.02 of the spot over 200 ticks
  and sinks 0.15 a tick at pitch 0 (0.19 at -15: keep pitch 0). Every 5 ticks drifts 0.05 to 0.08.
- **Plan a rocket as 15 ticks** (`GLIDE.boostTicks`; the mean is 15.7). Once it burns, read
  `loop.state.boostTicks`: it is now the expected ticks left, at least 1 for as long as the model boosts,
  0 once the removal arrived. The input loop boosts until the removal (at most 22).
- **No second rocket on top of a burning one**: it extends the boost to its own end and pushes no harder,
  so the overlap is wasted. Fire the next only when `boostTicks` is 0. If one is stacked anyway, the boost
  ends with the **last** rocket's removal.
- **A boost cannot be cut** (a slot switch does not), so the shortest burst is a whole rocket (9 to 21
  ticks, unknown in advance).
- **Rockets only from the hotbar**: the offhand does nothing through `item_use`.
- **Straight up and straight down are fine**: the glide starts at pitch -90 / +90 and a rocket straight up
  climbs 31 to 40 in 41 ticks without drift (the vertical takeoff is measured now).
- **A wall is a brake at a shallow angle**: free under 0.3 of horizontal speed lost (head-on at 0.3 a tick,
  45 degrees at 1.0, 70 degrees at 1.5), `wallImpactDamage` otherwise. The glide never ends on a wall.
  Ceilings cost nothing.
- **Touch down with the sink under 0.5 a tick** at least once in the last 3 blocks of drop: then the
  touchdown is free from any height (`glideFallStep`). A steep dive to the ground hurts like the fall it is.
- **Touch-and-go**: the jump on the contact tick, the glide request from the 2nd airborne tick (the vertical
  speed under 0.33), never on the first (refused; the loop defers such a request by one input anyway). The
  brain's rule "request when falling" (vy under 0) is safe and costs about 5 more ticks.
- **The takeoff from a standing jump**: the request on the 2nd airborne input, the first rocket on the
  input after it (a rocket before the glide's second input does nothing, the loop no longer boosts it).
  Not under a 2-high ceiling: the jump is too short to glide. A planner that starts a test or a route
  with a teleport into the air asks for the glide once the body falls, never at once (the server's body
  is on the ground after a teleport and the request's jump press jumps it).
- **A 2-high bore is flyable**: the server ends the glide only on a floor contact. At 1.4 a tick a level
  glide (pitch 0) sinks onto the floor within 10 blocks; pitch -10 holds the height.
- **Land on water, hay or honey to cut damage; avoid slime, powder snow, cobweb and scaffolding**: the
  model does not know them (slime bounces 11 blocks from a steep dive and the bot glides again by itself,
  cobweb and powder snow keep the glide flag while the body stops).
- **A ladder or vine is a free catch**: touching one ends the glide and holds the body with no damage, even
  at 1.0 a tick glancing. Not modelled (3 to 5 corrections), and a glide request there is refused: climb
  off (or let go) before asking again.
- **A 1-high hole is threadable** at 1.1 to 1.5 a tick with the box's bottom 0.31 to 0.40 over the floor
  on the tick before the wall; under that the lip catches (the glide ends, half the speed lost) or the wall
  below hits (12 damage at 1.5). The model's sweep is exact, so simulate the pass rather than aim it.

## Model changes (Track F0)

| Change | Before | Now | Tests |
|---|---|---|---|
| the boost of a rocket | 15 inputs, cut by the removal | up to 22 (`GLIDE.boostMaxTicks`), ended by the removal | `flight-envelope.test.ts` "without a remove_entity ..." |
| the removal's lag | 3 inputs back | 2 (`GLIDE.boostEndLag`, measured), and the ticks the model boosted after the real end are taken back even when its own counter ran out | "remove_entity cuts it ...", "... after the model ran out ..." |
| a second rocket | restarted the counter | the longer of the two counters (the union) | "a second rocket ...", "an explicit shorter boost ..." |
| `state.boostTicks` | the model's counter | the expected ticks left (`boostTicksExpected`, the measured tail) | "the state shows ...", "boostTicksExpected ..." |
| a refused glide request | the model glided on | taken back after `GLIDE.confirmTicks` (10) inputs with no flag, asked again (`GlideEvent.refused`) | "a glide request the server never confirms" |
| a glide request on the input after a jump | sent, refused by the server | held one input (`lastJumped`) | "no glide on the input right after a ground jump" |
| a rocket on an input entered without gliding (also the glide's first) | boosted the model | no boost (the server makes no rocket) | "a rocket on an input the body enters without gliding ..." |
| the damage | not modelled | `wallImpactDamage`, `glideFallStep` (with `damageForCounted`) | "flight envelope: wall and touchdown damage" |

Not changed: the soft blocks (above); the glide start's first tick (the server's first gliding tick is
0.067 off the model's, never a correction).

## Open points

- The removal's lag is measured on a local BDS (2 inputs). On a Realm it is longer: the loop then keeps
  boosting a tick or two after the real end and the correction 30 ticks after the fire grows by about 0.02
  a tick of extra lag. `endBoost(agoTicks)` takes the lag; a measured value from the Realm would replace
  the default.
- `GLIDE.confirmTicks` (10) is a guess for a Realm's latency (1 input on the local BDS). Too short would
  take back a glide the server was about to confirm.
- The soft blocks are not in the model (no block query for them while gliding).
- A teleport into the air: the model has the body airborne, the server on the ground for 2 samples (a
  glide request there jumps it). Not modelled; the bot does not teleport in flight. A gliding body
  teleported is most likely the same (a ground sample ends the glide), not flown.
- The headroom a jump takeoff needs (more than 2, enough at 3 by the model) is not flown.
