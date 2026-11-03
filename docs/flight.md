# Elytra flight (wave 11, Track AU; Track AU2: roofs, the rocket economy, the descent geometry, fly then walk)

`!fly <x y z> | <waypoint> | <player> | home`, `!fly stop`, `!land`, and the automatic flight of
`!come` / `!goto` over `flyMin` blocks: the bot puts on its elytra, takes off from flat ground under
open sky with a firework rocket, climbs once to the height the glide to the target needs, glides in
(a rocket only when the glide would fall short) and lands on the target block with a flare (the
design target: the 3x3 platform of a creeper farm 40 blocks up, within a block of its centre, no
damage), then puts the chestplate back on. `!come` / `!goto` land on the nearest landable cell and
walk the rest; under a roof they walk to open sky first. The flight model only does what a vanilla
client can do (yaw, pitch, the jump key, the glide request, a rocket in the hand); the server stays
authoritative. Decision record: [decisions/0042-elytra-flight.md](decisions/0042-elytra-flight.md)
(the Track AU2 addendum at its end). Container: `bds-fly` (udp/19204, FLAT, peaceful, fall damage ON;
`node scripts/bds.mjs --profile fly up|pack`).

> **The Realm, 2026-10-30 (the first day with an elytra).** Two flights by the owner's bot, from the
> owner's words and the log: at 16:43 `!fly sand` started *indoors* at about 110 57 -43 (home): the
> climb hit the roof three times within two seconds (1.9 damage each, 0.7 and 4.6 before), the flight
> ended by the health rule after 73 ticks and 5 rockets (the owner saw it nearly kill itself on the
> roof). At 16:47 the same 1490-block flight from outside cruised at y 164 (the terrain floor: the
> highest column 151) and landed on the spot after 1261 ticks with **17 rockets**, 1 go-around and 33
> corrections (the owner found it very wasteful, firing rocket after rocket). Track AU2 is
> the answer to both: the sky check before the takeoff and the path-ahead check in the air; the
> energy model of the cruise (the same flight on the model: 9 to 10 rockets); and the descent
> geometry (the owner suggested a spiral to slow the landing where the geometry allows).

## Files

| Path | What |
|---|---|
| `bot/src/skills/input/physics.ts` | `GLIDE`, `glideVelocity` (the vanilla fall-flying formula, float32), `stepGliding`, the `gliding` branch of `stepBody` |
| `bot/src/skills/input/flags.ts`, `inputLoop.ts`, `types.ts` | `start_gliding` with a jump press (`GLIDE_START_FLAGS`), `stop_gliding`; `cmd.glide`, `boostStart`; the own `gliding` actor flag (`GlideEvent`), `boost()` / `endBoost()`, `canGlide` |
| `bot/src/skills/fly/plan.ts` | the geometry (`cruiseHeight`, `columnsAlong`, the yaw law), the approach profile and its simulation, `touchdownCost`, the `ApproachPlanner`, `approachHopeless`; Track AU2: the energy model (`GLIDE_RATIO`, `glideLine`, `glideMargin`, `rocketPitchFor`), `takeoffSky`, `pathAhead`, `spiralFit`, `circleYaw` |
| `bot/src/skills/fly/brain.ts` | `FlightBrain`: the per-tick state machine (takeoff, climb, cruise, approach, go-around, land); Track AU2: `steerClear` (the path ahead), the cruise's rocket rule, `descend` / `chooseDescent` (the circle, S-turns), `goaroundHeight`, the `roof` end |
| `bot/src/skills/fly/controller.ts` | `FlightController`: the brain on the InputLoop, the rocket use, the rocket entity, the server-confirmed landing, `skyQuery`; the report's rockets by phase and descents (Track AU2) |
| `bot/src/skills/fly/kit.ts`, `kitops.ts` | the flight kit (`readKit`, `kitReady`, the lines, `SupplyWatch`) and its ground work (the elytra swap, rockets to the hotbar, the refill from the box) |
| `bot/src/tasks/process/fly.ts` | `FlyProcess` (user, 40) and `FlightProcess` (auto, 101: control in the air); the sky check before the jump (Track AU2) |
| `bot/src/chat/commands-fly.ts` | `!fly`, `!land`, the autoFly hooks on `pve.walk` / `pve.come`, the status line, `flyControlOf`; Track AU2: `landingNear` (fly then walk), `walkOut` (the legs to open sky), `skyHere` |
| `bot/src/tasks/mobility.ts` | `canGlide` for the loop (the elytra in the chest slot) |
| `bot/src/skills/survival/{keeper,armour}.ts`, `container/stash.ts`, `home/{unloader,logistics}.ts`, `chat/commands-survival.ts` | the kit rules (never dropped, stashed, unloaded; `!drop all` keeps it; the armour pass leaves a worn elytra alone; `ArmourController.wear`) |
| `bot/src/config/settings.ts` | `autoFly`, `flyMin`, `flyClearance`, `flyCruise` (unused since AU2), `flyGoArounds`, `fireworksMin`; Track AU2: `flyTakeoffRun`, `flyRetryBlocks`, `flyMaxClimb`, `flyMargin`, `flyLandSearch` |
| `bot/src/nl/{plan,prompt,executor}.ts` | the `fly` step ("fly to me", "fly home", "land") |
| `bot/src/health/panel/*` | the `flight` line of the statuses (`gliding, 23 rockets`) |
| `packs/truth/src/fly.ts` | `truth:glide`, `glidelog`, `equip`, `boxdrop` |
| `bot/test/unit/skills/fly.test.ts` | the geometry, the planner, whole trips on `stepBody` (the economy, the tree, the roof, the walled platform), the kit rules, the supply lines |
| `bot/test/e2e/fly-truth.ts`, `fly-glide.test.ts`, `fly-land.test.ts`, `fly-kit.test.ts` | the e2e suites on bds-fly (Track AU) |
| `bot/test/e2e/fly-economy.test.ts`, `fly-roof.test.ts`, `fly-descent.test.ts`, `fly-walk.test.ts` | Track AU2: the rocket economy of 300 / 600 / 1200-block flights, the room and the tree, the 10 + 10 descents, fly then walk (the pit, the house) |
| `bot/src/skills/fly/landing.ts` | Track BF: `findLanding` (the confirmed-path search), `floorsOf`, the wet / hazard rules, `corridorsOf` / `corridorLands` (overhangs), `stillLandable` |
| `bot/src/skills/survival/surface.ts`, `bot/src/tasks/process/surface.ts` | Track BF: `headInWater`, `swimUp`; the `surface` process and `shoreNear` |
| `bot/test/unit/skills/fly-landing.test.ts`, `surface.test.ts`; `bot/test/e2e/fly-overhang.test.ts` | Track BF: the farm replica on the model, the big roof, the sea, the hold; the swim up and drowning; the e2e farm / roof / water / seabed / sneak cases |
| `bot/src/skills/fly/glide.ts` | Track BH: `findLedges`, `smallPlatform`, `simulateFlight` (the whole flight on the live model), `planGlideDown`, `ledgeTakeoff`, `jumpTakeoff`, `glideKitReady` |
| `bot/src/skills/fly/prone.ts` | Track BH: `headCells`, `recoverProne` (the crawl pose after a glide) |
| `bot/test/unit/skills/fly-glide.test.ts`; `bot/test/e2e/fly-glide-down.test.ts` | Track BH: the ledges, the glide down from a pillar / a cliff, the glide that cannot reach, the farm overhang takeoff, the canopy, the prone cells; the e2e pillar / ledge / noreach / farm / prone cases |
| `bot/src/skills/fly/terrain.ts` | Track BL: `terrainFloor` (the floor ahead, unknown is not air), `assumedTop`, `strictObstacle`, `highCruiseWanted`, `TerrainMemo` |
| `bot/src/skills/fly/dive.ts` | Track BL: `planDive` / `simulateDive` (the dive descent, simulated whole before it is flown) |
| `bot/src/skills/fly/sites.ts` | Track BL: `siteCandidates`, `preferSite`, `RecheckState` (the takeoff-site search and the walk re-check) |
| `bot/test/unit/skills/fly-terrain.test.ts`, `fly-trip.ts`; `bot/test/e2e/fly-terrain.test.ts` | Track BL: the floor, the ridges / tower / unknown / cache-only trips, the dive against the circle, the site ranking and the re-check; the e2e wall / tower / ridge / dive / site / nosite / recheck cases |
| `docker/compose.fly.yml` | `bds-fly` |

## Packets (BDS 1.26.60.6, measured on bds-fly)

