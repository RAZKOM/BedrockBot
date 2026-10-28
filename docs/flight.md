# Elytra flight (wave 11, Track AU)

`!fly <x y z> | <waypoint> | <player> | home`, `!fly stop`, `!land`, and the automatic flight of
`!come` / `!goto` over `flyMin` blocks: the bot puts on its elytra, takes off from flat ground with a
firework rocket, climbs to a cruise height clear of everything under its line, glides in and lands
on the target block with a flare (the design target: the 3x3 platform of a creeper farm 40 blocks up,
within a block of its centre, no damage), then puts the chestplate back on. The flight model only
does what a vanilla client can do (yaw, pitch, the jump key, the glide request, a rocket in the
hand); the server stays authoritative. Decision record: [decisions/0042-elytra-flight.md](decisions/0042-elytra-flight.md).
Container: `bds-fly` (udp/19204, FLAT, peaceful, fall damage ON; `node scripts/bds.mjs --profile fly up|pack`).

## Files

| Path | What |
|---|---|
| `bot/src/skills/input/physics.ts` | `GLIDE`, `glideVelocity` (the vanilla fall-flying formula, float32), `stepGliding`, the `gliding` branch of `stepBody` |
| `bot/src/skills/input/flags.ts`, `inputLoop.ts`, `types.ts` | `start_gliding` with a jump press (`GLIDE_START_FLAGS`), `stop_gliding`; `cmd.glide`, `boostStart`; the own `gliding` actor flag (`GlideEvent`), `boost()` / `endBoost()`, `canGlide` |
| `bot/src/skills/fly/plan.ts` | the geometry (`cruiseHeight`, `columnsAlong`, the yaw law), the approach profile and its simulation, `touchdownCost`, the `ApproachPlanner`, `approachHopeless` |
| `bot/src/skills/fly/brain.ts` | `FlightBrain`: the per-tick state machine (takeoff, climb, cruise, approach, go-around, land) |
| `bot/src/skills/fly/controller.ts` | `FlightController`: the brain on the InputLoop, the rocket use, the rocket entity, the server-confirmed landing, `skyQuery` |
| `bot/src/skills/fly/kit.ts`, `kitops.ts` | the flight kit (`readKit`, `kitReady`, the lines, `SupplyWatch`) and its ground work (the elytra swap, rockets to the hotbar, the refill from the box) |
| `bot/src/tasks/process/fly.ts` | `FlyProcess` (user, 40) and `FlightProcess` (auto, 101: control in the air) |
| `bot/src/chat/commands-fly.ts` | `!fly`, `!land`, the autoFly hooks on `pve.walk` / `pve.come`, the status line, `flyControlOf` |
| `bot/src/tasks/mobility.ts` | `canGlide` for the loop (the elytra in the chest slot) |
| `bot/src/skills/survival/{keeper,armour}.ts`, `container/stash.ts`, `home/{unloader,logistics}.ts`, `chat/commands-survival.ts` | the kit rules (never dropped, stashed, unloaded; `!drop all` keeps it; the armour pass leaves a worn elytra alone; `ArmourController.wear`) |
| `bot/src/config/settings.ts` | `autoFly`, `flyMin`, `flyClearance`, `flyCruise`, `flyGoArounds`, `fireworksMin` |
| `bot/src/nl/{plan,prompt,executor}.ts` | the `fly` step ("fly to me", "fly home", "land") |
| `bot/src/health/panel/*` | the `flight` line of the statuses (`gliding, 23 rockets`) |
| `packs/truth/src/fly.ts` | `truth:glide`, `glidelog`, `equip`, `boxdrop` |
| `bot/test/unit/skills/fly.test.ts` | the geometry, the planner, whole trips on `stepBody`, the kit rules, the supply lines |
| `bot/test/e2e/fly-truth.ts`, `fly-glide.test.ts`, `fly-land.test.ts`, `fly-kit.test.ts` | the e2e suites on bds-fly |
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

## The controller

Phases of `FlightBrain` (one tick in, the controls out; `FlightController` applies them to the loop):

| Phase | What |
|---|---|
| takeoff | on the ground: jump; falling: the glide request (`start_gliding` with the jump press goes out); the server's `gliding` flag confirms; 120 ticks without a confirmed glide end the flight (`no_glide`) |
| climb | rockets back to back at the climb pitch until the body's momentum reaches the cruise height (`cruiseHeight`: `flyClearance` above the highest known column under the straight line, unknown columns as the highest known, at least `APPROACH_HEIGHT` + 2 above the target, at most what the glide down needs with the climb's own run taken off) |
| cruise | level towards the target; a rocket when the height falls more than 7 under the wanted slope (the approach entry 10 above the target at 56 blocks, rising 0.12 per block beyond); a dive when too high (steeper the higher, never over 1.7 blocks a tick); the speed bleed before the approach; far too high (22 above the entry) within 116 blocks: a spiral (12 degrees of yaw a tick) down to 10 above |
| approach | within 56 blocks (earlier when high): the `ApproachPlanner` every tick |
| go-around | no landing plan for 6 ticks within 45 blocks, or a hard one near (cost over 35 within 14 blocks, over 70 within 30): a climbing turn away (one rocket when under the entry height), out to 68 blocks and low enough, back in, a new approach; at most `flyGoArounds` (4), then the nearest safe ground |
| land | the emergency: `!fly stop`, `!land`, `!stop`, health under `fleeHealth`, the elytra at `toolWearLimit` + 20 uses; the nearest safe column ahead (a plain top, no lava / water / cactus / magma / fire, no 1-wide column, 10 to 60 blocks), a spiral down when far above it, then the same landing |
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
  server's `inventory_slot`);
- the refill: fewer than `fireworksMin` (16) rockets in the hotbar and some in the box: the box is
  placed next to the bot (`boxSpots`), opened, rockets are taken until the hotbar holds a stack,
  closed, broken (the Digger) and picked up again; before a flight and after a landing, never in the
  air;
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
| `flyCruise` | 25 | the cruise height above the higher end (capped by what the glide down needs) |
| `flyGoArounds` | 4 | approaches flown again after a miss |
| `fireworksMin` | 16 | the refill and the low-supply line |

## Processes

`flight` (auto, priority 101) wants control from the takeoff until the body stands: flee (100), defend,
the night retreat and every command wait for the landing. `fly` (user, 40) does the ground work and
is cancelled and resumed like any command; `!stop` stops it (the flight still lands; the chestplate
then stays off), `!fly stop` and `!land` land and let the trip finish. `!come` and `!goto` wrap
`pve.come` / `pve.walk`: a flight to the target block (half 1 for a block, 2 for a player or home), then
the walk for the last metres.

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

## Open points

- Mending by XP: a repair chore for the elytra (an XP source, `xp_orb` pickups) is a separate track;
  until then the owner is asked to mend or replace it.
- The End: a glide there is never started (the void rule of docs/nether.md); the planner has no
  "void below" notion beyond the ground height of the target.
- Riding the wind, weather: no model; the server's movement has none either.
- The Nether ceiling check only sees loaded columns (and walks when more than an eighth are unknown).
- A wall right in the straight line is avoided by a go-around, never by a lateral dodge; a go-around
  costs about 150 ticks and sometimes a rocket.
- The takeoff always jumps; a glide started by stepping off a ledge is handled (the fall is the
  takeoff) but not sought.
- The stop landing from a platform flight's cruise takes 11 to 14 s (the physics: a zero-damage
  descent sinks at most 0.2 blocks a tick); from a ground flight's cruise about 7 s.
