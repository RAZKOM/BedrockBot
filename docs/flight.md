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
| `packs/truth/src/course.ts`, `course-layout.ts` | Track F4a: `truth:course` build, clear and list (the obstacle courses); the layouts as pure data, shared with `route/courses.ts` |
| `bot/src/skills/fly/route/courses.ts`, `bench.ts`; `bot/test/unit/skills/fly-course.test.ts`, `bot/test/e2e/fly-course.test.ts` | Track F4a: the obstacle courses offline (`obstacleCourse`, `flyLegs`, `scoreOf`) and on the server |
| `bot/test/unit/skills/fly.test.ts` | the geometry, the planner, whole trips on `stepBody` (the economy, the tree, the roof, the walled platform), the kit rules, the supply lines |
| `bot/test/e2e/fly-truth.ts`, `fly-glide.test.ts`, `fly-land.test.ts`, `fly-kit.test.ts` | the e2e suites on bds-fly (Track AU) |
| `bot/test/e2e/fly-envelope*.ts`, `bot/test/unit/skills/flight-envelope.test.ts` | Track F0: the flight-envelope harness and its cases, the model changes it led to ([flight-envelope.md](flight-envelope.md)) |
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
| `bot/src/skills/fly/maneuvers.ts` | Track F1: the manoeuvre library (`Maneuver`, `runManeuver`, `runChain`, the swept cells), the turn geometry (`turnRate`, `turnOffsetFor`, `turnRadius`), the station keeping (`keepYaw`), the stubs |
| `bot/src/skills/fly/brake.ts` | Track F1: the brake / elevator landing family (`BRAKE_FAMILY`, `simulateBrake`, `brakeControl`, `BrakePlanner`); its K and the whole landing as library manoeuvres (`settleOnto`, `brakeApproach`) |
| `bot/src/skills/fly/maneuvers-route.ts` | Track F1: the library as Track F2 route-planner edges (`asRoute`, `settleRoute`, `approachRoute`, `routeLibrary`) |
| `bot/test/unit/skills/fly-maneuvers.test.ts`, `fly-maneuvers-route.test.ts`, `fly-brake.test.ts`, `fly-worlds.ts`; `bot/test/e2e/fly-maneuver.test.ts` | Track F1: every manoeuvre on stepBody against the model; the route edges flown as F2 flies them; the brake family, the precision goals, the pillar / shaft / roof / wall / farm trips, the go-around shortening, the flare regression; the e2e pillar / roof3 / roof4 / shaft2 / shaft1 / wall / farm cases |
| `docker/compose.fly.yml` | `bds-fly` |
| `bot/src/skills/fly/route/types.ts` | Track F2: the route problem (`RouteState` with the boost range, `RouteControl`, `RouteGoal`, the `Maneuver` plug, `RouteEdge`, `RoutePlan`, the costs) |
| `bot/src/skills/fly/route/grid.ts`, `primitives.ts`, `search.ts`, `robust.ts` | Track F2: the grid and the swept box (`sweep`), the manoeuvre library and `edgeOf` (the burn branches, `replay`), the hybrid A* (`planRoute`, `heuristic`, `energyHeight`), the burn check (`checkRobust`) |
| `bot/src/skills/fly/route/tracker.ts`, `worker.ts`, `live.ts` | Track F2: the per-tick tracker (`RouteTracker`), the search in a worker thread (`RoutePlannerClient`, `snapshotFor`), the tracker on the InputLoop (`flyRoute`) |
| `bot/src/skills/fly/route/courses.ts`, `bench.ts` | Track F2: the course generator (`tunnel`, `field`, `standardCourses`, the fills for the truth pack) and the offline harness (`flyCourse`, `benchLine`) |
| `bot/test/unit/skills/fly-route.test.ts`; `bot/test/e2e/fly-route.test.ts` | Track F2: the sweep, the primitives against stepBody, the search, the tracker, the worker, the benchmark set; the e2e tunnels on bds-fly3 |
| `bot/src/skills/fly/route/landing.ts`, `route/takeoff.ts` | Track F3: the route landing (`planLandingRoute`: the entry, the bearings, the `via` hint, the margin of the passage, `RouteHandoff`) and the route takeoff (`exitsFrom`, `planTakeoffRoute`) |
| `bot/src/skills/fly/rocket.ts` | Track F3: `RocketHand`, the rocket plumbing the controller and the route driver share (the item use, the cooldown, the own rockets as a set, the take-back of a use no rocket answered) |
| `bot/src/skills/fly/brain.ts` (`route`, `routeTakeoff`), `landing.ts` (`preciseGoal` with the route, `ROUTE_HEADROOM`), `chat/commands-fly.ts` (`routeTakeoffFor`, the worker client), `tasks/process/fly.ts` | Track F3: the hand-over to the RouteTracker within ROUTE_HANDOVER, the route takeoff as the takeoff phase, the planner in the worker, `flyRoute` |
| `bot/test/unit/skills/fly-route-landing.test.ts`; `bot/test/e2e/fly-route-land.test.ts` | Track F3: the goals with cells, the hint and the weight, the plans and the tracker flights on every case, findLanding with the route, whole trips with the hand-over, the takeoffs; the e2e stacks / holes / shaft / room / pocket on bds-fly3 |
| `bot/src/skills/fly/corridor/coarse-port.ts` | Track F4b: the coarse layer's contract re-exported (`skills/coarse/types.ts`), `CorridorProvider` (what the executor uses of a layer), `StubCorridorProvider` and the builders (`volumeOf`, `portalOf`, `legOf`, `corridorOf`) |
| `bot/src/skills/fly/corridor/cost.ts` | Track F4b: `FlightCost` (the fly mode's `CoarseCost`), `flightSpace`, `tunnelTicks`, `skyTicks` and the calibration constants |
| `bot/src/skills/fly/corridor/stretches.ts` | Track F4b: `splitLeg` (a fly leg into sky / underground stretches), `changeCell` (where a stretch lands for the next), `nextWindow` (an underground window: portal boxes, steps, bend points, the tail rule, the chunk cut), `bendPoints` |
| `bot/src/skills/fly/corridor/drive.ts` | Track F4b: `TrackerChain` (route trackers over a long window, planned in shadow and handed over) and `flyStretch` (the chain on the InputLoop, the rockets through `RocketHand`) |
| `bot/src/skills/fly/corridor/executor.ts`, `registry.ts` | Track F4b: `CorridorExecutor` (plan, follow the legs, marks, re-plans; `UNKNOWN_FLY_MAX`), the task's provider and `corridorWanted` |
| `bot/src/tasks/process/corridor.ts`, `bot/src/chat/commands-corridor.ts`, `chat/commands-fly.ts` | Track F4b: `UnderFlyProcess` (one underground window as a `fly` process), `runCorridorTrip` (the executor's ports), the hand-over in `!fly` |
| `bot/test/unit/skills/fly-corridor.test.ts`, `fly-corridor-world.ts`; `bot/test/e2e/fly-corridor.test.ts` | Track F4b: the costs, the stretches and windows, the chain flown on stepBody, the executor over stub corridors and over the coarse layer's own; the e2e mouth / shaft / blocked / layer / layershaft cases on bds-fly3 |

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
the rocket (flight duration 1) boosts 9 to 21 ticks (Track F0: n 175, mean 15.7; `GLIDE.boostTicks` 15
plans, the input loop boosts until the rocket's removal), pulling the speed towards 1.7 blocks a tick
along the look. The manoeuvres beyond the steady glide: "The flight envelope" below.

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

### The nearest open sky by walking (Track CA)

Before the line's candidates, each leg first asks for the nearest open sky **by path**
(`probeOpenSky`, skills/home/reach.ts: the `surface` goal, 40 000 nodes / 1500 ms, sliced, no digging, no
long falls). An exit 4 or more path blocks away is the leg (`fly: leg 1 to the nearest open sky by walking
x y z (n blocks)`); a nearer one means the bot already stands under the sky, and the line's candidates
follow as before. The owner's case (2026-11-06): at the foot of a diagonal mineshaft whose top is near
home, the line's cell was over the bot's head, so the walk climbed the shaft, walked back out over its old
spot and tried to fly home from there. Now the leg ends at the shaft's top; the next takeoff check finds
home within `flyMin` and walks. Unit test: `test/unit/skills/open-sky-exit.test.ts`.

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
- **Measured on BDS** (Track F0, [flight-envelope.md](flight-envelope.md) section 6): the server starts the
  glide with the look straight up and a rocket climbs 31 to 40 blocks in 41 ticks with no drift, every
  tick as the model has it. The request on the first falling tick after the jump is taken (section 8).
  `!set flyVerticalTakeoff off` still takes it out of the chain.

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

## Manoeuvres (flight v2, Track F1)

ADR [0057](decisions/0057-flight-manoeuvres.md). The flare of Track AU lands on a 3 x 3 platform or open
ground. It touches down at 0.27 to 0.35 blocks a tick, and the server slides the body 0.6 to 0.8 further.
It cannot land on a block-wide cell. Track F1 adds three things:

- a library of manoeuvres, each a pure control law that a planner can roll out on the model and check
  against the world;
- a second landing family built from them, the **brake / elevator landing**: stop over the cell, keep
  station, sink straight down;
- the **precision goals** it makes landable: a 1 x 1 pillar top, a shaft floor, a cell under a roof 3
  above, a cell before a wall.

### One rollout, one profile search

`plan.ts glideRollout(body, yaw, pitch, ticks, law, check)` is the one formula-level tick loop of the
planners. Each tick the law gives the look (`{ yaw, pitch, fire?, done? }`). A rocket gives `GLIDE.boostTicks`
of boost from that tick on, like stepBody's `boostStart`. `glideVelocity` then moves the body, and the
checker sees the tick's move (`{ t, pos, next, vel, yaw, pitch, boosting }`). A value from the checker
ends the rollout. These run on it:

- `pathAhead`;
- the flare profiles (`simulateProfile` with `touchdownCheck`);
- the dive (`simulateDive`);
- the brake landing;
- every manoeuvre.

A deterministic fingerprint of eight whole trips, three dive plans, the path ahead and one profile is the
same before and after the refactor.

`ProfilePlanner<P, S>` is the profile search: random samples across the ranges and around the plan, a hill
climb, the phase kept. It runs a `ProfileFamily`:

- the parameters, their ranges and steps;
- the free set per phase;
- the samples per tick;
- the simulation and the control law.

`FLARE_FAMILY` is Track AU's profile, and `ApproachPlanner` is that family on the search. `BRAKE_FAMILY` is
in brake.ts.

### The library (`fly/maneuvers.ts`)

A `Maneuver<P>` has:

- `entry(state, p)`: why it cannot start, or nothing;
- `law(state, p)`: a fresh closure that gives the look each tick and `done` at its exit;
- `maxTicks(p)`;
- a `status`: `measured` (flown on bds-fly), `model` (the formula only) or `stub`.

`runManeuver(m, p, state, { obstacle, berth, target, rockets, maxTicks })` rolls it out on `glideRollout`.
It returns a run with:

- `end`: `done`, `landed`, `hit`, `missed`, `timeout` or `refused`;
- `out`, the state handed over;
- `ticks` and `rockets`;
- `swept`, the cells the 0.6-high box overlapped at every tick's end and midpoint, as a set of `cellKey`;
- `touchdown`, `minY`, `maxY` and `moved`.

`runChain` flies manoeuvres one after the other. This is the edge interface for Track F2: state in, then
state out with the swept cells, the ticks and the rockets.

The physics the laws use (the glide formula, docs above "Physics"):

- **The heading follows the look by a tenth a tick** (`v.xz += (l̂·h − v.xz)·0.1`). Looking straight back
  takes a fifth of the speed a tick. Looking 96.4 degrees off turns the velocity fastest: 6.38 degrees a
  tick, for a radius of about 9 times the speed in blocks, at about 10 % of the speed lost a tick. The rate
  at offset θ is `atan2(0.1 sin θ, 0.9 + 0.1 cos θ)` (`turnRate`, inverted by `turnOffsetFor`).
- **The dive term pushes along the look** by a tenth of the sink, 0.015 a tick at the hover's 0.149. Near a
  standstill the look is a thruster. A look flipped by 180 degrees every tick cancels out: the hover sinks
  0.149 a tick at pitch 0 (0.166 at ±10, 0.222 to 0.225 at ±20, 0.339 at 30) and stays put.
- **The pull term (pitch up) lifts along any heading.** At pitch −30, looking back, it pushes the body
  forward and up by `0.04 h sin 30`. This holds the height through a brake.
- **The station-keeping law** (`keepYaw`, gains `KEEP`):
  - The wanted velocity is `kp·error`, capped at `vmax`, and the look points along `wanted − kd·velocity`.
  - Within `band` of the point and nearly still (`still`), the look flips every tick.
  - With kp 0.15, kd 1, vmax 0.3 and band 0.04 it settles from 3 blocks off in about 33 ticks, overshoots
    by about 0.15, then stays within 0.05.
  - While fast the same law is the brake: the look points straight back.

| Manoeuvre | Status | Law | Use |
|---|---|---|---|
| `brake180` | model | the look back along the velocity, the pitch holding the entry height (`holdPitch`: −30 on it, −40 under, towards 0 over) | stop in 3.5 to 5.5 blocks |
| `partialBrake` | model | the look held 100 to 170 degrees off the entry heading to one side | a brake that also moves the stop point sideways (from 140) |
| `hover` | model | station keeping over a point | wait, sink 0.149 a tick in place |
| `creep` | model | station keeping onto a new point, at most `vmax` a tick | the last blocks onto a cell |
| `elevator` | model | station keeping while sinking to a height | down a shaft, onto a pillar, under a roof |
| `snapTurn` | model | the look snapped to a heading under a rocket | a 90-degree turn in 4 ticks |
| `glideTurn` | model | the look offset for a radius at the speed now | a turn without a rocket |
| `zoomClimb` | model | pitch up along the heading until the top of the climb | hop an obstacle without a rocket |
| `flare` | measured | Track AU's segment B | the flare landing's pull-up |
| `spiral` | measured | Track AU2's descent circle | lose height in place |
| `dive` | measured | Track BL's dive, pull, bleed | lose height fast |
| `verticalClimb` | model | pitch −90 on rockets until the coast reaches the top | the vertical takeoff's climb (once the glide has taken: Track F2 measured that a rocket before the server's gliding flag does nothing) |
| `settleOnto` (brake.ts) | measured | the brake landing's K: station keeping over the cell centre, braking at pitchK while fast, sinking at pitchE | onto a cell from up to 16 out (every e2e brake landing flew it) |
| `brakeApproach` (brake.ts) | measured | the brake landing with fixed parameters: A2 towards the cell at pitchA until brakeAt, then K | the whole landing as one law, for the route planner |
| `shortBoost`, `stackedBoost`, `wallKiss`, `rocketBrake` | stub | refuse every entry | see "The stubs" below |

### Characterisation (the model; stepBody in the flat world gives the same end state)

From the state in column 2 (a level glide has vy −0.1, still has vy −0.15). The last column is the distance
between the stepBody flight's end and the model's. The two are one formula: stepBody adds only the
collisions.

| Manoeuvre | From | Ticks | Moved | Height | Speed after | Heading after | Rockets | stepBody vs model |
|---|---|---|---|---|---|---|---|---|
| brake180 (hold) | 1.05 level | 8 | 3.5 | −0.24 | 0.18 (vy −0.05) | 0 | 0 | 0.000 (8 ticks) |
| brake180 pitch 0 | 1.05 level | 7 | 3.0 | −0.83 | 0.16 (vy −0.13) | 0 | 0 | 0.000 (7 ticks) |
| brake180 pitch −20 | 1.05 level | 8 | 3.4 | −0.40 | 0.16 (vy −0.06) | 0 | 0 | 0.000 (8 ticks) |
| brake180 pitch −40 | 1.05 level | 8 | 3.6 | −0.17 | 0.19 (vy −0.05) | 0 | 0 | 0.000 (8 ticks) |
| brake180 (hold) | 1.48 level | 10 | 5.5 | +0.30 | 0.17 (vy 0.00) | 0 | 0 | 0.000 (10 ticks) |
| brake180 pitch 0 | 1.48 level | 8 | 4.5 | −0.96 | 0.18 (vy −0.13) | 0 | 0 | 0.000 (8 ticks) |
| brake180 pitch −20 | 1.48 level | 9 | 5.1 | −0.09 | 0.20 (vy −0.03) | 0 | 0 | 0.000 (9 ticks) |
| brake180 pitch −40 | 1.48 level | 10 | 5.6 | +0.62 | 0.19 (vy 0.02) | 0 | 0 | 0.000 (10 ticks) |
| partialBrake 120 | 1.48 level | 40 | 12.1 | −1.34 | 0.29 (vy −0.15) | 117 | 0 | 0.000 (40 ticks) |
| partialBrake 140 | 1.48 level | 14 | 7.0 | +0.50 | 0.20 (vy −0.03) | 68 | 0 | 0.000 (14 ticks) |
| partialBrake 160 | 1.48 level | 11 | 5.8 | +0.34 | 0.18 (vy −0.01) | 34 | 0 | 0.000 (11 ticks) |
| partialBrake 170 | 1.48 level | 10 | 5.5 | +0.31 | 0.18 (vy −0.00) | 16 | 0 | 0.000 (10 ticks) |
| hover 60 ticks pitch 0 | still | 60 | 0.0 | −8.97 | 0.01 (vy −0.15) | – | 0 | 0.000 (60 ticks) |
| hover 60 ticks pitch 20 | still | 60 | 0.0 | −12.95 | 0.01 (vy −0.23) | – | 0 | 0.000 (60 ticks) |
| hover 60 ticks pitch 30 | still | 60 | 0.0 | −18.53 | 0.01 (vy −0.34) | – | 0 | 0.000 (60 ticks) |
| creep 1 sideways | still | 19 | 0.9 | −2.84 | 0.02 (vy −0.15) | −90 | 0 | 0.000 (19 ticks) |
| creep 3 sideways | still | 32 | 2.9 | −4.79 | 0.01 (vy −0.15) | −90 | 0 | 0.000 (32 ticks) |
| creep 6 sideways | still | 45 | 5.9 | −6.73 | 0.02 (vy −0.15) | −90 | 0 | 0.000 (45 ticks) |
| elevator 10 down pitch 0 | still | 67 | 0.0 | −10.02 | 0.01 (vy −0.15) | – | 0 | 0.000 (67 ticks) |
| elevator 10 down pitch 20 | still | 47 | 0.0 | −10.01 | 0.01 (vy −0.23) | – | 0 | 0.000 (47 ticks) |
| elevator 10 down pitch 30 | still | 35 | 0.0 | −10.10 | 0.01 (vy −0.33) | – | 0 | 0.000 (35 ticks) |
| snapTurn to −45 | 1.48 level | 3 | 4.6 | −0.11 | 1.61 (vy −0.02) | −42 | 1 | 0.000 (3 ticks) |
| snapTurn to −90 | 1.48 level | 4 | 5.4 | −0.13 | 1.58 (vy −0.02) | −88 | 1 | 0.000 (4 ticks) |
| snapTurn to −135 | 1.48 level | 3 | 3.0 | −0.11 | 1.38 (vy −0.02) | −131 | 1 | 0.000 (3 ticks) |
| glideTurn 90, radius 15 | 1.48 level | 20 | 18.7 | −2.65 | 0.87 (vy −0.15) | −90 | 0 | 0.000 (20 ticks) |
| glideTurn 90, radius 20 | 1.48 level | 24 | 25.0 | −3.24 | 0.99 (vy −0.15) | −89 | 0 | 0.000 (24 ticks) |
| glideTurn 90, radius 40 | 1.48 level | 43 | 50.9 | −6.06 | 1.22 (vy −0.15) | −89 | 0 | 0.000 (43 ticks) |
| zoomClimb −30 | 1.0 level | 38 | 23.5 | +4.65 | 0.35 (vy 0.04) | 0 | 0 | 0.000 (38 ticks) |
| zoomClimb −45 | 1.0 level | 30 | 18.3 | +4.13 | 0.35 (vy 0.05) | 0 | 0 | 0.000 (30 ticks) |
| zoomClimb −60 | 1.0 level | 26 | 15.7 | +2.66 | 0.34 (vy −0.02) | 0 | 0 | 0.000 (26 ticks) |
| zoomClimb −30 | 1.48 level | 52 | 40.2 | +22.33 | 0.34 (vy 0.28) | 0 | 0 | 0.000 (52 ticks) |
| zoomClimb −45 | 1.48 level | 41 | 31.4 | +21.12 | 0.34 (vy 0.38) | 0 | 0 | 0.000 (41 ticks) |
| zoomClimb −60 | 1.48 level | 35 | 26.8 | +18.00 | 0.34 (vy 0.36) | 0 | 0 | 0.000 (35 ticks) |
| flare −60 | 1.05 level | 27 | 16.8 | +3.81 | 0.34 (vy 0.02) | 0 | 0 | 0.000 (27 ticks) |
| spiral r12, 20 down | 1.0 | 102 | 24.4 | −20.09 | 0.70 (vy −0.16) | 5 | 0 | 0.000 (102 ticks) |
| dive 75 / pull −30 from 250 up | 1.2 | 126 | 154.2 | −124.95 | 1.05 (vy −0.03) | 0 | 0 | 0.000 (126 ticks) |
| verticalClimb 30 | still, pitch −90 | 23 | 0.0 | +30.54 | 0.00 (vy 0.74) | – | 1 | 0.000 (23 ticks) |

Notes on the table:

- The glide turn's radius comes out about 0.9 times the radius asked: the dive term turns the velocity
  too, and the speed decays in the turn.
- The radius asked must be at least about 9 times the speed; under that the turn runs at the rate cap.
- partialBrake at 100 to 120 degrees off is a turn, not a brake: the speed stays over 0.2 for its 40 ticks.
- These are the formula's numbers. On bds-fly2 the brake, the station keeping and the elevator flew the
  e2e landings below with 1 to 7 corrections a flight.

### The brake / elevator landing (`fly/brake.ts`)

| Segment | Law | Parameters (range, step) |
|---|---|---|
| A1 | the approach yaw law, `pitchA1` for `ticksA1` ticks | pitchA1 −30 to 45 (5), ticksA1 0 to 40 (4) |
| A2 | the approach yaw law, `pitchA2` until `brakeAt` from the cell centre | pitchA2 −30 to 45 (5), brakeAt 2 to 16 (1) |
| K | `keepYaw` over the cell centre: the brake at `pitchK` while faster than 0.35 a tick (`BRAKE_FAST`), then the hover / creep / elevator at `pitchE` until the feet touch the cell | pitchK −45 to 0 (5), pitchE 0 to 30 (10) |

How the brake family plans and is costed:

- **The simulation.** `simulateBrake` runs the profile on `glideRollout`, up to 400 ticks, with
  `touchdownCheck` minus the overshoot test (the brake comes back to the cell). In K the body is short as
  soon as it is under the cell's top beside it; in A, at 2 under the top, which no brake climbs back from.
- **The cost.** `touchdownCost` has one change for a precision cell (`precise`, or a target a block wide):
  the server's slide counts in proportion to the speed (`SERVER_SLIDE · h / 0.33`). A flared touchdown on a
  1 x 1 top costs about 6 more than a nearly still one.
- **The samples.** A runs 60 wide samples (20 once a soft plan exists), 24 near ones and 2 hill-climb
  rounds. In K only `pitchK` and `pitchE` are free: 12 (4), 6 and 2.
- **The CPU.** Offline it runs about 33 simulations a tick, about 0.5 ms a tick on average and 11 ms at most.

The brain (`landStyle`, the setting `flyLandStyle`) chooses the family:

- `flare` and `brake` plan only their own family.
- `auto` (the default) plans the flare. It plans the brake as well in two cases:
  - on a precision cell;
  - while the flare is missing: `BRAKE_RESCUE` (3) ticks without a landing plan, or a plan over
    `BRAKE_RESCUE_COST` (35) within 30 blocks.
- The brake is flown when its cost plus `BRAKE_BIAS` (4) is under the flare's. Changing the family being
  flown takes `BRAKE_SWITCH` (2) more.
- The family is committed once the flare's pull-up (B) or the brake's K begins, but only to a plan that
  lands. A flare pulling up into an overshoot may still become a brake.
- The plan not flown is reset when it would have committed itself.
- The go-around decision uses the better of the two (the fewer missing ticks).
- On a plain platform the brake is never planned unless the flare misses. `auto` then flies exactly the flare
  of before: the same ticks, rockets and touchdown on four whole trips (a unit test).

The brain flies the brake's yaw (`ApproachChoice.yaw`), since the family has its own yaw law. The stats
and the `flight: landed` log line carry the family (`landing brake (53 ticks braked / station-kept)`), and
the line also counts the brakes that took over from a missing flare (`brakeRescues`).

### Precision goals (`landing.ts preciseGoal`)

An exact goal (`!fly <x y z>`) that is no plain floor (Track BF's `sound` fails, or the roof is lower than
`flyHeadroom`) becomes the target itself. It must pass these checks:

- dry and no hazard;
- `PRECISE_HEADROOM` (3) or more of room. Track F2 measured on bds-fly3 that a gliding body entering a
  2-high bore lands (BDS ends the glide there), so 3 is the least room the brake can fly in;
- a brake simulation (`BrakePlanner`, the world's solids as walls) lands on it: from the approach entry
  along four bearings or, under a roof, along a corridor (`corridorsOf` with the room the roof leaves,
  `corridorLands` with the brake).

The target carries:

- `precise: true`;
- its floor's `cells` (the same height, connected, within 1.5: the four cells of a 2 x 2 shaft);
- for a shaft, its `rim`: the lowest top of the columns around those cells, when each is a wall from the
  floor up and 2 or more high.

`entryTop(target)` (the rim when it is higher than the top) is what the approach entry, the glide line, the
cruise height, the go-around height, the open bearing and the dive are flown over. Only K comes down inside.

Two more uses of the brake in the landing search:

- `stillLandable` re-checks a precision cell for dryness and room only, since `sound` is not asked of it.
- Track BF's walk-landing search, with the style `auto` or `brake`, also counts the overhang cells that
  only the brake's corridor simulation lands on, and marks them precise.

`flyLandStyle flare` keeps the Track BF search unchanged.

### Go-arounds shortened (stop and re-aim)

The case is the fly-walk house: the target is retargeted to the cell before the door wall while the body
circles beyond the house. It arrives 16 above the cell at 29 blocks out, at 0.8 a tick.

- The flare's plans pass over the cell (`over`, cost 128), and after 6 ticks it goes around.
- In `auto` the brake takes over at the third missing tick. It glides in, brakes and sinks the 16 blocks
  onto the cell.

| Seed | flare | auto |
|---|---|---|
| 1 | 1 go-around, 478 ticks, 3 rockets, 0.09 off | 0 go-arounds, 360 ticks, 2 rockets, 0.00 off (brake) |
| 2 | 1 go-around, 475 ticks, 3 rockets, 0.35 off | 0 go-arounds, 367 ticks, 2 rockets, 0.00 off (brake) |

The other go-arounds of the offline suite cannot be rescued. The overhang corridors arrive 3 to 10 under
the floor at 45 blocks out, and the farm 10 under, both at 0.6 to 0.8 a tick. No family lands from there
without a rocket.

On bds-fly2, the regression run of `fly-descent` (`auto`, 3 x 3 platform, the dive from 65 above) had
one rescue: in open run 9 the flare's plans missed after the dive and the brake took over. It landed in
141 ticks with 1 rocket, 0.01 from the centre at a touchdown of 0.01 a tick (`landing brake (33 ticks
braked / station-kept, 1 instead of a go-around)`). The nine flared runs took 141 to 195 ticks and touched
down at 0.31 to 0.35 a tick.

### Offline (whole trips on stepBody, `fly-brake.test.ts`)

From 300 blocks south (the farm from 300 behind the box), the goal through `findLanding`:

| Case | Style | Seed | Off | Touchdown vy / h | Ticks | Rockets | Go-arounds | K ticks |
|---|---|---|---|---|---|---|---|---|
| 1 x 1 pillar 8 high | auto (brake) | 5 / 11 | 0.06 / 0.03 | −0.12 / 0.01, −0.13 / 0.01 | 363 / 368 | 2 / 2 | 0 / 0 | 15 / 14 |
| 2 x 2 shaft 10 deep | auto (brake) | 5 / 11 | 0.01 / 0.01 | −0.20 / 0.01, −0.28 / 0.01 | 394 / 387 | 2 / 2 | 0 / 0 | 65 / 50 |
| 1 x 1 shaft 10 deep | auto (brake) | 5 / 11 | 0.01 / 0.01 | −0.28 / 0.01, −0.28 / 0.01 | 383 / 397 | 2 / 2 | 0 / 0 | 48 / 50 |
| roof 3 above, 20 up | auto (brake) | 5 / 11 | 0.77 / 0.14 (in the 9 cells) | −0.15 / 0.14, −0.24 / 0.30 | 310 / 291 | 3 / 3 | 0 / 0 | 31 / 7 |
| roof 4 above, 20 up | auto (brake) | 5 / 11 | 0.28 / 0.29 | −0.15 / 0.07, −0.15 / 0.07 | 330 / 325 | 3 / 3 | 0 / 0 | 54 / 48 |
| wall 6 behind | brake | 5 / 11 | 0.05 / 0.03 | −0.12 / 0.01, −0.13 / 0.01 | 414 / 418 | 2 / 2 | 0 / 0 | 12 / 15 |
| farm platform under the box | brake | 5 / 11 | on the cells | −0.16 / 0.04, −0.16 / 0.01 | 641 / 653 | 9 / 9 | 1 / 1 | 42 / 50 |

Against the flare on the same goals:

- **The shafts:** 4 go-arounds, then landed off the cell.
- **The pillar:** a touchdown at 0.35 a tick (the server would slide it off).
- **The wall case:** `auto` keeps the flare, since it is a plain floor (0.16 / 0.07 off, h 0.34).
- **The farm:** the flare also goes around once (Track BF's corridor arrives low).

### e2e (`fly-maneuver.test.ts`, bds-fly2, each case twice)

From 150 blocks of each goal, with the goal given exactly (`!fly x y z`). The farm is a `!goto` to the room
under the box, 300 out. The style is `auto` unless the case says `brake`. "Off" is where the bot stood
after the settle, from the cell centre. "Corr." is the server's corrections in the flight. "K" is the
ticks braked and station-kept.

| Case | Run | Style flown | On the cell | Off | Damage | Rockets | Corr. | Ticks | K | Touchdown vy / h | Go-arounds |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 x 1 pillar 8 high | 1 | brake | yes | 0.04 | 0 | 1 | 1 | 185 | 53 | −0.198 / 0.006 | 0 |
| | 2 | brake | yes | 0.04 | 0 | 2 | 3 | 270 | 12 | −0.120 / 0.013 | 0 |
| roof 3 above (20 up) | 1 | brake | yes | 0.02 | 0 | 4 | 3 | 298 | 24 | −0.149 / 0.002 | 1 |
| | 2 | brake | yes | 0.59 | 0 | 4 | 6 | 297 | 7 | −0.188 / 0.302 | 0 |
| roof 4 above (20 up) | 1 | brake | yes | 0.02 | 0 | 2 | 2 | 209 | 19 | −0.142 / 0.010 | 0 |
| | 2 | brake | yes | 0.10 | 0 | 4 | 3 | 317 | 12 | −0.238 / 0.014 | 0 |
| 2 x 2 shaft 10 deep | 1 | brake | yes | 0.04 | 0 | 3 | 4 | 215 | 64 | −0.256 / 0.015 | 0 |
| | 2 | brake | yes | 0.02 | 0 | 2 | 4 | 348 | 53 | −0.254 / 0.012 | 0 |
| 1 x 1 shaft 10 deep | 1 | brake | yes | 0.02 | 0 | 1 | 1 | 229 | 65 | −0.203 / 0.007 | 0 |
| | 2 | brake | yes | 0.03 | 0 | 1 | 1 | 231 | 65 | −0.251 / 0.010 | 0 |
| wall 10 high 6 behind (`brake`) | 1 | brake | yes | 0.04 | 0 | 5 | 4 | 589 | 50 | −0.171 / 0.004 | 1 |
| | 2 | brake | yes | 0.06 | 0 | 2 | 2 | 265 | 17 | −0.141 / 0.022 | 0 |
| farm replica (`brake`) | 1 | brake | yes (the platform) | 0.02 | 0 | 8 | 7 | 477 | 38 | −0.158 / 0.018 | 0 |
| | 2 | brake | yes (the platform) | 0.01 | 0 | 7 | 5 | 515 | 34 | −0.202 / 0.015 | 0 |

Fourteen landings out of fourteen were on the cell, with 0 damage. Thirteen stood within 0.10 of the
centre (the median 0.03 to 0.04). The server accepted the look flipped every tick and the one-tick snaps,
with 1 to 7 corrections a flight.

The exceptions:

- **The roof-3 run 2** (0.59 off) came in along the corridor at 0.30 a tick with 7 ticks of K. It slid
  0.48 (sneaking) and stayed in the floor's cells.
- **The two go-arounds:**
  - roof 3, run 1: `no landing plan for 6 ticks (best: flare over, cost 135, 1.5 from the centre) at 43
    blocks out, 21 above, 1.12 blocks a tick`, the corridor entry too high and fast;
  - wall, run 1: `no landing plan for 6 ticks (best: brake wall, cost 207, 6.7 from the centre) at 11
    blocks out, 5 above, 0.22 blocks a tick`: every brake plan from there ended against the wall, past the
    cell.

  Both landed on the second approach.
- **The farm** case lands on the platform under the box, on the cell that Track BF's search picks (3 from the
  room goal, 70 up), and walks the rest down the ladder.

### The stubs (until Track F0 reports)

| Stub | The idea | What F0 must measure |
|---|---|---|
| `shortBoost` | cut a rocket's burn short by a hotbar slot switch | does BDS end the boost when the rocket leaves the hand (in Java the boost belongs to the rocket entity and survives the switch)? |
| `stackedBoost` | a second rocket before the first one's burn ends | do two boosts add up, or does the second only extend the first? |
| `wallKiss` | touch a wall under the impact-damage threshold as a brake | the threshold speed on BDS (`kinetic` damage). Track F2 measured on bds-fly3 4 to 8 damage a touch at 1.3 to 1.7 a tick and 0 for a slow touch; the threshold between them is still open |
| `rocketBrake` | a rocket fired looking back: stops in 2 to 3 ticks, then reverses | useful only with the short boost |

They refuse every entry (`not available: not measured on the server yet (Track F0)`), so a planner can list
them without flying them.

### The planner's edges (`fly/maneuvers-route.ts`, for Track F2)

Track F2's route planner takes a manoeuvre as an edge through its own interface (route/types.ts
`Maneuver`):

- `applies(s)`: whether the edge may start from this state;
- `control(start, now, i)`: the look and the rocket of tick i;
- `ticks(start)`: at most 40;
- `done(start, now, i)`: the exit, met after tick i.

The planner flies the law itself on its tick-exact `stepState` and sweeps the box through its grid, so an
edge has no world check or outcome estimate of its own. maneuvers-route.ts mirrors that interface
structurally (a scratch type-check against F2's route/types.ts passes) and holds these:

- **`asRoute(m, p, o)`** wraps a library manoeuvre:
  - `p` is the parameters, or a function of the start state that gives them (a turn by an offset from the
    heading);
  - `applies` asks for a glide that has taken (no `glideIn`), `quiet` (no rocket that may burn: boost
    max 0), `rocket` (one in the hand), a further condition, and the manoeuvre's `entry`;
  - the law keeps its memory per start (a zoom remembers it has risen). `done` evaluates the law for the
    next tick and hands that look to the `control` that follows, so the law sees each tick once. A call with
    i = 0 starts it afresh, and two edges from the same start fly the same controls (a unit test).
- **`settleRoute(goal, pitchE)`** is brake.ts `settleOnto`, the brake landing's K as a manoeuvre. It
  brakes over the cell centre, creeps onto it and sinks at pitchE. It applies within 16 of the cell, over
  its top, and the planner chains it edge after edge until the touchdown.
- **`approachRoute(goal, pitchA, brakeAt)`** is brake.ts `brakeApproach`: the whole brake landing with
  fixed parameters (A2 at pitchA, then K), from up to 48 out.
- **`routeLibrary(goals)`** is the edge set:
  - for each landing goal, the settle at pitch 0 and 20 and five approaches: pitch −10 (holds the height
    over a rim), 0 and 10, each braking 4 or 8 out;
  - the brake180 (holding the height, and at pitch 0) and the 4-tick hover. These replace F2's minimal
    `brake180`, `hover` and `settle`;
  - with `extras` (the default): the partial brakes 140 and 160, the powered snaps 45 and 90 (a rocket),
    the glide turns 45 and 90 at radius 20, and the zooms −30 and −45, each to both sides.

  Every edge's family is `maneuver`.

F2's `planRoute` from 24 out at 1.0 a tick, with F2's library and then with its brake / hover / settle
replaced by `routeLibrary` (scratch, offline, margin 0.3):

| Landing | Library | Complete | Ticks | Off | Touchdown vy / h | Nodes | ms |
|---|---|---|---|---|---|---|---|
| flat cell, 6 above (F2's unit test) | F2 | yes | 27 | 0.29 | −0.12 / 0.22 | 8 040 | 73 |
| | F2 + F1 | yes | 44 | 0.01 | −0.14 / 0.006 | 110 | 2 |
| 1 x 1 pillar 8 high, 6 above | F2 | yes | 27 | 0.29 | −0.12 / 0.22 | 9 839 | 65 |
| | F2 + F1 | yes | 44 | 0.01 | −0.14 / 0.006 | 110 | 1 |
| 3 x 3 platform 5 high, 6 above | F2 | yes | 27 | 0.29 | −0.12 / 0.22 | 9 605 | 56 |
| | F2 + F1 | yes | 44 | 0.01 | −0.14 / 0.006 | 110 | 1 |

On the 1 x 1 shaft 10 deep, F2's own `edgeOf` lands the chain `approach-10/4`, settle, settle (margin
0.1, 118 ticks from 3 over the rim, 0.004 off, h 0.008), but `planRoute` finds it with neither library
within 60 000 nodes. The search, not the edges, is what misses there. On the 2 x 2 shaft, a settle at the
goal cell's centre is 0.5 from two walls, so a margin of 0.2 touches them; it needs a landing goal of
several cells or a smaller margin in a shaft.

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
| `flyLandStyle` | auto | Track F1: `flare` lands with the flare only, `brake` with the brake / elevator landing only, `auto` flies the flare and takes the brake for a precision goal (a pillar top, a shaft floor, a cell under a low roof) or when the flare's plans keep missing ("Manoeuvres") |
| `flyRoute` | auto | Track F3: the route planner lands an exact goal the brake refuses (a slot 2 high, a hole, a 1 x 1 shaft, a pocket) and takes off where the ledge, the jump and the vertical takeoff are all refused; `off` keeps the Track F1 search and chain ("Route landings and takeoffs") |
| `flyCorridor` | auto | Track F4b: an `!fly <x y z>` farther than 96 blocks to a covered goal (a cave, a chamber: no open sky over it) follows the coarse layer's corridor when there is one: the cruise to a mouth or a shaft, the bores flown where they are 3 high, the rest walked ("Corridor flight"); `off` flies the cruise only |
| `flyCave` | off | Track F5b: powered flight underground (a corridor's cave stretches, `!fly via` / `!fly route`) in the cave style: every window proven before its takeoff, a stop and a sink when the plan runs out; `off` walks underground as the 2026-11-06 hotfix left it. It killed the bot once: `on` only after it has passed the cave benchmark ("Cave flight") |

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

## The flight envelope (flight v2, Track F0)

What the server does for the manoeuvres of flight v2, measured tick by tick against the model:
[flight-envelope.md](flight-envelope.md) (ADR [0056](decisions/0056-flight-envelope.md)). In short:

- Yaw snaps of any size, the 180 brake (stops in 8 to 10 ticks over 5 blocks), the hover (the look flipped
  every tick: within 0.02 of the spot, sinking 0.15), walls, ceilings, a 1 x 1 hole and the start at pitch
  -90 / +90 all match the model with no correction. The vertical takeoff ("Vertical takeoff" above) is
  measured now: a rocket straight up climbs 31 to 40 blocks in 41 ticks, no drift.
- A rocket boosts 9 to 21 ticks; the input loop boosts until its removal (at most 22) and
  `state.boostTicks` is the expected ticks left. A second rocket extends the boost and pushes no harder.
  A slot switch does not cut it; offhand rockets do nothing.
- Wall damage is 10 x the horizontal speed lost minus 3 (`wallImpactDamage`); the fall distance while
  gliding restarts on every tick with the sink under 0.5 (`glideFallStep`), so a level touchdown is free.
- A glide request on the first airborne tick of a jump is refused (from the second it is taken, also from
  a standing jump while it rises); the loop holds such a request one input, and takes a request the server
  never confirmed back after 10 inputs and asks again. A rocket works from the input after the glide's
  first (the loop boosts nothing before). Under a 2-high ceiling no jump glides (2 airborne inputs).
- Slime, powder snow, cobweb, honey, scaffolding, ladders and vines are not in the glide model (a ladder
  or vine ends the glide and catches the body with no damage).

The harness (`bot/test/e2e/fly-envelope-harness.ts`) flies a scripted per-tick control on bds-fly and
compares each tick with the model: the place to measure a new manoeuvre before a planner relies on it.

## A new trip in the air

A `!goto`, `!come` or `!fly` sent while a flight is in the air takes that flight over instead of
landing first (`takeOver`, commands-fly.ts; `FlyProcess.adopt` / `handOver`, tasks/process/fly.ts):

- the landing for the new goal is found as for any flight (`findLanding`: the goal when it is landable,
  else a confirmed cell near it, held high while its ground is not loaded), and the flight is retargeted
  to it there (`FlightController.retarget`); the cruise height is raised when the new trip needs more
  (never lowered; the cruise's rockets cover the distance). The bot says `flying on to <goal> (N blocks)`.
- the trip that started the flight ends `replaced` without a landing, and its walk after the landing never
  runs. Before this, the old flight landed where it was going and its walk then replaced the new one, so
  the bot ended up where it was first sent.
- the new trip does the ground work after the landing (chestplate, refill) and the walk for the rest.
- the brain refuses a retarget once the approach is within 15 blocks of the touchdown, or while it lands:
  the flight then lands where it was going (`fly: too close to the landing to turn now; landing first,
  then going to <goal>`) and the trip starts again from the ground, flying again when it is worth it.
- `!fly` in the air skips the kit check (a glide with no rockets left can still turn), `!fly stop`, `!land`
  and `!stop` land as before.

## The trips home fly too

`!goto` and `!come` flew by themselves since Track AU, but the trips home the bot makes on its own walked
the whole way (the owner: far from home it walked all the way back). `pve.returnHome` is wrapped like
`pve.walk` (commands-fly.ts): the dawn return, the respawn return, the walk home after a guard fight, a
food job or branch mining go through the same decision (`autoFly`: over `flyMin`, the kit ready, open sky,
a landing near home), and fly as the **home return**: the FlyProcess is named `home`, kind `auto`,
`PRIORITY.home` (20), so `!stop`, a death and a new command drop it exactly as they drop the walk home (in
the air the flight lands; with the mid-air takeover a new command takes the flight over instead). After
the landing the rest is the plain walk home. `ifIdle` returns keep their rule (`busy` while a command
runs, checked again after the landing search). Under a roof, without the kit or for a short trip it walks
as before.

Still walking: the night shelter and the bed (the night process, priority 80, holds control: a flight
there would need its own path inside it), and the walks inside a job (the cook step, herd marks, the
breeding pen, remembered forests, the stash chest, `!bring`): a flight there would have to run inside the
job's own process rather than as a process of its own.

## Route planner (Track F2)

Decision record: [decisions/0058-flight-planner.md](decisions/0058-flight-planner.md). Container: `bds-fly3`
(udp/19212, FLAT, peaceful, fall damage ON, the truth pack; not in `scripts/bds.mjs`; the fly e2e helpers read
`FLY_BDS_PORT=19212 FLY_BDS_CONTAINER=bds-fly3`). The planner that lets the bot fly a random tunnel with
curves and turns and take off out of a tight place: a search over the body's state in the voxel grid with the
glide formula as its edges, a tracker that flies the plan tick by tick, and the benchmark that says what it can
and cannot do. Nothing calls it from a command yet (`flyRoute` is the e2e's entry; the integration is Track F3).

### The problem (`route/types.ts`)

| Piece | What |
|---|---|
| state | feet position, velocity, the look yaw, the boost ticks left as a **range** (`min`, `max`, and the `nom` the plan is simulated with: a rocket burns 12 to 18 ticks, the plan assumes 15, the end is known about 3 ticks late), gliding or standing, rockets in the hand, goals passed |
| controls a tick | yaw, pitch, a rocket; for a takeoff the jump key and the glide request |
| the body | the 0.6 x 0.6 x 0.6 gliding box over the feet (physics.ts GLIDE.height), with a margin round it (`margin`: 0.3 in a 3 x 3 bore, 0.2 in a 2 x 2, 0.12 in a 1-wide one, plan.ts's 0.4 in the open) |
| the grid | the world model's solid cells; **an unknown cell is solid** (the takeoff sky check's rule; the cruise's `skyQuery` does the opposite on purpose) |
| goals | in order: a **waypoint** (pass through a box: the feet inside it at a tick's end or midpoint), a **landing** (touch the cell's top inside it at under 0.3 blocks a tick, vertical and horizontal); a **takeoff** is a start state that stands |
| cost | ticks + 20 per rocket (`ROCKET_COST`) + the risk: per tick, 1 minus the box's clearance over 1 block (`RISK_COST` 0.5 a tick at the wall) |

### The swept box (`route/grid.ts`)

A tick moves the box up to 2.5 blocks, more than a cell, and `moveBody` moves it along **y, then x, then z**.
`sweep` samples the box every quarter block along those three legs (the corners included) against the solid
cells of the move's hull: a hit when a cell is within the margin of any sample, else the least distance (the
risk). Two things the straight line misses: a body climbing a 45-degree stair rises into the step's ceiling
before it goes forward (the first staircase run hit with the tracker 0.00 off its plan, before the order was
copied), and a fast diagonal move in a 2-wide diagonal bore collides on the axis path although the line is
clear (the per-axis order is why random 2 x 2 tunnels are at the edge of what the body can do at all). The
first version swept the hull of the two end boxes: it failed every curved bore on the hull's corners.

### The search (`route/search.ts`, `route/primitives.ts`)

Hybrid A*: the state is continuous, the closed set lives on a lattice (half-block cells, 15-degree heading
buckets, speed buckets of 0.25, sink buckets of 0.2, a boost bucket, the rockets, the goals passed). An
expansion flies every primitive of the library from the node's exact state for 3 ticks (`EDGE_TICKS`: the look
lags the velocity by about 2 ticks under a rocket) on `glideVelocity`, sweeping every tick; an edge that hits
is dropped, the rest become children with the cost above. The heuristic: the chained distance through the
remaining goals over the boosted speed (1.7), plus the rockets the climb beyond the body's **energy height**
needs (vy² / 0.08 of momentum plus 11 h² of zoom climb; 45 blocks a rocket; infinite when the hand cannot buy
it, so an unreachable goal is refused at once), and for a landing the ticks to bleed the speed (6 a block a
tick) and to come down at 0.2 a tick. It is a weighted A* (a steep dive beats 1.7 a tick; the bleed is an
estimate): fast, not optimal. Budgets in nodes and ms; when they run out the best partial plan comes back (most
goals passed, then nearest the next), with `why`.

The primitives are a **`Maneuver`** (types.ts): a name and family, `applies(state)`, `control(start, now,
tick)` (yaw, pitch, fire), `ticks(start)` and an optional `done`. `edgeOf` simulates one and takes the swept
boxes, the ticks, the rockets and the clearance from the simulation. The minimal library (temporary, until
Track F1's manoeuvres plug in): steady glides at −20 to 35, coordinated turns (the look held 25 / 50 / 90
degrees off the velocity, level or 15 down), rockets straight at −60 to 20 (−45 is the staircase's), powered
snaps (a rocket with the look snapped 45 / 90 off the heading), the boost held along the velocity, the 180
brake (until under 0.2 a tick), the hover flip, the settle onto a landing cell (the hover held until contact
within 4 blocks of the cell) and the jump takeoff (jump + glide, then a pitch, a rocket on the first gliding
tick or none; under a 2-high ceiling the jump is clipped as moveBody clips it). The library for a state is 30 to
45 edges.

**What F1's manoeuvres must expose to plug in**: the `Maneuver` interface, nothing else: a pure control law
over `(start, now, tick)` returning `{ yaw, pitch, fire }` in absolute Bedrock degrees, `applies` (speed range,
a rocket needed or burning, a standing body), `ticks` (at most 40) and optionally `done`. No side effects, no
own collision check, no own estimate of the outcome: the planner sweeps what the law does. A manoeuvre that
needs the goal (a brake aimed at a cell) is built per request (`libraryFor(families, ticks, takeoffYaws,
goals)`), as `settle` is. The families (`glide`, `turn`, `rocket`, `brake`, `hover`, `takeoff`, `maneuver`)
only serve the benchmark's ablations.

### Robust to the burn (`route/robust.ts`, the burn branches)

From every rocket the search carries two shadow bodies, the burn at its shortest (12) and its longest (18),
stepped with the same controls and swept like the nominal: an edge is only taken when all three clear, until
the shadows have converged back onto the nominal (within 0.3 after the burn). A plan found that way is robust
to the burn by construction; when none exists the search runs once more without the branches (the rest of the
budget) and the plan says `robust: false`. A finished plan is re-flown open loop with every burn end 12..18 of
every rocket, the others nominal, plus all-shortest and all-longest (`checkRobust`: 6 branches a rocket + 2),
and reports whether every branch clears and still passes the goals, and the least clearance. The open-loop
check is the conservative statement: the tracker flies closed loop and corrects most of the drift (the
staircase's plan is "robust NO" open loop and flown without a hit three times out of three).

### The tracker (`route/tracker.ts`)

Every tick the real body (the loop's state; stepBody's in the benchmark) is matched to the plan's reference
state nearest in time (the plan's start counts), and the next control is **re-optimised around the plan's**:
the plan's control and yaw perturbations of ±4 / 8 / 16 and pitch of ±6 / 12 are each flown 8 ticks on the
formula followed by the plan's controls, scored by the weighted distance to the reference path and a hit
penalty, and the best first tick is flown (the landing planner's style). The burn is **read off the body**:
the velocity the last control produced is either the boosted or the plain glide step of the last one (the gain
is 0.5 towards 1.5 along the look), so an early end is known a tick after it, not three, and a burn past the
nominal is seen as it goes on. A new plan is asked for from the real state (the boost range as believed, the
goals left) when the body is a block off the reference (`REPLAN_ERROR`), when the corridor of the next 20 plan
ticks is blocked in the grid (`noteWorldChange`: newly loaded chunks, a changed block; checked every 4 ticks
anyway), when a correction moved the body (`noteCorrection`), when the burn ended before the plan assumed, or
when the plan runs out. The old plan is flown meanwhile (a worker may answer later); with no plan a level glide
along the heading is held; when the planner finds no edge from the body's state (it drifted inside the margin)
the first edges of the next plan keep half the body's real clearance and an **evade** rule flies the control
clear of a hit the longest with no margin while the planner is asked again; 40 ticks without any plan fail.
A passed goal does not end the plan (its goals are its own list); a landing goal is passed when the body stands
on the cell.

### Off the main thread (`route/worker.ts`)

The 0023 pattern: the same file as a `worker_threads` Worker (`workerData.bedrockbotRoute`), one search at a
time; `RoutePlannerClient.plannerOver(grid)` is a tracker planner that snapshots the box around the start and
the goals (padded 24, at most 256 a side; one byte a cell, 1 = solid or unknown; outside = solid) on the main
thread and resolves the plan from the worker. The unit test checks 500 random cells of the snapshot against the
grid and that the worker's plan is the in-thread plan control for control. The in-thread search answers
synchronously (the benchmark, the e2e's 300 ms budget).

### Benchmark (`route/courses.ts`, `route/bench.ts`; the unit test prints the table)

The courses are fully known worlds over the flat ground plus the fill boxes that build them with `truth:fill`
(the hull in stone slabs under 32 768 blocks, the bore in run-length air boxes), so the offline and the server
runs fly the same cells. A tunnel is a centreline of segments (straights, arcs of a radius and angle, sharp
corners, slopes) carved as the bore's cross-section every quarter block (an odd width through cell centres, an
even one along cell boundaries; the band's every cell at any heading); the waypoints are the bore's
cross-section at each segment's end and the exit. The harness flies the course on stepBody with the tracker,
the burn of every rocket drawn at random in 12..18 (seeded) and its end told 3 ticks late, the planner
in-thread with 40 000 nodes / 2 s. Metrics: success (every goal passed by the real body), hits (a collision while
gliding; the speed at the first), the least clearance of the real body from any solid, ticks, rockets, the
plans (re-plans, partial ones, ms), the tracker's largest error from its reference, the first plan's
robustness over the burn branches (open loop).

The standard set, seed 3 (`stair*` from standing; the rest entering at 1.2 blocks a tick with 8 rockets; the
fields at 1.3 with 4):

| Course | Result | Clearance | Ticks | Rockets | First plan | Robust (open loop) |
|---|---|---|---|---|---|---|
| straight 3x3, 40 long | ok, 0 hits | 0.38 | 37 | 1 | 2210 expanded, 391 ms | yes (0.45) |
| straight 2x2 | ok, 0 hits | 0.53 | 37 | 1 | 435, 75 ms | yes (0.55) |
| straight 1x2 (1 wide, 2 high; margin 0.12) | ok, 0 hits | 0.19 | 25 | 0 | 37, 7 ms | (no rocket) |
| curve r16, 90°, 3x3 | ok, 0 hits | 0.31 | 30 | 1 | 2058, 446 ms | NO (0.00; flown 1.11 off at most, re-planned) |
| curve r8, 3x3 | ok, 0 hits | 0.35 | 19 | 1 | 339, 56 ms | yes (0.35) |
| curve r4, 3x3 | ok, 0 hits | 0.62 | 15 | 1 | 132, 22 ms | yes (0.62) |
| curve r8, 2x2 | ok, 0 hits | 0.27 | 27 | 1 | 165, 26 ms | yes (0.27) |
| corner 90°, 3x3 | ok, 0 hits | 0.37 | 14 | 1 | 75, 12 ms | yes (0.37) |
| corner 90°, 2x2 | ok, 0 hits | 0.29 | 26 | 1 | 36, 5 ms | yes (0.29) |
| S-bend 2x2 (r6, 60° each way) | ok, 0 hits | 0.26 | 19 | 1 | 56, 10 ms, partial first | yes (0.26) |
| climb 3x3 (6 up over 20) | ok, 0 hits | 0.34 | 31 | 1 | 129, 23 ms | yes (0.34) |
| drop 3x3 (8 down over 20) | ok, 0 hits | 0.31 | 30 | 1 | 814, 96 ms | yes (0.31) |
| **staircase 45°, 3 high, from standing** (margin 0.15) | ok, 0 hits | 0.16 | 44 | 1 | 479, 82 ms | NO (0.00; flown 0.00 off) |
| staircase 45°, 2 high, from standing | **hit** at 1.48 a tick after goal 1 | 0 | 8 | 1 | 2, partial | NO |
| 1-high slot, 6 long (margin 0.12) | ok, 0 hits | 0.13 | 4 | 0 | 1, 0 ms | |
| 1-high slot, 12 long | ok, 0 hits | 0.12 | 8 | 0 | 3, 1 ms | |
| random 3x3 a (4 segments, seed 11) | ok, 0 hits | 0.30 | 47 | 2 | 3877, 937 ms | yes (0.30) |
| random 3x3 b (seed 12) | ok, 0 hits | 0.38 | 47 | 1 | 6912, 2002 ms (the budget), partial first | yes (0.40) |
| random 2x2 a (curves only, seed 21) | **hit** at 1.30 a tick after goal 3 of 5 | 0 | 21 | 1 | 51, partial | |
| random 2x2 b (seed 22) | ok, 0 hits | 0.21 | 33 | 1 | 50, 11 ms, partial first | yes (0.21) |
| field 1 (18 pillars and slabs in 60 x 24 x 60) | ok, 0 hits | 0.80 | 51 | 1 | 1177, 505 ms, partial first | yes |
| field 2 | ok, 0 hits | 1.00 | 42 | 2 | 1459, 484 ms, partial first | yes |
| field 3 | ok, 0 hits | 0.95 | 44 | 1 | 1743, 590 ms, partial first | yes |

Against the envelope: a 90-degree turn needs a rocket in every bore (the glide turn's radius of 6 to 15 at
a sink of 0.15 a tick does not fit a 3-high bore for 12 to 20 ticks), and the planner finds the powered snap
(radius 1.4 to 3.7) and the boost held level through every curve down to radius 4; the 3-high staircase is
flown as the envelope predicted (a 45-degree climb under boost at pitch −45, about ±0.4 of slack: the margin is
0.15 there), the 2-high one is not (2.2 blocks needed; the jump is clipped to 0.2 by the ceiling and every edge
from there is inside the margin); a 1-high slot is threaded level (the box is 0.6 high, the sink 0.15 a tick:
0.4 of slack lasts under 3 ticks without a boost, and a boost at pitch 0 pulls the sink to 0). The fields' first
plans are partial by the 2 s budget and the flights still arrive: the tracker re-plans from the partial plan's
end. The random 2 x 2 tunnels are at the edge: their diagonal parts allow only slow flight (the per-axis path
above), and a slow glide sinks out of a 2-high bore.

The same courses with the world loading 12 blocks ahead of the body (`view: 12`: unknown is solid beyond,
"chunks" every 4 blocks) are flown with re-plans on the loaded cells (the unit test's straight 3 x 3: ok, 0
hits, re-plans > 0). From a stalled start (the body put into the bore at rest, as the e2e does it): curve r8
3x3, S-bend 2x2 and corner 3x3 ok with 0 hits.

The planning cost: an expansion is 30 to 45 edges of 3 swept ticks, about 0.1 to 0.15 ms; a tunnel's first
plan 5 to 500 ms, a long random 3 x 3 up to the 2 s budget (40 000 nodes); the tracker's tick (35 candidates
over 8 ticks) under a millisecond. The live driver gives the search 300 ms in-thread; the worker takes it off
the tick when the integration wants more.

### On the server (`route/live.ts`, `test/e2e/fly-route.test.ts`)

`flyRoute(deps, { goals, margin, ... })` binds the tracker to the InputLoop for one route: the loop's state is
the body, the control becomes the command (yaw, pitch, the jump key for a takeoff, the glide requested once
the body falls and kept), a rocket is used as the controller does it (the firework's item-use transaction,
`loop.boost()`, the rocket entity's `remove_entity` ending it with `loop.endBoost()` and the tracker's
`rocketEnded`) and only once the loop's `GlideEvent` has confirmed the glide, the loop's corrections go to the
tracker; the search runs in the worker (`planner`) or in-thread. The report: the end (`done`, `ground`, `failed`, `timeout`), ticks,
rockets, the local model's hits, corrections and the largest, the least clearance, the goals reached, the
tracker's stats. The e2e builds a course of the benchmark with the truth pack in the private area (the same
fills), puts the bot in its bore with an elytra on and 16 rockets in the hand, flies it twice and reads the
server's damage from the hurt log and the truth position against the exit. The numbers are under
"Measurements (Track F2)".

## Measurements (Track F2, bds-fly3, BDS 1.26.60.6)

`fly-route` builds three courses of the benchmark with the truth pack and flies each twice with `flyRoute`
(the search in the worker, 600 ms / 40 000 nodes; the local model's glide box margin as the benchmark's).
Seven rounds were needed to get the takeoff and the entry right; the table is run 6 (the last one whose notes
were printed), run 7 on the same code passed the suite's gate 3 of 3; the findings below are what the earlier
rounds measured.

| Course | Start | Run | End | Ticks | Rockets | Local hits | Corrections (max) | Damage (truth) | Plans (re / partial, ms) | Max error |
|---|---|---|---|---|---|---|---|---|---|---|
| tunnel 3x3: straight 10, curve r8 90°, straight 8, corner 90°, straight 10 (open exit) | standing in the bore | 1 | **done** 4/4, at the exit | 39 | 2 | 0 | 0 | 0 | 3 (2 / 0, 82) | 0.23 |
| | | 2 | **done** 4/4, at the exit | 39 | 2 | 1 (a wall touch) | 1 (1.47) | 0 | 5 (4 / 1, 52) | 1.17 |
| S-bend 2x2 (r6, 60° each way), open entrance and exit | gliding 14 blocks before the entrance, 10 up | 1 | ground after goal 1 of 5 | 36 | 1 | 0 | 1 (0.13) | 0 | 3 (2 / 3, 1033) | 4.63 |
| | | 2 | **done** 5/5, at the exit | 51 | 1 | 0 | 2 (0.71) | 0 | 8 (7 / 5, 655) | 3.30 |
| staircase 45°, 3 high (open exit) | standing in the flat section | 1 | done 3/3, at the top | 91 | 3 | 20 | 4 (1.55) | **13.5** (flyIntoWall x2) | 34 (33 / 29, 170) | 2.09 |
| | | 2 | done 3/3, at the top | 48 | 3 | 9 | 2 (2.41) | **8.2** (flyIntoWall x2) | 21 (20 / 19, 21) | 2.17 |

The gate: the tunnel done at the exit with 0 damage in both runs; the staircase done at the top (its damage
recorded, not gated); the S-bend recorded. In run 4 (the search in-thread, the glide requested as the model
does it) the staircase was flown twice with 0 damage and 0 hits, 29 ticks and 1 rocket each; the falling-tick
rule below made the tunnel pass and the staircase scrape: the takeoff plan in its flat 3-high section is now a
partial one (every primitive from the jump's apex hits at the margin of 0.15) and the body climbs the steps on
re-plans every few ticks, touching them. The next step is a takeoff primitive measured by Track F0 on the
server, not a longer guess.

What the rounds measured on the server (the per-tick samples of `truth:glidelog` against the local trace):

- **A glide starts only once the body falls** (superseded: Track F0 measured a standing jump's glide from the
  2nd airborne input, "The flight envelope"; the 7 ticks here were a teleport artefact. Track F3 set the
  planner's GLIDE_DELAY to 1 and the driver asks from the first airborne tick, which the loop holds one
  input). After a jump the server's gliding flag comes 7 ticks later
  (the rise of 6 ticks, then the request on the first falling tick, confirmed the tick after: run 5's trace
  `7:a vy 0.42 ... 13:a vy -0.15, 14:G`); the brain's takeoff requests the glide on a falling tick for the
  same reason. The model's loop glides from the first airborne tick when asked, 6 ticks before the server: a
  correction of 0.89 every takeoff until the driver asked on the falling tick (run 6: 0 corrections in the
  tunnel's first run). The planner's takeoff models those ticks as plain jump physics (`glideIn`, GLIDE_DELAY
  7; 2 for a jump clipped by a ceiling).
- **A rocket used before the server's gliding flag does nothing.** Runs 3 and 4: the plan's rocket on the
  first local gliding tick left the server's body falling back to the floor; the driver holds a use until the
  loop's `GlideEvent` confirmed the glide (`heldFires` in the report), the tracker read the missing boost off
  the velocity a tick later (`burns read`).
- **An in-thread search stalls the loop.** 300 ms of search blocked 6 ticks of input (run 4: a second plan
  right after the jump put the body on the ground); the e2e plans in the worker since run 5. The tracker's
  reference is matched anywhere up to the expected index when a plan arrives late.
- **The local model is stale right after a build.** A plan made on cells the model had not received went
  through stone (run 4, "the corridor ahead is blocked" at once); the e2e waits until every fill of the
  course answers as built in the loop's block query.
- **A gliding body teleported into a 2-high bore lands.** BDS ended the glide on the teleport (run 3) and a
  glide requested 1.6 blocks up never started before the ground (run 4): the S-bend is entered from the open
  air 10 blocks up, 14 before the entrance, and the open-air approach is where the 40 000-node budget runs out
  (the partial first plans of the S-bend rows; a distance field through the bore is the open point).
- **flyIntoWall** at 1.3 to 1.7 blocks a tick through a step's corner costs 4 to 8 damage a touch (the
  staircase rows); the tunnel's one wall touch at low speed cost none. The threshold is Track F0's.

## Route landings and takeoffs (Track F3)

ADR [0064](decisions/0064-route-landings-and-takeoffs.md). The planner of Track F2 in the flight: a cell the
flare and the brake refuse (Track F1 needs 3 of room over a precision goal) is handed to the route planner,
which decides whether an entry path exists and, in flight, flies it; and a takeoff nothing else can make is
searched the same way. The owner's headline case: the inner platform of two 3 x 3 platforms stacked with 2
blocks of air between them. The gliding box is 0.6 high, the body comes in sideways at the slot's height and
brakes over the floor; Track F0 measured that a 2-high bore flown in at pitch -10 keeps the glide and at pitch
0 the box sinks onto the floor, which on a cell is the touchdown (and that no jump glides under such a
ceiling: the way out is the ledge takeoff, as before).

### What is landable now (`landing.ts preciseGoal`, `route/landing.ts`)

An exact goal (`!fly <x y z>`) that is no plain floor is tried as Track F1 tries it: dry and safe, the brake
simulated from above along four bearings or along a corridor. When that fails, or the room over the floor is
only 2 (`ROUTE_HEADROOM`), `planLandingRoute` runs with `flyRoute auto`:

- **The spec**: the floor's cells (the same height, connected, within 1.5; a 3 x 3 platform's nine), the
  top, a shaft's rim, the ceiling.
- **The entry** (`routeEntry`): `ROUTE_ENTRY_OUT` (40) blocks out along a bearing, `ROUTE_ENTRY_UP` (9) over the
  top or the rim, 1.0 a tick heading in: where the cruise's glide line puts the body before an approach
  (APPROACH_HEIGHT over the entry top at the approach distance, sinking 0.1 a block, bled to about 1.05). A
  plan from there is the plan the tracker starts near.
- **The bearings**: the body's side first (`LandingOptions.from`), under a roof the corridors' (`corridorsOf`
  with the room the roof leaves), else every 45 degrees; at most `ROUTE_TRIES` (6).
- **The weights**: each bearing at `ROUTE_WEIGHTS` 2 then 1 (`RouteRequest.weight`: f = g + weight x h). The
  greedy search finds the long landing edges (a 40-tick approach, the settles) in a few hundred nodes where
  the plain A* drowns in the open air over the cell; the plain A* is kept for what the greedy one misses.
- **The margin** (`specMargin`): the passage's narrower side: a 1-wide shaft 0.1, a 2-high slot 0.12, a
  3-high room or a 3-wide pocket 0.2, the open 0.4 (a shaft had been getting the open-air margin and could not
  be entered at all).
- **The goal** (`landingGoalFor`): the cell nearest the floor's centre, the other `cells` (a touchdown in any
  lands; `landsOn`, the tracker's goal check), and the heuristic's **`via`** hint: over the centre at the rim +
  1 for a shaft (the way down at the hover's sink, 0.149 a tick), beside the room's mouth at the slot's height
  for a cell under a low roof (the creep in at 0.4). Without it the heuristic flies straight at a floor it
  cannot reach straight, and the 1 x 1 shaft 10 deep was never found within 60 000 nodes (Track F2's open
  point); with it and the weight the shaft is found in 87 nodes.
- **The library** (`RouteRequest.library: 'landing'`, `search.ts libraryNamed`): Track F2's glides, turns and
  rockets with Track F1's manoeuvres and the brake landing's approaches and settles onto every landing goal
  (`routeLibrary`), built by name so a request crosses to the worker.
- **The answer**: the first complete plan. The target becomes a precision goal (`precise`, its `cells`, its
  `rim`) with `route` (`RouteHandoff`: the bearing, the entry, the goals, the margin, the weight, the plan's
  ticks, rockets, edges and effort) and the bearing as a Track BF corridor (`bearing`, `ceiling`), so the
  cruise comes in along it. The log line: `landing for X: the goal itself (0 93 0, a cell under a roof 2
  above, a route landing in from 180 (65 ticks, 0 rockets; 210 nodes in 5 ms: approach+10/8 hover glide+35
  hover settle; tried 1 bearing))`. `stillLandable` asks `ROUTE_HEADROOM` of such a cell.

The search runs in the planner worker (`RoutePlannerClient`, the 0023 pattern; `commands-fly.ts` owns one per
task over a grid of the live model in which an unknown cell is solid). A landable cell costs tens of
milliseconds; a cell that is not costs up to 6 bearings x 2 weights x 800 ms before the search says so.

### The flight (`brain.ts route`)

The cruise flies as to any corridor target (the corridor entry 64 out along the bearing, the glide line, the
descent geometry). Two things differ for a target with a `route`: no approach of the landing families is ever
started, and within `ROUTE_HANDOVER` (44) on the bearing's side (within 60 degrees of it from the cell) the
brain hands over to a `RouteTracker` (phase `route`) with the planner's edges and the goals of the plan, the
search in the worker (40 000 nodes, 600 ms), a rocket still burning seeded into the tracker's burn range. The
tracker plans from the real state (the entry is where it should be, not where it must be), re-plans as the
body drifts, and the brain passes its controls through, counting its rocket as the landing's. The flight ends
as any other when the body stands; a touchdown in any of the floor's cells is on target. No plan for 40
ticks, or no touchdown in `ROUTE_MAX_TICKS` (400): a go-around, whose way back in hands over again; none
left: the nearest safe ground. On the way in a target under the glide line gets a small top-up at any flying
speed (the tracker dives off a surplus more easily than it climbs out of a deficit), none within 48.

The log: `route landing: handing over to the route tracker 44 out, 9.2 over the cell at 1.02 a tick (planned in
from 180: ...)`, the tracker's `route: start: plan 65 ticks ...` lines, and the finish line's `landing route
(149 ticks on the route tracker, 7 plans, 6 re-plans, max error 0.31)`.

### The route takeoff (`route/takeoff.ts`, `commands-fly.ts takeoffFor`)

The last step of the takeoff chain, after the ledge, the jump on every heading and the vertical takeoff: the
air around the start is flooded (6-connected through the air cells, up to 6 000 cells within 32 blocks) for
the cells under `EXIT_OPEN_SKY` (16) of known air at or above the feet (`exitsFrom`, the nearest by the flood
first), and from standing a plan to a waypoint box 2 to 6 over such a cell is searched (`planTakeoffRoute`: F2's
takeoff primitives, the margin 0.15, weight 2, at most 3 exits). The brain flies it with the tracker as its
takeoff phase (`routeTakeoff`): the jump, the glide requested from the first airborne tick (the loop holds it
one input and asks on the 2nd, which the server takes: Track F0), a rocket from the second gliding tick, then
the climb along the heading towards the target once the exit is passed (or after `ROUTE_TAKEOFF_MAX_TICKS`,
200, or with no plan: the climb's path-ahead check does what it can). Under a 2-high ceiling the planner
refuses at once (`stepState`: a jump clipped to `LOW_CEILING_RISE` never glides), so the owner's inner platform
is left by the ledge takeoff as before (a small platform). The log: `fly: route takeoff: 2696 exits under open
sky; 2 93 0 (2 cells away): 5 ticks, 1 rockets, 2 nodes, 1 ms (takeoffR-20)` and the finish line's `route
takeoff (7 ticks)`.

### Track F0 in the route code

- `BURN` 9 to 21 (the burn branches and the robust check widen with it); `GLIDE_DELAY` 1 (one input of plain
  physics after the jump; was 7 from a teleport artefact); the driver and the benchmark harness request the
  glide from the first airborne tick; the tracker re-issues a rocket the body could not use yet on its first
  gliding tick (`fireLater`); the brain's route takeoff fires from the second gliding tick.
- `rocket.ts RocketHand` (the controller and the route driver share it): the own rockets are a set and the
  boost ends with the last removal, never while a newer use waits for its entity; a use with no entity within
  5 ticks fired nothing and its boost is taken back (`loop.endBoost(ticks since the use)`); the loop's own
  refusal of a glide request is no glide end.
- The stubs `shortBoost` and `stackedBoost` stay refused with F0's measurement in their notes (a slot switch
  does not cut the boost; the boost is the union of the lifetimes).

### Offline (stepBody; `fly-route-landing.test.ts`, the scratch sweeps)

The plans from the entry (40 out, 9 up, 1.0 a tick, the preferred bearing), with weight 2 and the hint, and the
tracker flying them on stepBody from that entry (3 seeds each, the search in-thread 600 ms / 40 000 nodes):

| Case | Margin | Plan | Nodes / ms | Flown (3 seeds) | Ticks | Max error |
|---|---|---|---|---|---|---|
| the stacked platforms, 2 of air (the owner's) | 0.12 | approach+10/8 hover glide+35 hover settle | 210 / 5 | ok, 0 hits | 66 | 0.00 |
| the stacked platforms, 3 of air | 0.2 | approach+10/8 hover glide+35 settle+20 | 108 / 3 | ok, 0 hits | 64 | 0.00 |
| a 1 x 1 hole 2 deep | 0.1 | approach+10/4 settle+20 | 76 / 1 | ok, 0 hits | 78 | 0.00 |
| a 2 x 1 hole 2 deep | 0.1 | approach+10/4 settle glide-20 | 86 / 1 | ok, 0 hits | 83 | 0.00 |
| the 1 x 1 shaft 10 deep | 0.1 | approach+10/4 settle+20 settle | 87 / 1 | ok, 0 hits | 117 | 0.00 |
| a cell under a roof 3 above at ground level (a room open on one side) | 0.2 | glideTurn45L glideTurn90R settle (in from 90, the 3rd bearing) | 1 118 / 13 | ok, 0 hits | 69 | 0.00 |
| a 3 x 3 x 3 pocket in a cliff face 30 high, 10 up | 0.2 | glideTurn45L approach+10/4 settle (in from 135, the 4th bearing) | 610 / 8 | ok, 0 hits | 71 | 0.00 |

What the weight, the hint and the entry did (the same cases from 24 out and 6 up, the first sweep): with
weight 1 and no hint the shaft and the 2-high stack were not found in 40 000 nodes a bearing; with the hint
alone the shaft was still missed at weight 1; with weight 2 and the hint every case but the pocket was found
in 92 to 1 632 nodes, the pocket only at weight 1 (the dive before the turn in: hence `ROUTE_WEIGHTS` 2 then
1); from the lower entry the tracker stalled in the 2-deep holes on the rim (it entered the 1-wide bore 0.2
off its centre); from the 40 / 9 entry everything above flies.

Whole trips of the brain from 300 blocks south onto the goal `findLanding` gives (seeds 5 and 11):

| Case | Landing found | Flown | Off | Touchdown vy / h | Ticks | Rockets | Go-arounds | Route ticks (plans / re-plans, max error) |
|---|---|---|---|---|---|---|---|---|
| the stacked platforms, 2 of air | a route landing in from 180 | ok, on the goal cell, 0 hits | 1.13 | -0.16 / 0.26 | 543 | 5 | 0 | 149 (8 / 7, 0.05) |
| the stacked platforms, 3 of air | Track F1's brake, in from 0 under the roof (the route is not asked) | ok, 0 hits | 0.01 | -0.14 / 0.00 | 492 | 4 | 0 | 0 |
| the room at ground level | Track F1's brake, in from 165 (3 under the roof) | ok, 0 hits | 0.02 / 0.05 | -0.18 / 0.03, -0.11 / 0.33 | 505 / 723 | 4 / 5 | 2 / 4 | 0 |

So the planner is only ever asked for the 2-high slot (and for a hole, a shaft or a pocket when the brake's
simulation fails, which it does not on the model); the room at ground level, Track F1's open point, is landed
by the brake's corridor after 2 to 4 go-arounds (the corridor entry still arrives badly). The hand-over state
is the weak point of the route landing: the cruise arrives a rocket's worth high and the descent circles of a
corridor target leave the body 25.7 over the cell at 0.64 a tick at 44 out, so the tracker's first plans are
partial for a few ticks before it comes down (149 ticks on the tracker against 66 from the planned entry).

The route takeoffs on stepBody (the route found, then flown by the tracker from standing, 3 seeds):

| Case | Exits | Plan | Flown | Ticks | Rockets |
|---|---|---|---|---|---|
| out of the 3-high stack | 2 696 | takeoffR-20 to the cell beside the platform | ok, 0 hits | 7 | 1 |
| out of a 1 x 1 hole 2 deep | 5 167 | takeoff glide+0 rocket-60 | ok, 0 hits | 11 | 1 |
| from under a roof 3 above (the room) | 5 060 | takeoffR-20 out of the open side | ok, 0 hits | 7 | 1 |
| the inner platform of the 2-high stack | 2 705 | none (the jump never glides: F0) | | | |
| the floor of the 1 x 1 shaft | 4 956 | none (the jump's box has no margin in the bore; the vertical takeoff is the way out) | | | |

### Measurements (Track F3, bds-fly3, BDS 1.26.60.6)

`fly-route-land.test.ts`, run 1: from the start on the flat (feet -60), `!fly x y z` onto each truth-built cell
twice (150 to 270 blocks out), then `!fly` back to a cell near the start from inside it (the takeoff out). "how"
is what landed (the finish line): the route tracker, Track F1's brake or the flare; "off" the truth feet from the
cell centre once stood; "route" the ticks on the route tracker; the damage from the hurt log (fall damage on).

| Landing | How | On the cell | Off | Damage | Rockets | Corr. | Ticks | Route | Touchdown vy / h | Go-arounds |
|---|---|---|---|---|---|---|---|---|---|---|
| **stack2 #1** (the owner's: the inner platform under 2 of air) | **route** | yes | 0.05 | 0 | 1 | 1 | 181 | 63 | -0.162 / 0.130 | 0 |
| **stack2 #2** | **route** | yes | 0.41 | 0 | 1 | 1 | 194 | 77 | -0.194 / 0.120 | 0 |
| stack2 out (the takeoff from the inner platform) | ledge takeoff, flare | yes | 0.07 | 0 | 2 | 1 | 327 | | -0.167 / 0.350 | 0 |
| stack3 #1 (3 of air) | flare (F1's corridor landing, in from 0) | yes | 0.11 | 0 | 2 | 1 | 353 | | -0.109 / 0.319 | 0 |
| stack3 #2 | flare | yes | 0.11 | 0 | 3 | 2 | 372 | | -0.095 / 0.343 | 0 |
| stack3 out | ledge takeoff, flare | yes | 0.08 | 0 | 1 | 3 | 395 | | -0.115 / 0.345 | 0 |
| hole1 #1 (1 x 1, 2 deep) | brake (F1) | yes | 0.02 | 0 | 1 | 1 | 301 | | -0.151 / 0.008 | 0 |
| hole1 #2 | brake | yes | 0.02 | 0 | 1 | 1 | 301 | | -0.151 / 0.008 | 0 |
| hole1 out | vertical takeoff (6 up), flare | yes | 0.07 | 0 | 1 | 2 | 306 | | -0.105 / 0.347 | 0 |
| hole2 #1 (2 x 1, 2 deep) | brake | yes | 0.02 | 0 | 1 | 2 | 320 | | -0.177 / 0.007 | 0 |
| hole2 #2 | brake | yes | 0.02 | 0 | 2 | 2 | 268 | | -0.191 / 0.011 | 0 |
| hole2 out | vertical takeoff (6 up), flare | yes | 0.05 | 0 | 1 | 3 | 280 | | -0.103 / 0.339 | 0 |
| shaft1 #1 (1 x 1, 10 deep) | brake | yes | 0.02 | 0 | 1 | 1 | 263 | | -0.174 / 0.010 | 0 |
| shaft1 #2 | brake | yes | 0.04 | 0 | 1 | 2 | 330 | | -0.207 / 0.008 | 0 |
| shaft1 out | vertical takeoff (10 up), flare | yes | 0.12 | 0 | 1 | 1 | 222 | | -0.112 / 0.328 | 0 |
| room3 #1 (under a roof 3 above at ground level) | brake (F1's corridor) | yes | 0.02 | 0 | 2 | 3 | 401 | | -0.206 / 0.136 | 0 |
| room3 #2 | brake | yes | 0.09 | 0 | 2 | 2 | 546 | | -0.169 / 0.016 | 1 |
| room3 out, run 1 | **route takeoff** (out through the open side in 9 ticks, 1 rocket), then `roof` | NO (on the ground 15 out, 0 damage) | | 0 | 1 | 0 | 17 | | | |
| pocket #1 (3 x 3 x 3 in a cliff face, 10 up) | brake | yes | 0.03 | 0 | 2 | 3 | 352 | | -0.316 / 1.001 | 0 |
| pocket #2 | brake | yes | 0.02 | 0 | 2 | 4 | 341 | | -0.158 / 0.013 | 0 |

- **The owner's case lands by the route, twice, with 0 damage**: the brain hands over at 44 out, the tracker
  brings the body down beside the stack and in sideways under the upper platform, the glide ends on the inner
  floor. 1 rocket (the climb), 1 correction, the touchdown 0.12 to 0.13 a tick sideways and 0.16 to 0.19 down.
  The second run stood 0.41 from the centre (the slide after a sideways entry is longer than the brake's).
- **The stack's takeoff is the ledge takeoff** (`a roof 2 up: 16 ledges on 9 cells, heading -180: clear,
  gliding 9.2 under the edge`), as the F0 rule predicts (no jump glides under 2 of ceiling): 0 damage.
- **Everything else is Track F1's**: the holes 2 deep, the shaft, the room at ground level and the pocket are
  landed by the brake family (`preciseGoal` asks it first and it lands), 0.02 to 0.09 off, 0 damage; the holes
  and the shaft are left by the vertical takeoff (6 and 10 up), the room's 3-high ceiling by the route takeoff.
  The pocket's first landing touched down at 1.0 a tick sideways (the brake's K took it only 2 ticks before the
  pocket's back wall) and still stood 0.03 off with 0 damage.
- **The one failure (room3 out, run 1)**: the route takeoff flew out through the open side in 9 ticks and fired
  its rocket on the loop's second gliding tick, which on the server is the input that starts the glide (F0: no
  rocket entity), so the body left the room 2 up at glide speed with no boost; the climb then took over and its
  path-ahead check, from 2 up at pitch 0, "hit" the ground within 20 ticks on every candidate and ended the
  flight `roof` on the ground 15 blocks out (0 damage). Two fixes followed: the first rocket from the third
  gliding tick (`ROUTE_FIRE_GLIDE_TICKS`), and no path-ahead check until the body is 6 over the start after a
  route takeoff (`ROUTE_OUT_ABOVE`, the window the jump takeoff has by being slow).

The room case flown again after the two fixes (runs 2 and 3 of `FLY_F3_ONLY=room3`, both passed; run 3's rows):

| Landing | How | On the cell | Off | Damage | Rockets | Corr. | Ticks | Touchdown vy / h | Go-arounds |
|---|---|---|---|---|---|---|---|---|---|
| room3 #1 | flare (F1's corridor) | yes | 0.05 | 0 | 2 | 4 | 649 | -0.106 / 0.324 | 1 |
| room3 #2 | flare | yes | 0.03 | 0 | 2 | 3 | 413 | -0.246 / 0.350 | 0 |
| **room3 out** | **route takeoff** (`5060 exits under open sky; 67624 -60 63474 (4 cells away): 5 ticks, 1 rockets, 2 nodes, 1 ms (takeoffR-20)`; out through the exit after 10 ticks, 1 rocket, max error 0.57), then the climb to y -20.5, a dive descent, the flare | yes | 0.06 | 0 | 1 | 2 | 277 | -0.107 / 0.322 | 0 |

So the route takeoff is measured once on the server, twice over (runs 2 and 3 of the room case): the ledge
takeoff has no edge on the room's floor, the vertical takeoff's column is open only 2 up, the route planner
finds the way out through the open side in a millisecond and the flight flies it, lands 247 blocks away and
takes 0 damage. The room's own landings are Track F1's corridor landings (the brake in run 1, the flare in
run 3, 0 to 1 go-arounds).

## Obstacle course (Track F4a)

ADR [0067](decisions/0067-long-range-flight.md) "F4a". The permanent flight benchmark: one set of courses, built
the same on the server and offline, flown on one score, so a change to the route code, the tracker or the
brain's hand-over is measured on everything at once. It also closed four open points of Tracks F2 and F3 (the
tunnel regression, the hand-over height, route first or brake first, the room at ground level).

### The courses (`packs/truth/src/course-layout.ts`, `course.ts`; `route/courses.ts`)

A layout is pure data (`courseLayout(name, origin)`): the ops (boxes of air, stone, dirt, grass or gold) that
first clear the course's volume (air from the ground's feet height up, dirt with grass on top under it, so a
rebuild over anything left is the same world) and then build the stations, and the legs to fly: a start (in
the air at a speed and heading, or standing), the goals (boxes to pass, or a landing: the cells, the top, a rim,
a ceiling), the planner's margin, chained or not. The module has no runtime imports, so the pack and the bot
share it: `truth:course build <name> x y z` executes the ops (`fillBlocks` calls of at most 32 768 blocks in a
`runJob`, a ticking area held over each piece while it fills, so nobody stands there) and answers the bounds,
the op and block counts and the legs; `truth:course clear` gives the flat ground back; `truth:course list` the
names. The bot's `route/courses.ts` builds the bench's world from the same ops (`layoutWorld`) and the
`Course` legs from the same legs (`layoutCourses`, `obstacleCourse(name)`); F2's bore geometry (`centreline`,
`carve`, `bore`) moved into the shared module, so the tunnel and the staircase are the cells F2 flew.

| Station | What | Start | Margin |
|---|---|---|---|
| `rings` | five 3 x 3 openings in 1-thick walls, 18 apart, at 7, 12, 6, 14 and 8 over the ground | standing on a 1 x 1 pillar 11 up (`START_UP`), 8 rockets | 0.3 |
| `slalom` | five 3-wide gates 14 apart, alternating 3 left and right of the line | the same | 0.3 |
| `tunnel` | the 3 x 3 S-tunnel (straights and arcs) 8 up, entered from the air | on a pillar 9 up | 0.3 |
| `stair` | the 45-degree staircase 3 high (F2's), out of its top | standing at its foot (a gold block) | 0.15 |
| `overhang` | a landing on a 5 x 5 ledge 8 up against a cliff, under a roof 4 over it | gliding at the route hand-over's entry (40 out, 9 over the floor, 1.0 a tick) | 0.3 |
| `stack` | the owner's stacked platforms: 3 x 3 at y+20 and y+23, the inner one landed through the 2-high slot | the hand-over's entry | 0.12 |
| `shaft` | a landing on the floor of a 1 x 1 shaft 10 deep | the hand-over's entry | 0.1 |
| `full` | climb (a start pad, the stair, the rings), weave (the slalom, the tunnel), ledge (the overhang), finish (from the ledge onto a finish pad), each going on from the last; then stack and shaft from their entries | the stations flown on to have no pillar in the way: a leg whose predecessor failed starts gliding there (0.3 a tick, the ledge 1.0) | |

### The score (`route/bench.ts`, `fly-course.test.ts`)

Offline `flyLegs` flies a course's legs in order on stepBody with the tracker (a chained leg starts from the
body and the rockets the last one ended with, when that one was done), over `COURSE_BURNS`: every rocket of a
run burning 9, 12, 15, 18 or 21 ticks (F0's range and its middle), and three runs drawn at random in 9..21. A
hit is flown through (`continueOnHit`: the server's glide survives a scrape) and costs F0's wall damage
(`wallImpactDamage`, 10 x the speed lost - 3, the speed against the same step in empty space). Per course:
done (every goal passed), clean (done with no hit), ticks, rockets, damage, hits, re-plans and the least goals
passed, as means over the 8 runs (`scoreOf`, `scoreLine`). On the server (`fly-course.test.ts`, bds-fly2) the
truth pack builds each course in the private area and `flyRoute` (the tracker on the real body, the search in
the worker) flies its legs; the damage is the hurt log's, the corrections and re-plans the driver's report.

### Offline, before and after (`COURSE_BURNS`, the planner in-thread 600 ms / 40 000 nodes)

"Before" is the tree at the start of the track (Track F3, with F0's corrected takeoff model) on these courses
with the rings, the slalom and the tunnel started gliding at 0.3 a tick; "after" the final code on the same
starts, and on the courses as they are now (those three started from their pillars). Done / clean of 8, then the
means:

| Course | Before | After | After, from the pillars |
|---|---|---|---|
| rings | 8 / 7, 85 ticks, 4.4 rockets, damage 1.2, 8.3 re-plans | 8 / 8, 93 ticks, 5.0 rockets, damage 0, 12.9 re-plans | 8 / 8, 98 ticks, 4.6 rockets, damage 0 |
| slalom | 7 / 6, 86 ticks, 2.6 rockets, damage 2.2, 12.0 hits | 8 / 8, 82 ticks, 3.1 rockets, damage 0, 9.5 re-plans | 8 / 8, 70 ticks, 3.5 rockets, damage 0 |
| tunnel | 7 / 5, 49 ticks, 1.8 rockets, damage 1.2 | 8 / 8, 51 ticks, 2.6 rockets, damage 0 | 8 / 8, 40 ticks, 2.1 rockets, damage 0 |
| stair | 8 / 8, 34 ticks, 1.4 rockets, damage 0 | 8 / 8, 23 ticks, 2.0 rockets, damage 0 | (the same) |
| overhang | 8 / 8, 71 ticks, 0 rockets | 8 / 8, 71 ticks, 0 rockets | (the same) |
| stack | 8 / 8, 66 ticks, 0 rockets | 8 / 8, 66 ticks, 0 rockets | (the same) |
| shaft | 8 / 8, 117 ticks, 0 rockets | 8 / 8, 117 ticks, 0 rockets | (the same) |
| full: climb (pad, stair, rings) | 4 / 3, 105 ticks, 4.6 rockets, damage 0, 20.6 re-plans | 8 / 7, 123 ticks, 5.6 rockets, damage 0, 11.6 re-plans | (the same: no pillars in the full course) |
| full: weave (slalom, tunnel) | 4 / 1, 141 ticks, 3.4 rockets, damage 6.5 | 3 / 2, 97 ticks, 2.4 rockets, damage 1.4, 28.5 re-plans | |
| full: ledge (the overhang) | 8 / 7, 101 ticks, 1.0 rockets, damage 0.2, 10.4 re-plans | 6 / 5, 249 ticks, 0.6 rockets, damage 0.2, 148.6 re-plans (alone from its start: 8 / 8, 127 to 309 ticks) | |
| full: finish (onto the pad) | 6 / 6, 92 ticks, 2.0 rockets | 7 / 7, 76 ticks, 1.4 rockets | |
| full: stack, shaft (from their entries) | 8 / 8 each | 8 / 8 each | |
| **full chain** (every leg done) | **0 / 8**, 622 ticks, 11.0 rockets, damage 6.8 | **0 / 8**, 728 ticks, 10.0 rockets, damage 1.6 | |

Every station is clean in every run now. The rings, the slalom and the tunnel spend up to a rocket more: a
plan boosts where it turns instead of riding the last ticks of a burn whose end it cannot know (fix a below),
and the tracker flies each candidate on the burn's earliest and latest end, turning earlier when the plan's
tail hits for one of them. The staircase is 11 ticks faster on a second rocket out of its top. The landings
(overhang, stack, shaft) do not change: from their entries they are F3's plans and fly the same. In the full
course the climb is done every time now (4 of 8 before) and the damage is a quarter; the chain is still never
done in one go (the weave, open points). From the pillars the passages are as clean and up to 12 ticks faster
(the takeoff's rocket); the landings stay at the hand-over's entry (from a pillar there the stack lands 3 of 8:
a takeoff 30 up into a 2-high slot is another problem, open points).

### The F0 model in the route code (the tunnel regression, fix a)

F3 left `fly-route`'s 3 x 3 tunnel red: with F0's takeoff model the e2e scraped a wall at 1.7 to 1.9 a tick.
Offline over F0's range the cause was the burn: the plans assumed every rocket burns the nominal and the
tracker re-planned only on an early end, so a burn 6 short swung wide in the arc and one 4 long hit the
ceiling. The changes (`route/primitives.ts`, `tracker.ts`, `search.ts`, `live.ts`, the brain's route phases):

- `stepState`: the glide's first input after a jump takes no rocket (`RouteState.glideFresh`, F0: a rocket works
  from the input after it), so the model's first boosted tick is the server's; `takeoff` fires on the input
  after the glide's first.
- The tracker's `optimise` flies each candidate on the belief's nominal for the tracking cost and on the burn's
  earliest and latest end (`[min, min(max, HORIZON + 1)]`) for the hits; when every candidate followed by the
  plan hits for one of those ends, held candidates with wider turns (`HOLD_YAWS` to 90, `HOLD_PITCHES` -20 to
  35) compete, and once a burn the tracker asks for a plan from there ("the plan's tail hits for an end of the
  burn").
- The search branches a burn already running from its start state (`early` / `late` from the root, as for a
  rocket fired in the plan), and the robust search's plain fallback is no longer skipped for a plan without
  rockets while a burn runs.
- A burn past the plan's nominal now asks for a re-plan ("the rocket burns on past the plan"; F2 asked only
  for an early end), with the belief's nominal moved to the middle of what may be left.
- A rocket the driver held (the server's gliding flag not yet there, the hand busy, the brain's own boost
  count still running) calls `tracker.fireHeld()` (`flyRoute`, the brain's `route` and `routeTakeoff`), which
  gives the tracker back the burn it had before and fires on the next tick it can.
- `BURN.nominal` stays 15 (F0's mean 15.7): 10 was flown over the same set and was worse (75 of 96 clean, the
  staircase 2 of 8 with damage 13.2).
- **A rocket may go once the burn may be over** (`primitives.ts inBurnTail`: past the burn's earliest end, 9
  ticks; the search and the tracker): if the burn still runs, the boost is the union of the two lifetimes (F0's
  measurement), so the burn after the rocket is a fresh one whatever the old one does. A plan puts a rocket
  where it needs the boost's authority (a powered snap into a corner) instead of riding the last ticks of a
  burn whose end it cannot know, and the tracker no longer holds the plan's rocket when the body's burn runs
  on past the plan's.
- **A rocket on a control the tracker skipped** (the body matched a state past the next control: it runs a tick
  ahead of the reference) is fired late instead of lost.
- **The first plan of a gliding body is asked ahead** (`TrackerOptions.lead`; `flyRoute` with the worker: the
  ticks of `maxMs` and 2 more): the plan starts at the state the hold reaches when the answer comes, and the
  hold flies until then. Before, a start in the air at 0.3 a tick fell off every first plan (the worker answers
  9 to 13 ticks after the ask) and the e2e's air legs ended on the ground. Offline (in-thread, the answer at
  once) a lead of 14 costs the stations 0 to 7 ticks and no clean run.

The e2e's tunnel (straight 10, arc r8 90, straight 8, corner -90, straight 10, from standing), offline over
every burn 9..21 (seed 1; the search in-thread 600 ms, 40 000 nodes) and on bds-fly2 (two runs):

| Rule for a rocket while a burn may run | Offline clean of 13 | bds-fly2 `flyIntoWall` |
|---|---|---|
| none (F3; the changes above without the last three) | 16 of 26 over seeds 1 and 2, up to 7.5 of damage | 5.3, 0.9 |
| from the burn's nominal end | 11 | |
| from the nominal end, and the skipped rocket fired late | 12, 0 damage (burn 19 touches at 1.45) | 2.2, 6.5 |
| any time (full stacking, `stackRockets`) | 26 of 26 over seeds 1 and 2 | 0, 0 |
| **from the earliest end** (the final rule) | **13, 0 damage, max error 0.00** | **0, 0** (0 local hits, max error 0.00) |

No plan robust over 9..21 exists for the tunnel under the first three rules (20 s and 400 000 nodes did not
find one): the plain plan's snap turns ride on the burn's nominal end, a burn one tick short (14) left the turn
into the arc unpowered and one long (19) arrived at the corner too fast for an unpowered 90. With the rule at the
nominal end the server's two runs both drew burns of 19 to 20 ticks: the belief's nominal moved on past the
plan's (the burn read on), the plan's rocket at the corner was held for it, and the boost ran out a tick
before the snap turn. With the earliest end the first plan is 38 ticks with 2 rockets, found in 398 expanded
(1 090 before), and flies every burn the same (1 re-plan, none partial). Full stacking made the tunnel clean as
well but cost the stations: the rings 7 of 8 done and 5 clean, the S-tunnel 2.6 of damage (more speed in the
gates); it stays off (`stackRockets`).

### The hand-over (fix b, `brain.ts routeSink`)

F3's route landing arrived about one rocket's height high: the cruise's glide line came down to the corridor
entry, the generic descent circled there (a spiral of radius 24 at 51 out, from 22 to 34 over the cell), and
left the circle 6 over the glide line with its window a lap deep, so the tracker took over 15 to 26 over the
cell at 0.64 a tick and spent its first plans getting down. The tracker lands from 5 to 13 over the cell at
0.65 to 1.3 a tick from 44 out (measured from the planned entry), from 17 and more not always. Now a route
target never circles (`spiralDue` is off for it): lined up on the corridor (within 36 of it along the bearing,
30 degrees off at most), from APPROACH_DISTANCE + 60 in (farther when the surplus needs it), `routeSink`
compares the sink still needed a block to reach the glide line's height at the hand-over:

- up to 0.15 (`ROUTE_LEVEL_SINK`, the level glide's): the cruise as before;
- up to 0.2 (`ROUTE_SINK_MAX`): a steeper straight glide, the pitch from the glide's steady sink table
  (`pitchForSink`);
- beyond: S-turns along the corridor line, swung off the bearing by the angle whose longer path sinks what is
  needed at 0.158 a tick (at most 50 degrees: about 0.25 a block, `ROUTE_STURN_MAX`), the side flipped at the
  corridor's width.

A circle of one lap sinks 19 to 31 at the speeds it holds (radius 18 to 24; smaller ones bleed the speed to 0.4
to 0.7 a tick), too coarse for the band; a hand-over farther out (60 or 80) with a higher entry was tried and
did not land better. The stack at 16 distances (150 to 600 blocks, a 30 step, the brain on stepBody, the search
in-thread 60 s so the plans do not depend on the machine's load):

| | Before (F3) | After |
|---|---|---|
| landed | 16 / 16 | 16 / 16 |
| ticks (all trips) | 8 822 | 7 162 (-19 %) |
| rockets | 84 | 78 |
| ticks on the tracker | 2 128 | 1 940 |
| circle decisions | 73 | 0 |
| hand-over height over the cell | 7.1 to 26.3 (mean 18.4), at 0.60 to 1.63 a tick | 9.7 to 16.7 (mean 13.0), at 0.81 to 1.39 |
| hand-over in the band (5 to 13) | 5 / 16 | 7 / 16 |

("After" is the final code: the sink, the corridor line near the entry (fix d) and the route rules of fix a.)
From about 400 blocks the hand-over is 13.7 to 15 over the cell: the climb's height there is more than the
S-turns' 0.25 a block takes off over the last APPROACH_DISTANCE + 60. Every such trip landed, at 1 tick to 2
of the tracker's plans more.

### Route first or brake first (fix c, `landing.ts ROUTE_FIRST`)

F3 asked the route planner only after F1's brake simulation failed. F3's cases (the stacks, the holes, the
shaft, the room, the pocket; 300 blocks south, `findLanding` then the whole trip on stepBody, seeds 5, 11 and 17,
the search in-thread 60 s), the route asked first or after the brake:

| Case | Brake first | Route first |
|---|---|---|
| stack2 (2 of air) | the route (the brake cannot), 359 ticks, 3 rockets | the same |
| stack3 (3 of air, covered) | the brake's corridor, 498 ticks, 4 rockets, 0.01 off | the route, 469 ticks, 5 rockets, 0.59 off |
| hole1, hole2 (open sky) | the brake, 292 ticks, 2 rockets, 0.01 off | the route, 399 ticks, 2 rockets, 0.10 off |
| shaft1 (open sky) | the brake, 388 ticks, 2 rockets, 0.01 off | the route, 382 ticks, 2 rockets, 0.04 off |
| room3 (covered, ground level) | the brake's corridor, 488 ticks, 3 rockets, 1.7 go-arounds | the route, 374 ticks, 2 rockets, 0 go-arounds |
| pocket (covered, a cliff face) | the brake's corridor, 321 ticks, 2 rockets | the route, 319 ticks, 2 rockets |
| all 21 trips | 21 on target, 377 ticks, 2.6 rockets, 0.24 go-arounds | 21 on target, 386 ticks, 2.6 rockets, 0 go-arounds |
| **the rule (covered, from the body's side)** | **21 on target, 360 ticks, 2.4 rockets, 0 go-arounds** (stack2, room3 and the pocket by the route; stack3, the holes and the shaft by the brake) | |

Under open sky the brake is faster (by 18 %) and more exact (0.01 off the cell's centre); under a roof the
route flies 11 % fewer ticks for the same rockets and never goes around (the brake's corridor entry is the
weak part, F1's open point), when it comes in from the side the body arrives from. From the far side it does
not: the room asked from the north-west (fix d's 16 trips; the room is open to the north) lands 15 of 16 on
the cell by the route, 479 ticks and 6.9 rockets (up to 24), and 16 of 16 by the brake's corridor, 274 ticks
and 1.4 rockets; the 3-high stack's route comes in from its far side too (469 ticks, 5 rockets, 0.59 off,
against the brake's 495, 4 and 0.01). So `ROUTE_FIRST = 'covered'` with
`ROUTE_FIRST_OFF = 30`: a precision goal under a ceiling within OPEN_SKY asks the route first and takes it when
its bearing is within 30 degrees of the body's side (`o.from`); otherwise, and under open sky, the brake first
and the route after it (`LandingDeps.route.first` overrides either way). The route lands a multi-cell floor up
to 0.7 off the asked cell's centre (any of the floor's cells is on target).

### The room at ground level (fix d)

F3's `room3` ended `roof` once under load. Offline (the room 200 east and 150 south, F0's random burns, a
lag model of 0 and 0.15 of a tick, 8 seeds each) the brake's corridor landed 1 of 16 on the cell. The cause
was the generic tangent circle before the corridor: it never met its leave (the pursuit passed the tangent
point 5 to 6 off and the leave asked 4; at pitch 8 the speed stayed over 1.15), so it circled down to its
forced exit 6 over the ground, slowed in the turn, and `pathAhead` saw the ground on every candidate and
ended the flight `roof`. The changes (`brain.ts descend`, `steerClear`): the circle is left within 7 of its
tangent point (`TANGENT_NEAR`) at 1.15 a tick or less, a circle tangent to the approach line bleeds its speed at
pitch -5 to 1.1 (`CIRCLE_SPEED`) for the leave, and `steerClear` climbs out on a rocket (outside the landing
phase) before it ends a flight `roof`. The same 16 trips after: 16 of 16 on the cell.

The trips then cost up to 19 rockets by the route and 3 to 8 by the brake: a body that passed the corridor's
entry point more than 60 degrees off its line turned back to it the long way at 15 degrees a tick, a U-turn
that bled the speed. Near the entry (within `ENTRY_NEAR` 12 of it, or on the corridor line from 36 to
CORRIDOR_OUT out within `ENTRY_BAND` 16 of it) the cruise now aims along the corridor line `ENTRY_LEAD` 24
ahead of the body instead of at the point (`brain.ts corridorAim`). The 16 trips with the final code: 16 of 16
on the cell, 274 ticks, 1.4 rockets, 0.12 go-arounds (by the brake's corridor: the body comes from the
north-west, the room's route from the north, `ROUTE_FIRST_OFF`). Under load F3's `room3` on bds-fly2 is the
brake's or the flare's corridor too, below.

### No powered flight without a safe plan (`tracker.ts PLAN_CLEAR_MIN`)

A corridor window in a Realm cave flew on partial plans at the 600 ms budget ("the corridor ahead is blocked",
plans at clearance 0.00, a window handed over with no plan), hit walls for 6.5 and 2.8 and died (the hotfix on
main walks underground stretches). The tracker now fires a rocket only on a plan it is tracking whose least
clearance is `PLAN_CLEAR_MIN` (0.05) or more. A plan made with the request's margin always clears by more than
it (0.1 to 0.3); one under it was asked for from a body already within the margin of a solid (its first edges
keep half the body's real clearance, `startMarginFor`). With no plan (the first one not back yet, the lead's
hold, a partial plan run out into a blocked corridor, or `failed`) no rocket goes either, and the rockets the
driver held or the plan asked for before the glide took are dropped, not kept for later: the next safe plan
fires its own. Each refused rocket is counted (`stats.refused`) and noted once a plan. With no plan the hold
flies level along the heading only while that glide sweeps clear for HORIZON ticks; else the evade rule
steers (the most clearance over the horizon, unpowered), so a window handed over with no plan no longer flies
straight on. The glide bleeds its speed meanwhile. The tracker does not end the flight on this itself; the
drivers keep their own ends (the brain's route phases go around or land on `failed` or their tick cap, F4b's
`flyStretch` ends on `failed` or its tick cap).

Offline the rule costs nothing measurable: over the bench (the seven stations and the full course, 8 runs each,
104 leg flights) it refused 1 rocket (in a chained weave), the stations fly the same to within 2 ticks, the
full course's rows are within a run of the table above, and the e2e's tunnel over every burn 9..21 is 13 of 13
clean. The in-thread search answers before the next tick from the body's own state, so its plans keep the
margin; the server's late plans for a state the body has left are the ones that graze (below).

### On the server (bds-fly2, the final code)

`fly-course.test.ts` (2 runs a station, 1 of the full course; `flyRoute` with the worker, 600 ms and 40 000
nodes, `lead` 14; the damage is the server's hurt log):

| Leg | Run 1 | Run 2 | Before `PLAN_CLEAR_MIN` (runs 1 and 2) |
|---|---|---|---|
| rings (from the pillar) | done, 195 ticks, 9 rockets, 9.1 of `flyIntoWall` | done, 285 ticks, 10 rockets, 17.8 | on the ground after 2 of 5 rings (20.4); done, 300 ticks, 11 rockets, 9.1 |
| slalom (from the pillar) | **done**, 139 ticks, 3 rockets, 0 | **done**, 145 ticks, 4 rockets, 0 | **done**, 112 ticks, 0; on the ground after 3 of 5 gates (9.4) |
| tunnel (from the pillar) | done, 58 ticks, 3 rockets, 10.5 | **done**, 50 ticks, 2 rockets, 0 | **done**, 52 ticks, 0; done, 58 ticks, 0.9 |
| stair | **done**, 25 ticks, 2 rockets, 0 | **done**, 26 ticks, 2 rockets, 0 | **done** twice, 26 ticks, 0 |
| overhang (put at the entry, falling) | on the ground short of the ledge, 0 | on the ground short of the ledge, 10.0 | **done**, 79 ticks, 0; on the ground (1.3) |
| stack (the same) | done, 815 ticks, 14 rockets, 9.2 | **done**, 302 ticks, 3 rockets, 0 | **done**, 214 ticks, 0; done, 401 ticks, 5.6 |
| shaft (the same) | on the ground, 0 | on the ground, 2 (a fall) | on the ground twice (0, 1.4) |
| full (1 run) | climb: done, 405 ticks, 13 rockets, 11.3; weave (its own start): stopped before gate 1, 0; ledge: on the ground, 0; finish: **done**, 51 ticks, 0; stack: done, 498 ticks, 20.1; shaft: on the ground, 0 | | climb: on the ground after 5 of 8; weave: 1 of 11 (0.8); ledge: a fall (11); finish: short of the pad; stack: done (9.5); shaft: on the ground (1.9) |

Gated (exit 0 both times): every course builds and every leg is flown, and each passage station passes all its
goals in one of its runs. The rule refused 1 rocket in the run (the weave's first plan, partial at clearance
0.00); the runs differ from each other by more than the rule does (the rings, the tunnel and the overhang swap
between clean and scraped from one run to the next on the same code). The server is well short of the bench:
the worker answers 9 to 13 ticks after the ask and its first plans are partial (the 600 ms run out 2 goals in),
so every re-plan in flight is for a state the body has left ("off the reference by" 1 to 17); the rings
re-plan 21 to 33 times and scrape. An earlier run (before the rule) had the rings done once (3.5 of damage) and
on the ground once at 0, the slalom done twice (0 and 4.6), the tunnel done twice (1.6 and 0). With the
stations started in the air (a teleport, the glide asked) the rings and the slalom fell from their start in 3
of 4 runs: the reason for the pillars.

`fly-route.test.ts` (Track F2's; 2 runs a case):

| Case | Before (F3, the takeoff model) | Rule at the nominal end | Final |
|---|---|---|---|
| tunnel (3 x 3, from standing) | 1.9 and 1.7 of `flyIntoWall` (F3 on bds-fly), 5.3 and 0.9 here | 2.2 and 6.5 | **done twice, 0 damage**, 0 local hits, max error 0.00, 43 and 45 ticks, 2 rockets, 2 plans (1 re-plan, none partial); with `PLAN_CLEAR_MIN` the same: 44 and 42 ticks, 2 rockets, 2 and 3 plans, none partial |
| stair (3 high, from standing) | done twice, 0 damage, 38 ticks, 1 rocket | done twice, 0 damage, 37 ticks, 1 rocket | done twice, 0 damage, 26 and 27 ticks, 2 rockets (with `PLAN_CLEAR_MIN`: 26 and 25) |
| sbend (2 x 2, gliding in from 8 out; not gated) | | on the ground twice | done once (3.3 of damage, 2 local hits); once on the ground after 26 ticks (a fall, 6); with `PLAN_CLEAR_MIN` on the ground twice (3 and 0; no rocket refused: the air start, open points) |

`fly-route-land.test.ts` (Track F3's; room3 and stack2, `FLY_F3_ONLY`):

| Case | Before (F3) | An earlier F4a run | Final code (2 runs of the file) |
|---|---|---|---|
| stack2 (2 of air) | the route, on the cell | the route twice, 0.13 and 0.37 off | the route twice, 0.01 and 0.51 off, 0 damage, 0 go-arounds; the takeoff out (flare) 0.03 off |
| room3 (covered, ground level) | ended `roof` once under load | the brake 0.79 off and the flare 0.77 off, a go-around each | the brake 0.57, 0.57 and 0.65 off, 0 damage, 0 go-arounds; **once the flare touched down 4.4 short of the room** (`landed_off` after a descent spiral at 51 out, 0 damage): red, the file's rerun green; the takeoff out 0.05 off |

The one miss is F1's flare path after a descent circle (the brain chose the flare there); the brake's corridor
landed the room every time it was chosen (open points).

## Corridor flight (Track F4b)

Flight v2, Track F4b, [decisions/0067](decisions/0067-long-range-flight.md) "F4b". The owner's case: the bot at
0 100 0, the goal at 1000 0 1000, reachable only through a cave entrance part of the way along. The coarse layer
(Track CB, [coarse.md](coarse.md)) plans a corridor of legs over everything the bot has seen; the flight prices its
mode on that graph and follows the fly legs: the cruise to the entrance, the bore flown where it is 3 high, the rest
walked.

```
!fly 1000 0 1000        far (> 96), covered (no open sky over the goal), a provider, flyCorridor auto
  -> plan (walk + fly, start walking, end standing)   corridor: fly 307, walk 20
  -> fly leg: sky stretch  -> the cruise to the cell 2 inside the mouth (or a shaft's floor, or the open
                              ground where the sky meets a covered volume)
              under stretch -> windows from standing (route trackers), the chunks waited for between them,
                              a short window or the tail after a bend walked
  -> walk leg: the navigator
  a failure marks its portal failed for its mode and plans again (at most 4); a change flown through is marked ok
```

### The cost (`corridor/cost.ts`, `FlightCost`)

Every price is in ticks (walking is 4 a block in the layer), calibrated on [flight-envelope.md](flight-envelope.md)
and the measurements above. Registered once per layer (`setCost('fly', ...)`, `registry.ts`).

| | price |
|---|---|
| open sky | 1 / 1.5 a block (the cruise) + 0.67 rockets per 100 blocks x `ROCKET_COST` 20 |
| a bore 3 x 3 or more | 1 a block + a rocket per 30 blocks; 2 wide x 1.5, 1 wide x 2.5 |
| 2 high | a glide in or a landing only: at most `GLIDE_IN_MAX` 6 blocks, else Infinity; under 2 Infinity |
| into a cave from the sky (x / z) | `MOUTH_ENTRY_TICKS` 160 (the brake landing just inside, the takeoff there) |
| out of a cave into the sky | 30 + a rocket |
| down a y portal (a shaft, a hole, the open top of a covered volume) | 60 + the drop at the hover's 0.149 a tick |
| up a y portal | the vertical takeoff: 0.8 a tick, a rocket per 31 |
| a climb sky to sky | a rocket per 31 blocks of the sky's floor rising |
| unknown space | 8 a block under y 64, 2.5 between 64 and 192, the sky's price x 1.15 above (high, never Infinity); + 60 at an unknown portal |
| water, a dig portal (`dug`), a portal the flight failed at | Infinity (the marks are per mode and decay: the walk may still take it) |
| a portal flown through before (`ok`) | x 0.9 |
| into flight (`switchCost`) | 0 from fly; a takeoff 60 + a rocket + the landing 100; Infinity in water, in an unknown volume underground or one under 3 high |
| `ticksPerBlock` (the search's heuristic) | 0.667 (the cruise's speed alone) |

### Stretches and windows (`corridor/stretches.ts`)

`splitLeg` classifies each segment between two waypoints by the layer's volume at the body's height along it
(`flightSpace`: sky volumes are the cruise's, caves, surface volumes and unknown sections under y 192 the route
planner's). A change of class is a portal where the stretch before lands so the next starts from standing
(`changeCell`): into a mouth 2 blocks inside (`MOUTH_IN`), down a y portal on the floor under its centre (a shaft's
floor; with the layer's own corridors also the open ground of a covered chunk, where its sky meets the band under
the chunk's highest block), out of a bore just inside the exit. Waypoints are matched to their portals by the
centre (the layer lists the entry and the exit among the portals, not among the waypoints).

An underground stretch is flown a window at a time from where the body stands (`nextWindow`):

- the portals ahead as waypoint boxes (`portalGoal`: the opening, a cell more each way along its axis), a box every
  `WINDOW_STEP` 24 along a clear straight, and bend points where the straight line between two anchors leaves the
  bore (`bendPoints`: a 6-connected BFS through air at the body's height, at most 40 000 cells, pulled tight and
  recentred in the bore) so the route heuristic never aims through rock;
- cut at the first portal whose chunk is not loaded (the window lands on the last loaded portal's floor; the next
  waits up to 15 s for the chunks: the server holds a body at the edge of its loaded chunks, ADR 0055) and at
  `WINDOW_BLOCKS` 320;
- the tail rule: when less than `UNDER_TAIL_MIN` 40 blocks follow the last bend, the window lands at least 6 before
  the bend and the tail is walked (flying out of a bend at cruise speed and landing within a few blocks of it failed
  4 in 10 offline at the live budget);
- a window shorter than 24 blocks (`UNDER_FLY_MIN`) is walked; a window that ends short of its landing is flown again
  from there (at most 2 more times), then the stretch fails.

A window is a chain of route trackers (`drive.ts TrackerChain`): 5 goals each (`CHAIN_WINDOW`), overlapping by 1,
the next one created when the active one has 2 goals left and ticked in shadow (it holds, fires nothing) until it has
a plan, then it takes over with the rocket still burning seeded into it; the last tracker plans with Track F1's
landing library. One tracker over a whole bore gets partial plans past about 100 blocks (the 256-block snapshot,
the 600 ms budget) and hits the wall; the tracker cannot extend its goals. `flyStretch` runs the chain on the
InputLoop like `route/live.ts` (`RocketHand` scope `corridor`, the glide from the 2nd airborne input, chunk
arrivals as world changes, held corrections counted with the chunk-edge note). Each window is its own process
(`tasks/process/corridor.ts UnderFlyProcess`, `fly`, user; FLIGHT_PRIORITY while the body is in the air): the
rockets to the hotbar, the elytra on, the window, the ground.

### The executor (`corridor/executor.ts`) and the entry

`CorridorExecutor.run(goal)` plans (modes walk + fly, `startMode` walk, `goalStanding`, `CORRIDOR_PLAN_MS` 4000:
flight is cheap in all the sky, so a covered goal makes the search exhaust the sky round it first: 3 600 volumes offline,
7 700 and 2.2 s over the e2e's cold real chunks, where the default 500 ms gave a partial corridor ending in the sky
over the goal) and follows the legs:

- walk / mine legs: the navigator's own walk (not the fly-wrapped one);
- fly legs: the stretches; an underground fly leg whose unknown share (sampled every 4 blocks in its underground
  stretches) is over `UNKNOWN_FLY_MAX` 0.25 is walked instead (`walk (unknown)`);
- a sky stretch that lands within 64 blocks of its cell (`SKY_WALK_MAX`) walks the rest (along the roof and down the
  hole, round through the mouth): a cruise from standing that close does not fly (the takeoff, a flare and down on
  the spot in 14 ticks, no rocket, measured twice on the e2e); one that came down whole farther off (`landed_off`:
  its go-arounds ran out) is flown once more (`SKY_RETRIES` 1) before the change fails;
- a failure (no floor known at a change, a cruise that ends far off, a window failed 3 times, a walk that fails)
  marks its portal `failed` for the mode and plans again from where the body stands (`MAX_REPLANS` 4);
- a partial corridor is followed to its end and planned again from there.

`!fly <x y z>` hands over when `corridorWanted`: `flyCorridor` not `off`, a provider (the task's registered one,
else `skills.nav.coarseLayer`), the goal more than `CORRIDOR_MIN` 96 away and covered (`skyTop` at or over the
goal; unknown counts as covered). The reply is `flying to <goal> along a corridor (...)`, the end `arrived at
<goal> along a corridor (fly 307, walk 20); 4 rockets, 1 cruise, 1 underground, 3 walks, 0 re-plans, 40.6 s` or
`fly: the corridor to <goal> failed: <why>`. `!fly stop` ends the trip after the step in progress. The cell
query of the executor is the live model, else the world cache (`world.cache.blockAt`), so the cell inside a mouth
at the edge of the loaded chunks is known; the windows are still cut by the live chunks. The chestplate goes back
on at the end of the trip; between windows the elytra stays on.

### Offline (stepBody; `fly-corridor.test.ts`)

The corridor world (`fly-corridor-world.ts`): the start on the flat ground, a 3 x 3 mouth 150 blocks out, a 140-block
3 x 3 bore, a bend to +z, 30 more blocks, a 2-high section 12 long, a 9 x 9 x 5 chamber closed but for it (the goal,
about 290 from the start), optionally a 1 x 1 hole through the bore's roof 60 in. The chain flown on stepBody (the
burn drawn 9 to 21 ticks, its end told 3 ticks late, node budgets only so the numbers are the same everywhere):

| case | result |
|---|---|
| one tracker over a straight bore of 48 / 64 / 80 / 96 blocks | done |
| one tracker over 128 / 158 blocks | hit (partial plans) |
| the chain, the bend and a landing 28 after it, minimal library, 2 000 ms | 2 to 3 of 3 seeds |
| the same, the last tracker with the landing library, 2 000 ms | 6 of 6 |
| the same at 1 500 ms / 600 ms (the live budget) | 6 of 10 / 4 of 10 (the misses on the outer wall after the bend) |
| 3 goals per tracker, or a new tracker at 3 / 4 goals left | worse |
| the bore from inside the mouth with the tail rule (lands before the bend), seeds 1 to 3 | done 9 of 9 goals, 144 / 144 / 153 ticks, 2 rockets, 0 hits, 2 trackers, 10 to 11 plans |
| a bend with 70 blocks after it, seeds 1 to 3 | done 8 of 8, 130 / 124 / 124 ticks, 2 / 1 / 1 rockets, 0 hits, 2 trackers |

The executor over stub corridors (stub flights that stand on their cell): sky, mouth, bore, walk, walk; the shaft
drop; the mouth failed and the re-plan through the shaft; a shaft cruise that ran out of go-arounds 35 off walked
the rest, one 100 off flown again (and the shaft failed after a second); the unknown bore walked; a window failed 3
times marks its first portal. Over the coarse layer's own corridor on the same world (`terrainSource`): with the hole the corridor
takes it (fly 320 then walk 18, cost 793 against 1 539 walking, 3 047 volumes, 137 ms), without it the fly leg comes
down onto the open ground of the mouth's chunk and goes in through the mouth (fly 319, walk 18, cost 871, 3 602
volumes, 191 ms); the executor flies the cruise there, one window to the last straight portal and walks the rest.

### e2e (`fly-corridor.test.ts`, bds-fly3, BDS 1.26.60.6)

The corridor world built with truth:fill in the run's private area. Seen first: a scripted fly-over (teleports along
the corridor after the build, every chunk dropped and loaded again) into a fresh world cache on the bot's world
model; the coarse layer over that cache attached to the navigator as `index.ts` does.

Runs: `mouth` (x 2), `shaft` and `blocked` follow stub corridors (`setCorridorProvider`); `layer` (the roof hole
closed) and `layershaft` (open) follow the coarse layer's own corridor (no stub registered: `!fly` takes
`skills.nav.coarseLayer`), each after a plan with modes fly + walk that checks the layer found the way in by itself.
The final code, two runs (E: area cell 34, F: area cell 67; every case green in both):

| run | arrived | s | rockets | damage | corrections | route re-plans | corridor re-plans | cruises / windows / walks | legs |
|---|---|---|---|---|---|---|---|---|---|
| mouth #1 (stub) | yes / yes | 76 / 38.7 | 9 / 4 | 0 / 0 | 11 / 6 | 5 / 18 | 0 / 0 | 1 / 1 / 3 | fly 307, walk 20 |
| mouth #2 (stub) | yes / yes | 76 / 39.7 | 9 / 4 | 0 / 0 | 9 / 4 | 4 / 11 | 0 / 0 | 1 / 1 / 3, 1 / 1 / 2 | fly 307, walk 20 |
| shaft (stub) | yes / yes | 60.3 / 42.6 | 6 / 4 | 0 / 0 | 7 / 3 | 8 / 7 | 0 / 0 | 1 / 1 / 2 | fly 308, walk 20 |
| blocked (stub: the mouth filled, the shaft second) | yes / yes | 41.9 / 41.7 | 5 / 3 | 0 / 0 | 5 / 4 | 8 / 8 | 1 / 1 | 1 / 2 / 2, 1 / 1 / 2 | fly 307, fly 308, walk 20 |
| layer (the layer's corridor, the hole closed) | yes / yes | 40.8 / 38.7 | 3 / 4 | 0 / 0 | 3 / 5 | 9 / 11 | 0 / 0 | 1 / 1 / 3 | fly 319, walk 18 |
| layershaft (the layer's corridor, the hole open) | yes / yes | 52.3 / 66.9 | 5 / 8 | 0 / 0 | 4 / 7 | 10 / 8 | 0 / 0 | 1 / 1 / 2 | fly 320, walk 18 |

The layer's plans (fly + walk, 4 s, `CORRIDOR_PLAN_MS`), on five areas (B to F):

| world | found | legs | cost | volumes | ms | the way in | walk only |
|---|---|---|---|---|---|---|---|
| the hole closed | yes, 5 of 5 | fly 319, walk 18 | 871 | 7 725 to 8 792 | 2 219 to 3 384 | the mouth chunk's open top (a 16 x 12 y opening onto the ground by the mouth), then x portals along the bore | cost 1 539, 156 volumes, 1 to 115 ms |
| the hole open | yes, 5 of 5 | fly 320, walk 18 | 793 | 7 211 to 8 185 | 1 941 to 3 063 | the 1 x 1 hole (y portal 4 over the floor) | the same |

The earlier runs on other areas: A (cell 11, the stub runs only, before the main merge), B (cell 138, the layer
runs only), C (cell 92, the code before the sky stretch's second try), D (cell 168, a second cruise from where the
first came down, in place of `SKY_WALK_MAX` 64):

| run | arrived | s | rockets | damage | corrections | route re-plans | corridor re-plans | cruises / windows / walks |
|---|---|---|---|---|---|---|---|---|
| mouth #1 (stub), A / C / D | yes | 40.6 / 42.9 / 39.7 | 4 / 4 / 5 | 0 | 7 / 7 / 6 | 8 / 3 / 21 | 0 | 1 / 1 / 3, 1 / 1 / 2, 1 / 1 / 2 |
| mouth #2 (stub), A / C / D | yes | 40.7 / 59.3 / 48.7 | 3 / 7 / 4 | 0 | 6 / 9 / 3 | 1 / 11 / 30 | 0 | 1 / 1 / 2 |
| shaft (stub), A / C / D | yes / no / no | 53.1 / 64.8 / 43.2 | 7 / 6 / 8 | 4.1 (flyIntoWall) / 0 / 0 | 0 / 8 / 9 | 8 / 0 / 0 | 0 / 1 / 1 | 1 / 1 / 2, 1 / 0 / 0, 2 / 0 / 0 |
| blocked (stub), A / C / D | yes | 47.2 / 47.9 / 47.6 | 5 / 6 / 5 | 0 | 5 / 6 / 6 | 7 / 10 / 10 | 1 | 1 / 1 / 2 |
| layer, B / C / D | yes | 38.7 / 42.2 / 38.8 | 3 / 2 / 4 | 0 | 6 / 3 / 4 | 15 / 3 / 13 | 0 | 1 / 1 / 3, 1 / 1 / 3, 1 / 2 / 2 |
| layershaft, B / C / D | yes | 42.7 / 50.8 / 116 | 3 / 3 / 9 | 0 / 2 (fall) / 0.3 (flyIntoWall) | 5 / 5 / 15 | 7 / 7 / 4 | 0 / 0 / 3 | 1 / 1 / 2, 1 / 1 / 3, 4 / 4 / 4 |

- mouth: the cruise to the cell 2 inside the mouth lands 0.02 to 0.29 from it in 8 cruises of 10 (0 to 1
  go-around) and ran out of its 4 go-arounds 7 and 21 blocks off in E (walked in: E's 9 rockets and 76 s). The
  window from there (119 to 120 blocks, 8 goals, cut before the bend) ended `done` 8 of 8 in 3 runs of 10 (D, F, F)
  and touched down 5 to 25 blocks short of its landing otherwise (6 or 7 of 8 goals); the rest is flown again or
  walked. 0 damage in every run.
- shaft: of the 15 cruises to the bore floor under the 1 x 1 hole (shaft, blocked and layershaft runs), 11 land on
  it (0.00 to 0.03 off where logged, the brake, 1 to 3 go-arounds), 1 on the roof beside the hole (walked in: 2 of
  fall damage), 3 ran out of their 4 go-arounds 31 to 35 blocks off (on the roof, on the ground beside the bore).
  C ended there (the stub has no other corridor, the shaft marked failed). D flew the cruise again from there and
  it does not fly that close: the takeoff, a flare and down on the spot in 14 ticks, 0 rockets, 4 times; D's
  layershaft then marked the shaft failed, re-planned through the mouth, walked into it and arrived after 3
  re-plans in 116 s. Hence `SKY_WALK_MAX` 64: a landing that close walks (along the roof and down the hole, or round
  through the mouth). The window from the shaft (60 to 62 blocks, 4 goals) ends `done` in every run but one (1 of 4,
  flown again); A's shaft took 4.1 of wall damage in the approach to the hole.
- blocked: no standable cell inside the filled mouth: the mouth is marked failed and the re-plan goes in through
  the shaft in every run; 0 damage.
- layer: the cruise lands on the open ground by the mouth 0.09 to 0.32 from the cell (the flare, 1 rocket, 0
  go-arounds) in all 5 runs; the window (132 blocks, 10 goals, 3 trackers) through the mouth ended `done` 10 of 10
  in E and F and `ground` 8 of 10 in B, C and D (B at the window's end with corrections up to 8.2, C and D 24 and 32
  short, the rest walked or flown again). 0 damage.

### Open points (Track F4b)

- The route tracker has no way to add goals or re-plan to new ones (`route/tracker.ts`, Track F4a's): the chain
  of trackers works round it, planning in shadow; an `extend(goals)` on the tracker would let one tracker fly a
  whole stretch.
- A tracker planned with a reduced start margin re-plans "the corridor ahead is blocked" over and over (up to 30
  route re-plans in one window, mostly partial plans).
- A bend at cruise speed with a short landing after it is unreliable at the live 600 ms budget (6 of 10 at
  1 500 ms offline): the tail rule walks tails under 40 blocks.
- The windows touch down short of their landing (mouth: 5 to 25 blocks, 6 or 7 of 8 goals); the executor flies
  again or walks the rest, so the trips arrive, but a window that lands where it was meant to would save the walk.
- The cruise into the 1 x 1 hole costs 1 to 3 go-arounds and ran out of its 4 in 3 of 15 cruises (31 to 35 off),
  the cruise to the cell inside the mouth in 2 of 10 (7 and 21 off); A's shaft took 4.1 of wall damage (Track F1 /
  F3's landing families; the corridor only asks for the cell and walks from up to 64 off).
- A cruise from standing 30 to 51 blocks from its goal does not fly: the takeoff, a flare and down on the spot in
  14 ticks with no rocket (FlyProcess / the brain, 4 times in run D). The corridor walks instead; a short hop in
  the open would need the brain to climb first.
- A window planned from the open ground by the mouth after a re-plan (D's layershaft) found no start twice (41
  partial plans in 6 ms, 0 goals) before the next re-plan's window from inside the mouth flew.
- Each sky stretch swaps to the chestplate after its FlyProcess and back to the elytra for the underground windows.
- The landing price at a fly-to-walk change belongs to the walk cost's `switchCost` (the layer's 20); FlightCost
  prices the landing in its own takeoff switch (`LANDING_TICKS` 100).
- `surface` volumes (open air under the chunk's highest block) are flown as underground (the route planner from
  standing), so a corridor through low open ground under tall trees is windows, not a cruise.
- Only an exact `!fly <x y z>` to a covered goal more than 96 away takes the corridor; `!goto` / `!come` keep
  their own fly-then-walk.

## Cave flight (Track F5b)

Flight v2, Track F5b, [decisions/0069](decisions/0069-cave-flight.md). The owner's goal: "fly through caves and land
underground". The first Realm trip into a real cave died (ADR 0067, the hotfix): the windows flew powered on partial
plans at the live budget. This track builds the cave flying style, a procedural cave set to score it on (next to the
owner's cave, Track F5a's replica), the waypoint routes (`!fly via`, `!fly route`) and the setting `flyCave`, default
**off**: nothing flies underground unless the owner turns it on.

```
flyCave on, !fly <x y z> (covered, > 96) or !fly route cave
  -> the corridor (the coarse layer's, or the waypoints as via anchors)
  -> each underground window PROVEN before its takeoff: a complete, burn-robust plan from standing (2 s in the worker)
       partial -> the window cut back to what the plan reached (3 times at most), nothing reached -> walk to the first goal
  -> flown on the proven plan; a re-plan in flight from the reference 12 ticks ahead; a partial answer never replaces it
  -> no plan for 6 ticks, 2 short partial plans in a row, 1.5 off the plan, or blocked ahead with a partial answer:
       the BAIL-OUT (the 180 brake at the clearest pitch, the hover's sink to the floor) -> the executor flies on or walks
```

### Files

| File | What |
|---|---|
| `bot/src/skills/fly/route/caves.ts` | the worm-cave generator (`wormCave`, `caveSet`: the GENERALISATION set of 12) |
| `bot/src/skills/fly/cave/style.ts` | `CAVE_STYLE` (the windows, the proof's budget, the tracker rules), `caveExecutorOptions`, `caveStretchOptions` |
| `bot/src/skills/fly/cave/bench.ts` | the offline bench: `flyWindow` (a window on stepBody over the worker's snapshot, plans with the worker's latency), `flyTrip` over any provider, `flyCaveCorridor` (the layer's corridor, no waypoints), `flyCaveWaypoints`, `scoreCaves` |
| `bot/src/skills/fly/cave/route.ts` | `WaypointProvider` (the waypoints as a corridor), `orderedRoute`, `shortcutRoute` |
| `bot/src/skills/fly/cave/proof.ts` | `proveShortcut` (the stretch through an optional waypoint flown on the model over the burn's range), `proveShortcutInWorker` |
| `bot/src/skills/fly/route/tracker.ts` | `TrackerRules` (`bailAfter`, `partialStop`, `completeOnly`, `replanLead`, `bailError`, `commitTicks`; `refuseUncommitted`, `fireSpeedMax` measured harmful), the bail-out, `corridorClear` on the plan's clearance |
| `bot/src/skills/fly/corridor/executor.ts`, `drive.ts`, `stretches.ts`, `cost.ts` | `prove` / `proveWindow` / `PROVE_CUTS`, `windowBlocks` / `tailMin`; `firstPlan`, `windowRequest`, `proofOf`, `rules`, `riskCost`; via anchors (`viaGoal`, `firstAhead`, `standableNear`, `Window.goalS`); `wideFace` (a sloping bore across a section border is no shaft) |
| `bot/src/chat/commands-fly.ts`, `commands-corridor.ts` | `!fly via <wp> ...`, `!fly route <prefix> [noshortcut]`, `TripStyle` (the style on a trip with `flyCave on`) |
| `bot/scripts/cave-gen-bench.ts`, `cave-real-bench.ts` | the benches from the command line: the generator set (modes, style variants, burns, workers) and the owner's cave through the same path (Track F5a's fixture: the corridor, route A, its legs, route B, trip C, the shortcut proof) |
| `bot/test/e2e/fly-cave.test.ts` | Track F5a's e2e; `FLY_CAVE_STYLE=1` turns the cave style on for its flown runs (one line added) |
| `bot/test/unit/skills/fly-cave-style.test.ts` | the guard tests |

### The style

A cave is not an open-air flight made smaller. What was measured on the cave set, in this order:

1. **Rockets refused by rule (a speed cap, none on a short partial plan) make it worse**: a plan's rocket is its turn.
   Refused, the body leaves the plan it is tracking by 1.4 to 1.7 in 5 ticks and hits the wall it was turning from.
   Both rules stay in the code (`fireSpeedMax`, `refuseUncommitted`), off.
2. **The bench must deliver plans late.** Track F4a's and F4b's benches answered the in-thread search at once; with
   the worker's latency (a tick per 50 ms) a re-plan asked from the body's state comes back for a state 12 ticks old,
   15 blocks behind a body that has meanwhile left its old plan, and the tracker turned round to chase it: errors of 20
   to 35 blocks, then the wall. Hence `replanLead`: the re-plan is asked from the plan's reference 12 ticks ahead and
   the old plan is flown until its start tick.
3. **Prove the window before the takeoff.** The plan from standing at 2 s / 80 000 nodes (the body stands: the live
   600 ms is the in-flight budget) is the commit: complete and burn-robust, or no takeoff. A partial plan cuts the
   window back to what it reached (`Window.goalS`); nothing reached walks to the first goal. The tight caves of the set
   (3 to 5 across) are mostly walked by this rule: a takeoff in a 3-wide, 3-high passage is at the edge of what the
   search finds in 2 s.
4. **Stop when unsure.** The bail-out (the 180 brake at the pitch that sweeps clear longest, then the hover's sink)
   replaces the hold / evade flight the Realm window died in: no plan for 6 ticks, two short partial plans in a row at
   speed, 1.5 off the plan, or a complete plan blocked ahead with only a partial answer. The driver sees the ground and
   the executor flies again or walks. Most of what used to be a hit is a bail-out now.
5. **The corridor check uses the plan's own clearance** (with the rules on): a plan from a standing start keeps less
   than the margin on its first edges by construction, and the full-margin sweep found it "blocked" every 4 ticks
   (F4b's open point) and, near a landing cell, found the floor the search excludes. On every driver it cost the
   obstacle course its rings and tunnel on bds-fly2, so the open-air drivers keep F4a's check.

### The cave set (`route/caves.ts caveSet`)

| cave | kind | blocks | waypoints | narrowest (high x wide) |
|---|---|---|---|---|
| tight-101 | r 1.6, 1 drop | 140 | 8 | 2 x 3 |
| medium-102 | r 2.7, 1 drop, 4 pillars | 160 | 9 | 3 x 4 |
| wide-103 | r 2.9, 2 drops, 4 pillars | 180 | 10 | 4 x 4 |
| tight-104 | r 2.2, 1 drop | 200 | 11 | 3 x 4 |
| medium-105 | r 2.1, 1 drop, 3 pillars, water | 140 | 8 | 3 x 4 |
| wide-106 | r 2.8, 2 drops, 3 pillars | 160 | 9 | 4 x 5 |
| tight-107 | r 2.2, 1 drop | 180 | 10 | 3 x 4 |
| medium-108 | r 2.4, 1 drop, 5 pillars, water | 200 | 11 | 3 x 4 |
| wide-109 | r 3.9, 2 drops, 4 pillars, water | 140 | 8 | 5 x 7 |
| tight-110 | r 1.6, 1 drop | 160 | 9 | 2 x 3 |
| medium-111 | r 3.0, 1 drop, 4 pillars | 180 | 10 | 4 x 4 |
| wide-112 | r 3.4, 2 drops, 5 pillars | 200 | 11 | 5 x 5 |

### Offline (the layer's corridor, no waypoints; `scripts/cave-gen-bench.ts --mode corridor`)

Every trip from the mouth cell to the goal cell over the coarse layer's own corridor (the layer over the cave's
terrain, FlightCost registered: "fly" legs are its choice), the windows on stepBody with the worker's latency, three
random burns a cave (the seeds 1 to 3), 600 ms / 40 000 nodes in flight, the proof at 2 s / 80 000. "legs" are the
windows flown; "bands" the trips per damage band 0, (0, 1], (1, 3], (3, 6], (6, 10], (10, 20], over 20; fatal is 20
of damage in one trip (no healing between windows). `rules0` is Track F4b's flight as main has it with `underFly`
on (no proof, no rules, 320-block windows): what the Realm died on.

| variant | trips | arrived | fatal | legs clean | damage a trip (mean) | worst single hit | bands 0 / 1 / 3 / 6 / 10 / 20 / over | bail-outs | rockets a trip | flown / walked blocks a trip |
|---|---|---|---|---|---|---|---|---|---|---|
| **on** (the style: the proof, the rules, 8 burns a cave) | 96 | 96 (100 %) | 0 | 114 / 143 (80 %) | 1.26 | 10.7 | 75 2 5 5 4 5 0 | 95 | 1.6 | 51 / 126 |
| partialok (the style without `completeOnly`) | 96 | 95 (99 %) | 0 | 159 / 196 (81 %) | 1.28 | 10.7 | 69 4 7 7 7 2 0 | 120 | 2.1 | 73 / 110 |
| rules0 (Track F4b's flight as main has it with `underFly` on: no proof, no rules, 320-block windows; 6 burns a cave) | 72 | 72 (100 %) | **9** | 94 / 165 (57 %) | 8.19 | 13.4 | 30 0 3 6 9 15 9 | 0 | 4.2 | 174 / 48 |
| off (the hotfix: everything underground walked) | 36 | 36 (100 %) | 0 | - | 0 | 0 | 36 0 0 0 0 0 0 | 0 | 0 | 0 / 147 |

Earlier variants of the style on 3 random burns a cave (36 trips each), before the proof and the latency were in: the
rocket refusals (`rules0` of that round: 34 / 36 arrived, 2 fatal, 69 % clean, damage 6.5), fewer goals a tracker,
a wider margin, a risk weight of 0.5 or 4: none moved the clean share above 71 %. The proof before the takeoff
(decision 3) and the re-plan from ahead (`replanLead`) are what moved it; the bail-outs are what took the fatal trips
away.

Per cave, the style on:

| cave | arrived | legs clean | damage mean | worst hit | bands | bail-outs | rockets | flown / walked |
|---|---|---|---|---|---|---|---|---|
| tight-101 | 8 / 8 | walked (no window proven) | 0 | 0 | 8 0 0 0 0 0 0 | 0 | 0 | 0 / 129 |
| medium-102 | 8 / 8 | walked | 0 | 0 | 8 0 0 0 0 0 0 | 0 | 0 | 0 / 144 |
| wide-103 | 8 / 8 | 33 / 42 (79 %) | 5.59 | 10.7 | 1 1 1 3 0 2 0 | 27 | 4.8 | 147 / 72 |
| tight-104 | 8 / 8 | walked | 0 | 0 | 8 0 0 0 0 0 0 | 0 | 0 | 0 / 177 |
| medium-105 | 8 / 8 | walked | 0 | 0 | 8 0 0 0 0 0 0 | 0 | 0 | 0 / 125 |
| wide-106 | 8 / 8 | walked (the layer's corridor walks it) | 0 | 0 | 8 0 0 0 0 0 0 | 0 | 0 | 0 / 138 |
| tight-107 | 8 / 8 | walked | 0 | 0 | 8 0 0 0 0 0 0 | 0 | 0 | 0 / 154 |
| medium-108 | 8 / 8 | 12 / 13 (92 %) | 0.76 | 6.1 | 7 0 0 0 1 0 0 | 7 | 1.9 | 82 / 112 |
| wide-109 | 8 / 8 | 14 / 17 (82 %) | 0.32 | 1.1 | 5 1 2 0 0 0 0 | 12 | 2.3 | 72 / 64 |
| tight-110 | 8 / 8 | walked | 0 | 0 | 8 0 0 0 0 0 0 | 0 | 0 | 0 / 141 |
| medium-111 | 8 / 8 | 27 / 38 (71 %) | 4.99 | 7.6 | 2 0 1 1 3 1 0 | 27 | 5.9 | 156 / 178 |
| wide-112 | 8 / 8 | 28 / 33 (85 %) | 3.41 | 10.3 | 4 0 1 1 0 2 0 | 22 | 4.1 | 154 / 77 |

The same set with the generator's floor cells every 20 blocks given as waypoint hints (`--mode waypoints`, the
`WaypointProvider`, 3 random burns a cave): 36 / 36 arrived, 0 fatal, 37 / 51 legs clean (73 %), damage 1.85 a trip, worst hit 10.9, 27 bail-outs, 56 flown / 102 walked blocks a trip: the hints neither help nor hurt the corridor; the windows are the same windows.

What the numbers say: every trip arrives, none is fatal (F4b's flight on the same caves: 9 of 72 trips take 20 or
more); the style's damage a trip is a sixth of F4b's; 95 of the 143 windows end in a bail-out (a stop and a sink, 0
damage in most); the tight caves and two others are walked (no window proven, or the layer's corridor walks them);
the **95 % clean-legs bar is not met** (80 %): the hits left are a body drifting 1 to 1.5 blocks off its proven plan
in a wide irregular passage, under a burn the plan did not assume, before the error bail fires (`bailError` 1.5),
and the worst single hit is still 10.7 (wide-103, wide-112): half the health.

### Offline, the owner's cave (`scripts/cave-real-bench.ts`)

Track F5a's fixture (the Realm cave the bot died in: the world cache's extract and the owner's waypoints, private,
never in the repository; the lines name legs only) through the same bench (`flyTrip` over F5a's `caveWorld`), the
burns 9, 15 and 21, the live budget in flight, the proof at 2 s. The walks are stubs (the body stands on its cell at
once); on the Realm they are Track W1's water walking now.

| run | style | arrived | legs clean | damage a trip | worst hit | bail-outs | water | flown / walked blocks |
|---|---|---|---|---|---|---|---|---|
| **cave_start to cave_end, the layer's corridor, no waypoints** | on | 3 / 3 | 3 / 4 | 0.99 | 3.0 | 3 | 0 | 39 / 172 |
| the same | rules0 (F4b's flight) | 3 / 3 | 14 / 14 | 0 | 0 | 0 | 4 | 124 / 53 |
| route A, every waypoint a hint | on | 3 / 3 | 6 / 6 | 0 | 0 | 3 | 1 | 34 / 147 |
| route A, every waypoint a hint | rules0 | 2 / 3 | 24 / 27 | 1.66 | 1.9 | 0 | 3 | 222 / 29 |
| route A leg by leg (22 legs x 3 burns) | on | 66 / 66 | 6 / 6 (two legs flown, the rest under 24 blocks: walked) | 0 | 0 | 4 | 0 | 3 / 22 |
| route B (cave_4, cave_5, cave_shortcut, cave_end as hints) | on | 3 / 3 | no window proven: walked | 0 | 0 | 0 | 0 | 0 / 43 |
| route B | rules0 | 3 / 3 | 9 / 9 | 0 | 0 | 0 | 0 | 0 / 42 (its windows end on the floor they took off from) |
| trip C (home, cave_2, cave_start) | on / rules0 | 3 / 3 | the cruise to the entrance (a stub offline), 54 blocks walked in | 0 | 0 | 0 | 0 | 0 / 54 |
| **the shortcut proof** (cave_5 through cave_shortcut to cave_end, flown on the model) | | **not proven**: at burn 15 the first window stops and sinks 13.6 blocks short of its landing with no hit (11 plans, all partial); `!fly route cave` flies the full route | | | | | | |

What this says: the style flies the two clean pieces the corridor proves (about 40 blocks of the 186) and walks the
rest with 0 to 3 of damage over the three burns; F4b's flight flies 124 blocks of it with 0 damage on these burns but
ends four windows in the water floors, and on route A it takes 1.7 to 1.9 and misses one trip. Track F5a's leg-mode
baseline on the same cave (the raw flight, nothing walked) hit 13 of 13 on the shortcut for about 110 of damage;
here the shortcut is never flown because it is never proven. Route A leg by leg is mostly under 24 blocks a leg
(`UNDER_FLY_MIN`): walked by construction.

### `!fly via`, `!fly route`, the shortcut

`!fly via <wp> <wp> ...` flies the named waypoints in order; `!fly route <prefix>` orders `<prefix>_start`,
`<prefix>_1 .. _N`, `<prefix>_end`. Both hand the executor a `WaypointProvider`: one fly leg whose waypoints are via
anchors of the windows (a 3 x 3 x 3 box each, the bend points between them, `stretches.ts nextWindow`), a portal at
every change between open sky and cover (the cruise lands 2 blocks inside it, as at a mouth), the rest the executor's:
with `flyCave on` the proof and the windows, with it off the walk; a sky leg is the cruise either way. A re-plan asked
from within 4 blocks of the last one walks its first segment. A `<prefix>_shortcut` is taken only when
`cave/proof.ts` has flown the stretch from its nearest numbered waypoint through it on the model over the burn's
nominal, shortest and longest, every window landing (or stopping and sinking within 8 blocks of its landing) with no
hit and the bore's margin kept in the air; the proof runs in a worker over a snapshot of the route grid and the reply
says which. `noshortcut` skips it. Offline: a straight 3 x 3 bore of 31 from standing is proven (burn 9 and 15 land on
the cell, 21 stops 6 short); a 2-high bore is refused (no jump glides under its ceiling).

### Open points (Track F5b)

- The 95 % clean-legs bar: the hits left are drift off a proven plan in wide irregular passages (1 to 1.5 blocks at
  1.3 to 1.6 a tick, under a burn other than the plan's nominal) before `bailError` fires; a lower threshold stops
  more flights, a tracker that keeps the burn branches as alternative references would track better.
- Tight caves (3 to 5 across) are walked: the proof finds no complete plan from standing there in 2 s. A takeoff
  into a 3-high passage is at the planner's edge; a longer proof budget or a takeoff primitive for low rooms would open
  them.
- The coarse layer's walk cost finds no corridor at all through `wide-103` (a 7-block drop) and refuses most fly-only
  corridors through caves with a 2-high pinch; the mixed search then walks whole caves whose middle is 2 high at one
  spot. The layer's costs are Track CB's; the flight should be able to land before a pinch, walk it and take off again
  (today the cost of two switches makes the walk cheaper).
- The server replica (fly-cave e2e) and the owner's cave are not flown: F5a's tooling.
- The bench's walks and cruises are stubs (a walk stands on its cell at once); the walked blocks are reported, not
  timed.

## Tight cave flight (Track F6)

Flight v2, Track F6, [decisions/0071](decisions/0071-tight-cave-flight.md). Track F5b made cave flight safe and left it
mostly walking (the owner: "is it flying from cave start to cave end, or just able to pathfind through it?"). This track
makes the proofs complete where plans exist, keeps the tracker on its plan under a burn other than the plan's nominal,
and stops the three ways a proven plan still hit. `flyCave` stays default **off**.

```
flyCave on, a cave window
  -> the proof from standing, the search IN PIECES of 3 goals (search.ts planPieces): each piece from the end of the one before,
     a partial piece searched once more with the piece before it; the plan must clear the walls by proveClearMin (0.15)
  -> flown on the proven plan; the burn read off the body RE-TIMES the reference (replayBurns) when the re-timed path is clear,
     else the plan counts as blocked where it would hit
  -> a plan blocked within the commit horizon (12 ticks) bails out at once; a re-plan asked for an unsafe tail wants a complete answer
  -> water is an obstacle to the planner and no floor to the windows (no plan through a pool, no landing on one, no takeoff from one)
```

### Files

| File | What |
|---|---|
| `bot/src/skills/fly/route/search.ts` | `planPieces` (`RouteRequest.pieces`), `planWhole`, `joinPlans`, `fieldView`; the field built once per request |
| `bot/src/skills/fly/route/field.ts` | the geodesic distance field (`buildField`, `fieldDistance`, `fieldBox`; `RouteRequest.geodesic`), measured off |
| `bot/src/skills/fly/route/primitives.ts` | `replayBurns` (a plan's states under the burns given per rocket) |
| `bot/src/skills/fly/route/tracker.ts` | `rules.retime` (`retime`, `burnHazard`, `firedAt`), `firstBlocked`, the bail-out within the commit horizon, `needComplete` on an unsafe tail, no held candidates and half the margin on the burn ends under the cave rules, the burn read's `nomBefore` |
| `bot/src/skills/fly/route/grid.ts`, `worker.ts` | `RouteGrid.bounds` (a snapshot's box, for the field) |
| `bot/src/skills/fly/corridor/stretches.ts` | `standable`, `mouthCell`, `changeCell`, `landingGoal`, `standableNear` take a `floor` query; `WindowOptions.floor`, `.landReach` |
| `bot/src/skills/fly/corridor/executor.ts` | `proveClearMin`, `landReach`, `CorridorPorts.floor`; `WindowProof.clearance` |
| `bot/src/skills/fly/corridor/drive.ts` | `TrackerChain.fireHeld` (a rocket the driver held leaves the belief), `windowRequest` carries the risk, the pieces and the field flag |
| `bot/src/skills/fly/corridor/cave.ts` | the fixture's grid and `solid` with water as an obstacle, `floor` the real solids |
| `bot/src/skills/fly/cave/style.ts` | `pieces` 3, `geodesic` false, `landReach` 2, `marginExtraFrom` 4 (`caveMargin`), `proveClearMin` 0.15, `rules.retime` |
| `bot/src/skills/fly/cave/proof.ts` | the shortcut proof plans each window from standing first and flies that plan over the burns |
| `bot/src/skills/fly/cave/bench.ts` | the trip worlds carry `floor`; water is an obstacle in the generated caves' grids too; a held rocket is told to the chain |
| `bot/src/chat/commands-fly.ts`, `commands-corridor.ts` | the live route grid and the corridor ports with water as an obstacle and a `floor` query; the proof's request as the trackers' |
| `bot/scripts/route-speed-bench.ts` | the planner's speed on a machine (the M4 calibration) |
| `bot/scripts/cave-gen-bench.ts` | the F6 variants (`f5b`, `nopieces`, `pieces2`, `geo`, `noretime`, `margin3`, `reach2`, `err10`, `prove6s`) |
| `bot/test/e2e/fly-cave.test.ts` | `flyC` (cave_start to cave_end on the layer's corridor, FLY_CAVE_RUNS 5) and `flyS` (the shortcut as a waypoint route, 3) |
| `bot/test/unit/skills/fly-cave-tight.test.ts` | the guard tests |

### What was measured first (the owner's cave, `scripts/cave-real-bench.ts`, this PC)

- **The proofs failed for want of search, not of plans.** The first window of the corridor (75 blocks, 7 goals through
  two chunk-border faces and a 16-block climb) has a complete, burn-robust plan: one search found it after 105 699
  expansions in 33.7 s. The proof's budget of 80 000 nodes is 2 000 to 4 500 expansions (an expansion pushes 17 to 45
  children), so the proof came back partial at 5 of 7 goals and the window was cut to 20 to 35 blocks or walked.
- **The heuristic was not the bottleneck.** The straight line and a geodesic field through the cave (`field.ts`) reached
  the same 5 to 6 of 7 goals at 80 000 nodes; with the search in pieces the straight line completed the window in 886
  expansions (293 ms) against the field's 2 764 (720 ms), and the whole 204-block stretch in pieces reached 18 of 22 goals
  with the straight line against 14 with the field. The field over every air cell was worse still: it ran through the
  one-cell cracks of the walls and pulled the search into them (3 of 7).
- **Margin.** The shortcut window (5 x 3) completed in 496 expansions at the bore margin 0.3 and needed 27 587 at
  F5b's 0.4; with the search in pieces the 96-block window completed at both.
- **The M4.** `scripts/route-speed-bench.ts` (four generated-cave requests, the nodes budget binding) on this PC and on
  the deploy host: 277 to 329 ms against 244 to 274 ms, 1 204 to 1 355 against 999 to 1 027; the M4 is 1.2 to 1.3 times
  faster, so a millisecond budget met here is met there. The live budgets (600 ms in flight, 2 s standing) are kept;
  at the M4's 25 to 30 nodes a millisecond in a wide cave the 600 ms are 15 000 to 18 000 nodes, in a tight one the
  40 000 nodes bind first (about 350 ms).

### The search in pieces (`search.ts planPieces`)

`RouteRequest.pieces` n: the goals are searched n at a time, each piece from the state the piece before ends in (its
replayed last state, the branches dropped; a burn still running at the boundary is branched from there as F4a branches
a running burn), the plans joined (`joinPlans`: the controls in order, the states re-flown from the start, the edges'
offsets moved, the least clearance, every piece robust). A partial piece is searched once more together with the piece
before it from the state before them (room to come in slower: a landing right after a fast passage is the usual
failure); still partial, the joined plan is the partial plan, its `reached` what its states pass. Each piece's nodes
budget is the request's, the ms budget the request's whole; the time of a dropped piece is charged to the next.

| the 75-block window, 7 goals, landing last (80 000 nodes / 8 s) | result | expanded / nodes | ms |
|---|---|---|---|
| one search, straight line | partial 6 / 7 | 7 157 / 80 017 | 1 716 |
| pieces of 3, straight line | complete | 886 / 10 679 | 293 |
| pieces of 2, straight line | partial 6 / 7 (the last piece) | 3 533 / 80 376 | 1 363 |
| pieces of 3, the field | complete | 2 764 / 31 148 | 720 |
| pieces of 3, straight line, margin 0.3 | complete | 1 088 / 12 742 | 339 |
| one search, 1 000 000 nodes | partial 5 / 7 | 65 102 / 1 000 000 | 24 428 |

### The tracker under the burn (`tracker.ts`)

- **Re-timed reference** (`rules.retime`). The burn read off the body (F4a's `readBoost`: a plain step while the belief
  boosted, a boosted one while it did not) re-flies the plan's controls with that burn (`replayBurns`: the k-th rocket
  the burn given, the rest nominal; a burn running at the plan's start as its ticks left) and, when the re-flown path
  sweeps clear ahead, the body is tracked against it. In the guard test the body under a 9-tick burn tracks the re-timed
  reference at 0.00 where the nominal one drifts away. When the re-flown path hits, the reference stays nominal (which is
  clear) and the plan counts as blocked at that tick (`burnHazard`). Adopting it unchecked made the set worse: 2 fatal
  trips on tight-107, the body following a re-timed reference into a wall 3 ticks on.
- **The burn read's off-by-one.** The step `readBoost` judges was flown with `nomBefore` ticks of the nominal left and
  was boosted iff that was over 0. Judged on the belief after its own tick, the last nominal tick read as "burns on past
  the plan" and the next as "ended early": two re-plans a nominal burn, and with the re-timing a reference re-flown to 18
  and then to 15 ticks.
- **A held rocket leaves the belief** (`TrackerChain.fireHeld`, the bench and `flyStretch`): a rocket the tracker asked
  for that the driver did not use (the loop's burn still runs) made the belief burn a rocket the body never had, read the
  next plain step as a burn of 1 tick and re-time the plan to it.
- **Blocked within the commit horizon: the bail-out now.** The worker's answer comes 12 ticks later and the horizon's
  ±16 degrees cannot steer round a wall in a 3-wide passage (tight-107 at burn 12: the wall 5 ticks ahead, the re-plan
  asked, 12.1 of damage). A re-plan asked because the plan's tail hits for an end of the burn wants a complete answer too
  (a partial one bails), as a blocked plan does.
- **No held candidates, half the margin on the burn ends, in a cave.** F4a's `optimise` abandons the plan's control for a
  held candidate (a yaw up to 90 off the heading) when the plan's tail hits at the margin for an end of the burn. On the
  owner's cave the body tracked a proven plan at 0.00 for 36 ticks, the check fired on the burn ending "now" (within the
  range the plan is robust to), the held candidate took it 1.3 off the plan in one tick and the window bailed out 2 blocks
  off. The cave rules keep the plan's own best control, judge the ends on half the margin (the plan keeps the margin at the
  burn's extremes by construction) and ask for the complete re-plan.

### The windows (`executor.ts`, `stretches.ts`, `style.ts`)

- **A proof keeps clear** (`proveClearMin` 0.15): a complete plan with less clearance is no proof (a plan of clearance 0.09
  from a body standing within the margin of a wall took 5.2 on the way out); the executor walks to the window's first
  goal and asks again from there.
- **The bore margin in a 3-high passage** (`caveMargin`, `marginExtraFrom` 4): F5b's extra 0.1 is added where the bore is 4
  high or more. At 0.4 everywhere the set flew 74 blocks a trip with 70 % of its legs clean; at the rule 61 to 96 with 90 to
  93 %.
- **The landing zone stays LANDING_REACH 2** (`landReach`): at 4, in a 3-wide bore the zone is the whole floor and the plan
  lands beside the wall (7 scrapes at burn 21 in a clean 3 x 3 bore; the unit test caught it).
- **Water** is an obstacle to the planner's grid and to the windows' `solid` (no plan through or into a pool, the margin
  kept over its surface), and no floor (`floor`: the real solids, so `standable`, `mouthCell`, `landingGoal` and
  `standableNear` never pick a cell over a pool, and a body in a pool has no takeoff: ADR 0068's rule). The live wiring
  (`commands-fly.ts`) treats water and lava so; the fixture's `caveWorld` and the generated caves' trip worlds too.

### Offline, the owner's cave (`scripts/cave-real-bench.ts --burns all`, the burns 9, 12, 15, 18, 21 and three random)

The style on, the live budget (600 ms in flight, 2 s / 80 000 nodes standing) and, "nodes-bound", the same with the
ms cap lifted (`--ms 100000`: the nodes budgets bind, as they do on a quiet M4; the wall-clock runs are what a loaded
PC gives). The corridor is the layer's own (one fly leg of 186), route A the waypoints as hints. "water" counts windows
whose bail-out sank onto a pool (0 damage; the next window starts from there).

| run | arrived | legs clean | damage a trip | worst hit | bail-outs | water | flown / walked blocks a trip | flown share |
|---|---|---|---|---|---|---|---|---|
| **cave_start to cave_end, the corridor**, live budget | 8 / 8 | 18 / 19 (95 %) | 0.35 | 2.8 | 15 | 5 | 111 / 143 | 44 % |
| the same, nodes-bound (`bailError` 1.5) | 8 / 8 | 20 / 21 (95 %) | 0.28 | 2.3 | 19 | 9 | 141 / 141 | 50 % |
| the same, nodes-bound, **the style** (`bailError` 1.0) | 8 / 8 | 19 / 19 (100 %) | 0 | 0 | 18 | 6 | 116 / 148 | 44 % |
| F5b (3 burns, docs above) | 3 / 3 | 3 / 4 | 0.99 | 3.0 | 3 | 0 | 39 / 172 | 18 % |
| **route A as hints**, live budget | 8 / 8 | 10 / 10 | 0 | 0 | 10 | 3 | 41 / 104 | 28 % |
| the same, nodes-bound (`bailError` 1.5) | 8 / 8 | 15 / 17 (88 %) | 0.63 | 2.5 | 17 | 7 | 81 / 97 | 46 % |
| the same, nodes-bound, **the style** | 8 / 8 | 21 / 22 (95 %) | 0.49 | 3.9 | 22 | 12 | 84 / 99 | 46 % |
| F5b | 3 / 3 | 6 / 6 | 0 | 0 | 3 | 1 | 34 / 147 | 19 % |
| **route B** (the shortcut as hints) | 8 / 8 | walked: no window proven | 0 | 0 | 0 | 0 | 0 / 43 | 0 % |
| **the shortcut proof** | not proven: the plan from cave_5 has no edge (the branch waypoint stands in a pool: no takeoff from water); from a dry cell the climb to cave_shortcut with a landing comes back partial (2 of 5 goals at 80 000 nodes) | | | | | | | |

The bars: on the corridor, 0 wall-damage events in 95 % of runs and no hit over 3 are met over the 8 burns (one hit of
2.3 to 2.8 in one run of eight, none in the style's own run); route A had one hit of 3.9 in eight runs; 70 % of the
underground blocks flown is not met (44 to 50 %). The walks left are the windows no proof
completes (the second half of the cave: a 16-block climb through chunk-border faces, then the pools), the proofs
refused for clearance, and the pieces after a bail-out. Nearly every window ends in a bail-out (the stop and the sink,
clean) rather than on its landing cell, which is why the trips are long on walks and short on damage.

### Offline, the generator set (`scripts/cave-gen-bench.ts --mode corridor --burns all`, 96 trips a row)

`on` is the style; `f5b` is this code with F6's pieces, re-timing, margin rule and landing zone off (the other F6
fixes, water as an obstacle and the held rocket, apply to both); the "live budget" rows were run on a loaded machine
(the ms cap binds and the proofs complete less: three runs of the same code gave 87, 92 and 93 % clean), the
"nodes-bound" rows with the ms cap lifted (the proofs complete as on a quiet M4, and far more is flown).

| variant | arrived | fatal | legs clean | damage a trip | worst hit | bail-outs | flown / walked a trip |
|---|---|---|---|---|---|---|---|
| F5b's own run (docs above) | 96 | 0 | 114 / 143 (80 %) | 1.26 | 10.7 | 95 | 51 / 126 |
| on, live budget (three runs) | 96 | 0 | 87 to 93 % | 0.56 to 0.72 | 5.8 to 12.6 | 119 to 167 | 61 to 68 / 107 to 113 |
| f5b, live budget | 96 | 1 | 115 / 127 (91 %) | 0.63 | 10.1 | 88 | 47 / 129 |
| on with `bailError` 1.5 (F5b's), nodes-bound | 96 | **2** | 176 / 223 (79 %) | 2.70 | 12.8 | 176 | 122 / 83 |
| **on, `bailError` 1.0 (the style), nodes-bound** | 96 | 0 | 207 / 245 (84 %) | 1.39 | 11.1 | 213 | 120 / 86 |
| f5b, nodes-bound | 96 | 0 | 140 / 167 (84 %) | 1.14 | 10.3 | 116 | 71 / 116 |

Per cave, `on`, nodes-bound, `bailError` 1.5 then 1.0 (the tight caves 101, 104 and the medium 102 are walked by the
layer's corridor itself; the flown ones):

| cave | legs clean (1.5) | worst hit (1.5) | flown / walked (1.5) | legs clean (1.0) | worst hit (1.0) | flown / walked (1.0) |
|---|---|---|---|---|---|---|
| wide-103 | 18 / 22 (82 %) | 7.5 | 131 / 97 | | | |
| medium-105 | 14 / 21 (67 %), **1 fatal** | 11.2 | 169 / 102 | 17 / 22 (77 %) | 11.1 | 172 / 118 |
| wide-106 | 24 / 27 (89 %) | 8.8 | 188 / 27 | | | |
| tight-107 | 20 / 31 (65 %), **1 fatal** | 12.8 | 238 / 43 | 21 / 24 (88 %) | 8.6 | 182 / 34 |
| medium-108 | 25 / 31 (81 %) | 5.9 | 179 / 35 | | | |
| wide-109 | 23 / 25 (92 %) | 5.1 | 136 / 21 | | | |
| wide-112 | 26 / 34 (76 %) | 9.6 | 215 / 34 | 42 / 51 (82 %) | 8.1 | 295 / 54 |

What this says, honestly: the proofs now complete in the tight caves (tight-107 flies 182 to 238 of its 281 blocks
where F5b walked it), and that is where the hits are. With the proofs completing the set is 79 to 84 % clean against
the bar of 95 %, and at F5b's `bailError` 1.5 two trips were fatal; the style's 1.0 stops the body a half block earlier
and had none, with the same flown fraction. The tracker in a 3-wide, 3-high passage still loses a proven plan under a
burn the plan did not assume faster than the bail-out stops it. On the owner's cave (3 x 4 and wider passages) the
same code keeps 95 % of its legs clean with a worst hit of 2.8. The 95 % bar is not met on the set; the hits are why
`flyCave` must stay off (the owner's rule) and why the next step is the tracker in tight passages, not more proofs.

### On the server (bds-fly2 and bds-fly3, BDS 1.26.60.6, 2026-11-07)

The cave replica (`fly-cave.test.ts`, `FLY_CAVE_STYLE=1`, the new runs):

| run | result | what happened |
|---|---|---|
| flyC, cave_start to cave_end on the layer's corridor (2 + 2 + 5 runs) | **0 arrived**: timeout at 180 s, 38 off, 0 damage | The layer's corridor on the replica starts with a cruise to the opening over the cave (the open top of a covered chunk, a y portal at y 94): the cruise lands on the surface by it (0.02 from its cell) and the underground stretch, laid from the surface, yields no window; the executor walks to the stretch's end 20 blocks down and the walk fails (`unreachable`, 350 ticks in water), the corridor is planned again (fly 85) and the same happens. Offline, the layer over the fixture starts the fly leg inside the cave (one leg of 186) and the same code flies 44 to 50 % of it. The first run of the day failed faster (5 re-plans in 2 s): the y face at the change had no standable cell with water as an obstacle; `changeCell` now falls back to the floors through water, and a cut window lands at a y face's or a step box's nearest standable cell. |
| flyS, the shortcut as a waypoint route (2 + 3 runs) | **0 arrived**: no corridor worked after 5 re-plans, 0 damage | The model's proof refuses it first (the plan from cave_5 has no edge: the branch waypoint stands in a pool). The trip's first fly leg (29) lays no window from the pool, the walk to the stretch's end (15 up) is `unreachable`, the provider's stuck rule walks the first segment, the same. |

The regressions, every suite on this branch after main 7bfa8e7d was merged into the tree:

| suite | server | result |
|---|---|---|
| fly-route | bds-fly3 | 3 of 3 green (the tunnel 2 x done 4 / 4, 0 damage; the stair 2 x done, 0 damage; the S-bend measured as before) |
| fly-corridor | bds-fly3 | 5 of 5 green |
| fly-land | bds-fly2 | 5 of 5 green |
| fly-course, FLY_AREA 71520,69472 | bds-fly2 | 7 of 8 (rings: 3 / 5 and 1 / 5, 0 damage); main on the same area: 7 of 8 (the slalom) |
| fly-course, FLY_AREA 66400,70496 | bds-fly2 | 7 of 8 (rings); main on the same area: 7 of 8 (rings) |
| fly-course, FLY_AREA 63328,66400 | bds-fly2 | 8 of 8 |

The open-air drivers carry no cave rules, so the tracker's F6 changes under `rules` do not touch them; the burn read's
off-by-one fix does (fewer spurious re-plans a nominal burn) and the course is not worse for it on the three areas.

### Open points (Track F6)

- **The flown fraction of the owner's cave is under the 70 % bar** (40 to 50 % over 8 burns; F5b: 21 %). What is left
  is walked for three reasons the lines name: a proof partial at the landing after a climb (the window cut back to its
  last reached goal, often under 24 blocks), a proof refused for clearance (the body stands against a wall), and the
  bail-outs: nearly every window still ends in a bail-out rather than on its landing cell (the stop and sink is clean, 0
  damage, but the next window starts from wherever the body came down, pools included).
- **The shortcut is not proven**: its branch waypoint stands in a pool (no takeoff from water, ADR 0068; with water an
  obstacle the search from there has no edge), and from a dry cell the climb to cave_shortcut has no complete plan with
  a landing in the budget (the landing right after a climb: the brake needs the burn surely over, 21 ticks after any
  rocket, and the window is 27 blocks). A brake that may be flown while the burn may still run (measured on the server
  first) is what this needs; the owner's rule keeps it off until then.
- **The generator set's clean share is 87 to 93 % against the bar of 95 %**, the worst hit 5.8 to 12.6 between runs of
  the same code: the ms budgets make the runs load-dependent (a proof that completes alone is partial under a full
  machine), so the tables carry the nodes-bound run too. The hits left are tight-107's and medium-108's: a body a block
  off a proven plan in a 3-wide passage, under a burn the plan did not assume, before the re-plan comes back.
- **The pieces prove windows, not the stretch**: a 22-goal stretch of 204 blocks reached 18 of 22 goals in 20 s. The
  funnel of the brief (plan the whole underground stretch while standing, track in the air) is open.
- **The replica's entry**: on bds-fly2 the layer's corridor enters the cave through the open top over it; the cruise lands
  on the surface by the opening and no window is laid from the surface, so flyC never flies (the table above). The
  stretch's start should be the floor under the opening (the executor lands there for a shaft; for a wide y face it
  lands on the open ground above) or the cruise should come down into it.
- **Trip C** (the cruise landing "no walking path from any landing cell") is untouched; the coarse layer's fly switch
  costs too (the owner's cave is one fly leg already; the generator caves the layer walks outright, 101, 102, 104, 105 and
  106, are the layer's choice, not the proofs').
- **The bench's budgets are wall-clock**: a run on a loaded machine proves less and flies less; `--ms 100000` gives the
  nodes-bound numbers. The M4 is 1.2 to 1.3 times faster than this PC on the same searches, so the live budgets are met
  with room.

## Tight passages (Track F7)

Flight v2, Track F7, [decisions/0073](decisions/0073-tight-passages.md). Track F6 left the tracker losing a proven plan in a 3
to 4 wide passage under a burn other than the plan's nominal, and nearly every window ending in a bail-out. This track puts
the tracker's eyes on the body instead of the timetable (the tube controller), lets the bail-out land dry, flies the landing's
last blocks closed loop, and fixes three things the traces found under the losses: the rockets the plans fire were never fired
when planned, a re-timing forgot the burns read before, and "robust by construction" was not. `flyCave` stays default **off**.

```
flyCave on, a cave window (the proof and the windows as F6 left them)
  -> the body matched to the plan BY POSITION (up to 8 states ahead of the time index, never behind): a burn longer or shorter
     than the plan's nominal moves the body along the path, not off it
  -> the horizon tracks the nearest point of the reference path; the candidates hold a yaw or pitch offset over the horizon
  -> the body's own forecast on the control chosen decides the bail-out: a collision within the commit horizon brakes NOW;
     wider held offsets are tried first when the plan's own control collides
  -> a rocket goes when the tracker asks (a burn still running or not, as the plans assume); the burns read are kept per rocket
  -> near the landing cell, slow: the brake landing's law from the real state (hold the height, creep nose up, flip over the cell)
  -> a bail-out's sink creeps onto the nearest dry floor within 3 (a body in a pool has no takeoff)
```

### Files

| File | What |
|---|---|
| `bot/src/skills/fly/route/tracker.ts` | `TrackerRules.tube` and `.blockedBail`; `LOCATE_AHEAD`, `TRACK_SLACK`; the held offsets and the wide ones (`WIDE_YAWS`); the forecast (`forecastHit`); `burnsRead`; `NEXT_PLAN_FAR` and `farFrom`; `settleControl` and `settleCell`; `TrackerOptions.floor`, `sinkTarget`, `SINK_REACH`; `TrackerOutput.debug` (the benches' trace) |
| `bot/src/skills/fly/route/search.ts`, `primitives.ts` | the pieces start from the piece before replayed with the burn branches (`replay(..., branches)`) |
| `bot/src/skills/fly/corridor/drive.ts` | the rocket fired when the tracker asks (no wait for the running burn's end); `ChainOptions.floor`, `StretchDeps.floor` |
| `bot/src/skills/fly/cave/style.ts` | `rules.tube` on, `rules.blockedBail` |
| `bot/src/skills/fly/cave/bench.ts` | `landed` and the tracker's worst tick in the score; rockets fired as the live driver fires them, the burn ended by the last rocket's removal; `latencyTicks` (a fixed latency for reproducible traces); the trace carries the tracker's debug every tick |
| `bot/src/chat/commands-corridor.ts` | the floor query to the stretch |
| `bot/scripts/cave-gen-bench.ts` | the variants `notube`, `bbail`, `nobbail`, `err15`, `err20` |
| `bot/test/unit/skills/fly-cave-tube.test.ts` | the guard tests |

### What was measured first (the owner's cave and the generator set, the bench's trace of every tick)

- **The bail-outs were not at the walls.** In a tight-107 trip all 5 windows bailed out "1.0 to 1.3 off the plan" in the open:
  a burn read as ended early re-flew the plan with that burn (F6's `retime`); where the re-flown controls hit, the reference stayed
  nominal and boosted on while the body did not; the error grew 0.05, 0.50, 1.21 in three ticks and the brake began. Where a
  re-timing was adopted, the next one gave the rockets read before their nominal back (`replayBurns` was given one burn), and the
  reference jumped 1.5 off a body tracking at 0.00.
- **The rockets were held.** The search fires a rocket in a burn's tail (F4a: from 9 ticks after the one before) and plans a fresh
  burn from it; the corridor driver (`drive.ts`) and the bench fired only with `boostTicks` 0, so every such rocket was held
  until the running burn's end (`fireHeld`), the plan's reference boosted on, the body did not, and the window bailed out "off
  the plan" (tight-107 at burn 15: 6 ticks of "the plan's tail hits for an end of the burn", one held rocket a tick). The
  open-air route driver (`route/live.ts`) never had the condition.
- **"Robust by construction" was not.** The proofs' plans re-flown open loop (`robust.ts flyBranch`) hit at the burn's own
  extremes: tight-107's first window, the first rocket at 9 and at 21, both hit about 20 ticks on; medium-108's single rocket at
  10 to 20 hit at 15 to 40 ticks. Two causes: the search in pieces started every piece from a plain replay of the one before
  (no branches: the states are replayed without them), and even in one search the burns between the branches hit the margin
  (one search of the same window: 9 and 21 clear, 10 to 16 hit the margin at ticks 16 to 20). The controls are a timetable; a
  body the burn carried farther takes the bend late.
- **The landing was replayed, not flown.** The plan's last edges are the brake landing's station-keeping law recorded open
  loop; the real body, 0.5 to 1.6 off, hovered down beside its cell (the owner's cave: windows that reached their last goal and
  stopped short, then bailed out "off the plan", or sank into the pool next to the landing cell).

### The tube controller (`tracker.ts`, `rules.tube`)

The pieces, each with what it was put in for (the traces above) and what it did on the traced trips (fixed worker latency of
12 ticks, the owner's cave corridor at burns 9 / 15 / 21 and tight-107, medium-105 and medium-108 at 12 / 15 / 21):

- **The match by position** (`locate`: up to LOCATE_AHEAD 8 states ahead of the time index, never behind the last match) and
  **the tracking cost to the path** (the nearest reference point within TRACK_SLACK 3 ticks of the matched one, not the point at
  the same tick). A body the burn carried farther or less far is matched where it is; the error left is the height a longer
  burn gained. In the guard test a body on a 21-tick burn against a plan on 15 is 0.8 off at worst with the tube and 1.6 without.
  A match that could go back a tick made a body sinking beside a descending path match earlier and earlier states (the match
  never goes back now).
- **The held offsets**: every yaw / pitch perturbation is tried once on the first tick (F2's) and once held over the whole
  horizon (a sustained correction). **The wide offsets** (25 to 70 degrees of yaw, 20 of pitch, held) are tried only when the
  plan's own best control collides within the horizon (F6 kept F4a's held candidates out of the caves because they jumped a
  body off a plan that was fine; here they are the last resort before the brake).
- **The forecast bail-out**: the control chosen is re-flown at PLAN_CLEAR_MIN over the horizon (the plan's controls after it, the
  forecast ending with the plan: the last control repeated sank it through the landing's floor and bailed every window out 8
  ticks before its cell); a collision within the commit horizon brakes now, at any speed (a slow touch may be a pool: the second
  window of the owner's corridor sank into one at 0.2 a tick). The reference's own collision course (F6) no longer bails under the
  tube: a re-timed reference is adopted also where the plan's controls hit (the hazard asks for a complete plan once), and the
  straight bore of the shortcut proof lands at 21 where F5b stopped 6 short. Every candidate hitting the margin asks for a plan
  once per plan.
- **The burn may end now** (`END_FORECAST` 3): while the burn may end (min 0, the nominal running), if NO candidate, the wide ones
  included, keeps clear of a WALL for 3 ticks without the boost, the brake begins now. A plan's brake flown under the boost (the
  boost reverses the body in a tick) and a turn at 1.55 a tick met the wall when the burn's last tick was plain, 7 to 11 of damage
  one tick after a clear forecast (medium-105 at the random burns of seed 8, wide-106 at 18). The floor is not a wall: the plan's
  dive in a clean 3-high bore sinks to it in 3 ticks without the boost and a nose-up candidate pulls out of it; a first version
  without the distinction bailed every bore flight out of its dive.
- **The burns read are kept per rocket** (`burnsRead`) and **a plan asked from ahead is dropped when it starts over 1.5 from the
  body** (`NEXT_PLAN_FAR`: when it is due, or back late), the reference having moved since; 4.5 and 11 blocks "off the plan" in
  the open were such adoptions.
- **`bailError` needs LOST_TICKS 3 ticks over** under the tube: a re-timing moves the reference, not the body, and the horizon
  converges in a few ticks (route A at 18: 0.43 then 1.15 after a re-timing, bailed, then a 9-block sink into a pit and the rest
  of the stretch walked).
- **The landing flown closed loop** (`settleControl`, within SETTLE_LOOP_NEAR 4 of the cell under SETTLE_LOOP_SPEED 0.5, above its
  top, no burn running): the station keeping at pitch -30 while faster than 0.35 (the height held), the look at the cell nose up
  (pitch -15: 0.4 a tick for 0.07 of sink) while farther than 0.6, the flip over it. The replayed law left bodies hovering down
  0.5 to 1.6 beside their cell; the owner's corridor at 15 landed 4 of 6 windows on their cells in the traced trip (0 of 5 before).
- **The sink onto a dry floor** (`sinkTarget`, `TrackerOptions.floor`): the column under the body when its first solid is a
  floor, else the nearest column within SINK_REACH 3 whose first solid is a floor no more than 6 down, with air at the body's
  height and all the way down; the creep is the settle's. The corridor wiring passes the live model's real solids.
- **`blockedBail`** (F5b's bail-out on a blocked complete plan whose re-plan is partial), a switch measured both ways (the tables).

Two things outside the tracker the traces made necessary: **the rockets fire when the tracker asks** (`drive.ts`, the bench; a
rocket used while one burns extends the boost to the later end, F0, and the belief's burn ends with the last rocket's removal),
and **a portal behind the body's progress along the stretch counts as passed** (`stretches.ts progressAlong`, `PROGRESS_FAR`:
Track R1's file, one rule added): the owner's corridor crosses a z face and comes back to that z about 40 blocks further on, and every
window laid from the landing there flew 79 blocks back to the face and landed where it took off (windows 2 to 6 of a trip,
the same cell both times; the flown blocks of a trip exceeded the cave's length).

### Offline, the generator set (`scripts/cave-gen-bench.ts --mode corridor --burns all --ms 100000`)

The layer's corridor, no waypoints, 8 burns a cave, nodes-bound (the ms cap lifted: the numbers do not swing with the load; they
still differ between runs of the same code by the worker's latency, which is the search's own wall-clock). "the flown caves" are
the nine the layer's corridor flies (tight-101, medium-102 and tight-104 are walked by the layer itself, 24 trips at 0 damage in
every row). The rows are stages of the code, each measured on the way; the last is the style as shipped.

| code | caves | arrived | fatal | legs clean | landed | damage a trip | worst hit | trips at 0 | bail-outs | flown / walked a trip |
|---|---|---|---|---|---|---|---|---|---|---|
| **main (F6)** | 12 | 96 / 96 | **1** | 202 / 237 (85 %) | 35 / 237 (15 %) | 1.38 | 12.8 | 66 / 96 | 201 | 120 / 86 (58 %) |
| the tube (position match, held offsets, forecast bail, re-timed reference adopted) | 12 | 96 / 96 | 0 | 207 / 232 (89 %) | 45 / 232 (19 %) | 0.74 | 9.7 | 74 / 96 | 196 | 126 / 93 |
| + the burns read per rocket, the settle, the dry sink, the wide offsets, `blockedBail` as a switch | 12 | 96 / 96 | 0 | 204 / 228 (89 %) | 36 / 228 (16 %) | 0.82 | 11.2 | 78 / 96 | 192 | 133 / 91 (59 %) |
| + a plan from ahead dropped only when adopted late (not when back early), the stretch's progress rule, `bailError` over 3 ticks, the burn-may-end check | the flown 9 | 72 / 72 | 0 | 167 / 189 (88 %) | 30 / 189 (16 %) | 0.94 | 10.7 | 54 / 72 | 164 | 145 / 51 (74 %) |
| the same, `blockedBail` off | the flown 9 | 72 / 72 | 0 | 168 / 187 (90 %) | 34 / 187 (18 %) | 0.94 | 10.7 | 57 / 72 | 155 | 147 / 49 (75 %) |
| **the style as shipped** (+ the burn-may-end check over 5 ticks, a riser under a dive a wall, `blockedBail` off) | the flown 9 | 72 / 72 | 0 | 194 / 212 (92 %) | 36 / 212 (17 %) | 0.91 | 9.7 | 55 / 72 | 181 | 140 / 53 (73 %) |

Over the whole set the shipped style is 96 of 96 arrived, 0 fatal, 92 % of legs clean (the three walked caves fly none), 79 of
96 trips at 0 damage, 59 % of the set's blocks flown. Per cave, the shipped style (8 burns each):

| cave | legs clean | landed | damage a trip | worst hit | trips at 0 | bail-outs | flown / walked |
|---|---|---|---|---|---|---|---|
| wide-103 | 9 / 11 (82 %) | 1 / 11 | 0.41 | 2.9 | 6 / 8 | 10 | 103 / 80 |
| medium-105 | 17 / 19 (89 %) | 1 / 19 | 0.51 | 3.7 | 6 / 8 | 18 | 104 / 51 |
| wide-106 | 25 / 26 (96 %) | 7 / 26 | 0.16 | 1.3 | 7 / 8 | 24 | 155 / 37 |
| tight-107 | 28 / 30 (93 %) | 5 / 30 | 1.33 | 9.3 | 6 / 8 | 26 | 188 / 46 |
| medium-108 | 42 / 43 (98 %) | 7 / 43 | 0.76 | 3.9 | 7 / 8 | 36 | 196 / 39 |
| wide-109 | 21 / 24 (88 %) | 3 / 24 | 1.33 | 5.3 | 5 / 8 | 21 | 114 / 30 |
| tight-110 | 8 / 8 | 3 / 8 | 0 | 0 | 8 / 8 | 5 | 49 / 106 |
| medium-111 | 22 / 23 (96 %) | 5 / 23 | 0.06 | 0.5 | 7 / 8 | 18 | 140 / 62 |
| wide-112 | 22 / 28 (79 %) | 4 / 28 | 3.64 | 9.7 | 3 / 8 | 23 | 208 / 30 |
| tight-101, medium-102, tight-104 | walked by the layer | | 0 | 0 | 24 / 24 | 0 | 0 / 129 to 177 |

F6's per-cave worst hits on the same caves were 7.5 to 12.8 with two fatal trips at `bailError` 1.5 and 8.1 to 11.1 at 1.0; the
tight caves 107 and 110 are at 93 and 100 % clean now. The worst tracker tick over the 96 trips: 9.9 ms on this PC.

The hits left, each traced to its tick: **medium-111 10.7, tight-107 8.5 and 11.6, medium-105 11.2, wide-106 6.9** are one
mechanism: a plan's brake or turn at 1.4 to 1.6 a tick in a 3 to 4 wide passage that relies on the boost's last ticks (the rocket
brake reverses the body in a tick; a turn under the boost follows the look), with the burn ending 1 to 3 ticks before the plan's
nominal; the body meets the wall one tick after a clear forecast. The burn-may-end check (no candidate keeps clear of a wall for
5 ticks without the boost: fly the one that does, else brake) took tight-107's trip of seed 7 from 20.1 (a death) to 11.7 and
then to 0 on the traced runs, but the mechanism is the plan's: a sharp manoeuvre at full speed next to a wall has no margin for
the burn's last tick, and only a planner that prices speed by clearance (or refuses rocket edges in tight sections) removes it.
That is the open point of this track. The bars of 95 % clean legs and a worst hit under 4 are **not met** on the generator set;
0 fatal, 100 % arrived and the flown share (74 to 78 % of the flown caves' blocks, 58 % of the set's) are.

### Offline, the owner's cave (`scripts/cave-real-bench.ts --mode corridor,routeA --burns all`, 8 burns a row)

The layer's corridor (one fly leg of 186) and route A as hints, nodes-bound (`--ms 100000`) and at the live budget (600 ms in
flight, 2 s standing); the burns 9, 12, 15, 18, 21 and three random. "landed" are windows that ended on their landing cell;
"flown share" is flown / (flown + walked) blocks. The runs differ from one another by the worker's latency (the search's own
wall-clock), so two runs of the same code are shown where there are two.

| run | arrived | legs clean | landed | damage a trip | worst hit | trips at 0 | bail-outs | water | flown / walked | flown share | worst tracker tick |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **corridor, main (F6)**, nodes-bound | 8 / 8 | 30 / 30 | 4 / 30 (13 %) | 0 | 0 | 8 / 8 | 25 | 13 | 179 / 140 | 56 % (the windows flown back and forth included) | - |
| corridor, **F7**, nodes-bound, run 1 | 8 / 8 | 13 / 13 | 3 / 13 (23 %) | 0 | 0 | 8 / 8 | 11 | 2 | 112 / 90 | 55 % | 4.8 ms |
| corridor, F7, nodes-bound, run 2 | 8 / 8 | 15 / 16 (94 %) | 3 / 16 (19 %) | 0.53 | 4.2 | 7 / 8 | 13 | 5 | 120 / 89 | 57 % | 6.7 ms |
| corridor, F7, `blockedBail` off, nodes-bound | 8 / 8 | 14 / 14 | 3 / 14 (21 %) | 0 | 0 | 8 / 8 | 12 | 3 | 121 / 84 | 59 % | 7.0 ms |
| corridor, F7, `bailError` 1.5, nodes-bound | 8 / 8 | 11 / 11 | 2 / 11 (18 %) | 0 | 0 | 8 / 8 | 10 | 3 | 110 / 82 | 57 % | 6.2 ms |
| corridor, **the style as shipped**, nodes-bound | 8 / 8 | 18 / 19 (95 %) | 4 / 19 (21 %) | 0.62 | 5.0 | 7 / 8 | 16 | 7 | 142 / 81 | 64 % | 7.8 ms |
| corridor, F7, **live budget**, run 1 | 8 / 8 | 10 / 10 | 3 / 10 (30 %) | 0 | 0 | 8 / 8 | 8 | 3 | 97 / 96 | 50 % | 4.7 ms |
| corridor, F7, live budget, run 2 | 8 / 8 | 12 / 12 | 3 / 12 (25 %) | 0 | 0 | 8 / 8 | 10 | 4 | 102 / 95 | 52 % | 9.6 ms |
| corridor, **the style as shipped**, live budget | 8 / 8 | 13 / 13 | 4 / 13 (31 %) | 0 | 0 | 8 / 8 | 10 | 2 | 107 / 97 | 52 % | 7.6 ms |
| **route A, main (F6)**, nodes-bound | 8 / 8 | 21 / 22 (95 %) | 0 / 22 | 0.49 | 3.9 | 7 / 8 | 22 | 12 | 84 / 99 | 46 % | - |
| route A, **F7**, nodes-bound, run 1 | 8 / 8 | 13 / 14 (93 %) | 0 / 14 | 0.38 | 3.0 | 7 / 8 | 14 | 1 | 69 / 102 | 40 % | 8.5 ms |
| route A, F7, nodes-bound, run 2 | 8 / 8 | 13 / 14 (93 %) | 0 / 14 | 0.38 | 3.0 | 7 / 8 | 13 | 2 | 75 / 100 | 43 % | 11.3 ms |
| route A, F7, `blockedBail` off | 8 / 8 | 13 / 14 (93 %) | 0 / 14 | 0.38 | 3.0 | 7 / 8 | 14 | 1 | 69 / 102 | 40 % | 8.7 ms |
| route A, F7, `bailError` 1.5 | 8 / 8 | 16 / 17 (94 %) | 0 / 17 | 0.38 | 3.0 | 7 / 8 | 16 | 3 | 71 / 107 | 40 % | 5.8 ms |
| route A, **the style as shipped**, nodes-bound | 8 / 8 | 13 / 14 (93 %) | 0 / 14 | 0.38 | 3.0 | 7 / 8 | 13 | 2 | 75 / 99 | 43 % | 9.0 ms |
| route A, F7, live budget | 8 / 8 | 12 / 13 (92 %) | 1 / 13 (8 %) | 0.38 | 3.0 | 7 / 8 | 12 | 0 | 64 / 103 | 38 % | 11.1 ms |
| route A, **the style as shipped**, live budget | 8 / 8 | 12 / 13 (92 %) | 0 / 13 | 0.38 | 3.0 | 7 / 8 | 12 | 1 | 66 / 102 | 39 % | 7.3 ms |

What this says. **The damage bars hold on the owner's cave**: the corridor is at 0 damage in 7 of 8 runs of each row (one hit of
4.2 to 5.0 in one run of six: the second window's turn at 1.4 a tick under a 12-tick burn, the wall 2 ticks after the burn's
end was read; the same spot every time it hits), route A has one hit of 3.0 in one burn of eight in every row (the same window), never
fatal. **The flown share does not reach 70 %**, and it is not the tracker that caps it any more: after the first window lands
on its cell (the cut landing of the first 91 blocks), the proof of the next window is partial (6 of 7 goals, the
landing after the 16-block climb through the chunk-border faces, F6's known limit), the cut back to the goals reached gives no
shorter window and the executor's unproven rule walks to the STRETCH'S END (82 blocks) rather than to the next goal; route A's
first window (42 blocks, the landing its only goal) bails out at 1.0 to 1.2 off, sinks 9 blocks into the pit under it and the
executor walks the rest of the stretch from there (108 blocks). Both are executor rules (Track R1's: the cut-back and the walk
target when no proof completes) and are reported to R1. F6's 44 to 50 % was flown back and forth (windows laid from the first
landing flew 79 blocks back to a portal plane the corridor re-crosses and landed where they took off: 500 blocks flown for a 186
cave); with the progress rule the flown blocks are honest and the share is what the proofs allow: 50 to 59 % on the corridor,
38 to 43 % on route A. **Landed windows**: 3 of 10 to 16 on the corridor (0 of 30 to 4 of 30 before), none on route A (its first
window bails before its cell in every burn). The tracker's own tick costs 5 to 11 ms at worst on this PC (the M4 is faster).
`blockedBail` off and `bailError` 1.5 change nothing measurable here; the style keeps `blockedBail` on as F5b left it (the
generator set's table decides).

### On the server (bds-fly2 and bds-fly3, BDS 1.26.60.6, 2026-11-08)

`fly-cave.test.ts` flyA (route A leg by leg as corridor trips, `FLY_CAVE_STYLE=1`), three full runs on bds-fly2, the benches
running on this PC meanwhile (the route worker shares its CPU):

| run | arrived | damage | windows flown | rockets | ticks in water | time | how the windows ended |
|---|---|---|---|---|---|---|---|
| 1 | 22 / 22 | 0 | 2 (legs 0 and 1) | 4 | 1 317 | 380 s | 1.3 off the plan after a correction of 1.26 (the brake, the sink); the forecast's bail at 0.37 a tick 6 ticks before a collision |
| 2 | 22 / 22 | 0 | 2 | 4 | 2 025 | 330 s | a blocked plan with a partial re-plan (`blockedBail` still on in this run), the sink into the pool and 900 ticks in it before the tick cap; 2.2 off after a correction of 1.21 |
| 3 | 22 / 22 | 1.0 | 2 | 3 | 1 299 | 274 s | 1.3 off the plan; the forecast's bail 1 tick before a collision at 0.75 a tick (2 local hits, 1.0 of damage) |

Route A on the replica is mostly the layer's walk legs: the corridor planner chooses `walk` for legs 3 to 21 (the pools and the
climb), so only the first two legs lay windows (45 and 35 blocks), and both bail out before their cell in every run: the body
left its plan by 1.3 to 2.2 after a server correction of 1.2 to 1.3 (Realm-sized; the bench has none) or, once, the forecast
stopped it 6 ticks early at 0.37 a tick. Nothing hit hard (1.0 in one of 66 legs), nothing died. Run 2's first window sank into a
pool and stayed a window for 900 ticks: the live stretch had no end for a glide that ended in water (`drive.ts` ends it now; the
bench always had). Whether the sink chose a dry cell on the server could not be read off the report.

The regressions, the final code (the two load-sensitive suites were run again with no bench running; the first runs were under
four to six bench workers):

| suite | server | result |
|---|---|---|
| fly-route | bds-fly3 | 3 of 3 green |
| fly-land | bds-fly2 | 5 of 5 green |
| fly-corridor | bds-fly3 | **5 of 5 green** quiet; under load 3 of 5 (the coarse layer's 4 s corridor search bound: "search limit hit (4000 ms)", not a flight failure) |
| fly-course, FLY_AREA 71520,69472 | bds-fly2 | 7 of 8 (rings, the ms budget bound under load); main on the same area: 7 of 8 (the slalom) |
| fly-course, FLY_AREA 66400,70496 | bds-fly2 | 7 of 8 (rings); main: 7 of 8 (rings) |
| fly-course, FLY_AREA 63328,66400 | bds-fly2 | **8 of 8 green** quiet; under load 7 of 8 (rings: every plan partial, "the ms budget ran out"); main: 8 of 8 |

The open-air drivers carry no cave rules, so nothing of the tube touches them; the one change they share is `replay`'s optional
branches (default off) and the search's pieces (the cave style's only).

### Open points (Track F7)

- **The hits left are the plans', at full speed next to a wall**: a brake or a turn at 1.4 to 1.6 a tick in a 3 to 4 wide passage
  that relies on the boost's last ticks, with the burn ending 1 to 3 ticks early (medium-111 10.7, tight-107 8.5, medium-105
  11.2, wide-106 6.9). The tracker now flies the candidate that is safe both with and without the boost and brakes when there
  is none, which halves the hit or removes it on the traced trips, but the margin is the planner's to make: price speed by
  clearance (or refuse rocket edges in tight sections) so that a burn's last tick is worth half a block, not two. Until then the
  95 % and under-4 bars of the generator set are not met and `flyCave` stays off.
- **The flown share of the owner's cave is capped by the proofs and the executor, not the tracker**: after the first window lands
  the next proof is partial at the landing after the climb (F6's limit), the cut back gives no shorter window and the unproven
  rule walks to the stretch's end; route A's first window bails before its cell and the walk takes the rest. Both for Track R1
  (`executor.ts` cut-back and walk target), with the traces in this section.
- **Server corrections of 1.2 to 1.3 blocks** put the body 1.3 to 2.2 off its plan on bds-fly2 (none in the bench): the
  `bailError` rule stops the body there. A bench with the Realm's corrections (ADR 0069 measured 0.7 to 0.8 in normal flight) would
  say whether the three-tick rule should be longer or the correction folded into the reference.
- **Landed windows** are 15 to 50 % per cave on the set and 20 to 30 % on the owner's corridor: most windows still end in a
  bail-out, now mostly the forecast's (a plan on a collision course under the burn read) rather than the error's.
- The bench's trip-level loop (windows laid back to a re-crossed portal plane) is closed by the progress rule in `stretches.ts`;
  R1 owns the file and may prefer another form of it.
- GPU work: none; the benches run in minutes on worker threads and the tracker's tick costs 5 to 18 ms at worst on this PC.

## Cave entry (Track F8)

Flight v2, Track F8, [decisions/0074](decisions/0074-cave-entry.md). The owner (2026-11-08): "What actually has to be done
to get it to fly into the cave? It once again just failed with `!fly cave_start`." On the Realm the trip's first corridor
was partial (the 4 000 ms search limit, 32 blocks short), the cruise held over a ground "not loaded yet", landed 29 blocks
off on the surface beside the cave, and the walk down failed. On the replica no flyC run had arrived. This track makes the
entry from above: the corridor searched again from its partial end and joined before anything flies, the cruise coming down
INSIDE a roof opening (the brake over the rim, the elevator to the floor under it), a replica whose surroundings are the
Realm's and not a mesa on a flat world, and, in the planner, the burns between the extremes swept too (Track F7's open
point: a plan robust at 9 and 21 hit the margin for the burns in between). `flyCave` stays default **off** in the code; the
coordinator turned it on live the same evening (the owner set keepInventory).

```
!fly <covered goal> far off
  -> the corridor search (4 s); partial -> a second search from its end (2.5 s): joined into one corridor when found
  -> the sky stretch's cruise to the change cell; down a y opening the executor names the opening's plane as the RIM:
       the landing search treats the dry floor under it as a pit floor (the brake over the rim, the elevator down),
       the hold circles over the rim while the floor's chunk is not loaded, never a touchdown on the surface beside it
  -> the underground windows as Tracks F5b to F7 left them, the planner sweeping the burns 12 and 18 besides 9 and 21
       (speed by clearance is in the code, measured, off: it needs a wall-only clearance)
```

### Files

| File | What |
|---|---|
| `bot/src/skills/fly/corridor/executor.ts` | `CORRIDOR_JOIN_MS`, `joinCorridors` (the second search from a partial end, joined), `SkyHint` (the rim to the cruise), `CorridorReport.joins` |
| `bot/src/skills/fly/landing.ts`, `brake.ts` | `LandingOptions.rim` (a pit floor under a rim the caller knows: `preciseGoal`, never the plain goal), `brakeMaxTicks` (the simulation's horizon grows with the depth) |
| `bot/src/chat/commands-fly.ts`, `commands-corridor.ts`, `tasks/process/fly.ts` | the hint through `corridorSky`, `planFlight`, `landingFor`, `LandingHint`, the held target's `rim`, `watchLanding` |
| `bot/src/skills/fly/corridor/cave.ts` | `replicaCoarse` (the replica's world for the layer offline), `replicaTerraces` (the real heights round the box from the extract's tops), `REPLICA_SHELL`, `REPLICA_HOME_CHUNKS` |
| `bot/src/skills/fly/route/types.ts`, `primitives.ts`, `search.ts`, `tracker.ts` | `MID_BURNS`, `RouteState.mids`, `midLefts`; the mids stepped, swept, carried across the pieces, stripped off a re-plan's start; `SPEED_RULE` / `speedCap` (speed by clearance, applied per tick in `edgeOf`; measured, off) |
| `bot/scripts/cave-entry-probe.ts` | the corridor into the owner's cave from the command line (the fixture or the replica's world, the second search, the legs' shapes; no coordinate printed) |
| `bot/scripts/cave-gen-bench.ts`, `cave-real-bench.ts` | the variants `nomids`, `nospeed`, `slow06`, `slow04` |
| `bot/test/e2e/fly-cave.test.ts` | the replica's surroundings (`buildSurroundings`: the shell and the terraces from teleport stops), trip C with the style and FLY_CAVE_RUNS |
| `bot/test/unit/skills/fly-cave-entry.test.ts` | the guard tests |

### What was measured first (the Realm's log, the fixture, `scripts/cave-entry-probe.ts`)

- **The partial corridor is the heuristic's.** The layer's search prices the sky at 0.8 ticks a block and its heuristic is the
  straight line at the flight's slope (weighted 1.5); the way underground costs 160 ticks through a mouth, 60 and a sink
  through an opening and 1.7 a block inside. A covered goal makes every sky node within a few hundred blocks cheaper than
  the way in, and the sweep pays for every chunk it touches: on the replica's world the search from a surface start 660
  blocks from cave_start built 1 548 chunks and 2 778 border portals (3.0 of its 4.0 s) for 9 300 expansions and ended on
  the surface by the entrance, 33 blocks from the goal; with 20 s it built 8 878 chunks and still ended 12 blocks short.
  From that end the way in is found in 30 to 50 ms (300 to 800 expansions). Underground the corridors are found at once
  (cave_start to cave_end: one stretch of 186 in 0.3 to 0.5 s). The Realm's log of the owner's trip is the same picture:
  4 000 ms, 32 blocks short; the second plan after the landing, found in 2 s.
- **The cruise could not see the pit.** `preciseGoal` scanned the rim round a shaft floor OPEN_SKY (20) up and only where the
  walls touch the cell; the dry floor under a wide, deep opening (the owner's cave: 46 under the rim, the pit 11 across) has
  floor cells, not walls, round it and sky above, so the landing search called it a plain open cell (the flare's glide
  line, into the pit's wall) or a precision cell under open sky whose simulated approach met the wall, and the cruise took
  the fallback: dry ground beside the cave, 29 blocks off.
- **The replica was a mesa.** Outside the extract's box bds-fly2 is the flat world 160 blocks below the box's surface. The
  box's edge slices the cave open (a cliff with the cave's cross-section in it) and the layer's corridor into cave_start
  went in through that cut face, 33 blocks from the goal, where the fixture (solid outside the box) and the Realm have rock;
  flyC's corridor left the cave the same way. The offline fixture and the replica disagreed, and neither was the Realm.

### The pieces

- **The second search** (`executor.ts`): a partial corridor's last leg ends where the search stopped; a second search from
  there to the goal (2 500 ms, the mode of that leg: no takeoff charged) is asked before anything flies, and when it is
  found the two are joined (`joinCorridors`: a fly leg and a fly leg become one leg, the waypoints and portals in order,
  the totals summed; different modes are appended). The cruise then aims at the real change into the cave (the mouth cell,
  the floor under the opening) instead of the partial end. A partial second search leaves the first as it was (the trip
  re-plans from its end, as before).
- **The rim** (`SkyHint`, `LandingOptions.rim`): down a y opening whose plane lies 2 or more over the landing cell the executor
  tells the cruise the opening's plane; the landing search then skips the plain goal, calls the cell a pit floor that deep
  and simulates the brake landing in over the rim along four bearings (APPROACH_HEIGHT above it, the brake over the cell,
  the elevator down: `brakeMaxTicks` adds the sink past 20 down to the simulation's horizon); the held target carries the
  rim too, so the hold circles over the rim and every look from the air is asked with it. Offline (the model, an 11 x 11 pit
  46 deep, two seeds): the whole trip comes down inside the pit onto the cell by the brake, no hit, no go-around, touchdown
  under 0.36 a tick.
- **The replica's surroundings** (`fly-cave.test.ts buildSurroundings`, `cave.ts replicaCoarse`): a stone shell one block
  thick round the box's sides from the flat ground to the box's top, and the real terrain's heights round it from the
  extract's column tops (a chunk at a time, its lowest known top; none round home, whose tops are the owner's roofs), sent
  as fills from a grid of teleport stops 128 blocks apart (a fill wants its chunks loaded). The same world for the layer
  offline: `scripts/cave-entry-probe.ts --source replica`. With it the corridor from the surface start is partial at 4 s as
  before (the sweep), the second search finds the way in through the real mouth in 30 ms, and the joined corridor is one
  fly leg (sky 872, the mouth, under 39) and a walk of 10.
- **The burns in between** (`MID_BURNS` 12 and 18): a rocket starts four branches (9, 12, 18, 21) next to the nominal body,
  each boosted for its own burn and swept with the same controls; an edge is taken only when all clear. A rocket used in a
  burn's tail extends each branch's burn to the later end (the union). The pieces carry the mids across their seams and a
  re-plan's start drops them with the extremes. The benches' `nomids` variant is the planner without them. Only the cave style
  asks for them (`CaveStyle.midBurns`, `RouteRequest.midBurns`); open-air flight plans as before.

### Offline, the generator set (`scripts/cave-gen-bench.ts --mode corridor --burns all --ms 100000`)

The layer's corridor, no waypoints, 8 burns a cave, nodes-bound, 4 workers on this PC (the baseline ran while the cave e2e shared
the CPU, the mids run alone; the trips differ between runs by the worker's latency). `main` is this branch's planner before the
mids (the executor's entry changes do nothing to the offline trips); `mids` is the style as shipped. "landed" are windows that
ended on their landing cell; the flown caves are the nine the layer flies (tight-101 and medium-102 are walked by the layer in
both, tight-110 by the proofs in the mids run).

| planner | arrived | fatal | legs clean | landed | damage a trip | worst hit | trips at 0 | bail-outs | flown / walked a trip | run |
|---|---|---|---|---|---|---|---|---|---|---|
| main (the extremes 9 and 21 swept) | 96 / 96 | 0 | 232 / 254 (91 %) | 33 / 254 (13 %) | 1.08 | 10.4 | 75 / 96 | 218 | 121 / 66 | 1 785 s |
| **mids** (9, 12, 18 and 21 swept) | 96 / 96 | 0 | 146 / 152 (**96 %**) | 64 / 152 (**42 %**) | **0.18** | **8.3** | 91 / 96 | 104 | 86 / 86 | 3 776 s |

Per cave, `mids` (8 burns each):

| cave | legs clean | landed | damage a trip | worst hit | trips at 0 | flown / walked | main's legs clean, worst hit |
|---|---|---|---|---|---|---|---|
| wide-103 | 11 / 11 | 4 / 11 | 0 | 0 | 8 / 8 | 40 / 132 | 17 / 19, 2.9 |
| tight-104 | 11 / 12 | 3 / 12 | 0.06 | 0.5 | 7 / 8 | 113 / 93 | 21 / 22, 1.7 |
| medium-105 | 10 / 10 | 2 / 10 | 0 | 0 | 8 / 8 | 89 / 68 | 17 / 19, 3.7 |
| wide-106 | 15 / 16 | 5 / 16 | 1.04 | **8.3** | 7 / 8 | 143 / 18 | 26 / 29, 8.5 |
| tight-107 | 18 / 18 | 10 / 18 | 0 | 0 | 8 / 8 | 90 / 84 | 27 / 29, 9.3 |
| medium-108 | 20 / 20 | 14 / 20 | 0 | 0 | 8 / 8 | 145 / 60 | 44 / 45, 3.9 |
| wide-109 | 16 / 20 | 3 / 20 | 1.07 | 2.9 | 5 / 8 | 101 / 48 | 24 / 27, 5.3 |
| tight-110 | walked (no window proven) | | 0 | 0 | 8 / 8 | 0 / 151 | 8 / 8, 0 |
| medium-111 | 20 / 20 | 12 / 20 | 0 | 0 | 8 / 8 | 119 / 71 | 25 / 27, 10.4 |
| wide-112 | 25 / 25 | 11 / 25 | 0 | 0 | 8 / 8 | 195 / 29 | 23 / 29, 9.7 |

What this says. Sweeping the burns in between is what Track F7's diagnosis asked for: the hits of 9 to 10 in tight-107, medium-111
and wide-112 are gone, the legs are 96 % clean (the bar is 95), three times as many windows land on their cell (the plans no longer
rely on a burn's last ticks next to a wall, so the body stays on them to the end) and the damage a trip is a sixth. The price is
flown distance: a window whose plan needs a rocket near a wall now has no proof and is walked (tight-110 entirely, wide-103 for
two thirds), 86 blocks a trip flown against 121. One hit of 8.3 remains (wide-106 at a random burn; main took 7.2 and 8.5 there at other
burns) and wide-109 takes 2.9 twice, so the under-4 bar is **not** met; those two caves are where the speed rule below is measured.

**Speed by clearance** (`types.ts SPEED_RULE`, `primitives.ts edgeOf`): a tick flown with the swept box within `clear` of a solid
(beyond the margin) may not be faster than `slow` at clearance 0, rising to `fast` at `clear`; a faster tick refuses the edge. The
variant `slow06` (clear 0.6, slow 0.8, fast 1.6) on the two caves that still hit with the mids, 8 burns each, nodes-bound:

| cave | planner | legs clean | landed | damage a trip | worst hit | trips at 0 | flown / walked |
|---|---|---|---|---|---|---|---|
| wide-106 | mids | 15 / 16 (94 %) | 5 / 16 (31 %) | 1.04 | **8.3** | 7 / 8 | 143 / 18 |
| wide-106 | mids + slow06 | **18 / 18** | **11 / 18 (61 %)** | **0** | **0** | 8 / 8 | 128 / 23 |
| wide-109 | mids | 16 / 20 (80 %) | 3 / 20 (15 %) | 1.07 | 2.9 | 5 / 8 | 101 / 48 |
| wide-109 | mids + slow06 | 21 / 25 (84 %) | 8 / 25 (32 %) | 1.33 | 2.9 | 6 / 8 | 113 / 36 |

The rule takes the 8.3 away (the plan no longer turns at 1.5 a tick beside the wall there) and doubles the landed windows, for the
same flown distance (121 against 122 blocks a trip over the two). On the owner's cave it costs nothing: the corridor 8 / 8 clean at
0 damage, 88 flown / 96 walked (the mids alone 87 / 86), route A the same 19 / 21 clean with its 4.4. **It ships off all the same**
(`SPEED_RULE_DEFAULT` clear 0; `SPEED_RULE_MEASURED` is the value above): the sweep's clearance counts floors and ceilings as it
counts walls, and in a 3-high bore a body just off the floor at the takeoff, or coming down onto its cell, is within 0.6 of a
solid at glide speed, so the rule refused fly-route's tunnels and the shortcut proof through a straight 3 x 3 bore (the unit
tests caught it; the owner's cave and the two generator caves are wider than 3 at the spots it mattered). What it needs is a
wall-only clearance (the horizontal distance to a solid beside the box), which the sweep does not give today; with that it is
the lever that takes the last big hit away. The whole generator set with the rule on is not run (the mids run alone took 63
minutes on 4 workers).

### Offline, the owner's cave (`scripts/cave-real-bench.ts --mode corridor,routeA --burns all --ms 100000`)

The layer's corridor (one fly leg of 186) and route A as hints, nodes-bound, 8 burns a row, 4 workers; `mids` is the planner as
shipped, `nomids` the variant without the burns in between (Track F7's planner on this branch).

| run | arrived | legs clean | landed | damage a trip | worst hit | trips at 0 | bail-outs | water | flown / walked | flown share |
|---|---|---|---|---|---|---|---|---|---|---|
| **corridor, mids** | 8 / 8 | 8 / 8 | 4 / 8 (50 %) | **0** | **0** | 8 / 8 | 5 | 0 | 87 / 86 | 50 % |
| corridor, nomids | 8 / 8 | 18 / 19 (95 %) | 4 / 19 (21 %) | 0.62 | 5.0 | 7 / 8 | 16 | 7 | 142 / 81 | 64 % |
| (F7's shipped row, "Tight passages": the same numbers; the nodes-bound run is deterministic) | 8 / 8 | 18 / 19 (95 %) | 4 / 19 (21 %) | 0.62 | 5.0 | 7 / 8 | 16 | 7 | 142 / 81 | 64 % |
| **route A, mids** | 8 / 8 | 19 / 21 (90 %) | 2 / 21 (10 %) | 0.93 | 4.4 | 6 / 8 | 19 | 2 | 99 / 89 | 53 % |
| route A, nomids | 8 / 8 | 17 / 19 (89 %) | 0 / 19 | 0.91 | 4.3 | 6 / 8 | 18 | 4 | 95 / 120 | 44 % |

The corridor flies clean with the mids (no hit, half its windows landing on their cell, no bail-out into a pool) at a flown share
of 50 % against 64 % without them: the windows whose plans needed a rocket next to a wall are walked now. Route A's hit of 4.3 to
4.4 (two burns of eight, the same window, with or without the mids) is not a burn-branch matter: F7 saw 3.0 there. **The 70 % flown
share and the no-hit-over-3 bars are not met**; the flown share is capped by the proofs (the climb through the chunk-border faces,
F6's limit) and the walks after a landed window (Track R2's), as F7 found.

### On the server (bds-fly2, BDS 1.26.60.6, 2026-11-08)

`fly-cave.test.ts`, `FLY_CAVE_STYLE=1 FLY_CAVE_RUNS=5`, the replica with its new surroundings (864 terrace chunks and the shell in
1 597 fills from 23 teleport stops, 373 s; the box itself 30 s). **Trip C** (`!fly` from the home pad, 660 blocks, to cave_start),
five runs while a 4-worker bench loaded this PC (the route worker shares its CPU):

| run | arrived | off | s | rockets | damage | corrections | the corridor | the way in |
|---|---|---|---|---|---|---|---|---|
| 0 | yes | 0.1 | 125 | 7 | 2.7 | 8 | partial (fly 871, walk 20), the second search found walk 40 in 1 ms: joined fly 871 + walk 60 | the cruise to the walk's start held ("only 2 851 of 4 848 columns loaded"), none confirmed, `landed_off` 28 blocks off; the re-plan walked 87 in (54 ticks in water) |
| 1 | yes | 0.1 | 122 | 7 | 0 | 5 | partial (fly 885), the second search found fly 10 in 0 ms: joined fly 895 | **the opening, 15 under the rim**: "a pit floor 15 deep (2 cells), the brake landing simulated in from 0"; landed 0.02 from the centre, touchdown 0.20 a tick; the last blocks walked |
| 2 | yes | 0.1 | 122 | 7 | 0 | 7 | the same | the opening: landed 0.01 off, touchdown 0.25 a tick |
| 3 | yes | 0.1 | 100 | 7 | 0 | 5 | partial (fly 875), the second search found fly 13 + walk 10: joined | the opening: landed 0.01 off, touchdown 0.19 a tick; walk 10 |
| 4 | yes | 0.2 | 139 | 8 | 0 | 6 | found at once (fly 894) | the opening, 5 under the rim: held over it until its chunk loaded (5 ticks), landed 0.01 off; then one window of 54 flown (proofs partial at 2 s under the load, cut back), bailed out 1.4 off after a correction, 0 hits, the rest walked (140 ticks in water) |

Four of five came down through the roof opening onto the floor under it, by the brake over the rim and the elevator, within 0.02
of the cell and without a scratch; before this track every run landed on the surface beside the cave. The one that took the
layer's walk way in landed off because the landing cell's columns were not loaded when the cruise had to choose (the hold's look
found nothing it could confirm): the second search is right to prefer the opening, and a walk leg's start is still a plain
walk-landing (Track BF's rules).

**flyC** (cave_start to cave_end on the layer's corridor), five runs with the machine loaded (180 s cap) and five alone (300 s cap):

| runs | arrived | damage | windows flown | what happened |
|---|---|---|---|---|
| 5 loaded, 5 quiet | **0 / 10** | 0 | 0 | The replica's layer plans the corridor OUT through the cave's roof opening (`leg 1 (fly 184): under 52 -> y 16x15, sky 49 -> y 16x13, under 84`), where the fixture and the offline replica source plan one underground stretch of 186. The first window's proof (up to the opening, 10 goals) runs out of its 2 s (6 000 to 6 900 expansions, 1 of 3 goals in the first piece) and the body walks to the window's first goal, where every takeoff primitive hits ("the open list emptied", 8 expansions: a pool or a low spot); the cruise out of the cave and down the second opening lands 0.01 from its cell every time (the rim hint: "13 under the rim"), and the last 84 blocks, the cave's pools, are walked and fail `unreachable` until the re-plans run out (8 walks a run). |

The entry from above works on both ways in (the first opening on trip C, the second on flyC); what stops flyC is the walk through
the pools that follows (Track R2's) and a proof that wants more than 2 s for a climb out through a roof. The layer's choice of
the sky on the replica, where the offline source has it underground, is not understood: the two sources differ only in what the
world cache recorded from the fly-over's chunks.

### The regressions (the final code; bds-fly3 for fly-route and fly-corridor, bds-fly2 for the rest)

| suite | result |
|---|---|
| fly-route | 3 of 3 green |
| fly-corridor | 5 of 5 green |
| fly-land | 5 of 5 green |
| fly-course, FLY_AREA 71520,69472 | 7 of 8 (the slalom); main on the same area: 8 of 8 (F7's run of main there: 7 of 8, the slalom) |
| fly-course, FLY_AREA 66400,70496 | 7 of 8 (the rings); main: 7 of 8 (the rings) |
| fly-course, FLY_AREA 63328,66400 | 7 of 8 (the slalom); main: 8 of 8 |

(The course runs of this branch shared the CPU with the offline benches, as Track F7's did; main's reference runs on bds-fly3 failed
at the build because that server's truth pack has no `course` command, so they were run on bds-fly2 after this branch's.) The
open-air drivers carry no cave rules; what they share with the cave style is the planner's branches and the speed rule, which
only refuse edges.

### Open points (Track F8)

- **flyC does not arrive on the replica** (0 of 10): the replica's layer plans the corridor out through the roof opening and back in
  through a second one where the fixture's layer (and the offline replica source) stays underground; the two differ only in what
  the fly-over's world cache recorded. The cruise out and down lands 0.01 off (the rim hint); the walk through the pools that
  follows fails `unreachable` (Track R2), and the first window's proof (a climb to the opening, 10 goals) wants more than 2 s.
- **The hits left**: 8.3 once on wide-106 and 2.9 twice on wide-109 with the mids; route A's 4.3 to 4.4 with or without them (the
  same window every time: not a burn-branch matter and not a speed one; its trace is the next look). The speed rule removes the
  8.3 but refuses 3-high bores: a wall-only clearance in the sweep is what lets it ship on.
- **The flown share**: the mids walk what they cannot prove (86 blocks a trip against 121 on the set, 50 % against 64 % on the
  owner's corridor). The windows lost are those whose plans fired a rocket next to a wall; a slow way through them (the creep, a
  glide turn) is what the planner lacks.
- **The first corridor is partial by construction** for a covered goal; the second search fixes the trip, not the search. A
  heuristic that knows the goal is covered (the cheapest way underground added to h for a sky node) belongs in the layer's
  search (Track CB's file).
- **A walk leg's start as the cruise's landing**: run 0 of trip C landed off because the cell's columns were not loaded when the
  cruise had to choose; the rim hint covers y openings only.
- **Server corrections** (F7's open point) are not measured here beyond the replica's 5 to 8 a cruise.

## Real-cave benchmark (Track F5a)

Flight v2, Track F5a, [decisions/0068](decisions/0068-real-cave-benchmark.md). The corridor flight's first real cave
(the owner's, 2026-11-06) went wrong where the made-up bores of F4b never did. This track turns that cave into a
benchmark, offline and on a test server, and stops the takeoff from water that failed there. **The cave is private:
nothing in the repository names it or gives a coordinate of it.** Its data lives in `bot/fixtures-private/cave/`
(git-ignored; `CAVE_FIXTURE_DIR` points elsewhere), and every test and script that reads it skips without it.

### The fixture (`world/cache/export.ts`, `corridor/cave.ts`)

`export.ts` writes a box of a world cache as one file: the 2-bit classes packed and deflated, the chunks the cache
never saw listed, the highest solid block of every column of a wider rectangle (`--tops`). It opens the cache
read-only and writes to stdout, so it runs on the deploy host over ssh from stdin and writes nothing there (the
command is in the file's header; the host needs the same commit). The owner's cave: a box of 288 x 150 x 227 cells,
none in an unknown chunk (air 4.33 M, solid 5.38 M, water 94 k, avoid 5 k), 334 kB, exported in 0.46 s. The bot's
waypoint file goes next to it as `waypoints.json`.

`caveWorld` reads the extract once for every consumer: the route planner's grid, stepBody's block query, the coarse
layer's chunk source (the chunks wholly inside the box) and the walk navigator's terrain. An unknown chunk is solid;
outside the box is solid sideways and below and open sky above; avoid is solid; water is water (a source block's
height). **The cache rounds a partial block up to a full cube**: a slab or a stair step reads as a whole block, so two
of the owner's steps read 2 and 3 high (cave_start to cave_1, cave_8 to cave_9) and the walk cannot take them.

The routes (`ROUTE_A`, `ROUTE_B`, `TRIP_C`; consecutive waypoints are the legs, each waypoint moved to the nearest
standable feet cell):

| route | stops | |
|---|---|---|
| A | cave_start, cave_1 .. cave_21, cave_end | the whole path, 22 legs of 6 to 43 blocks; cave_2 is under open sky, cave_4 to cave_7 have water floors |
| B | cave_4, cave_5, cave_shortcut, cave_end | the shortcut, flight only (the coarse layer's walk from cave_5 to cave_shortcut is 160 blocks, the fly 16; no walk at any step height up to 4) |
| C | home, cave_2, cave_start | the trip in from home: the cruise to the entrance by cave_2 and in (home is outside the box) |

### Offline (`corridor/cave-bench.ts`, `scripts/cave-bench.ts`)

The live code on stepBody: the corridor executor with `underFly` on (`executor`: the coarse layer over the extract,
the stretches and windows, the TrackerChain, the walks through the walk navigator in a closed loop:
`test/unit/skills/fly-cave-walk.ts`), each leg as one window from standing (`leg`), the whole route as one window
(`route`), and the walk-only baseline (`walk`). Every flight over every burn 9 to 21 (its end told 3 ticks late, the
rocket only with no boost left), two planner budgets (live 600 ms / 40 000 nodes, generous 3 000 ms / 200 000);
wall touches are flown through and scored with F0's wall damage, water ends the glide. 1 377 jobs on 20 worker
processes, 36 minutes (the final code, 2026-11-06):

`leg`, route A (done of 13 burns; live / generous; the mean ticks, rockets, damage and partial plans at the live budget):

| leg | done | clean | rockets | damage | partial | other ends (live) |
|---|---|---|---|---|---|---|
| cave_start -> cave_1 | 2 / 3 | 1 / 2 | 13.4 | 9.5 | 68 | ground 11 |
| cave_1 -> cave_2 | 6 / 10 | 4 / 8 | 8.5 | 3.7 | 32 | ground 4, water 3 |
| cave_2 -> cave_3 | 13 / 11 | 13 / 11 | 6.7 | 0 | 24 | - |
| cave_3 -> cave_4, cave_4 -> cave_5, cave_5 -> cave_6 | 0 / 0 | 0 / 0 | 1 to 1.5 | 0 to 0.4 | 3 to 5 | water 13 (the glide ends in the water floor) |
| cave_6 -> cave_7, cave_7 -> cave_8 | 0 / 0 | 0 / 0 | 0 | 0 | 4 to 5 | timeout 13 (standing in water: no glide; refused live now) |
| cave_8 -> cave_9 | 2 / 2 | 1 / 1 | 7.6 | 114.3 | 52 | ground 10, water 1 |
| cave_9 -> cave_10 | 0 / 0 | 0 / 0 | 0 | 0 | 41 | failed 13 (no start found) |
| cave_10 -> cave_11 | 4 / 8 | 1 / 7 | 19.8 | 5.7 | 72 | ground 7, water 2 |
| cave_11 -> cave_12 | 12 / 13 | 12 / 12 | 2.2 | 0 | 5 | ground 1 |
| cave_12 -> cave_13 | 8 / 10 | 5 / 10 | 6.9 | 26.8 | 26 | ground 5 |
| cave_13 -> cave_14 | 10 / 11 | 7 / 7 | 11.1 | 7.4 | 28 | ground 3 |
| cave_14 -> cave_15 | 3 / 4 | 3 / 3 | 7.6 | 2.0 | 23 | water 7, ground 3 |
| cave_15 -> cave_16 | 5 / 6 | 5 / 6 | 5.8 | 0.6 | 21 | water 6, ground 2 |
| cave_16 -> cave_17 | 5 / 9 | 3 / 7 | 9.9 | 5.4 | 39 | ground 8 |
| cave_17 -> cave_18 | 9 / 11 | 9 / 10 | 8.6 | 8.3 | 29 | ground 4 |
| cave_18 -> cave_19 | 8 / 12 | 5 / 12 | 10.5 | 20.3 | 37 | ground 5 |
| cave_19 -> cave_20 | 2 / 3 | 1 / 3 | 22.6 | 3.5 | 90 | ground 11 |
| cave_20 -> cave_21 | 6 / 9 | 4 / 7 | 10.1 | 1.6 | 34 | ground 7 |
| cave_21 -> cave_end | 13 / 11 | 12 / 11 | 6.8 | 0.4 | 13 | - |

`leg`, route B: cave_4 -> cave_5 0 / 0 (water 13); **cave_5 -> cave_shortcut 0 / 0, hits in 13 of 13, 18.4 rockets,
110.6 damage (live; 60.0 generous), 129 partial plans**; cave_shortcut -> cave_end 10 / 11 done but none clean (3.5
damage). `route` (the whole route as one window): A 0 of 13 both budgets (water after about 110 ticks), B 0 of 13
(water 13, 8.4 / 14.2 damage).

`executor` (arrived of 13 burns, the same at both budgets but where noted): route A cave_start -> cave_1 5 / 6 (the
fly 45 window lands short, the walks after it fail at the 2-high step), cave_1 -> cave_2 13 / 13 (one window,
14.8 rockets, 2.1 damage live, 0.6 generous), cave_2 -> cave_3 0 / 1, cave_3 -> cave_4 0, cave_4 -> cave_5 13
(walked), cave_5 -> cave_6 0, cave_6 -> cave_7 0, cave_7 -> cave_8 0, cave_8 -> cave_9 10 / 12 (walk fails, a fly 36
window, walk), cave_9 -> cave_14 13 each (walked), cave_14 -> cave_15 0, cave_15 -> cave_end 13 each (walked).
Route B: cave_4 -> cave_5 13 (walked), **cave_5 -> cave_shortcut 0 and cave_shortcut -> cave_end 0: the corridor is
walk legs only and the walks fail; the executor never tries the flight that `leg` mode shows is possible**. Every
failed leg is fast: five re-plans of the same corridor, each walk refused at once.

`walk` (the navigator alone): route A walks 15 of 22 legs (not cave_start -> cave_1, cave_3 -> cave_4, cave_5 -> cave_6,
cave_6 -> cave_7, cave_7 -> cave_8, cave_8 -> cave_9, cave_14 -> cave_15), route B 1 of 3.

### On the server (`fly-cave.test.ts`, bds-fly2)

`truth:cave` rebuilds the box on the server (stone over it, then 54 447 boxes of air and water in 299 messages of at
most 1 800 characters, 535 k characters): the boxes 1.1 s, sent 15.7 s (6 at a time), built 15.9 s (2 pieces under
ticking areas, 270 ticks), **33 s in all** for 9.8 M cells (26 s the second time: built 10.0 s, 196 ticks). The replica keeps the real heights and is moved in x and z
by a multiple of 16 (`FLY_CAVE_AT`, default -96000,-96000); home gets a 5 x 5 pad at its real height, the ground
between it and the box is the flat world's. Seen first: a fly-over of the box's surface (12 teleports) and of the
flat ground from home to the box into a fresh world cache, the coarse layer over it on the navigator.

Two runs of 2026-11-06 (every run completed both times, 636 / 595 s; a / b where they differ; trip C from a third
run and the second):

| run | arrived | notes |
|---|---|---|
| tripC: `!fly` home -> cave_start, today's behaviour | no (71 / 99 off) | the corridor plan partial (the layer's 4 000 ms search limit: one fly leg of 997 blocks ending 33 from the goal), the cruise to its end, "no landing spot near it with a walking path", landed on dry ground by the entrance, 31.7 s, 0 damage; the walk in not tried. Without the fly-over of the ground between home and the box (the first run) the layer's legs ran 64 to 94 % through unknown space and were walked: 5 re-plans, 0 rockets |
| walkA: route A walked | 16 of 22 legs | not cave_start -> cave_1, cave_3 -> cave_4, cave_5 -> cave_6, cave_6 -> cave_7, cave_8 -> cave_9, cave_10 -> cave_11 (all `unreachable` at once but cave_6 -> cave_7); 10 to 172 ticks in water on 7 legs; 10 fall damage on cave_14 -> cave_15 |
| flyA: route A, `underFly` on | 15 / 14 of 22 legs | flown: cave_start -> cave_1 (22.8 s, 1 rocket, 0 damage / 4.1 s, 2 rockets, 3.7 damage; one window), cave_1 -> cave_2 (5.4 / 22.1 s, 1 / 2 rockets, 0 damage), cave_8 -> cave_9 (walk refused, a fly 36 window landing 3 of 4 goals, walk: 0.4 damage / the window hit the walls for 9.2 and the trip stopped on health 10.8 under 12); the other arrivals walked; failed: cave_2 -> cave_3 (fly 18 refused five times), cave_3 -> cave_6 and cave_6 -> cave_7 (walks refused), cave_10 -> cave_11 (walk then fly 22 refused) |
| flyB: route B, `underFly` on | 0 of 3 legs | every corridor walk legs only (cave_5 -> cave_shortcut: walk + fly 16 to 39, the walk part refused; then no corridor) |

Where the server and the offline walk disagree (cave_7 -> cave_8 and cave_14 -> cave_15 walk on the server only,
cave_10 -> cave_11 offline only), the difference is the server's water and stand-in blocks against the extract's
cubes; the legs that fail on both fail the same way (`unreachable` before a step).

### No flight from water (`skills/fly/takeoff-water.ts`)

The Realm, 2026-11-06: a route takeoff planned and flown from a body standing in the cave's water. The local model
glides there (a body whose feet are less than 0.4 under the surface moves with air physics, `LIQUID.waterInset`),
the server does not (it ends a glide in water), and the climb fired 20 rockets into a glide that never came; the
flight ended `no_glide`. Now:

- every takeoff family (the run, the ledge, the vertical, the route takeoff) asks `takeoffWet` first
  (`commands-fly.ts takeoffFor`): water anywhere from the feet to the head (no inset), or the input loop's own
  water flag for the body's own cell, refuses with "fly: I am in water: swim up and stand on dry ground first";
- the flight controller does not start a flight from water (`flyTo` ends `in_water` at once, no rocket);
- the controller stops firing once `UNANSWERED_ROCKETS` (2) rockets have gone without the server ever confirming
  the glide; the takeoff ends `no_glide` on its own timeout. `fly-takeoff-water.test.ts` has the cases (19 rockets
  with the limit lifted: the Realm's bug).

### For the next track (F5b): measuring a change on the cave

1. The fixture: copy it from the owner's machine into `bot/fixtures-private/cave/` (`extract.json`,
   `waypoints.json`), or export a fresh one with the command in `export.ts`'s header. Never commit it.
2. Offline: `node scripts/cave-bench.ts --mode leg --route B --burns 9,15,21 --budget live --jobs 16` for a
   quick look at one route (a minute or two), the whole board with no options (36 minutes on 20 workers), `--legs 1`
   or `--legs "cave_5 -> cave_shortcut"` for one leg, `--latency 11` for the worker's 9 to 13-tick answer, `--json
   file` for the raw runs. `fly-cave.test.ts` (unit) is the smoke test.
3. On the server: `BDS_E2E=1 FLY_BDS_PORT=19210 FLY_BDS_CONTAINER=bds-fly2 FLY_CAVE_REPORT=<file> pnpm --filter bot
   test:e2e test/e2e/fly-cave.test.ts` (the build is 33 s; `FLY_CAVE_REUSE=1` skips it, `FLY_CAVE_ONLY=flyB`,
   `FLY_CAVE_LEGS=1` pick runs; vitest drops the console table of a passing run, so read the report file). Keep the
   report file out of the repository: it holds the replica's coordinates.

### Walk and swim problems (for the navigator's owner)

Seen on this cave; not fixed here (the navigator is not this track's):

- A walk that starts with the body in water: "no standable node" from the start cell; the walk refuses at once.
- A goal in water is not standable: a `block` goal at a waypoint in water is refused (the bench and the e2e use a
  `near` goal of 1.5).
- `unreachable` at once on 6 to 7 legs of route A that the owner walks, two of them a partial block read as a full
  one (2 and 3 high), the others through water floors and up out of pools (cave_3 -> cave_4, cave_5 -> cave_6,
  cave_6 -> cave_7).
- The corridor executor's walk legs fail the same way, and the executor re-plans the same corridor five times in
  under a second (the failed walk marks nothing the layer avoids next time).
- The walks that do go through water spend most of their ticks in it (117 to 172 of about 200).

### Open points (Track F5a)

- The executor walks short fly legs (under `UNDER_FLY_MIN` 24) and the walks fail: on route B it never flies the
  shortcut that `leg` mode flies (cave_shortcut -> cave_end done 10 of 13 as a window). A failed walk should leave
  the fly leg to the flight.
- `leg` mode's misses are mostly touchdowns short of the landing (`ground`) and glides into water floors (`water`);
  cave_5 -> cave_shortcut hits the wall in every run (110 damage at the live budget).
- The extract rounds partial blocks to full cubes and builds avoid cells (lava, fire, cactus...) as stone.
- The sky stretch is not benched offline (the executor's `flySky` port stands the body on its cell); trip C's cruise
  flies over the flat world, not the real terrain between home and the cave.
- `fly-corridor.test.ts`'s `flyChain` duplicates `flyCaveWindow`; the TrackerChain's stats do not sum `refused`;
  drive.ts / flyStretch has no water check of its own (stepBody ends the glide, the bench scores it `water`).
- Files outside this track's own touched for the water guard and the measurement switches: `controller.ts`,
  `commands-fly.ts` (`takeoffFor`, `FlyControl.corridor`), `commands-corridor.ts`, `registry.ts`.

## Open points

- Track F1: a corridor approach under a roof at ground level (the roof cases of `fly-brake.test.ts` on the
  ground, not 20 up) ends `roof`: the cruise and the corridor entry come in under the roof's level. The
  test cases stand on a platform 20 up. This is a Track BF / AU2 corridor limit, not the brake's.
- Track F1: the farm and the overhang corridors still go around once when the corridor entry arrives
  3 to 10 under the floor (Track BF's open point below). No family lands from there without a rocket.
- Track F1: the touchdown under a roof 3 above is up to 0.30 a tick (the brake comes in along the
  corridor and has 3 of room to sink). Elsewhere the brake touches down under 0.02 a tick offline.
- Track F1: the glide-down check (`planGlideDown`'s `simulateFlight`) always simulates the brain in `auto`,
  while the glide down itself flies the setting's style. On a plain floor the two fly the same flare; with
  `flyLandStyle brake` the check may accept or refuse a glide that the brake would fly differently. A glide
  down that brakes is not measured on the server.
- Track F1: the hotbar-switch boost, rocket stacking, the wall kiss and the rocket brake are stubs until
  Track F0 measures them ("The stubs").

- Track F2: the 2-high 45-degree staircase is not flown (the envelope's 2.2 blocks; the jump clipped to 0.2
  under the ceiling leaves no edge within the margin), nor the fast diagonal parts of 2 x 2 bores (the per-axis
  collision path); a 1-block step in a 2-high bore leaves a 1-high opening, so the random 2 x 2 courses have
  curves only.
- Track F2: the heuristic is an estimate (a weighted A*): the fields' and the long random tunnels' first plans
  are partial within 2 s and the flight relies on re-planning; a distance field through the bore would guide
  the search better. The lattice's buckets and the risk weight are untuned.
- Track F2: the landing goal is flown offline only (a 1 x 1 cell in open air: a brake and the settle), not the
  brake / elevator landings of Track F1 and not on the server; the stacked rockets, the slot switch and the
  impact threshold wait for Track F0's measurements (`stackRockets` is off).
- Track F2 (closed by Track F3): `flyRoute` was the e2e's entry only and the live driver's rocket plumbing
  duplicated the controller's; the brain's `route` phase and `rocket.ts` are the integration.
- Track F4a: the full course's chain is never done in one go (0 of 8 offline, 0 of 1 on bds-fly2): the weave leg (the slalom's
  gates straight into the S-tunnel) fails in most runs, after which the legs start from their own starts. The
  slalom and the tunnel are clean apart; chained, the body comes out of the last gate too fast and off the line
  for the tunnel's entrance, and the partial plans (the nodes budget runs out 0 to 2 goals in) re-plan 30 to 50
  times a leg; the ledge flown on from the tunnel's exit lands 6 of 8 at up to 150 re-plans (alone, from its own
  start, 8 of 8 at about 10). A heuristic that looks past the next goal, or a tracker that is handed the next goals as the
  last are passed (Track F4b asks for that too: `extend(goals)`), is the next step.
- Track F4a: the bench has no planning latency (the in-thread search answers before the next tick); the
  worker answers 9 to 13 ticks late. `lead` covers the first plan of a gliding body only: a re-plan in flight
  still answers for a state some ticks old and the tracker meets the body where it is (`locate`).
- Track F4a: the e2e's landing stations start from a fall at the hand-over's entry (the bare driver cannot make
  the brain's 1.0 a tick there), so their server rows are measured, not gated; offline they start in the
  hand-over's state. From a pillar at the entry (a takeoff 30 up into the stack's slot) the stack lands 3 of 8
  and the shaft 5 of 8 offline (282 and 139 re-plans): a route from standing to a precise landing that far out
  is not solved.
- Track F4a: the brain's route phases fire only with the loop's boost count at 0, so a rocket the tracker asks
  for on a running burn waits there (`fireHeld`); `flyRoute` and the bench fire it (the union). Letting the
  brain's hand fire on a running burn (RocketHand supports the union) would make the brain's route landings
  fly the plans as made.
- Track F4a (`PLAN_CLEAR_MIN`): the tracker refuses powered flight without a safe plan but does not end it; it
  glides on unpowered, holding clear. A driver that can land or brake (the brain's route phases, F4b's
  `flyStretch`) could end its phase after some ticks with no safe plan; the tracker would need to say so
  (`TrackerOutput`). The rule is not measured in a real cave: the e2e bores are clean, and offline it refused 1
  rocket in 104 leg flights.
- Track F4a: F3's `room3` on bds-fly2 missed once in 6 runs of the F4a code: the flare (not the brake's corridor)
  touched down 4.4 short of the room after a descent spiral at 51 out (`landed_off`, 0 damage). The brake's
  corridor landed it every time it was chosen.
- Track F3 (closed by Track F4a, "The hand-over"): the hand-over state. The cruise arrived a rocket's worth
  high and circled first; a route target now sinks onto the glide line along the corridor (no circle). Left:
  from about 400 blocks out the hand-over is still 13.7 to 15 over the cell (the climb's height, the S-turns'
  0.25 a block not enough over the last APPROACH_DISTANCE + 60), above the tracker's band of 5 to 13; every
  such trip still landed.
- Track F3: `!goto` / `!come` onto such a cell keep the walk-landing search (4 of headroom, level neighbours):
  only an exact `!fly <x y z>` is handed to the route planner. A route landing is never a walk landing. What it
  would need (Track F4a; `commands-fly.ts` is another track's): the autoFly hooks of `pve.walk` / `pve.come` call
  `planFlight` / `takeOver` with `exact` false, so `findLanding` never runs `preciseGoal` for the goal itself.
  For a block goal whose floor has 2 or 3 of room (`ROUTE_HEADROOM` up to `flyHeadroom`) and no walking path in
  (the probe's `none`, the stack's inner platform), the hook would pass `exact` (half 0.5) with the `route`
  deps it already builds, so the goal itself is a precision goal and the route planner lands on it (no walk
  after); `stillLandable(..., route: true)` for the re-check on the way; the player's own cell for `!come` the
  same. An e2e: `!goto` onto the inner platform of `truth:course build stack`.
- Track F3 (closed by Track F4a, "Route first or brake first"): the route planner was asked only after the
  brake's simulation failed. Covered goals now ask the route first and take it when it comes in from the
  body's side (`ROUTE_FIRST = 'covered'`, `ROUTE_FIRST_OFF`), open-sky ones the brake first; the 2-deep holes
  and the shaft stay the brake's, the route plan for them is the fallback. Left: a route from the goal's far
  side flies round to its corridor at up to 24 rockets (the room from the north-west by the route: 6.9 a trip
  against the brake's 1.4), so it is only the fallback there; a cruise that lines up on the corridor earlier
  would make it a choice.
- Track F3: the search's cost when a cell is not landable: up to 6 bearings x 2 weights x 800 ms in the worker
  before `findLanding` says so (a landable one is found on its first bearing in tens of milliseconds).
- Track F3: no route into a staircase from its flat section (Track F2's benchmark takes off there with the
  F0 model now; not re-flown on the server here) and no route out of a 1 x 1 shaft (the vertical takeoff is the
  way out; the jump's box has no margin in the bore).
- Track F3: Track F0's wall-damage rule (`wallImpactDamage`) and fall-distance rule are not costs in the
  route search (the margin keeps the box off the walls instead). The union of the lifetimes is used from a
  burn's earliest end on (Track F4a, `inBurnTail`); full stacking (`stackRockets`) stays off.
- Track F3 (closed by Track F4a, "The F0 model in the route code": the plans rode the burn's nominal end; the
  tunnel is 0 damage twice on bds-fly2 now, max error 0.00), a regression to look at: with the F0 takeoff
  model in the planner (`GLIDE_DELAY` 1, the glide asked
  from the first airborne tick) `fly-route`'s 3 x 3 tunnel on bds-fly touched a wall once in each of two runs
  (1.9 and 1.7 of `flyIntoWall`, 3 local hits, the second run ended `ground` after 3 of 4 goals; the first plan
  `takeoff glide+35 x3 glide+0 rocket90L-20 ...`, max error 0.98, 2 of 5 plans partial), where Track F2's run 6
  had 0 damage; the staircase, F2's open point, is clean now (0 hits, 0 damage, 0 corrections, twice, 38
  ticks, 1 rocket). The server's glide came on the same input as the model's (the trace: `11 air vy 0.33, 12
  air 0.25, 13 G 0.22` against the server's `15 a 0.42, 17 a 0.33, 18 G 0.22`), so the takeoff matches; what
  drifts a block before the snap turn into the curve was not analysed (the e2e's trace ends at 40 ticks).
  `fly-route`'s tunnel gate (0 damage) is red until it is.
- Track F3: `fly-terrain`'s `site` case now flies out from under its 91 x 86 roof 3 up by the route takeoff
  instead of walking 28 blocks to a site (the route takeoff comes before the site search in the chain; it
  arrived with 0 damage); the case accepts either way out.
- Track F2: on the server the 3-high staircase is climbed but scraped (8 to 13 of flyIntoWall, "Measurements
  (Track F2)"): the takeoff out of its flat section has no complete plan at the margin of 0.15 once the jump
  is modelled as the server flies it (7 ticks of plain jump before the glide). A takeoff primitive measured by
  Track F0 (the jump's rise, the glide's first ticks, the first rocket) is the next step, as is a planner
  heuristic that does not drown in the open air before an entrance (the S-bend's partial first plans).
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