| What | Packet | Measured |
|---|---|---|
| start the glide | `player_auth_input.input_data` with `start_gliding` **and a jump press** (`jump_down`, `jumping`, `want_up`, `jump_current_raw`, `jump_pressed_raw`, `start_jumping`) on an airborne tick with an elytra in the chest slot | the flag alone is ignored, `player_action start_glide` (15) too; with the jump press the server confirms on the next tick |
| the confirmation | `set_entity_data` of the own player, `flags.gliding = true` (the loop's `GlideEvent`); the truth pack's `player.isGliding` | the request at tick N is confirmed at N + 1 |
| end of the glide | the server's `flags.gliding = false` on ground or water contact; the client sends `stop_gliding` on that tick | a voluntary `stop_gliding` in the air is **ignored** (the glide goes on; 19 corrections of up to 2 blocks when the model stopped and the server did not): the model only ends a glide on contact |
| a rocket | `inventory_transaction` `item_use` / `click_air` of the `firework_rocket` in the selected hotbar slot (eat.ts `useItemTransaction`), `mob_equipment` first when another slot is selected | `add_entity` `minecraft:fireworks_rocket` 1 to 3 ticks later at the body; `remove_entity` 12 to 18 ticks after the use; the inventory packets take one rocket |
| the boost | no `set_entity_motion`: the server applies the boost in its own movement step; the client predicts it (`cmd.boostStart`) | with the boost inside the step before the drag the prediction is within 0.001 per boosted tick; the rocket's random life is the one mismatch (one correction of 0.05 to 0.35 per rocket, repaired by `endBoost` on `remove_entity`) |
| the elytra on | `item_stack_request` `swap` (with a chestplate on) or `place` into the `armor` container slot 1 under the inventory screen (armour.ts) | `inventory_slot` of window 120 confirms; the loop's `canGlide` reads that slot |
| corrections | `correct_player_move_prediction` (strict server, threshold 0.001) | level flight 220 ticks: 0; pitch 20 / -20: 29 / 34 corrections all under 0.0001 (the strict server's noise); a 40-degree turn in one tick: 6 of at most 0.004; a whole flight with 3 rockets: 10 to 20, 3 to 5 over 0.05 |
| the box | `truth:boxdrop` places an undyed shulker box, fills it a tick later and breaks it with `setblock ... destroy`: the item carries its contents as NBT `Items` | the bot picks it up by walking over it; `isFireworksBox` reads the NBT |

## Physics

`glideVelocity` per tick, with the look vector `l` (unit, pitch +90 = down), `h` the horizontal speed,
all float32 (`GLIDE` in physics.ts; the vanilla values in brackets where they differ):

```
vy += 0.08 · (−1 + cos²(pitch) · 0.75)                         lift: less gravity when level
if vy < 0:  d = 0.1 · (−vy) · cos²;  v += (lx / cos, 1, lz / cos) · d   a dive trades height for speed
if pitch < 0:  d = h · (−sin) · 0.04;  v += (−lx / cos · d, 3.2 · d, −lz / cos · d)   the pull-up
v.xz += (l.xz / cos · h − v.xz) · 0.1                           the heading follows the look
boost (while the rocket lives):  v += l · 0.1 + (l · 1.5 − v) · 0.5
v *= (0.99, 0.98, 0.99);  the body is 0.6 high
```

Measured against the server (per-tick server samples through `truth:glidelog`, the model stepped
from the server's state): every tick of a steady glide or a steady boost within 0.002; the boosted
ticks only match with the boost applied **before** the drag (the Java order is off by 0.01 per tick);
the rocket (flight duration 1) boosts 12 to 18 ticks (`GLIDE.boostTicks` 15), pulling the speed
towards 1.7 blocks a tick along the look.

| Quantity | Measured | From the formula |
|---|---|---|
| level flight (pitch 0) | sinks 0.15 to 0.17 blocks a tick at 1.3 to 1.5 blocks a tick (sink ratio 0.12) | 0.149 / 1.34 after 60 ticks |
| a dive at pitch 30 for 40 ticks | | −11.8 blocks over 54, the speed 1.2 → 1.53 |
| a pull-up (flare) from 1.2 blocks a tick | | pitch −60: +7.2 blocks over 21.5 blocks, the speed left 0.29; pitch −75: +5.4 over 19, 0.32 |
| the same from 0.9 blocks a tick | | pitch −60: +0.4 blocks over 11.8, 0.42 left; from 1.6: +20 blocks |
| the settle (pitch −15 at 0.4 blocks a tick) | | sinks 0.05 blocks a tick, 7.5 blocks of ground in 20 ticks |
| the zero-damage descent rate | the stall "parachute" and the level spiral both sink 0.15 to 0.2 blocks a tick | |
| one rocket in a climb at pitch −38 | +1.06 blocks a tick of climb at 1.29 forward while it burns; the momentum after it carries vy² / 0.08 more blocks (14 from 1.06) | |
| the stall | under about 0.55 blocks a tick the dive term no longer feeds the glide | |

The climb pitch adapts to the climb (−20 under 15 blocks, −30 under 30, else −38), the rockets stop
when the momentum will reach the cruise height, and the last 40 blocks before the approach are flown
at pitch −6 to bleed the speed to about 1.05 (the flare's climb grows with the square of the speed).

### The glide polar and what a rocket buys (Track AU2, the formula)

Measured on `glideVelocity` (the formula the server matches within 0.002 a tick), the steady glide
by pitch and one rocket fired from a steady level glide (1.48 blocks a tick), its pitch held while it
burns (15 ticks), then level until the climb's momentum is spent:

| Pitch held | Steady speed | Sink a tick | Glide ratio | | One rocket at this pitch | Up while burning | Up in all (momentum) | Glide back to the start height |
|---|---|---|---|---|---|---|---|---|
| −6 | 0.66 | 0.082 | 8.0 | | 0 (level) | −0.3 | −0.3 | 25 blocks (the speed, 1.67, decays) |
| −3 | 0.91 | 0.101 | 9.0 | | −10 | 4.0 | 5.7 | 108 |
| **0** | **1.51** | **0.150** | **10.1** | | −20 | 8.3 | 14.4 | 188 |
| 5 | 1.54 | 0.154 | 10.0 | | −30 | 12.1 | 23.9 | 265 |
| 10 | 1.63 | 0.168 | 9.7 | | **−38** | **14.8** | **31.2** | **321** |
| 20 | 1.98 | 0.227 | 8.7 | | −45 | 16.9 | 37.1 | 364 (the speed left 0.77) |
| 30 | 2.48 | 0.339 | 7.3 | | −55 | 19.3 | 44.1 | 408 (0.60: the stall is 0.55) |

A back-to-back climb at −38 gains 15.7 blocks a rocket while burning (12.9 at −30, 17.9 at −45) and
the last rocket's momentum (16) on top, over about 1.4 blocks of ground per block climbed. So the
polar is nearly flat (a dive sheds no height worth the name: pitch 20 glides at 8.7 against 10 level),
**height is the currency** (one rocket pitched up buys 31 blocks of height, 310 blocks of glide; the
same rocket level buys 25 blocks), and a rocket **levelled off while it burns loses the climb** (the
boost steers the velocity onto the look: vy halves every tick).

## The controller

Phases of `FlightBrain` (one tick in, the controls out; `FlightController` applies them to the loop):

| Phase | What |
|---|---|
| takeoff | on the ground: jump; falling: the glide request (`start_gliding` with the jump press goes out); the server's `gliding` flag confirms; 120 ticks without a confirmed glide end the flight (`no_glide`); the heading is the sky check's (Track AU2, "Takeoff and roofs"), held until 12 above the start |
| climb | rockets back to back at the climb pitch until the body's momentum reaches the cruise height (`cruiseHeight`, Track AU2: what the glide down to the approach entry needs plus the margin, with the climb's own run taken off, capped `flyMaxClimb` above the start, never under `flyClearance` above the highest known column under the straight line nor under the entry); every tick the path ahead is checked (`steerClear`) |
| cruise | level towards the target along the glide line (Track AU2, "Rocket economy"): a rocket only when the projected height (the momentum included) is more than 3 under the line plus the margin, pitched up for the height it should buy; the speed bleed before the approach; more than 12 above the approach entry within 116 blocks: the descent geometry ("Descent geometry") down to 6 above |
| approach | within 56 blocks (earlier when high): the `ApproachPlanner` every tick |
| go-around | no landing plan for 6 ticks within 45 blocks, or a hard one near (cost over 35 within 14 blocks, over 70 within 30): a climbing turn away (since the Track AU2 review out along a bearing whose last 24 blocks into the target have no column above its top, the nearest of 0 / 45 / 90 / 135 / 180 degrees off the bearing away, so it comes back from the open side; one rocket when under the go-around height: the entry + 6, or 7 above the highest column within 30 blocks of the target, Track AU2), out to 68 blocks and low enough, back in, a new approach; at most `flyGoArounds` (4), then the nearest safe ground |
| land | the emergency: `!fly stop`, `!land`, `!stop`, health under `fleeHealth`, the elytra at `toolWearLimit` + 20 uses, a roof or wall ahead that nothing clears (`roof`, Track AU2); the nearest safe column ahead looking down from the body (a plain top, no lava / water / cactus / magma / fire, level neighbours, 10 to 60 blocks), a circle down when far above it, then the same landing |
| done | the body stands: 10 ticks without the server lifting it again (a "bounce": the brain flies on) |

### The landing

A landing is a model-predictive choice of a four-segment profile, re-optimised every tick from the
body's real state (position, velocity, boost) and flown with the same pitch law the simulation uses:

- **A1** a pitch for some ticks (bleeds speed or loses height), **A2** a pitch until the flare point
  `flareAt` blocks before the centre, **B** the flare (−20 to −85) until the top of the climb (vy back
  to 0) or the speed under 0.35, at most 40 ticks, **C** the settle (−30 to 30) until contact.
- The simulation (glide formula, the approach yaw law: turn towards the target 15 degrees a tick,
  frozen within 1.5 blocks) ends with `landed` (the feet cross the platform's top inside its
  footprint), `wall` (the side from below, or a solid cell of the world model in the body's 0.6 box,
  checked at the end and the midpoint of each tick), `short` (the ground), `over` (past the target
  above it) or `none`.
- The cost: `off · 2 + max(0, −vy − 0.3) · 40 + max(0, h − 0.3) · 40 + slide beyond the room · 30 +
  (ticks − 60) · 0.04`; the misses 80 (short) / 120 + height (over) / 200 + speed (wall).
- The search: the current profile, 120 random profiles across the ranges while no soft plan exists
  (30 once one does), 40 around the current one, a hill climb of up to 3 rounds; seeded, so a flight
  replays. About 180 simulations on a cold start (10 to 12 ms), 60 to 90 afterwards (4 ms).
- The outcome (`FlightReport`): the landing position, the distance from the aim, rockets, go-arounds,
  ticks, corrections, the touchdown speeds (the last airborne tick's velocity).

Why this shape: the pull-up's climb grows with the square of the speed (above), so a soft touchdown
needs the speed bled to about 0.9 before the flare and the flare started below the platform top; a
constant-pitch approach cannot do both, and the real platform edge punishes every block of error
(a touchdown at 1.3 blocks a tick slides 1.5 blocks).

## Takeoff and roofs (Track AU2)

The sky check (`takeoffSky`, plan.ts) runs before the jump, in `!fly` (the reply) and in the
`FlyProcess` (autoFly): the 3 x 3 columns around the start and the columns of the first
`flyTakeoffRun` (12) blocks along the heading must be free from the head's cell up to the cruise
height in the world model, and **an unknown cell counts as a roof here** (the cruise's `skyQuery`
treats unloaded cells as air; a ceiling the model has not loaded is still a ceiling). A roof over the
start refuses: `fly: no open sky here (roof at y 72, 3 blocks up); walk outside first`. A blocked run
along the target's bearing (a tree, a wall) tries the other headings 30 degrees apart, the nearest
first, and the first free one becomes the takeoff heading (the log's `takeoff heading 30`): the
takeoff and the climb hold it until the body is 12 above the start, then turn to the target.

`!goto` / `!come` under a roof (indoors, underground, under trees) say `fly: no open sky here (roof
at y 72, 3 blocks up); walking towards <goal> and taking off outside` and walk towards the goal in
legs of up to `flyRetryBlocks` (32) blocks, each to the nearest known **open-sky cell** on the way
(`openSkyLeg`: a cell 4 to 32 blocks ahead, up to 4 beside the line, standing on its column's top
under open sky and not under the feet; from a tunnel that is the surface, so the walk comes up, not
along; an `xz` leg along the line only when none is known), trying the takeoff again after each leg
(`walkOut`, commands-fly.ts); a leg that cannot be walked, or a goal the flight is no longer worth,
falls back to the plain walk. With "Fly, then walk" below this gives the owner's case: underground
to a point 1000 blocks away underground = walk up, fly, land near, walk in (the e2e: a tunnel 6
under the surface with a stair).

The takeoff check is a **climb cone**, not a wall of columns: the start's own column is checked from
the head up, its eight neighbours from two above the head (a trunk beside the bot is no roof), and
the run's columns only above the cone (the feet's height less 2 for the first 3 blocks, then rising
0.6 per block: a bump on the ground 10 out passes, a tree does not). Before every rocket the
**boosted** path at the rocket's pitch is simulated for 20 ticks (`fire`): a roof 8 to 19 above,
invisible to the unboosted check, holds the rocket.

In the air the brain checks the path ahead every tick of the climb, the cruise, the descent and the
go-around (`steerClear`, `pathAhead`): the glide of the next 20 ticks with the commanded yaw and
pitch, on the formula, against the world model's solid cells (the planner's `hitsObstacle` box with
its 0.4 berth, at every tick's end and midpoint). A hit tries, in this order, levelling off, pitch
10, a turn of 30 / 60 / 90 degrees to either side (the side nearer the target first), a dive of 25,
and flies the first that clears (`steered` ticks in the report). Nothing clears (a roof, walls all
round): in the climb and the cruise the flight ends on the ground under it as `roof`
(`landNow('roof')`: the emergency landing looking **down from the body** for the ground, with the
roof's cells as the planner's walls, pitch 15 while a rocket still burns) instead of by health; in a
go-around or a descent near the target the check only steers and never lands (low structures there
are the planner's business: a house wall 4 blocks behind a landing cell ended a flight early on
bds-fly before this rule). A slow body (under 0.7 blocks a tick, near the stall) is not steered:
every path of a stalled body sinks, the speed recovery comes first. A `roof` landing's ground is
looked for **before** the solid nothing cleared (the straight glide's first hit, less a berth), on
the heading, then 45 / 90 / 135 degrees either side and behind (over a void the nearest known ground
may lie back the way the body came), and the `land` phase keeps steering clear on the way
down; with no known ground on any heading the fallback is 10 blocks ahead at the target's height.

Offline (the unit test's trips on `stepBody`): a tree 3 x 3 x 8 ten blocks ahead on the climb line is
cleared both with the sky check's 30-degree heading and straight at it (2 to 3 steered ticks), 0
hits; a wide roof 6 above the start that the sky check did not see ends the flight on the ground
under it as `roof` with the body never in the roof's cells.

## Rocket economy (Track AU2)

The model (`GLIDE_RATIO` 10, `ROCKET_CLIMB` 18, `ROCKET_CRUISE_CLIMB` 31; the table under "Physics"):
a flight of D blocks needs about D / 10 blocks of height; a rocket in the climb buys about 18 blocks
(15.7 while burning, the last one's momentum on top), a rocket fired from a level glide at −38 about
31 (310 blocks of glide), a level boost about 25 blocks of distance. So the cheapest flight climbs
**once** to what the glide needs and glides:

- `cruiseHeight` = the glide line at the top of the climb (the approach entry, 10 above the target
  at 56 blocks out, plus the remaining distance / 10, with the climb's own run of 1.25 blocks per
  block taken off) plus the margin plus 2, capped `flyMaxClimb` (120) above the start and never under
  `flyClearance` above the highest known column (Track AU's `flyCruise` cap of 25 above the ends is
  gone: it made every long flight cruise low and boost level every 100 blocks: the Realm's 17).
- The margin (`glideMargin`): `flyMargin` (15) from 600 blocks on, `distance / 30 − 5` under it, 0
  under 150 blocks (the glide ratio's error grows with the distance flown; a short flight's climb
  overshoots by its momentum anyway, and the planner wants the body low: arriving 15 above the entry
  at 300 blocks cost a go-around in the offline trips).
- The cruise fires only when `height + momentum < glideLine(distance) + margin − 3` (the climb hands
  over within 3 of its height: that is on the margin, not under it) **and the body glides at 1.1 or
  more** (a slow body after the climb or a circle sinks while it regains its speed; that sink is not
  a shortfall: judged while slow it fired two needless top-ups at 600 blocks), pitched for the height the
  rocket should buy (`rocketPitchFor`: the whole 31 at −38 while more than 310 blocks of glide are
  ahead, else just enough to arrive about 8 over the margin). While a rocket burns the pitch is held:
  the climb's last one at the climb pitch (levelled off, the boost kills the climb), a top-up at its
  own. The cap bounds the climb's rockets, not a top-up's run-out.
- Arriving high (the quantised rockets: up to a rocket's worth over the line) costs time, not
  rockets: the descent geometry below, from 12 above the entry.

Offline (the unit test's trips on the flat; "before" is the unchanged Track AU code **measured on
bds-fly on 2026-10-30** in `fly-economy` with `FLY_ECON_BASELINE=1`; the bds-fly "after" numbers are in
"Measurements"):

| Flight | Before (bds-fly) | After, offline model | Climb / top-ups / go-arounds (model) |
|---|---|---|---|
| 300 blocks, flat ground | 1 rocket | 2 | 2 / 0 / 0 (the climb to 36 up: the second rocket's quantum) |
| 600 | 5 | 4 | 4 / 0 / 0 |
| 1200 | 13 | 7 (9 with 12-tick rockets) | 7 / 0 / 0 (the cap: 120 up) |
| 1490 (the Realm's flight) | 17 (the Realm) | 9 | 7 / 2 / 0 |
| 150 to the 3x3 at 40 up | 3 to 5 (table above) | 3 | 3 / 0 / 0 |
| 300 to a 5x5 at 20 up | 2 to 4 | 3 | 3 / 0 / 0 |

## Descent geometry (Track AU2)

Arriving more than 12 above the approach entry within 116 blocks of the target (a descending
approach, a terrain-forced cruise, the rockets' quantum), the brain comes down to 6 above the glide
line before the approach, choosing by the world model's columns (`chooseDescent`, `spiralFit`):

1. **A circle around the target**: the largest radius 6 to 24 whose columns out to the radius + 4
   (the body strays from the circle) are all lower than the exit height − 3; flown by pure pursuit
   on the circle (`circleYaw`: the aim 10 blocks ahead along it, 15 degrees of yaw a tick, the turn
   direction nearer the body's heading), pitch 8 (0 over 1.4 blocks a tick, 20 near the stall): a
   level circle sinks 0.15 to 0.2 a tick without going anywhere. The circle is left heading at the
   target (within 45 degrees), at least 28 blocks out and **with the speed bled under 1.15** (a short
   circle left at 1.3 to 1.5 handed the planner too much energy: the 300-block flights' go-arounds on
   bds-fly), or 10 under the exit height whatever the heading.
2. **A circle farther out, tangent to the approach line** 30, 45, 60 or 80 blocks before the target,
   when none fits around it (walls near the platform): its centre a radius beside the line (the
   largest of 24, 18, 12, 8, 6 whose columns are free, either side), turned so that the tangent at the
   line points at the target; it is left at the tangent point (within 4 blocks, heading in within 35
   degrees) at the glide line's height there + 6, so the approach comes in along the line, i.e. from
   the open side. (A first version centred the circle on the line and left it wherever the heading
   pointed at the target: 7 of 10 walled landings on bds-fly, 3 missed after 4 go-arounds; the tangent
   exit gives 0 go-arounds offline.)
3. **S-turns** when no circle fits anywhere: the heading swung 70 degrees off the bearing, the side
   flipped 12 blocks either side of the line (a zig-zag at 70 degrees makes 3 to 4 blocks of path per
   block of progress; half circles would make only 1.6), straightened out 66 blocks before the target
   for the planner. The emergency landing (`land`) uses the circles only: no S-turns over unknown
   ground.

The go-around's height follows the same columns (`goaroundHeight`: 7 above the highest column within
30 blocks of the target, else the entry + 6), so the climbing turn away from a walled platform is
flown over the walls. Offline (3 seeds each): the 3x3 at 40 up in the open from a start 60 above its
level, 100 blocks away: `spiral r24 at 0 out`, 1 rocket, 0 go-arounds, 0.1 to 0.25 from the centre;
with 20-high walls 10 blocks out on three sides: `spiral r12 at 32 out` (the tangent circle), 1
rocket, 0 go-arounds, 0.07 to 0.38 from the centre, 0 hits (without the go-around height the turn
away of an earlier version hit the wall).

## Fly, then walk (Track AU2)

> Since Track BF `landingNear` and `retargetNear` are replaced by the confirmed-path search and the
> hold ("Landing v3" below); this section is the Track AU2 history.

`!goto` / `!come` over `flyMin` blocks land on the goal only when it is landable: its column's top is
the block under the goal (within a block), a plain solid (no lava / water / cactus / magma / fire)
with level neighbours (within a block either way: neither a 1-wide column nor the bottom of a hole)
and no loaded solid within 20 above (`landable`, commands-fly.ts). Otherwise the landing target is
the landable cell within `flyLandSearch` (48) blocks with the shortest walk to the goal
(`landingNear`: rings around the goal, every cell out to 8, every other beyond; the walk is the
straight distance plus three times the height difference, refined by a bounded probe plan (reach.ts
`probePath`, 4000 nodes, 300 ms) for the nearest six when the goal's chunk is loaded), the reply says
`flying 980 blocks to 23 blocks from <goal>, then walking` (the status line `..., then walking 23
blocks`), and after the landing (also after a miss or a `roof` landing) the original goto / come
continues on foot to the real goal inside the same command. When the goal's ground is not in the live
model at the command (too far to be loaded; the world cache alone is provisional, it may predate a
structure) the goal itself is flown to and the flight looks again every 10 ticks from 160 blocks out
(`retargetNear`, fly.ts): once the chunks arrive the landable cell is chosen and the flight
retargeted (`fly: landing 23 blocks from <goal> (no landing spot on it), then walking`), also during
the approach while still 15 blocks out (the planner re-plans from the new target; a go-around turns
outbound again, and the new approach comes in from the open side: a cell before a house wall retargeted while the body circled beyond the house went around 4 times on bds-fly before the go-around chose its bearing); loaded ground with nothing landable within `flyLandSearch` ends the search (the goal
stays the target). The retarget loop is not gated on the process token: the `flight` process holds
control in the air and the `fly` process is paused meanwhile.

## Landing v3 (Track BF)

Decision record: [decisions/0047-flight-landing-v3.md](decisions/0047-flight-landing-v3.md). The
Realm, 2026-10-30, the owner's mob farm (a 9 x 7 platform 70 up under a spawning box that overhangs
it, a room with a ladder under the platform, the waypoint in the room): `!fly gunpowder` went around 4
times and the emergency landing put the bot on the sea floor (every goto then `no standable node`,
minutes on the bottom); `!goto gunpowder` kept a landing cell from the world cache on the box's roof
(`no path` from there). Since Track BF a landing near a goal is one the bot can walk from.

**The search** (skills/fly/landing.ts `findLanding`; `landingFor` in commands-fly.ts). The columns
around the goal (`flyLandSearch`, 48) are read from the live world model only (`floorsOf`: every floor
of a column between 36 under and 72 over the goal, its headroom, wet and hazard flags). A candidate is a
**sound** floor: dry (no water, lava, bubble column, kelp or seagrass within 3 over it), no hazard
block (lava, cactus, magma, fire, portal, berry bush, powder snow, wither rose, dripstone, lily pad,
scaffolding), all four neighbours with a floor within a block. Open cells have 20 free over the feet;
**roof** cells at least `flyHeadroom` (4) and a corridor (below). Candidates are tried by the lower
bound of the walk (the straight distance, 3 per block of height, a roof cell's penalty 4 + 2 per block
under) with a probe plan each (reach.ts `probePath`, 6000 nodes, 400 ms, no breaking or placing, to
within 1.5 of the goal; at most `flyLandProbes` (16) and 6 s in all, the tick yields between them). A
probe that fails marks the cell's whole plateau dead (one probe per roof, not one per cell); the search
stops when the best found path is within max(2, 10 %) of every remaining lower bound. The answer:

| Answer | When | The flight |
|---|---|---|
| `goal` | the goal's own cell is a sound open floor | exact for `!fly <x y z>` (half 1), else the plateau around it as a walk landing |
| `cell` | a probe found a path from the cell | the cell's plateau (up to 240 cells) as a walk landing, `fly: landing 5 blocks from X (under the overhang), then walking` |
| `unknown` | under 85 % of the columns around the goal are loaded (or the goal's own column) | **hold**: circle high over the goal (the go-around height, a rocket when 6 under), search again every 40 ticks |
| `fallback` | loaded, but no probe found a path | the nearest dry ground (ranked: limited / no start < not probed < none; else the nearest `dryGround`), `fly: no landing spot near X with a walking path (...); landing on dry ground at x y z, then trying to walk` |

One log line per search: `fly: landing for 74712 6 72844: 1010 candidates (481 under a roof), 1
probes, 1 approach sims, 114 ms: 74715 10 72844/roof b240:path 5 -> 74715 10 72844 under a roof
(ceiling 22), in from 240, 5 blocks of walk, 9 cells`. In flight (`watchLanding`, fly.ts) the chosen
cell is checked every 40 ticks until 6 blocks out (`stillLandable`: still a dry floor with the
headroom); a hold searches every 40 ticks from 160 blocks out and lands on the nearest dry ground
after `flyHoldS` (30 s) of holding (`fly: no landing near X after 30 s (...)`).

**Dry ground everywhere.** The same wet rule is in `groundAt` (the emergency landing, `!land`, the
descent picks) and the walk landing: a column with liquid within 3 over its top is never ground.

**Overhangs** (`corridorsOf`, `corridorLands`). From a roof cell, every 15 degrees: the cells of the
feet .. feet + 3 on the line and feet + 1 .. + 2 a block to each side must be free until a column open
to the sky (no solid feet + 4 .. + 20) within `flyOverhangDepth` (10) + 1 blocks, then 40 blocks out
along a line rising 0.2 a block (unknown cells beyond 24 count as free); the corridors are ranked by
the depth under the roof, 45 degrees apart. The first two candidates' best corridor is flown on the
model (the ApproachPlanner on stepBody from 56 out / 12 up and 40 out / 7 up at 1.05 blocks a tick):
the cell is offered only when the simulated approach lands with a cost under 30. The target carries
the corridor's `bearing` and the roof height (`ceiling`): the brain flies to the corridor's entry
(64 out along the bearing) before it turns in, the descent circles are the ones tangent to the
corridor's line, the go-around flies out and back along it, and its height ignores the roof's own
columns. Simulated (fly-landing.test.ts, the farm replica): 3 of 3 seeds on the platform, 0
go-arounds, 7 rockets.

**Walk landings** (deliverable F). A landing that is only a stop on the way (`walk: true`, the cells
of the plateau) scores the touchdown by `touchdownCost`'s walk branch: 0.3 per block off the centre
(a precision landing pays far more), the vertical speed over 0.35 at 40, the horizontal over 0.5 at
25, the slide out of the cells (the predicted slide plus 0.8 for the server) at 30 per block. The
planner's go-around rule (`approachHopeless`) is unchanged, so a go-around comes only when no
touchdown of the profile lands on a safe cell. `!fly <x y z>` keeps the exact landing when the goal is
landable. Every go-around logs its reason: `flight: go-around 1: no landing plan for 16 ticks (best:
short, cost 82, 1.0 from the centre) at 45 blocks out, -9 above, 0.83 blocks a tick, a walk landing of
9 cells`.

**`!fly` flies, then walks.** `!fly <x y z> | <waypoint> | home | <player>` uses the same search, says
the walk up front when known (`flying to X (300 blocks, about 20 s, then walking 5 blocks; ...)`),
and after the landing walks to the block (or comes to the player) unless it landed on the goal
itself: `walked to X`, or `fly: landed, but the walk to X failed (...)`.

## Underwater recovery (Track BF)

The planner swims on the surface only (grid.ts `swim` wants two free cells over the water), so a body
on the sea floor has no start node. **BotSkills.goto**: a goto that ends `unreachable` with the head
in water (`headInWater`: the eye cell, feet + 1.62) swims straight up (skills/survival/surface.ts
`swimUp`: the jump key only, until the head has been out for 3 ticks, at most 400 ticks; the model
rises about 0.135 blocks a tick, 15 blocks in about 110 ticks) and plans once more:
`goto: no path under water at x y z; swam up 14.6 blocks in 112 ticks`. **The `surface` process**
(tasks/process/surface.ts, auto, priority 101 like the fire escape) wants control when the head has
been under water for 3 s (with the server's `air` value: as soon as it is under 100 of 300), swims up
and walks to the nearest dry standable cell within 24 blocks (`shoreNear`). **Drowning**: MobTracker
keeps the own `air` (set_entity_data key `air`); a health drop with the head under water is drowning
when the air is at 20 or below (without an air value: unless a mob swung at the bot with the hit), and
pve logs `pve: took 2.0 damage (drowning: head under water, air 0), health 14` instead of a mob guess
(not counted as a hit for the duel and flee rules).

## Sneak at the touchdown (Track BF)

`flySneakLand` (on): the controller holds the sneak key from 2.5 blocks over the landing cell (approach
or land phase) through the settle, and releases it once the slide after the flight has stopped (speed under 0.003, at most 40 ticks). The model: stepBody's edge
back-off applies to a sneaking body that is on the ground and not rising (Track AJ); a gliding body
takes the gliding branch first (no back-off), so the clipping starts on the first tick after the
contact (the glide has ended), which is the post-landing slide. The measurements on bds-fly are under
"Measurements (Track BF)".

## Glide down and ledge takeoff (Track BH)

Decision record: [decisions/0054-glide-down-and-ledge-takeoff.md](decisions/0054-glide-down-and-ledge-takeoff.md).

> **The Realm, 2026-10-31.** 04:34Z `!goto home` from the owner's farm platform (9 x 7, 135 above the
> goal, under the spawning box that overhangs it): the sky check refused the jump takeoff (the box), and
> walkOut's first leg went to an "open-sky cell" at y 176, the top of the box, which no walk reaches; then
> the plain walk ended `no path (exhaustive search)`. 04:46Z a flight that ended `roof` came down in a
> tree canopy and left the bot in the crawl pose: every goto said `no standable node ... on oak_leaves`.

### Glide down (a walk with no way on)

`!goto`, `!come`, waypoint walks and the process walks (`pve.walk` / `pve.come`) that end `unreachable`,
`no progress possible` or `no path` look for a glide down (`glideFallback` in chat/commands-fly.ts) when:

- `glideDown` is on, the bot is in the Overworld and not in the air, and it is not fleeing, guarding,
  fighting a fire, surfacing or holding a combat target;
- the goal is `glideDownMinDrop` (10) or more below the feet and `glideDownMinDistance` (16) or more away.
  This also applies under `flyMin`, where autoFly never asked;
- the elytra is ready (`glideKitReady`: an elytra under the wear limit, the chestplate swap). Rockets are
  optional.

The log line carries the walk's end and the planner's own reason (`GotoReport.why`, e.g. `no path
(exhaustive search, 1832 nodes)`). The landing comes from findLanding: a dry cell with a confirmed walking
path to the goal (Track BF). A `fallback` landing, or none at all, refuses the glide.

For a landing within 500 blocks (`GLIDE_SIM_RANGE`), `planGlideDown` (skills/fly/glide.ts) finds the
platform's ledges toward it (`findLedges`) and simulates the **whole flight** from each one. The simulation
runs the brain on stepBody over the live world model: unknown cells count as air, the rockets are as
carried, and `cruiseY` is the landing's top so the brain never climbs. The first ledge whose simulation
lands on the landing's cells, dry and with no collision, wins. A farther (or unloaded) goal with rockets
is flown with the simulated takeoff described below.

When no plan works, the owner hears `fly: no glide down to <goal>: <why>` and the walk's failure stands.
The why is one of `no simulated glide lands there (...)`, `beyond a glide without rockets` or `no landing
near it with a walking path`. When a plan is accepted the owner hears `gliding down to <goal> (62 blocks,
40 down; the walk found no way; stepping off at x y z; ...)`; then comes the flight, then the walk for the
rest in the same command. A goal above the bot never glides.

### Ledge takeoff (step off an edge)

`findLedges` looks at the platform the bot stands on: the cells at the same feet height it can walk to, up
to 10 blocks out. It checks 8 headings. An edge cell counts when:

- the next cell along the heading drops 12 or more (`LEDGE_MIN_DROP`), and so do the first 4 cells along
  the fall;
- the fall corridor is free for 10 blocks (`LEDGE_CORRIDOR`), from the feet to 2 above and one cell to
  each side: no wall and no overhang in the way.

Edges are ranked by the angle to the target (15 degrees counts as one block) plus the walk to the edge.

The FlyProcess walks to the edge cell with an ordinary goto and checks that the bot stands on it. Then the
brain's `ledgeTakeoff`:

1. turns to the heading;
2. **sneaks** forward to the edge (the edge back-off stops it on the rim);
3. **releases** the sneak after 2 still ticks (or after 60), so the walk carries it off;
4. requests the glide as the fall begins (`vy < 0`);
5. dives at pitch 20 (`LEDGE_DIVE`) until 0.7 blocks a tick (`LEDGE_SPEED`);
6. goes on to the climb (with rockets) or the cruise.

The finish log line says `ledge takeoff (gliding X under the edge)`.

The step-off is flight input, not a navigator move, so Track BI's `dropCheck` never refuses it. The water
bucket clutch never arms while a flight runs (`FallGuard.intended` is wired to `controller.active`).

The dive from a standstill, measured on glideVelocity:

- reaching 0.9 blocks a tick costs about 12.5 blocks of drop at any pitch up to 20;
- pitch 20 to 0.7 blocks a tick costs 8.7 blocks of drop over 17 blocks out;
- steeper is worse (pitch 40: 17.7 blocks).

Hence the 12-block minimum drop.

The ledge takeoff is used:

- always, for a glide down (above);
- for a flight (`!fly`, autoFly, the far glide down) when `flyLedgeTakeoff` is on and either the sky check
  refuses the jump takeoff (a roof, an overhang, no free run) **or** the start is a small platform. A small
  platform is one whose standable area at the feet's height has 12 cells or fewer, or nothing farther
  than 3 blocks from the start. `ledgeTakeoff` simulates up to 4 ledges for 300 ticks (until the approach)
  and takes the first that is still flying, dry and without a collision.

Example: on the farm platform under its box, the bot steps off the +x edge, glides out from under the box
and climbs. The unit test flies 800 ticks with no hit and ends above the box.

### The jump takeoff simulated (canopies)

The jump takeoff's heading no longer comes from the sky check alone. `jumpTakeoff` simulates the first 300
ticks (the takeoff and the climb) on candidate headings: the sky's first, then 30, 60, ... 180 degrees to
each side. It prefers a heading whose climb needs **no steering** at all. A heading that clears only by
steering around a solid is the fallback (`heading 0: clear only by steering 14 ticks`).

When every heading meets a solid, the reply is `fly: no clear climb from here (the simulated climb meets a
solid on every heading: trees, a wall); walk outside first`, and goto / come walk out as before.

### Walk-out legs probed

walkOut now probes each open-sky leg from the bot before walking it (`probePath`, 6000 nodes, 400 ms).
It tries at most 6 candidates (`LEG_PROBES`), nearest first. If none is found it takes a plain `xz` leg.
The leg line names the failed probes (`no path to 12 176 -40:exhausted, ...`), so a box top is never
chosen again.

### Prone after a glide

A glide that ends under less than 1.8 blocks of headroom (a canopy, a slab roof, a 1-high gap) leaves the
body in the crawl pose. BDS sets the `crawling` (or `swimming`) actor flag and a `boundingbox_height` of
0.6; a bot teleported into a 1-high gap gets the same pose (the e2e uses this). The InputLoop tracks the
pose from the bot's own entity data: `state.prone` is set when the bot is out of water and not gliding,
and the log says `pose: prone (crawling true, ...)`.

The planner plans a standing body and has no start node there. Two places recover:

- **`BotSkills.goto`**, after the swim-up retry. An `unreachable` goto while prone runs `recoverProne`
  (skills/fly/prone.ts):
  1. It breaks the cells a standing box would take over the prone one, leaves first. Each break must pass
     the navigator's break rules (protected blocks, containers, the base's protect radius).
  2. It waits up to 40 ticks for the server to stand the body up.
  3. It plans once more.
  4. If the bot is still boxed in (a gap under a roof all round), it plans once more with `allowBreak` for
     that walk. The log says `goto: standing but no way out of the gap; digging out`.

  The log line reads `goto: prone at x y z (no standable node); standing again after breaking oak_leaves ...`.
- **`FlyProcess.after()`**. If the bot is prone after the landing it runs the same recovery. When that fails
  the owner hears `fly: I landed somewhere I cannot stand up (...); help me out`.

There is no crawl move: a prone body that may not break what is over it stays where it is.

### Foliage

The emergency / `roof` landing ground (`groundAt`) never takes a column whose top is leaves, azalea or
vines. It takes the next column down the line with open ground instead (the Realm canopy end).

### Vertical takeoff (straight up)

Another technique in the takeoff chain, not a replacement: the order is the ledge (when it applies), the
jump along the sky check's heading, the jump on the other 11 headings, then **straight up**, then a
takeoff site to walk to, then the walk-out legs (`takeoffFor`, commands-fly.ts). It is tried when the
jump is refused on every heading, and when the sky check refuses for the 3 x 3 around the start or the
run along the heading (a roof right over the head closes the column too and refuses at once).

- **The column** (glide.ts `verticalTakeoff`): the cells over the head must be open, an unknown cell
  counts as blocked, up to the hand-over height plus `VERTICAL_SPARE` (3).
- **The hand-over height**: the lowest from `VERTICAL_MIN` (6) up, 2 at a time, at most `VERTICAL_MAX`
  (48) and the cruise height, from which the usual sky check (`takeoffSky`: its 3 x 3, its run along a
  heading) passes. The whole climb from the ground is then simulated, as for the jump (no hit, dry, it
  reaches the approach); at most 3 simulations.
- **The flight** (brain.ts `verticalTakeoff`): jump, request the glide on the first falling tick looking
  straight up (pitch -90), a rocket whenever none burns and the coast straight up (`verticalCoast`: vy² /
  0.2, gravity takes the whole 0.08 a tick with no lift) would not reach the height; the hand-over only
  once the body is over it (pitched over earlier, the climb turns into what it rose out of), then the
  usual climb along the chosen heading, held until `TAKEOFF_HOLD` (12) above the hand-over. Logged as
  `vertical takeoff: 22.4 up (aiming for 22), 1 rocket; the climb turns to heading 0`.
- **Offline** (fly-vertical.test.ts, stepBody): a 3 x 3 clearing and a 1 x 1 shaft in a 20-high forest
  where every jump heading hits: hand-over 22 up with 1 rocket, no drift (under 0.3 blocks), no hit, lands
  300 blocks away.
- **Not measured on BDS yet**: that the server starts the glide and boosts the rocket with the look
  straight up as the model does. Until an e2e run has measured it, `!set flyVerticalTakeoff off` takes it
  out of the chain.

## Terrain-safe cruise, dive descent, takeoff sites (Track BL)

ADR [0055](decisions/0055-terrain-safe-cruise.md). The Realm flights out of home kept ending `roof` /
`landed_off` / `lost` 250 to 340 blocks out against mountains. The cruise economy let the body sink along the
glide line into a ridge the cache knew, and the model counted unknown cells as air. At chunk edges the
server held the body (z 656.30 and 832.30) while the model ran on.

### Terrain-safe cruise

- **The floor** (`terrain.ts terrainFloor`). The columns under the next 200 blocks of the heading are
  scanned every 2 blocks, every 4 ticks. Each is live (the model; subchunks not received above a solid take
  the cache's top when higher), cache, or unknown.
  - A known column needs `top + 1 + flyClearance + s / 10` at the body, `s` blocks before it.
  - An unknown column is assumed to stand at `knownMax + 24 + 0.25 × (blocks past the last known column)`,
    capped at 320.
  - The scan stops 40 blocks before the target, where the approach takes over.
- **Unknown is not air.** The climb levels off at the higher of the cruise height and the floor. The cruise
  fires a rocket whenever the projected height is under the floor (at any speed from 0.8 b/t), never bleeds
  speed while under it, and pitches up at the climb pitch when the floor rises steeply. `cruiseHeight` adds
  24 when any column on the line is unknown.
- **Detour.** When the floor rises faster than a rocket climb can follow (`(at − 6) / 1.25`), a heading
  30 to 90 degrees off is held for 40 ticks. `steerClear` stays the last resort.
- **Log lines.** `flight: terrain ahead: <src> top y T at D blocks (need y N, short S): pulling up` when the
  floor starts lifting the cruise, and `flight: terrain cleared: ... gained N blocks (y a -> b), k rockets`
  when it is passed.
- **Crash notes.** `flight: held by the server at x y z: the cell ahead x y z is <live block | unknown
  (chunk cx cz not loaded; cache: ...)>; at a chunk edge: the server had not loaded the next chunk`, at
  most one every 40 ticks. A glide ended by contact mid-route gets the same note. The finish line counts
  `avoidances`, `dives` and `held`.

### High cruise

`flyHighCruise always` flies the cruise at y 328 (build limit + 8) or higher. The Realm accepted flight over
320 (the 00:04Z flight reached y 389 with 4 corrections). `auto` takes it only for trips of 1500 blocks or
more with unknown columns on the line whose glide needs y 288 or more anyway. The cost, offline (rockets):

| trip | economy + floor | high cruise |
|---|---|---|
| 300 from y 70 | 1 | 13 |
| 1200 flat | 7 | 24 |
| 2300 flat | 14 | 27 |
| 2300 from y 70 (1673 / 1759 ticks) | 6 | 19 |

### Dive descent

`flyDescent auto` (the default) tries a dive every 5 ticks of the cruise once the descent is due.
- **The profile.** The dive pitch is 55 to 85 degrees and the pull -15, -30 or -45. The pull height is
  solved in two rounds, then the brain bleeds at -6 to the hand-over.
- **The hand-over to the approach:** 48 to 72 blocks out, 3 below to 5 above the approach entry, at
  1.05 b/t or slower, the sink under 0.35.
- **The check.** The best four profiles are simulated against `strictObstacle`. The pull-out must stay 6
  blocks over known or assumed terrain past 48 blocks out.
- **Abort.** When the window is still ahead, the brain waits (and does not start a circle while more than
  76 blocks out). It pulls out and goes back to the cruise in two cases: the path ahead meets a solid
  before the pull height, or the re-simulation every 10 ticks fails. A dive is not tried again on that
  flight.
- **Not used:** corridor and overhang landings keep their approach, and so does a target with known columns more than 3 over it within 20 blocks (walls, trees: the circle or S-turns fit there; in the walled fly-descent case 1 dive in 10 went round 4 times and touched a wall).
- **Two fixes found by the e2e:** the start's own platform (columns under the feet within 6 blocks) gets the clearance but not the unknown slack in `cruiseHeight`, and the terrain floor is seeded from a ring 16 blocks out, not the column under the body. Before, a flight from a 3x3 platform 200 up climbed 50 blocks before its glide down. Also, the climb hands over to the cruise once it is within 6 blocks of its top with no rocket burning. Before, it could hang 1 block under the cruise height all the way to the target, so no dive was ever looked for.

### Takeoff sites

When the takeoff here is refused (a roof, a canopy, a valley), `commands-fly.ts takeoffSite` searches for a
site to walk to:
1. **Candidates** (`sites.ts siteCandidates`). Every second cell within `flySiteSearch` (48) in any direction
   that stands on its column's top under 20 blocks of open sky, within 12 blocks of the feet height. Cells
   on a thin roof or a canopy (air 2 and 3 under the top block) are left out. They are ranked by
   `1.3 × distance` of walking (0.178 s a block) plus `flightSeconds` from there.
2. **Takeoff.** The takeoff is simulated from each candidate (up to 12): a ledge when the platform is small,
   else the jump on every heading 30 degrees apart. The simulation carries the terrain columns: the brain
   keeps the floor, and a climbing turn into cache-only terrain or under an unknown column's assumed top
   counts as a hit.
3. **Walk.** The walk is probed (6000 nodes, 400 ms, no long falls; up to 6, 3 s in all) to the ones that
   clear. A cell within 6 blocks of one without a path is skipped.
4. **Choice.** The first candidate with `walk × 0.178 + flightSeconds(from there) < walk-all / flyPreferRatio`
   wins. The owner hears `walking 27 blocks to take off from X Y Z, then flying (420 blocks; walking would
   be ~1 min)`. On arrival the takeoff is checked again: refused, the owner is told and the walk goes on,
   watched.
5. **No site:** the Track AU2 walk-out legs, unchanged, as the fallback.

### Flight re-check on long walks

A `!goto` / `!come` that walks (the kit not ready, too few rockets, no site worth it) is watched once a
second (`sites.ts RecheckState`). It looks for a takeoff again in three cases:
- every `flyRecheckBlocks` (24) blocks walked;
- when the kit becomes ready (rockets picked up);
- when the body comes out from under a roof.

Limits:
- **Cheap gates first:** autoFly on, the walk process in control (not flee, guard or a fight), no combat
  target, the goal still over `flyMin`.
- **Rate:** at most one takeoff + landing search per 20 s, and none within 16 blocks of a refused takeoff
  for 5 min.

A chance found: the walk is stopped at a safe spot (standing, dry, |vy| ≤ 0.1, not a ladder, vine or
scaffolding; up to 3 s more of walking to find one). The takeoff is checked again from there and the flight
goes. The log says `fly: the walk to X stopped at x y z for a flight (the flight kit is ready)`.

## The kit

The flight kit is the elytra, the firework rockets and **the fireworks box**: any shulker box whose
contents (NBT `Items`) are firework rockets only, or the box the owner named with `!fly box <slot>`.
Rules (all named `// Track AU` in the shared files):

- never dropped by the keeper (`neverDrop`), never stashed by the stash step (`depositable`, the box
  is never the stash box), never unloaded by `!unload` (the box is kept as `flight_kit`, the rockets
  by `keepOnDropItems`), kept by `!drop items` **and** `!drop all` (`kept the flight kit (elytra, 23
  rockets, the fireworks box); !drop flightkit drops it`); `!drop flightkit` drops it, the worn
  elytra included;
- the armour pass leaves a worn elytra alone (the flight swaps the chestplate back itself); `!fly`
  never starts without the elytra in the chest slot (`ArmourController.wear`, confirmed by the
  server's `inventory_slot`); an elytra or chestplate worn by hand (`!equip slot <n>`, the panel's
  **Wear this**) is pinned against the armour pass, and the flight's own swaps end that pin
  (docs/survival.md "Armour worn by hand"): after a landing the chestplate goes back on as usual;
- the refill: fewer than `fireworksMin` (16) rockets in the hotbar and some in the box: the box is
  placed next to the bot (`boxSpots`), opened, rockets are taken until the hotbar holds a stack,
  closed, broken (the Digger) and picked up again; before a flight and after a landing, never in the
  air; rockets left in the main inventory move into the hotbar, and a full hotbar first parks its least
  useful item (a block or shulker box before food before a tool; never the elytra) in a free main slot
  (before, `no free hotbar slot for the rockets` refused a hotbar of tools and shulker boxes);
- the supply lines, once per count: `fireworks low: 9 rockets left and the box is empty; give me more
  (drop them or !bring fireworks_rocket 64)` when the box is empty and the rockets under
  `fireworksMin`; `elytra worn: 25 uses left; I will not fly until it is mended or replaced` at or
  under `toolWearLimit` + 20 uses (an elytra has 432 and breaks in the air), and `!fly` refuses with
  the same line. The controller lands at once when the uses reach that limit in the air.

## Settings

| Key | Default | What |
|---|---|---|
| `autoFly` | on | `!come` / `!goto` fly instead of walking over `flyMin` blocks when the kit is ready (`flying (420 blocks; walking would be ~1 min)`); the Nether only under a clear ceiling along the line |
| `flyMin` | 200 | the distance from which they fly |
| `flyClearance` | 12 | the cruise clears every known column by this |
| `flyCruise` | 25 | no longer used since Track AU2 (the cruise height is what the glide down needs, capped by `flyMaxClimb`); kept so older settings files load |
| `flyGoArounds` | 4 | approaches flown again after a miss |
| `fireworksMin` | 16 | the refill and the low-supply line |
| `flyTakeoffRun` | 12 | Track AU2: the sky over the start and over this many blocks along the takeoff heading must be free up to the cruise height (an unknown cell counts as a roof), else `!fly` refuses and goto / come walk to open sky first |
| `flyRetryBlocks` | 32 | Track AU2: goto / come that walk because the sky is closed try the takeoff again every this many blocks |
| `flyMaxClimb` | 120 | Track AU2: the climb never goes higher than this above the start; a longer glide is topped up on the way (31 blocks of height, 310 of glide, a rocket) |
| `flyMargin` | 15 | Track AU2: the cruise fires only when the glide ahead would reach the approach entry with less than this to spare (less for short glides: `distance / 30 − 5`, none under 150 blocks) |
| `flyLandSearch` | 48 | Track AU2: goto / come land on the nearest landable cell within this many blocks of the goal and walk the rest (Track BF: the radius of the confirmed-path search) |
| `flyLandProbes` | 16 | Track BF: probe plans (6000 nodes, 400 ms each, 6 s in all) tried from landing cells before the dry-ground fallback |
| `flyHoldS` | 30 | Track BF: seconds of holding over a goal whose ground is not loaded (or not confirmed) before landing on the nearest dry ground |
| `flyHeadroom` | 4 | Track BF: the least free height over the feet of a landing cell under a roof |
| `flyOverhangDepth` | 10 | Track BF: the deepest landing under a roof (0 = never under a roof) |
| `flySneakLand` | on | Track BF: sneak through the touchdown and the settle |
| `flyLedgeTakeoff` | on | Track BH: step off a platform edge to take off when the jump takeoff is refused (a roof, an overhang, no run) or the start is a small platform; the ledge is simulated first |
| `flyVerticalTakeoff` | on | go straight up the open column over the bot when the jump takeoff is refused on every heading (trees, walls, a shaft), then climb from above; simulated first ("Vertical takeoff") |
| `glideDown` | on | Track BH: a goto / come that ends with no way on to a goal far below glides down with the elytra when a simulated glide from a ledge lands near it (rockets optional), then walks |
| `glideDownMinDrop` | 10 | Track BH: the goal at least this far below the feet |
| `glideDownMinDistance` | 16 | Track BH: the goal at least this far away horizontally |
| `flyHighCruise` | auto | Track BL: `always` cruises at y 328 or higher (over everything), `off` never, `auto` only for trips of 1500+ blocks over unknown terrain whose glide needs nearly that height anyway |
| `flyDescent` | auto | Track BL: `dive` / `auto` dive steeply to the approach when the simulated profile is clear (else the circle), `spiral` always circles |
| `flyRecheckBlocks` | 24 | Track BL: a walk that did not fly looks for a takeoff again every this many blocks (and when the kit becomes ready, and out from under a roof) |
| `flyPreferRatio` | 1.5 | Track BL: walk to a takeoff site and fly when the whole walk would take this many times longer |
| `flySiteSearch` | 48 | Track BL: the radius of the takeoff-site search when the takeoff here is refused (0 = off: the walk-out legs) |

## Processes

`flight` (auto, priority 101) wants control from the takeoff until the body stands: flee (100), defend,
the night retreat and every command wait for the landing. `fly` (user, 40) does the ground work and
is cancelled and resumed like any command; `!stop` stops it (the flight still lands; the chestplate
then stays off), `!fly stop` and `!land` land and let the trip finish. `!come` and `!goto` wrap
`pve.come` / `pve.walk`: a flight to the target block (half 1 for a block, 2 for a player or home) or, since Track
AU2, to the nearest landable cell near it, then the walk for the rest; under a roof the walk comes
first ("Takeoff and roofs").

## Measurements (bds-fly, BDS 1.26.60.6, strict movement)

The landing table, a 3x3 platform 40 blocks up and 150 blocks away, flat ground, 64 rockets (the
track's probe `probe-fly.mts` on the FlightController, then the e2e suite `fly-land`). "local" is
the model's touchdown point, "server" the truth position once the body stood (the server's body
slides 0.6 to 0.8 blocks further after the glide ends than the model's: it keeps the glide a tick or
two longer); damage from the truth hurt log; fall damage on.

| # | off (local) | off (server) | on the platform | damage | rockets | go-arounds | s | touchdown vy / h |
|---|---|---|---|---|---|---|---|---|
| 1 | 0.28 | 1.00 | yes | 0 | 3 | 0 | 9.3 | −0.091 / 0.333 |
| 2 | 0.16 | 0.82 | yes | 0 | 5 | 1 | 16.2 | −0.106 / 0.298 |
| 3 | 0.20 | 0.94 | yes | 0 | 3 | 0 | 8.6 | −0.189 / 0.350 |
| 4 | 0.19 | 0.94 | yes | 0 | 5 | 1 | 21.5 | −0.105 / 0.342 |
| 5 | 0.14 | 0.88 | yes | 0 | 3 | 0 | 8.2 | −0.223 / 0.350 |
| 6 | 0.27 | 0.99 | yes | 0 | 2 | 0 | 9.6 | −0.103 / 0.332 |
| 7 | 0.05 | 0.66 | yes | 0 | 4 | 1 | 20.4 | −0.081 / 0.274 |
| 8 | 0.2 | 0.82 | yes | 0 | 5 | 1 | 20 | (e2e run 1) |
| 9 | 0.1 | 0.86 | yes | 0 | 3 | 0 | 9 | |
| 10 | 0.3 | 1.00 | yes | 0 | 3 | 0 | 11 | |
| 11 | 0.3 | 1.05 | yes | 0 | 7 | 2 | 27 | |
| 12 | 0.2 | 0.83 | yes | 0 | 5 | 1 | 21 | |
| 13 | 0.3 | 0.93 | yes | 0 | 5 | 1 | 16 | (e2e run 2) |
| 14 | 0.0 | 0.78 | yes | 0 | 7 | 2 | 23 | |
| 15 | 0.3 | 1.02 | yes | 0 | 6 | 1 | 17 | |
| 16 | 0.2 | 0.90 | yes | 0 | 6 | 1 | 18 | |
| 17 | 0.1 | 0.84 | yes | 0 | 6 | 1 | 17 | |
| 18 | 0.1 | 0.73 | yes | 0 | 5 | 1 | 19 | (e2e run 3) |
| 19 | 0.0 | 0.76 | yes | 0 | 5 | 1 | 21 | |
| 20 | 0.1 | 0.71 | yes | 0 | 5 | 1 | 19 | |
| 21 | 0.1 | 0.78 | yes | 0 | 5 | 1 | 17 | |
| 22 | 0.4 | 1.14 | yes | 0 | 3 | 0 | 9 | |

Over the twenty-two: mean distance from the centre 0.2 (model) / 0.87 (server), max 0.4 / 1.14; every
run stood on the platform; damage 0 in every run; 2 to 7 rockets (median 5); 0 to 2 go-arounds; 8 to 27 s. Before the server-confirmed landing (decision 4 of 0042) one run of the first
probe predicted a landing the server did not see and the body fell off the platform: that is the
case the "bounce" handles now.

Other flights (the probe; every landing with 0 damage and on the platform):

| Flight | Result |
|---|---|
| 100 blocks to flat ground, takeoff from flat ground | 1 rocket, 0.83 from the aim (server), 12.7 s |
| the 3x3 at 40 up from a start 60 blocks above its level, 100 blocks away (the descending approach) | 1 rocket, 0 go-arounds, 0.93, 0.83, 0.81 and 0.79 (e2e) from the centre, 19 to 21 s (a spiral down first) |
| a 5x5 platform 20 up at 300 blocks | 2, 4, 4 and 4 (e2e) rockets, 0 go-arounds, 0.88, 1.10, 0.97 and 1.85 from the centre, 12 to 15 s |
| a wall 7 high 10 blocks before the 3x3 (before the obstacle check) | landed after 1 go-around but hit the wall first: 3.6 and 9.2 damage (`flyIntoWall`); with the obstacle check in the planner (the world model's cells along the simulated path): 0 damage, 0 to 1 go-arounds; a 12-high wall (e2e): landed after 0 to 1 go-arounds, 0 damage once and a graze of 1.4 once, which led to the 0.4-block berth around obstacles |
| `!fly stop` at 4 s of a flight towards the 3x3 (cruise 55 above the ground) | landed with 0 damage 22 to 23 s later before the spiral descent (the offline simulator with it: 11 to 14 s from 55 up, 6.5 to 7 s from a ground flight's cruise 25 up); the e2e (a ground target 300 blocks out, the stop during the climb at 37 up): landed 12.8 and 13.6 s after the stop, 0 damage |

Rockets per 100 blocks: a 300-block flight to a platform 20 up took 2 to 4 rockets (the climb
included), a 150-block one to 40 up 3 to 5, a 100-block one on the flat 1: about one rocket per 100
blocks of cruise plus one per 18 blocks of climb (`estimateRockets`). Time: 300 blocks in 12 to 15 s
against about 54 s of sprinting (`walkMinutes`: 3.564 ticks a block).

### e2e

Three rounds on bds-fly (the tails are in the track's report). `fly-glide` (the 100-block glide from
flat ground): landed 0.1, 0.2 and 0.0 from the aim, 0 damage, 2 to 4 rockets, 1 to 2 go-arounds, 14 to
21 s; the elytra on during the flight and the chestplate back afterwards. `fly-land`: the 5 platform
landings of each round are rows 8 to 22 of the table (15 of 15 on the platform, 0 damage); the
descending approach 1 rocket, 0.79 to 0.83 off; the 5x5 at 300 blocks 4 rockets; the 12-high wall
landed after 0 to 1 go-arounds (one graze of 1.4 before the obstacle berth, 0 damage after); `!fly
stop` landed 12.7 to 13.6 s after the stop with 0 damage. `fly-kit`: `!drop all` keeps the kit and says
so, `!unload` keeps 23 rockets, the box and the elytra while 112 cobblestone go into the chest, the
stash step with a full inventory drops junk and never places the fireworks box, a flight with 8 rockets
in the hotbar takes 56 from the box first (the box keeps 8), the low-supply line is said once after a
landing with no box, `!fly` refuses with an elytra at 25 uses, `!goto` 300 blocks flies with autoFly on
(`flying (300 blocks; walking would be ~1 min)`) and walks with it off.

## Measurements (Track AU2, bds-fly, BDS 1.26.60.6)

The e2e suites of Track AU2 on the same container (fall damage on, the truth hurt log; "before" is
the unchanged Track AU code measured the same day with `FLY_ECON_BASELINE=1`).

### The rocket economy (`fly-economy`, flat ground, a ground target)

| Flight | Before (Track AU) | After, the two gated rounds | After: climb / top-up / go-around rockets | Max height | Landing |
|---|---|---|---|---|---|
| 300 blocks | 1 rocket, 16 s | 2, 15 s and 1, 17 s | 1-2 / 0 / 0 | 34 to 39 up | 1.3 to 1.7 off (within the gate's 3), 0 damage |
| 600 | 5, 26 s | 4, 31 s and 4, 32 s | 4 / 0 / 0 | 69 to 74 up | 0.8 to 1.0 off, 0 damage |
| 1200 | 13, 46 s | 8, 54 s and 8, 54 s | 7 / 1 / 0 | 131 to 133 up (the cap 120 + the last rocket's run-out) | 0.7 to 1.0 off, 0 damage |

Rockets per 100 blocks: 300 blocks 0.33 before, 0.33 to 0.67 after (the climb to the glide line is
one or two rockets by the rocket quantum, where the old cruise let the body sink under the approach
entry, which a platform cannot take); 600 blocks 0.83 before, 0.67 after; 1200 blocks 1.08 before,
0.67 after. The old flights boosted level every 100 blocks (the Realm's 1490 blocks: 17 rockets, 1.14
per 100; the model's: 9, 0.6). Every flight landed within 1.7 blocks of the aim with 0 damage. The
two earlier rounds, before the glide-speed rules of "Rocket economy" (the circle left only under 1.15,
the line judged only at 1.1 or more): 300 blocks 2, 3 (1 go-around) and 5 (2 go-arounds); 600 blocks
4, 4 and 6 (2 needless top-ups right after the climb); 1200 blocks 8 in every round. The long ones
arrive a rocket's worth high and circle down (`spiral r24 at 0 out from 24 to 37 above`), which is
the 10 s of extra time.

### Takeoff and roofs (`fly-roof`)

A truth-built room (walls, the roof block 4 above the floor, a 2 x 2 doorway towards the goal) around
the start, the goal 300 blocks out on the flat; then, in the open, a 3 x 3 x 8 oak-log "tree" 10 blocks
ahead on the climb line:

| Case | What happened |
|---|---|
| `!fly` in the room | `fly: no open sky here (roof at y -56, 4 blocks up); walk outside first` (no flight) |
| `!goto` 300 in the room | `fly: no open sky here (roof at y -56, 4 blocks up); walking towards 74592 -60 65676 and taking off outside`; walked out of the door (since the review: to the first open-sky cell outside, 6 blocks from the start; before it a 32-block `xz` leg) with no flight started, then `flying (268 blocks; walking would be ~1 min)`; landed 0.11 from the aim (1 climb rocket + 3 go-around rockets in run 1, 2 go-arounds), `arrived at 74592 -60 65676`, 0 damage |
| the tree 10 blocks ahead | the flight starts (the tree is not over the start), `takeoff heading 30` in the log; landed 0.1 from the aim, 3 rockets (2 climb, 1 top-up), 0 go-arounds, 19 s, 0 damage; run 1 of the same test earlier: 5 rockets (2 go-arounds), 0 damage |
| a tunnel under a raised surface (feet 7 below it, a covered stair up; the review's underground case) | `fly: no open sky here (roof at y -58, 2 blocks up); walking towards ... and taking off outside`; `leg 1 to the open-sky cell` on the surface 4 blocks ahead (up the stair, not along the tunnel), then `flying (296 blocks; ...)`; landed 0.28 from the aim, 2 climb rockets, 0 go-arounds, `arrived at`, 0 damage (the review fixes, 2 runs) |

Both runs of the suite passed (after the review fixes: 2 of 2 again, all three cases; the room: 1 rocket, 0.33 off; the tree: 2 rockets, 1 go-around, 0.17 off; 0 damage in all). The indoor case the owner hit (the flight already in the air under a
roof) is covered offline (the unit test's wide roof 6 above the start: the body never enters the
roof's cells and the flight ends on the ground as `roof`).

### The descent geometry (`fly-descent`: from a pillar 60 above the platform level, 100 blocks away)

Two rounds of ten landings each on the 3 x 3 platform 40 up (fall damage on; "off" is the truth
position from the centre once the body stood: the server's body slides 0.6 to 0.8 further than the
model's):

| Case | Descent chosen | On the platform | Damage | Off (server) | Rockets | Go-arounds | s |
|---|---|---|---|---|---|---|---|
| in the open, 2 x 10 runs | `spiral r24 at 0 out from 65 above` (the circle around the platform) in 20 of 20 | 20 of 20 | 0 in all | round 1: 0.62 to 1.01 (mean 0.79); round 2: 0.60 to 1.09 (mean 0.95) | 1 each | 0 | 25 each |
| 20-high walls 10 blocks out on three sides, 2 x 10 runs | `spiral r12 at 32 out from 65 above` (the tangent circle on the approach line) in 20 of 20 | 20 of 20 | 0 in all | round 1: 0.64 to 1.01 (mean 0.76); round 2: 0.66 to 0.97 (mean 0.77) | 1 each | 0 | 23 each |

(The first version of the walled descent, a circle centred on the line and left wherever the heading
pointed in: 7 of 10 on the platform, 3 missed after 4 go-arounds each, 0 damage in all; replaced by
the tangent circle.) No S-turns were needed: a circle fitted every case.

### Fly, then walk (`fly-walk`)

`!goto` from 300 blocks away on the flat; the goal's ground is not in the live model at the command
(the reply is the plain `flying (300 blocks; walking would be ~1 min)`), the flight looks again once
the chunks arrive and retargets in flight:

| Goal | In flight | Landing | Then |
|---|---|---|---|
| 3 blocks under the floor (a one-wide trench with a stair) | `fly: landing 1 blocks from <goal> (no landing spot on it), then walking` (the trench's own cell and its neighbours fail the level-neighbours rule) | 1 block beside the trench, 0.13 off the cell, 1 rocket, 0 damage | walked down the stair; `arrived at <goal>`, standing at y −63 |
| inside a 7 x 7 house (walls 3 high, a roof, a doorway) | `fly: landing 4 blocks from <goal> (no landing spot on it), then walking` (the roof's cells walk 12 by the height rule, the ground before the door 4) | on the ground 4 blocks before the door wall, 0 damage, 1 landing | walked in through the door; `arrived at <goal>`, standing inside |

After the review fixes one house run retargeted while the body circled beyond the house: every go-around
flew straight away from the cell and came back over the house (4 go-arounds, landed 34 off, 7 rockets, 0
damage, then walked and arrived); reproduced offline (the unit trip with the house, retargeted 10 beyond
its centre) and fixed by the go-around's open bearing ("The controller"): offline 1 go-around and on the
cell in every seed; on bds-fly 2 of 2 runs of the suite after the fix passed (both cases, 1 landing, 0 damage).

Three earlier runs of this suite found the bug the table above is free of: the retarget loop was
gated on the process token, which moves on while the `flight` process holds control, so it never ran
(the flight went for the goal itself and missed after 4 go-arounds, then walked the 30 blocks: the
goal was still reached, with 0 damage, but 5 to 7 rockets). One run before the ring-search fix landed
on the house's roof (its cells filled the inner rings before the ground cells were seen) and the walk
down was unreachable.

### Regression (`fly-glide`, `fly-land`, `fly-kit`)

One round each on the Track AU2 code. `fly-glide`: landed 0.2 from the aim, 0 damage, 2 rockets (1
climb, 1 go-around), 18 s; the elytra on in flight, the chestplate back. `fly-land`: the five 3x3/40
landings all on the platform, 0.62 to 0.95 off, 0 damage, 3 to 5 rockets (0 to 1 go-around), 16 to
19 s; the descending approach 1 rocket, 1.08 off (`spiral r24 at 0 out`); the 5x5 at 300 blocks 4
rockets, 0.79 off; the 12-high wall landed (not shown in the five-line table); `!fly stop` during the
climb of a 300-block flight landed with 0 damage **18.4 s** after the stop (the old gate was 15 s,
measured 13.6 with Track AU's 25-up cruise; the energy model cruises that flight at 36 up and the
circle sinks 0.15 to 0.2 a tick: the gate is 25 s now, headroom for a stop at the top of the climb; the open point below notes it). `fly-kit`:
all 7 (the kept kit, `!unload`, the stash step, the refill of 56, the low-supply line once, the worn
elytra refusal, `!goto` flying with autoFly on and walking with it off).

The second round of the Track AU2 suites: `fly-roof` 2 of 2 (the tree: 2 rockets, 13 s), `fly-descent`
20 of 20 on the platform with 0 damage (open: 0.60 to 1.09 off, mean 0.95; walled: 0.66 to 0.97, mean
0.77; 1 rocket, 0 go-arounds, 23 to 25 s each), `fly-economy` and `fly-walk`: see their tables (the
runs before the glide-speed conditions above: 300 blocks 5 rockets with 2 go-arounds, 600 blocks 6
with 2 needless top-ups; those two rules came from them).

## Measurements (Track BF, bds-fly, BDS 1.26.60.6)

### Landing v3 (`fly-overhang`)

`!goto` from 300 blocks away; the goal's ground is never loaded at the command, so every flight holds
briefly (1 to 22 ticks) until the search confirms a cell:

| Case | Search | Landing | Then |
|---|---|---|---|
| farm replica (platform 70 up under the overhanging box, room with ladder; goal in the room) | 1010 candidates (481 under a roof), 1 probe, 1 approach sim, 68 to 114 ms: the platform cell 3 from the hole, corridor in from 240 | on the platform under the box; run 1 (before the descent-window fix): 11 rockets, 2 go-arounds (the circle forced out 10 under its exit height, then a slide into the ladder hole); run 2 after it: **8 rockets, 0 go-arounds**, 0.44 off, 0 damage | walked down the ladder; `arrived at` the room goal |
| goal under a 41 x 41 roof 5 high | 5748 candidates, 2 probes (the roof top: none; the ground 20 out: path) | on the ground 20 blocks from the goal, 3 rockets, 0 go-arounds, 0 damage | walked in; `arrived at` |
| goal in the middle of a 31 x 31 pond | 16 probes all `limited` (6000 nodes do not swim 15 blocks): the fallback, said in chat | on dry ground at the shore, 1 rocket, 0 go-arounds, 0 damage | the walk failed (`goto: unreachable`: a swim of 15 blocks to a mid-pond cell; the navigator's business) |
| on the floor of a 10-deep pond, `!goto` 9 blocks onto the shore | 3 × `no standable node`, then `swam up 8.8 blocks in 55 ticks` | (no flight) | `arrived at` |
| idle on the same floor | `surface: head under water ... for 201 ticks, air 98: swimming up`; surfaced after 55 ticks | (no flight) | standing on the shore 16 s after the teleport |

Run 3 (after merging Track BG, the replica with a closed trapdoor over the ladder): all 5 cases passed; the
farm 7 rockets, 1 go-around (the reason above), walked through the hatch into the room.

Run 4 (final code: the level rule, sneak until stopped, the walk-back): `fly-overhang` and `fly-walk` 7 of 7;
the farm 6 rockets, 0 go-arounds; the roof 3 rockets, 1 go-around (`best: over, cost 132, 4.4 from the
centre at 44 blocks out, 17 above`: it arrived high); pond 1, pit 1, house 2 rockets, 0 go-arounds.

### Go-arounds and rockets per landing, before and after (deliverable F)

Base `8ee3027` against Track BF, the same suites on bds-fly (the `fly-overhang` farm / roof / water cases
and `fly-walk`; each landing is one flight):

| Case | Before (8ee3027) | After (Track BF) |
|---|---|---|
| farm | 7 rockets, 0 go-arounds, but landed **on the box's roof** (y 34): `goto: unreachable` | 8 / 7 / 11 rockets, 0 / 1 / 2 go-arounds (the 2 before the descent-window fix), on the platform, walked into the room |
| big roof | 2 rockets, 0 go-arounds, landed **on the roof** (y −54): `goto: unreachable` | 3 / 2 / 2 rockets, 0 go-arounds, on the ground, walked in |
| pond | 2 rockets, 1 go-around, dry ground | 1 / 1 / 1 rocket, 0 go-arounds, dry ground (said in chat) |
| fly-walk pit | 2 rockets, 1 go-around | 5 rockets, 4 go-arounds (a 1-cell target on the trench's first step: the level rule below came from it), then 2 rockets, 0 go-arounds |
| fly-walk house | 4 rockets, 2 go-arounds | 3 rockets, 1 go-around; then 1 rocket, 0 go-arounds |

Per landing over the walk suites (farm, roof, pond, pit, house), the last round: before 3.4 rockets and 0.8
go-arounds (2 of 5 goals not reached), after 2.6 rockets and 0.2 go-arounds (all reached but the mid-pond
goal). **Level cells**: a walk landing's candidate needs three of its four neighbours at exactly its height
(`ColumnView.level`); the first step of the 1-wide trench (neighbours at −60 and −62) was offered as a 1-cell
target and cost 4 go-arounds.

### Regression (`fly-land`, `fly-roof`, `fly-economy`) and the slide after the settle

`fly-roof` and `fly-economy` passed on the Track BF code. `fly-land` failed twice before the fix below: the
server's slide goes on after the controller's 10-tick settle, 0.6 to 1.0 blocks (the base `8ee3027` the
same: truth 0.62 to 1.06 off after landings reported 0.0 to 0.3 off), and two short straight-in flights
that touched down 0.5 and 0.8 past the centre of the 3x3 slid to its edge: the body stopped at exactly
0.27 over the edge (z 73720.27 in both), the **sneak edge rule holding it** (the server applies it to the
post-landing slide; without sneak that body falls 40 blocks), but outside the test's footprint. Fixes: sneak
stays on after the flight until the horizontal speed is under 0.003 (at most 40 ticks), then is released;
an exact `!fly` landing that ended more than 0.8 from the goal block's centre walks back onto it. After:
`fly-land` 5 of 5 (the 3x3 offs 0.03 to 0.76, 0 damage; the 5x5 at 300 blocks 0.72; the wall 0.11).

### Sneak at the touchdown (`fly-overhang` sneak case)

- **Sneak held while gliding** (40 ticks forced on mid-cruise): the server kept the glide (`isGliding`
  every sample, vy −0.15 steady), 0 corrections: on BDS 1.26.60 strict movement sneak neither ends nor
  changes a glide, and the model (gliding branch first, no sneak effect) agrees.
- **Landings on a 3 x 3 pillar 30 up**, 2 with and 2 without sneak through the touchdown: all on the
  pillar, 0 damage; the slide from the predicted touchdown to the settled position 0.73 / 0.75 without,
  0.74 / 0.76 with sneak; 2 to 5 corrections either way. The slide of a flared touchdown (h about 0.35)
  is under a block and stops on its own, so the edge rule was never reached on the pillar; `fly-land`
  (above) did reach it: the server does apply the sneak edge rule to the slide after a glide (the body
  held 0.27 over a 3x3's edge, no correction). The model applies the edge back-off from the first tick after
  the contact (the glide has ended then). Sneak stays on by default (`flySneakLand`): it costs nothing
  measurable and is the vanilla way to stop at an edge; it is released once the slide has stopped (the walk
  sets its own keys; keeping it on into the walk near an edge is not done).

## Measurements (Track BH, bds-fly, BDS 1.26.60.6)

### `fly-glide-down`

There were five green runs of 5 cases each: two before the merges of main, one after Track BI, and two
after BG2 and ADR 0051. The table gives typical values; they varied little between runs.

| Case | Result |
|---|---|
| pillar (bedrock 3 x 3, 40 up, goal 60 away, 0 rockets) | walk `no path (exhaustive search, 9 nodes)`; 16 ledges on 9 cells, the simulation took 533 ms and landed 0.4 from the centre in 283 ticks; real flight: landed 0.32 from the centre, 279 ticks, 0 rockets, 3 corrections, gliding 9.2 under the edge after 18 ticks of walk; arrived, 0 damage, 19 s in all |
| ledge (the same pillar, `!fly` 150 away, 64 rockets) | `ledge takeoff (a small platform)`; landed 0.10 from the centre, 2 rockets, 0 go-arounds, 410 ticks, 0 damage, 24 s |
| noreach (bedrock pillar 12 up, goal 150 away, 0 rockets, `longFalls` off) | every ledge's simulation is down 123 to 132 blocks short; the owner hears `fly: no glide down ...: no simulated glide lands there (...)`, then `goto: unreachable (the way down is a 12-block drop (8 HP); long falls are off ...)`; the bot stays on the pillar, 0 damage, 2 s |
| farm (the platform under the box, `!goto` 400 away and 130 lower) | `ledge takeoff (a roof 12 up)`: 32 ledges on 47 cells, the +x edge; landed 0.03 to 0.07 from the centre, 2 rockets, 0 go-arounds, 732 to 860 ticks; arrived, 0 damage, 41 to 48 s |
| prone (teleported into a 1-high gap under persistent leaves) | BDS sets the crawl pose at once (`box height 0.60`); the goto breaks the leaves over the head (one block, 6 ticks), stands up (`box height 1.80`), and with `allowBreak` digs out 3 more leaves; arrived 12 blocks away |

With Track BI's `longFalls` on, the noreach pillar is walked down instead (a 12-block drop, 8 HP), so the
case turns it off.

### Regressions

`fly-land`, `fly-walk`, `fly-overhang` and `fly-roof` passed 15/15 three times: before the merges, after
Track BI (with the landing probes fixed, see below) and after BG2 and ADR 0051.

After merging Track BI, `fly-overhang`'s roof case landed on the roof once, taking 3 fall damage. The
landing probe had confirmed a walk from the roof with a planned 6-block long fall. Landing probes now plan
without long falls (`probePath(..., { noLongFalls: true })`); after that the case passed again.

## Measurements (Track BL)

### Offline (the whole-trip simulator, `fly-terrain.test.ts`)

| trip | before: end, rockets, steered ticks | after: end, rockets, steered ticks |
|---|---|---|
| ridge 100 high at 560..710 of 1200 | `roof` at 566 ticks, 8, 34 | landed, 9, 0 |
| ridge 80 high at 860..1010 of 1200 | landed, 9, 116 | landed, 11, 0 |
| the same ridge 100 unknown until 96 blocks away | `roof`, 8, 34 | landed, 10, 0 |
| the same ridge 100 known only to the cache | `roof`, 8, 34 | landed, 9, 0 |
| tower 90 high at 200 of 300 | landed, 6, 0 | landed, 8, 0 |
| flat 300 / 1200 | 2 / 7 | 2 / 7 |

Dive against circle, ticks to touchdown, 0 hits, 0 go-arounds:

| start | dive | circle |
|---|---|---|
| 100 above, 250 out, 3x3 | 213 | 801 |
| 200 above, 350 out | 292 | 1431 |
| 300 above, 450 out | 372 | 2056 |
| flat 100 above | 251 | 808 |
| flat 300 above | 417 | 2063 |
| 60 above, 100 out | 149 | 471 |

### e2e (`fly-terrain`, bds-fly, each case twice, the final code)

| case | rockets | s | damage | crashes (held / contact notes) |
|---|---|---|---|---|
| wall 80 high, 81 wide, 180 out of 300, built after the takeoff | 3, 3 | 19, 22 | 0, 0 | 0, 0 |
| tower 9x9, 100 high, 220 out of 300 | 8, 9 | 50, 49 | 0, 0 | 0, 0 |
| mountain profile up to 100 high, 300..420 out of 700 | 8, 9 | 32, 55 | 0, 0 | 0, 0 |
| dive from a 3x3 platform 100 up, 250 out | 1, 1 | 42, 42 | 0, 0 | 0, 0 |
| circle, the same | 1, 1 | 40, 40 | 0, 0 | 0, 0 |
| dive from a 3x3 platform 200 up, 350 out | 1, 1 | 71, 74 | 0, 0 | 0, 0 |
| circle, the same | 1, 1 | 74, 72 | 0, 0 | 0, 0 |

- **Dive timing.** In the final run the "dive" rows fell back to the circle (see Open points). Two earlier
  runs that did dive from 100 up landed in 15 to 17 s, against 40 to 49 s for the circle, with 1 to 2
  rockets and 0 damage. In `fly-descent` (60 above, 100 out) the open platform dives 10 of 10 (9 to 11 s,
  every landing on the platform, 0 damage). The walled platform keeps the circle 10 of 10 (23 s, 0 damage).
- **site** (2 of 2). The roof is 91 x 86, 3 up; the only open sky is 27 or more blocks behind the start.
  The owner hears `walking 28 blocks to take off from X -60 Z, then flying (400 blocks; ...)`. The search
  took 83 to 90 ms (289 cells, 1 takeoff simulated, 1 walk probed). The takeoff went away from the goal
  (heading 90 off), turned back, and arrived with 2 rockets and 0 damage.
- **nosite** (2 of 2). Roof 121 x 121: `0 open-sky cells within 48`. The fallback walk-out legs ran, then
  the flight, then the arrival, 0 damage.
- **recheck** (2 of 2). The walk started with 2 rockets; 64 were given after 6 s. The log says
  `fly: the walk to ... stopped at ... for a flight (the flight kit is ready)`, then the flight and the
  arrival, 0 damage.
- **Regressions:** `fly-land` 5/5, `fly-walk` 2/2, `fly-overhang` 5/5, `fly-roof` 3/3, `fly-glide-down`
  5/5, `fly-economy` 3/3 (300 / 600 / 1200: 2 / 5 / 8 rockets), `fly-descent` 2/2 (20 landings).
- **Changed expectations.** `fly-roof` now accepts the site line, because the room's door and the
  tunnel's stair top are found as takeoff sites (`walking 16 / 23 blocks to take off from ...`).
  `fly-descent` accepts a dive on the open platform.

## Open points

- Track BL: a column that stays unknown until the body reaches it (a server that never sends the chunk)
  is assumed only 24 blocks over the highest known top. A taller mountain there is met by `steerClear` and
  logged as a held / contact note.
- Track BL: no lateral dodge round a single tower; the detour heading only when no climb clears in time.
- Track BL: the walk re-check covers `!goto` and `!come`, not `follow`. The takeoff-site search runs only
  when the takeoff here is refused, not for every walk over `flyMin`. The walk-out legs (the fallback) still
  stop and start every `flyRetryBlocks`.
- Track BL: the dive from a 3x3 platform 100 / 200 up in `fly-terrain` engaged in earlier runs but fell
  back to the circle in the final one. The flights start with the target held (its ground not loaded), and
  after the retarget the 200-up flight never logged a dive attempt. Not analysed further; the fallback is
  the safe circle (0 damage).
- Track BL: `flyHighCruise auto` is conservative
 (offline the high cruise cost 2 to 3 times the rockets).
  Whether the Realm's chunk-edge holds go away at y 328 is not measured.


- Track BH: there is no crawl move. A prone body under blocks it may not break stays where it is and asks
  for help. Digging out of a gap uses `allowBreak` for one walk, under the navigator's break rules.
- Track BH: a glide down is tried only when the walk finds no way. When Track BI's long falls make a
  hurting drop walkable, the walk takes the drop (8 HP for 12 blocks) even with an elytra on.
- Track BH: during a glide with 0 rockets the low-supply line (`fireworks low: 0 rockets left ...`) still
  goes out once, although the glide needed none.
- Track BH: the pose log says `prone` while gliding (BDS gives the gliding body a 0.6 box). `state.prone`
  ignores gliding, but the log line is noise.

- Track BF: since Track BG the replica's hatch is a closed trapdoor lying on the platform over the ladder
  (the planner opens it and closes it behind; `FLY_BF_TRAPDOOR=0` gives a bare hole). The owner's farm has
  the hatch in the floor layer with the ladder ending under it: BG plans that one down only, which is the
  direction the landing's probe needs.
- Track BF: the farm's corridor approach sometimes enters low and slow after the descent circle (1 of the
  3 complete farm runs: `go-around 1: no landing plan for 18 ticks (best: short, ...) at 45 blocks out, -2
  above, 0.60 blocks a tick`).
- Track BF: a mid-pond goal is not reached by the walk after the landing (a 15-block swim: `limited` probes,
  `goto: unreachable`).
- Track BF: the Realm flight at 00:07Z that ended `roof` at a cruise of y 294 to 305 with 99 steered ticks
  is not analysed here.

- Mending by XP: a repair chore for the elytra (an XP source, `xp_orb` pickups) is a separate track;
  until then the owner is asked to mend or replace it.
- The End: a glide there is never started (the void rule of docs/nether.md); the planner has no
  "void below" notion beyond the ground height of the target.
- Riding the wind, weather: no model; the server's movement has none either.
- The Nether ceiling check only sees loaded columns (and walks when more than an eighth are unknown).
- A wall right in the straight line is avoided by a go-around, never by a lateral dodge; a go-around
  costs about 150 ticks and sometimes a rocket.
- Track BH: the ledge takeoff (above) is sought only when the jump takeoff is refused or the start is
  a small platform; a wide plateau with an open sky still jumps even if a cliff edge is nearer the target.
- The stop landing from a platform flight's cruise takes 11 to 14 s (the physics: a zero-damage
  descent sinks at most 0.2 blocks a tick); from a ground flight's cruise about 7 s. Since Track AU2
  the cruise of a long flight is higher (what the glide needs, up to `flyMaxClimb`), so a stop early
  in such a flight comes down from higher: the circle sinks 0.15 to 0.2 a tick (100 blocks = 25 to
  33 s).
- Track AU2: the rockets are quantised (a climb rocket 16 to 31 blocks), so a flight often arrives a
  rocket's worth high and spends 5 to 10 s in the descent circle; a rocket pitched for a smaller gain
  costs the same rocket, so the time is the cheaper price. The sky check sees only the world model
  (loaded cells, unknown = roof): on a server with a short view distance a far cruise height may be
  above the loaded subchunks and refuse a takeoff in the open; `flyTakeoffRun` and the message say
  where. The S-turns are the offline fallback only: no e2e has needed them yet (a circle farther out
  fitted every walled case). `landingNear` ranks by a probe plan only when the goal's chunk is loaded;
  for a far goal the straight distance (plus 3 per block of height) decides.
