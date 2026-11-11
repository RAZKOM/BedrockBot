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
| `bot/src/skills/fly/landing.ts` | Track BF: `findLanding` (the confirmed-path search), `floorsOf`, the wet / hazard rules, `corridorsOf` / `corridorLands` (overhangs), `stillLandable`; Track L1: `walkFlood`, `approachLands`, the alternatives |
| `bot/src/skills/fly/landprice.ts` | Track L1: the landing's price in seconds (`decideGoAround`, `holdWorth`, the go-around's measured cost; "Landing by time (Track L1)") |
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
| `flyCaveExit` | off | Track F9a, F9d: with `flyCave` on, a takeoff from under a roof with no recording that proves clear flies out along a line drawn from the cave's own air to the open sky (the flood under the roof, the line a body can fly, the whole takeoff simulated at every burn before it is taken) instead of walking out. Until Track F9d this asked for the searched way out, which its proof refused. `on` after a `!test goto` series on real terrain ("Drawn lines") |
| `flyLearned` | off | Track F9b: with `flyCave` on, a takeoff from under a roof flies out along a path recorded with `!learn` that left the ground within 4 blocks of where the bot stands and comes out under open sky, when the whole takeoff simulated at five burns clears; no such path, or none that clears: the takeoff as without it. It has flown on the replica only: `on` after a `!test goto` series on real terrain ("Learned exits") |

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

(Track F9a: a plan to an exit is now taken only with a proof of the climb after it, and the climb keeps the exit's line until the
sky is open: "Cave exit (Track F9a)" below.)

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
  asks for them (`CaveStyle.midBurns`, `RouteRequest.midBurns`); open-air flight plans as before. **Off by default since
  2026-11-09**: at the live 2 s budget a proof with them runs 20 to 40 times slower and almost never completes (ADR 0074 addendum).

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
   **Before a track that flies recorded paths, export it again**: a recording is flown through the cave as it was when
   it was made, and a fixture exported before that is another cave (Track F9c proved two takes in a fixture three days
   older than they were; the Realm refused both). `scripts/cave-learned-entry-probe.ts` and the cave e2e print the
   fixture's export time against the newest recording first, `WARNING: STALE FIXTURE` when a recording is newer
   (`learn/fresh.ts`).
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

## Landing by time (Track L1)

Flight v2, Track L1, [decisions/0076](decisions/0076-land-by-time.md). The owner (2026-11-09): "It should try to land as close
as it can but it shouldn't waste a whole 10 s of go-around to save 2 s of walking." On the Realm 34 of 131 flights (all to the
owner's underground goal, cave_start) flew the four go-arounds `flyGoArounds` allows and then landed on "the nearest safe ground"
anyway; `!test cavestart` from home took 156 to 161 s a run, about 80 s of it the landing and the walk in. This track decides a
landing by its time: the walk it leaves against what a go-around costs and is likely to buy.

```
the landing search (landing.ts findLanding), a goal that is no landing itself
  covered goal (a roof over its floor, or a rim): the candidates by the walk flood from the goal's floor (walkFlood)
  each candidate: the probe's walk; an open cell also its approach simulated from where the flight comes in (approachLands)
  -> the cell, its walk priced in seconds (walkS), and up to 3 alternatives (6 apart, each priced and simulated)
the approach (brain.ts), a missed approach (approachHopeless) to a walk landing:
  P (goAroundChance: the miss's kind, the miss before) x (the cheapest landing now - the target's walk)  >  a go-around's cost ?
     yes: the go-around (as before)
     no:  an alternative (the cruise and the approach start over for it), or the nearest safe ground (landNow)
  one line each: "landing price: land now on ... against a go-around (...): saves N s <= 7.3 s: landing now"
the hold (tasks/process/fly.ts watchLanding): a partly loaded window answers from its loaded part (`partial`);
  its cell is taken unless an unloaded column could still save more walk than the next look's wait (holdWorth)
```

An exact landing (`!fly x y z`: no walk price on the target) keeps the go-arounds as before; so does a route landing.

### Files

| File | What |
|---|---|
| `bot/src/skills/fly/landprice.ts` | the price: `GOAROUND_S`, `GOAROUND_ROCKETS`, `ROCKET_S`, `GOAROUND_COST_S`, `WALK_S_PER_BLOCK`, `UNKNOWN_DETOUR`, `UNKNOWN_RISK_S`, `SINK_S_PER_BLOCK`, `GOAROUND_P`, `goAroundChance`, `walkSeconds`, `decideGoAround`, `holdWorth` |
| `bot/src/skills/fly/landing.ts` | `walkFlood`, `entryHeight`, `approachLands`, `approachBearings`, `APPROACH_SIMS`, `ALTERNATIVES`, `ALT_PROBES`, `ALT_APART`, `NO_APPROACH_NEAR`, `PARTIAL_MIN_SHARE`; `LandingOptions.partial`, `Unloaded`; `findLanding` with the flood, the approach check, the alternatives, `walkS` on the targets |
| `bot/src/skills/fly/plan.ts` | `LandingTarget.walkS`, `walkKnown`, `alternatives`, `name` |
| `bot/src/skills/fly/brain.ts` | the priced miss in `approach` (`landingOffers`, `switchTarget`, `lastMiss`), `FlightStats.landingPrices` |
| `bot/src/skills/fly/controller.ts` | the controller's target follows the brain's switch; the report's `landingPrices` and the end line's `(N priced)` |
| `bot/src/tasks/process/fly.ts`, `bot/src/chat/commands-fly.ts` | `LandingHint.partial`, the hold's priced look in `watchLanding` (and it stops when the brain took an alternative); `landingFor` passes `partial` |
| `bot/test/unit/skills/fly-land-time.test.ts` | the guard tests (the price, the decision, the flood, the pit, the hazard, the partial window, the brain's switch) |
| `bot/test/e2e/fly-cave.test.ts` | `FLY_CAVE_PLAIN=1`: trip C the `!test cavestart` way (flyCorridor off), its go-arounds, flight time and landing in the table |

### The price (`landprice.ts`)

| constant | value | source |
|---|---|---|
| `GOAROUND_S` | 6.2 s | the Realm's log, 2026-10-30 to 2026-11-09: the median between two go-around decisions (91 pairs, mean 6.9, 2.8 to 13.5); 6.0 from the last one to the forced landing (31 flights) |
| `GOAROUND_ROCKETS` | 1.13 | the same flights: 152 go-around rockets over 135 go-arounds |
| `ROCKET_S` | 1 s | a judgement: rockets are plenty, time is what the owner asked about |
| `GOAROUND_COST_S` | 7.3 s | the sum |
| `GOAROUND_P` | landed / short / over 0.8, wall 0.19, none 0.05 | the Realm's first go-arounds: `wall` landed after 3 of 16, `none` 0 of 19 (5 % as a floor), `over` 1 of 1; an energy miss is what a go-around fixes (the e2e's go-arounds on bds-fly2 each landed next time) |
| `GOAROUND_P_REPEAT` | 0.02 | a go-around after one that failed the same way: 1 of 91 landed |
| `GOAROUND_P_OTHER` | x 0.5 | after one that failed another way: 0 of 19 |
| `WALK_S_PER_BLOCK` | 0.3 s | between the steady sprint (0.178, `sites.ts WALK_S_PER_BLOCK`) and the walk in the owner's cave (the navigator in a closed loop on the fixture, `caveWalker`: cave_2 to cave_start, 81 steps of the flood in 741 ticks, 0.46 a step, partly swimming); the replica's walk from the hill over the goal (digging, 32 blocks in about 72 s) is no walking pace and is what the unknown walk's risk term stands for |
| `UNKNOWN_DETOUR`, `UNKNOWN_RISK_S` | 1.5, 15 s | an unconfirmed walk: the estimate (the flood's steps, else the straight distance plus 3 a block of height) times 1.5 plus 15 s for the risk it does not walk (the Realm's hill-top landings over the cave) |
| `SINK_S_PER_BLOCK` | 0.29 s | the descent circle sinks 0.15 to 0.2 a tick ("Descent geometry"): the height over SPIRAL_ABOVE above an alternative's entry |

The decision (`decideGoAround`): with P the chance the next approach lands, go round when P x (the cheapest offer's walk and
height - the target's walk) > 7.3 s, else take that offer. The owner's case: 2 s of walk saved at P 0.8 is 1.6 s, no go-around.
A `wall` miss with the nearest safe ground 60 s of unknown walk away and the target's 14 s: 0.19 x 46 = 8.7 s, one go-around; a
second `wall` miss: 0.02 x 46 = 0.9 s, landing now. The offers are only the target's alternatives (confirmed, simulated) and the
forced landing's own `emergencyTarget` (dry, no hazard, level), so nothing less safe than before is ever taken; the forced landing
merely comes earlier.

### The search

- **The walk flood** (`walkFlood`, a covered goal only: its floor has a roof under OPEN_SKY over it, or a rim): breadth first
  over the ColumnView's floors (a solid with two free cells over it) from the goal's floor, a step to a 4-neighbour at the same
  height, a block up (with 3 of room to jump), down by up to 3 (the column free that high), never a hazard floor; at most 20 000
  floors within the candidate radius plus 8. The candidates go by the flood's steps (one the flood never reached: its estimate
  plus 64, behind all), the stop rule's lower bound is the steps over the square root of 2 (a path cuts the corners). The line
  says where the flood first met open sky (the walk's entrance) and how far it is.
- **The approach check** (`approachLands`): a probed open cell is landable only when the flight's planner lands on its cells
  (under CORRIDOR_COST) from APPROACH_DISTANCE out along the bearing from the body, a quarter round either way or the far side, at
  the height the flight comes in there: the approach entry, or 3 over the highest floor on that line (the go-around's height over
  a hill). The flare, and under `flyLandStyle auto` the brake too (a brake-only cell is planned `precise`). A cell that fails is
  logged `path N, no approach (kind cost)`, and the open cells within 3 of it (the same hollow) are not tried. At most 24
  simulations a search; past them a cell is taken without one and the line says so.
- **The alternatives**: the cheapest landable cells beside the chosen one, 6 or more apart (from it and from each other), each
  with its own cells, walk price and approach; past the stop rule at most 2 more probes look for them (open cells only).
- **The fallback** (nothing confirmed) prefers, among the probes that ran out, the cell nearest by the flood, never one within 3 of
  a cell whose approach did not land while another is known; its walk is the flood's steps, priced as unknown.
- **The partial window** (`partial`, the hold's look only): with at least half of the window live, a confirmed cell on the loaded
  part is returned with `unloaded` (the live share and the least straight distance from the goal to an unloaded column).

### Measured: the replica of the owner's cave (bds-fly2, FLY_CAVE_PLAIN=1 FLY_CAVE_STYLE=1, 5 runs each)

Trip C from the home pad (650 blocks) to cave_start, `!fly <cave_start>` with `flyCorridor off` (the plain flight, as the
Realm's `!test cavestart` flew it), the cave style on (`flyCave on`, the rest after the landing through the corridor's windows).
Before: this branch's checkout before the landing code changed (the same replica, `FLY_CAVE_REUSE=1`, the same day).

| | go-arounds | seconds to the goal | flight | flown share | landed (from the goal, height) | damage | water ticks |
|---|---|---|---|---|---|---|---|
| before, 5 runs | 0, 0, 0, 0, 0 | 117.3, 118.9, 118.1, 119.0, 118.4 (median 118.4) | 877 to 911 ticks (44 to 46 s) | 37 % | 13 off, 15 above (the hill over the goal) | 0 | 54 to 57 |
| after, 5 runs | 0, 0, 0, 0, 0 | 73.4, 68.9, 69.7, 55.1, 72.0 (median 69.7) | 43 to 49 s | 64 % | 51 off, 25 above (the hill by cave_2, the walk flood's first) | 0 | 0 to 2 |

The replica does not reproduce the Realm's go-arounds (its probes all run out, so both before and after land on a fallback cell
with a brake landing on the first approach); what changes is the cell. Before, the ranking by the straight line took the hill top
13 blocks off and 15 over the goal: the corridor from there was one walk leg of 32 blocks through the rock (digging), about 72 s.
After, the walk flood (10 143 floors, 61 ms on the test host offline) ranks the cells by their walk: the first open sky the flood
meets is 38 steps from the goal (a crack in the slope, no landing cell), the first candidates are on the hill beside cave_2, 90
steps; the corridor from there flies the 88 blocks in (one or two underground windows, 10 to 29 s). 49 s saved a trip, 41 %.
Offline on the fixture (no probe), `findLanding` takes the same cell in 68 ms.

### Measured: the open-ground landings

bds-fly2, each suite on the same pinned area before (this branch's checkout before the change) and after. An exact landing
(`!fly x y z` onto a landable goal) takes neither the flood nor the approach check nor the price, so these show the noise.

| suite | before | after |
|---|---|---|
| fly-land, FLY_AREA 62048,62048: distance from the centre (truth) | 0.04, 0.01, 0.07, 0.78, 0.13 (3x3 40 up), 0.07 (descend 60), 0.13 (5x5 at 300), 0.02 (wall); all on the platform, 0 go-arounds, 0 damage | 0.08, 0.04, 0.05, 0.79, 0.02, 0.11, 0.10, 0.61 (the wall: 0.3 of slide more); all on the platform, 0 go-arounds, 0 damage |
| fly-land `!fly stop` case | fails: no end line within 60 s of the stop | fails the same way (an old failure on this area, not this track's) |
| fly-route, FLY_AREA 63072,63072 | 3 of 3 (the sbend's second run ground in both) | 3 of 3 |
| fly-course, FLY_AREA 63328,66400 | 6 of 8 (rings, slalom) | 8 of 8 |
| fly-walk, FLY_AREA 62048,62048 (walk landings: priced, flood, approach check) | 2 of 2: the pit's landing 5 blocks off (0.23 from its cell, 315 ticks), the house's 3 off (0.61, 273 ticks), 0 go-arounds, both walked in | 2 of 2: the same cells (0.38, 324 ticks; 0.26, 376 ticks), 0 go-arounds, both walked in |

### What `!test cavestart 5 from home` on the Realm should show

- No run with four go-arounds; most with none, at most one. Where an approach misses, the log has one line before the
  decision: `landing price: land now on ... against a go-around (7.3 s with 1.13 rockets, P 0.19 to land N s of walk from the
  goal): saves M s <= 7.3 s: landing now`, then `land now: ...`; a second miss of the same kind is never flown round again.
- The landing line for cave_start gains `walk flood N floors (open sky 38 steps from the goal at ...)` and `M approach sims`;
  its first candidates are the ones by walk (beside the cave's mouth by cave_2), not the hill top over the goal. The valley cell
  the probe confirmed on the Realm (46 blocks of walk) is taken only when its approach simulated from over the hill lands; else
  the line says `path 46, no approach (wall ...)` and the next cell by walk is taken.
- With flyCave on, the rest from the landing goes in through the corridor's windows from the mouth side, as on the replica
  (there 118 s became 70). The Realm's 156 to 161 s a run should drop by the 25 to 30 s of go-arounds and part of the walk in:
  about 100 to 120 s; the flight itself (the climb, the cruise, the hold) is unchanged.

### Open points (Track L1)

- `WALK_S_PER_BLOCK` is one number for every walk; the navigator's own path cost (ticks, digging included) would price a walk
  better, and the corridor's flown rest after the landing (as on the replica) is not priced at all: a cell 90 steps away beat
  one 32 blocks away because the rest from there flies.
- The replica does not reproduce the Realm's go-arounds (its probes run out on every cell, so the landing is a fallback with a
  first-approach brake landing); the brain's decision is covered by the unit tests only until the Realm's run.
- The probe's budget (6 000 nodes, 400 ms) runs out on every cell of the owner's cave from the hill: a longer probe for the
  flood's first few cells would turn fallbacks into confirmed cells.
- The route landing's tracker failure still goes round as before (no price); route landings are exact.
- The approach check simulates from APPROACH_DISTANCE along four bearings; the cruise's real entry (a descent circle over the
  cell from far higher) can still miss where the simulation landed: that is what the priced miss is for.
- Files outside the brief's list touched: `tasks/process/fly.ts` (`LandingHint.partial`, the hold's priced look and the stop when
  the brain switched, both in `watchLanding`).

### L2: the walk priced by its path, probes that finish

Track L2, [decisions/0076](decisions/0076-land-by-time.md) (the L2 addendum). Two of L1's open points cost the owner time: every
walk was priced at one pace (0.3 s a block), and on the owner's cave every probe ran out, so the landing was a fallback priced as
unknown (1.5 x the flood's steps at 0.3 plus 15 s: a cell 73 flood steps out came to 47.9 s). On the replica (before, this
track's base): all 16 probes of every search `limited`, in 650 to 1 500 ms in all; the 6 000 nodes ran out, not the 400 ms.

```
the probe (landprobe.ts landingProbe, over reach.ts probePath)
  -> found: the path's blocks and its planned ticks (landprice.ts probeTicks: the move costs without the surface preference
     of 6 ticks a node under a roof and the 30 of a drop deeper than a jump); planned without the surface preference
     (LAND_PROBE_SURFACE false: whether a walk exists does not depend on it)
the price (walkSeconds): confirmed with ticks: ticks / 20 x PATH_PACE (1.07); confirmed without: blocks x 0.3; unconfirmed: as L1
the search (findLanding): the cells ranked by that price in seconds (the roof penalty at 0.3 a block); the stop rule's bound
  at the probe's fastest pace (PATH_MIN_S_PER_BLOCK 0.248 s a block); a covered goal's first LONG_PROBE.count (3) probes by
  the walk flood get 60 000 nodes / 1 500 ms, cut to the search's time left (6 s in all, as before)
the line: each probe `path 113 40.2 s` (`pace` / ` long` when so), the cell `113 blocks of walk (40.2 s by its path)`,
  `at 0.3 s a block` or, a fallback, `unconfirmed: N blocks x 1.5 + 15 s`
```

| File | What |
|---|---|
| `bot/src/skills/fly/landprice.ts` | `TICKS_PER_S`, `PATH_PACE`, `PATH_MIN_S_PER_BLOCK`, `WalkEstimate.ticks`, `WalkPrice`, `walkPriceOf`, `probeTicks` |
| `bot/src/skills/fly/landprobe.ts` | `landingProbe` (the probe with its ticks and a budget findLanding may raise), `landingProbeNav` |
| `bot/src/skills/fly/landing.ts` | `ProbeOutcome.ticks`, `ProbeBudget`, `LandingDeps.probe(from, budget)`, `LandingOptions.longProbe`, `LONG_PROBE`, `LONG_PROBE_MIN_MS`; the ranking in seconds, the long probes, the price notes |
| `bot/src/skills/fly/plan.ts` | `LandingTarget.walkBy` |
| `bot/src/chat/commands-fly.ts` | `landingFor` probes with `landingProbe`; `LAND_PROBE_SURFACE` |
| `bot/scripts/land-probe-bench.ts` | the bench on the private fixture (below) |
| `bot/test/unit/skills/fly-land-time.test.ts` | the L2 guard tests (the price by the path, the shorter walk by time, the hazard, the long probes and the total time) |

**What the probes need** (the owner's cave, the private fixture, `scripts/land-probe-bench.ts` on the test host, 2026-11-09). The
flood's first 8 cells (the hill by cave_2, 25 over the goal) probed with 400 000 nodes:

| | nodes | search ms | path | planned ticks | price (PATH_PACE 1.07) | at the old 0.3 s a block |
|---|---|---|---|---|---|---|
| with the surface preference | 41 067 to 41 826 | 160 to 432 | 113 to 116 blocks | 752 to 772 | 40.2 to 41.3 s | 33.9 to 34.8 s |
| without it | 17 385 to 18 731 | 65 to 104 | 116 to 119 blocks | 745 to 766 | 39.9 to 41.0 s | 34.7 to 35.7 s |

Every one of them is a walk (no digging, no pillar); 6 000 nodes confirm none. The whole search (16 probes, the flood, the sims):

| long probes (3, the flood's first) | surface preference on | off |
|---|---|---|
| none (6 000 nodes / 400 ms each) | nothing confirmed, 397 ms in probes, 467 ms wall | nothing confirmed, 457 ms, 511 ms |
| 20 000 nodes / 800 ms | nothing confirmed, 649 ms, 705 ms | confirmed (113 blocks, 39.9 s by its path), 593 ms, 691 ms |
| 60 000 nodes / 1 500 ms (the default) | confirmed, 859 ms, 967 ms | confirmed, 630 ms, 719 ms |
| 150 000 nodes / 3 000 ms | confirmed, 872 ms, 962 ms | confirmed, 605 ms, 700 ms |

So: no surface preference in the probe, and 60 000 nodes for the first three (3x the need); offline the search stays under a second on
the test host (on the replica, with the live bot's loop, 0.94 to 1.87 s: below), far inside its 6 s. The other 13 probes still run out (the same hill, within 6 blocks of each other: no alternative).

**The pace** (`PATH_PACE`): the navigator in a closed loop on the fixture (`caveWalker`), eight walks between the cave's
waypoints to cave_start and to cave_end, 11 to 129 blocks, one with 208 ticks of swimming: real over planned ticks 1.00, 1.00,
1.02, 1.03, 1.10, 1.11, 1.13, 1.21, median 1.07. The price's error on those walks: 3 to 12 % (6 % on average) by the path,
0 to 32 % (14 %) at 0.3 s a block (the old pace priced the cave's walks 17 to 19 % short and the short dry ones up to 32 % long).
The walks from the hill cells themselves do not finish in the closed loop: the walker (with the surface preference) walks over
the hill to 43 above the goal and its plans there touch unloaded world (`no progress possible`); on the replica the rest from
those cells is the corridor's flight, not that walk.

**The evidence log's cells**, the Realm (blocks only; the log has no ticks, so the after column is the measured range of the
probe's ticks a block, 4.63 on the flat and 6.5 in the owner's cave, at PATH_PACE):

| the walk | L1's price | L2's price |
|---|---|---|
| 2 blocks, 6 blocks (the open goals) | 0.6 s, 1.8 s | 0.5 to 0.7 s, 1.5 to 2.1 s |
| 46 blocks (the valley cell under the hill) | 13.8 s | 11.4 to 16.0 s |
| 54 to 63 blocks (the probes' paths round the hill) | 16.2 to 18.9 s | 13.4 to 21.9 s |
| a fallback 73 flood steps out (the "15-block walk" at 47.9 s) | 47.9 s | 47.9 s when it is still unconfirmed; by its path once a long probe confirms it |

**Not done: the flown rest.** After a landing for a covered goal with `flyCave on` the rest is flown through the corridor's
windows, not walked (on the replica 88 blocks in 10 to 29 s against about 40 s on foot). Pricing it would need the corridor's
plan (the coarse layer's search and its windows' proofs) for every candidate, seconds each against the probe's 0.1 s; the cheaper
way is one corridor plan from the walk flood's entrance and a flown share on the cells whose walk passes it. Left open.

### Measured: the replica (L2, bds-fly2 on the test host, the same runs as L1's table)

Trip C as in L1's table (`FLY_CAVE_PLAIN=1 FLY_CAVE_STYLE=1 FLY_CAVE_REUSE=1`, 5 runs), before (this track's base) and after on
the same replica the same evening, the test host loaded by another track's bench (L1's 69.7 s median was measured on a quieter
host).

| | arrived | seconds to the goal | go-arounds | the landing | the landing search (wall, live) | held | damage |
|---|---|---|---|---|---|---|---|
| before | 4 of 5 | 89.9, 85.7 (the corridor's window: 24 damage, stopped at health 11), 75.2, 64.5, 79.7 (median 79.7) | 0 | 51 off, 25 above: a fallback (`about 56 s of walk`), all 16 probes `limited` | 0.65 to 1.56 s | 52 to 62 ticks | 0, 24, 0.5, 0, 1.9 |
| after | 5 of 5 | 74.5, 70.6, 74.9, 72.9, 97.2 (33 ticks in the cave's water in the corridor) (median 74.5) | 0 | the same hill cell, confirmed: `115 blocks of walk (39.8 s by its path)`, the three long probes found, the rest `limited` | 0.94 to 1.87 s | 60 to 74 ticks | 0 in every run |

The cell is the same (the walk flood's first, on the hill by the mouth): what changed is that it is confirmed and priced (39.8 s
by its path, where L1's line priced the fallback `about 56 s of walk`, unconfirmed), and the hold's look now answers from the loaded part; the
search takes about 0.3 s more at the live wall clock and the hold a few ticks more. The time to the goal is the corridor's rest
from that cell (the flight is 43 to 48 s in every run); the damage before was the corridor's, not the landing's.

The regressions, bds-fly2, FLY_AREA 62048,62048, the final code (L1's "after" column for comparison):

| suite | L2 | L1 after |
|---|---|---|
| fly-walk (walk landings: priced by the path now) | 2 of 2: the pit's landing 3 blocks off (0.62 from its cell), the house's 3 off (0.05), 0 go-arounds, both walked in | 2 of 2: the pit's 5 off (0.38), the house's 3 off (0.26) |
| fly-land, distance from the centre (truth) | 0.65, 0.06, 0.73, 0.03, 0.12 (3x3 40 up), 0.07 (descend 60), 0.03 (5x5 at 300), 0.05 (wall); all on the platform, 0 go-arounds, 0 damage | 0.08, 0.04, 0.05, 0.79, 0.02, 0.11, 0.10, 0.61 |
| fly-land `!fly stop` case | fails: no end line within 60 s of the stop | fails the same way (the old failure on this area) |

Exact landings take no price, so fly-land's spread is the noise of the two runs.

### What `!test cavestart 5 from home` on the Realm should show (L2)

- The landing line for cave_start: its first three probes say ` long`, and where L1's line said `none confirmed: dry ground at
  ... (about N s of walk)` it says `-> <cell>, N blocks of walk (M s by its path)`; the probes after them may still say
  `limited`. The search's time in the line about 0.3 s more than before (the replica, live: 0.65 to 1.56 s before, 0.94 to
  1.87 s after), well inside its 6 s.
- Go-arounds as with L1 (none in the 5 runs of 2026-11-09); a missed approach's `landing price:` line names the target's walk
  in seconds by its path.
- The trip's time about as L1's 81.5 s a run: the cell is the same hill by the mouth (the walk flood's first), now confirmed.
  The hold may land a little sooner where the loaded part has a confirmed cell (the partial answer needs one).

### Open points (Track L2)

- The flown rest after a landing is not priced (above).
- The walk from the hill cells by cave_2 does not finish in the closed loop on the fixture (the walker takes the hill's top and
  its plans touch unloaded world); the probe, without the surface preference, finds the walk the walker does not take. For the
  navigator's owner (Track R3's area): the walker's surface preference over a covered goal.
- `holdWorth`'s bound (tasks/process/fly.ts) still prices the unloaded part's least walk at 0.3 s a block; the path's fastest
  pace is 0.248. Not changed (the file is outside this track's list); the hold waits a little less than it could.
- The forced landing's price (brain.ts, the nearest safe ground) converts the target's walk back to blocks at 0.3 s a block;
  with the walk now priced by its path that is an approximation (brain.ts is Track F9a's).

## Cave exit (Track F9a)

Flight v2, Track F9a, [decisions/0077](decisions/0077-cave-exit.md). The owner (2026-11-09): "What are we doing wrong that the bot
can't fly from start to finish? I can do it in the realm." They take off inside their cave, fly out of its mouth and climb away.
From the same spot the bot hit the roof once or twice on every trip out: the Realm's `!test goto home from cave_start 3` arrived
3 of 3 in 136 s a run, 20 to 30 s of each lost to it. And the rule they gave for it: "the human nature part is first getting out
of the cave then flying home, not just flying home from within the cave. It doesn't have to pathfind its way home from underground,
it has to pathfind its way out from underground and then it can head home."

```
the takeoff chain (commands-fly.ts takeoffFor): ledge -> jump (simulated) -> vertical (simulated) -> route takeoff -> refused
the route takeoff (route/takeoff.ts planTakeoffRoute, commands-fly.ts routeTakeoffFor), two phases:
 1 OUT (the goal's bearing steers nothing)
   the exits (a cell with 16 of air over it, the nearest by the flood; those tried lie 8 apart)
     each: the plan from standing to the exit  ->  the PROOF (glide.ts routeTakeoff)
       the whole takeoff simulated: the tracker out to the exit, then the brain's climb, 300 ticks past the plan,
       at burns of 15, 9, 21, 12 and 18 ticks: out through the exit, no solid met, dry, still flying
     proven: kept, the one that is under open sky soonest wins     refused: one line saying what the climb met
   none proven, flyCave and flyCaveExit on: the WAYS OUT under the roof (waysOut)
     a flood that stays under the roof, through cells with room, to the cells under the real sky
     the plan through a waypoint every 24 cells of the flood's way, the exit and a point in the open, in pieces
     ->  the same proof
   the flight (brain.ts): the tracker flies the plan; after the last goal the climb keeps the line the body left it on
 2 TO THE GOAL: once the body has open sky over it (the sky check's 3 x 3 up to the cruise height) the heading turns
   to the goal 4 degrees a tick while the glide of the next 20 ticks on the new heading meets no solid (climbYaw);
   on the goal's heading the flight is the ordinary one
```

The jump and the vertical takeoff were always simulated before they were chosen. The route takeoff was not: it proved the way to
a cell and nothing after it.

### Files

| File | What |
|---|---|
| `bot/src/skills/fly/route/takeoff.ts` | `planTakeoffRoute` with `prove`, `far` and `budgetMs`; `exitsToTry`, `EXIT_APART`; `waysOut`, `wayGoals`, `WayOut` (its `open` point), the `WAY_*` and `OPEN_*` numbers; `TakeoffRoute.proven`, `out`, `score`, `pieces`; `TakeoffProof` |
| `bot/src/skills/fly/glide.ts` | `routeTakeoff` (the proof), `routeTakeoffOptions` (the brain's options, one place for the proof and the flight), `PROOF_BURNS`; `simulateFlight` with `burn` and `wait` (a planner that answers later), `SimResult.bumps` |
| `bot/src/skills/fly/brain.ts` | `climbYaw`'s two phases after a proven route takeoff (`CURVE_STEP`), `BrainOptions.routeTakeoff.curve`, `pieces`, `underRoof` (a way out that loses its plan lands); `FlightStats.routeTakeoffEnd`, `routeExitYaw`, `routeSkyAt`, `routeHeadingAt` |
| `bot/src/skills/fly/controller.ts` | `ROCKET_GLIDE_WAIT`: no rocket before the server's `gliding` flag; one line for a flight's first rocket |
| `bot/src/skills/fly/rocket.ts` | a rocket entity matched where the rocket was used; `ROCKET_LATE`, `RocketHand.late` |
| `bot/src/chat/commands-fly.ts`, `bot/src/tasks/process/fly.ts` | `routeTakeoffFor` asks for the proof (the flight's own view of the world: the live model, the cache where it has nothing) and writes the decision's line; the flight gets `routeTakeoffOptions` of what was proven |
| `bot/src/config/settings.ts`, `bot/src/chat/help.ts` | `flyCaveExit` (default off) |
| `bot/scripts/cave-exit-probe.ts` | the decision and the takeoff flown at every burn on the private fixture, offline (`--unproven`: the takeoff as it was) |
| `bot/test/unit/skills/fly-cave-exit.test.ts` | the guard tests on synthetic worlds |
| `bot/test/e2e/fly-cave.test.ts` | `tripOut`: `!goto` from cave_start to the home pad on the replica (`FLY_CAVE_EXIT=1`: with the ways out) |

### What was measured first (the Realm's log, the fixture, the replica, the owner's recordings)

**Why the climb hit.** The route takeoff's "exit under open sky" is a cell with `EXIT_OPEN_SKY` 16 of air over it. From cave_start the
Realm found 31 of them, all in the cave's hall (the exit it took had exactly 16 of air and rock over that). The plan to it was sound
(21 ticks, one rocket); the body came out 6 over the exit cell and the climb turned to the goal's heading there, into the hall's wall:
"nothing clears the solid ahead in the climb (the goal's heading, 1.27 a tick, the straight glide hits in 14 ticks): landing on the ground
before it (roof)". The flight came down 11 to 18 blocks lower than it began, the walk out from there took 24 to 60 s, and the next
route takeoff (an "exit" one cell away under the same roof) did the same in one run of three.

Offline on the fixture (`node scripts/cave-exit-probe.ts --unproven --cruise 133`: the first plan taken unproven, the climb turned
at the exit) the same takeoff is the same line for line: the plan of 21 ticks and 153 nodes, out at tick 23, "nothing clears the
solid ahead in the climb (the goal's heading, 1.27 a tick, the straight glide hits in 11 ticks)", `roof` at burns of
9, 15 and 21 ticks.

**The replica does not show it.** On bds-fly2 (`tripOut`, the code before this track, 5 runs) the route takeoff found no plan at all
and the bot walked out: the fixture has an opening to the sky 35 flood cells from cave_start that the Realm's flood never found (its
first three exits were three cells of that opening, each a search that ran out its budget), so the hall's exit was never tried. 5 of
5 arrived in 72 to 75 s, one flight a run, no `roof`. The Realm's failure is reproduced offline on the fixture, not on the replica.

**The second plan at the start.** Every route takeoff logged "the corridor ahead is blocked" a few ticks after its first plan and
searched the same plan again. Two causes. The tracker's burn hazard is an index, -1 for none, and the body matches index -1 while it
still stands on the plan's start: `burnHazard >= i` was `-1 >= -1`, so the first tick after a plan came back from the worker was
"blocked" (an in-thread planner answers within the tick that asks, which hid it from every unit test). And a plan from standing
beside a wall keeps less than the margin on its first edges by construction (`startMarginFor`) and was then checked against the
full margin ("the plan's corridor is blocked at tick 1 of 5, margin 0.15"); the cave windows' plans have been checked against their
own clearance since Track F5b. Explained and left as it is: the second search finds the same plan and costs the takeoff nothing
it can be seen to lose, and correcting it in the tracker cost the obstacle course its rings (see the open points).

**Rockets that fired nothing.** The Realm's log has seven in the three runs, at ticks 32, 39, 76, 83, 135, 52 and 130 of their
flights: all in the climb or the cruise, none the first rocket of a takeoff. Waiting for the glide's confirmation cannot remove
those. What they have in common is speed (1.5 a tick and more): the rocket entity appears where the server's body used the rocket,
its `add_entity` is read a round trip later, and it was matched within 6 blocks of where the local body is then. On the replica
(no latency) there are none, before or after.

**The owner's recorded exits** (seven takes of `!learn`, read offline): the rocket 0.3 to 0.5 s after the jump, out along the
passage climbing 12 to 19 degrees, and no turn at the exit: the heading curves to the goal's over about 35 blocks beyond the mouth
while the climb steepens to 38 degrees; 70 blocks out after 3.0 to 3.7 s and 24 to 45 over the start, on one rocket. Swept through
the fixture's world with the gliding box, every take's exit is clear (the only contacts are two takes' landings on the hilltop
at the end).

### The pieces

**The proof** (`glide.ts routeTakeoff`). `simulateFlight` with the flight's own options (`routeTakeoffOptions`, the same object the
flight then gets), the route's tracker flying on stepBody and the brain's climb after it, `TAKEOFF_SIM_TICKS` 300 past the plan's
ticks. The route's planner may be the worker: the simulation waits for each answer (`wait`), and a search already asked is not asked
again (the way out is the same at every burn until its first rocket ends). A takeoff clears when the tracker came out through its
last goal, no solid was met, the body stayed dry and is still flying or landed on the target; first at the nominal burn, then with
every rocket burning 9, 21, 12 and 18 ticks (`PROOF_BURNS`). A head bump on the way out (a ceiling touched while rising, no wall
met) is not a hit: Track F3's room, hole and stack take off under their roofs so and the server takes no health for it. The
simulation's world is the flight's view: the live model, and the cache's solids where the live model has nothing; with the live
model alone the simulated climb flew into a hill only the cache knew and was refused as "terrain not loaded".

**Two phases in the climb** (`brain.ts climbYaw`, for a proven route takeoff). After the last goal the climb keeps the line the body
leaves it on. Each tick it asks the sky check's 3 x 3 over the body up to the cruise height; from the tick that passes
(`routeSkyAt`, "open sky over the body") the held heading turns `CURVE_STEP` 4 degrees a tick towards the target whenever the glide
of the next 20 ticks on the new heading meets no solid, and stays otherwise; on the target's heading the hold is over
(`routeHeadingAt`). A heading held until a sky check towards the goal passed and then released was built first: at a burn of 11
ticks the body left the mouth 40 degrees off the held heading, the release turned 15 degrees a tick through headings that met the
shore's hill, and the flight ended `roof` outside the cave.

**The exits tried** (`exitsToTry`). The nearest, then exits `EXIT_APART` 8 from every one chosen, then (fewer than three such) the
nearest other columns as before; an exit within 8 of one whose climb was refused is skipped. Of the proven ones the takeoff that is
under open sky soonest wins; the time to the goal breaks a tie.

**The ways out** (`waysOut`, `wayGoals`; `flyCave` and `flyCaveExit` on). A flood from the start through the air that stays under
the roof: a cell with no solid over it up to the cruise height is a way out and is not flooded past, so the flood is the cave's
size (the owner's cave: 8 790 cells in 19 ms on the PC; flooding on through the open sky took 400 000). Past the first three steps a
cell needs a block of room each side and two of height. A way's plan goes through a 3 x 3 x 3 waypoint every `WAY_STEP` 24 cells of
the flood's way, the exit's box, and the way's open point (`WayOut.open`: 12 blocks out along the heading, of twelve, with the
longest run of open sky from the exit), searched in pieces of one goal (`WAY_PIECES`; in one search the same plan was not found in
4 s). The tracker is the plain one. Measured on the owner's cave at burns 9 to 21: with the cave style's rules 2 of 7 came out and
5 bailed out a block off the reference in a passage 14 wide; plain, all 7 came out through the mouth with no hit. A way out that loses its plan lands
(`underRoof`); it does not go on as a climb.

**The first rocket** (`controller.ts ROCKET_GLIDE_WAIT`). `canFire` is false until the loop's GlideEvent says the server glides the
body, in every takeoff the flight controller flies (the route driver and the corridor's driver already waited). After 6 predicted
gliding ticks without the flag the rocket goes as before. One line a flight: "the first rocket at tick N, G gliding ticks in: the
server's glide confirmed at tick C".

**The rocket's entity** (`rocket.ts`). Ours when it appears within 6 of the body now or of where the body used the rocket. A rocket
entity that comes within `ROCKET_LATE` 20 ticks for a use already written off is logged ("that rocket did fire, the write-off was
wrong") and counted (`RocketHand.late`), and one that is taken for somebody else's says how far it was from both.

### Offline, the owner's cave (`scripts/cave-exit-probe.ts --cruise 133`, the PC, 2026-11-09)

| | the takeoff as it was (`--unproven`) | this track, `flyCaveExit` off | this track, the way out |
|---|---|---|---|
| what is flown | the hall's exit, the climb turned there | nothing: the hall's exit is refused ("roof: down at ..."), the bot walks out | 5 goals, 57 ticks planned, 4 rockets planned |
| burns 9 to 21 (13) | `roof` at every burn tried (9, 15, 21) | | 13 of 13 out and flying 400 ticks on, no hit |
| the way out | 23 ticks, 1 rocket | | 54 to 76 ticks, 3 to 4 rockets |
| 70 blocks from the start | never | | after 3.0 to 4.0 s, 21 to 27 over the start |

The way out's plan at other margins and risk weights (0.2 / 0.5 and 0.25 / 2: other plans through the same cave): 13 of 13 each.
Without the open point the plans at 0.15 / 0.5, 0.25 / 0.5, 0.25 / 2 and 0.3 / 2 gave 13, 8, 12 and 10 of 13: the losses were
`roof` ends just outside the mouth, the body leaving it towards the hill beside it. The owner's takes are 70 blocks out after 3.0 to 3.7 s and 24 to 45 over the start on one
rocket: the same time, lower, on three times the rockets.

The decision's time, the planner in the thread: 4.1 s on the PC and 4.3 s on the Mac (`node scripts/mac-run.mjs -- node
bot/scripts/cave-exit-probe.ts --cruise 133`), of which 1.6 s are two searches that run out their 800 ms on the fixture's opening
the Realm does not have, 0.2 s the way's search and the rest the six simulations with the tracker's searches inside them.

### On the server (bds-fly2, the replica, `FLY_CAVE_ONLY=tripOut FLY_CAVE_STYLE=1`, 5 runs each, 2026-11-09)

| | before this track | this track (`flyCaveExit` off, the default) | this track, `FLY_CAVE_EXIT=1` |
|---|---|---|---|
| arrived | 5 of 5 | 5 of 5 | 5 of 5 |
| seconds to the goal | 71.9 to 74.9 (median 72.6) | 71.6 to 73.0 (median 72.3) | 73.3 to 76.5 (median 74.5) |
| flights a run | 1 (a vertical takeoff after a walk of 32 blocks to open sky) | 1 (the same) | 1 (the same) |
| flights ended `roof` | 0 | 0 | 0 |
| damage | 0 | 0 | 0 |
| rockets a run | 6 to 8 | 6 to 8 | 6 to 8 |
| rockets that fired nothing | 0 | 0 | 0 |
| the route takeoff at cave_start | no plan to three cells of one opening (2.4 s), refused | no plan to two cells of that opening, the hall's exit planned and refused by its proof ("roof: down at ..."), 1.7 s | the same, then the way out: 56 ticks, 4 rockets, 5 927 nodes, 80 ms; its proof clear at the nominal burn, one hit at a burn of 9 ticks: refused; 3.9 s |

The replica never had the Realm's `roof` ends (see above), so its trip is the same before and after: the walk out and a vertical
takeoff. What it shows of this track is the decision: the hall's exit, which the Realm flew into the roof, is planned and refused
before anything flies, in one line; and the way out is refused there by its proof (the worker's plan on the replica is one tick
shorter than the offline one and the simulation at a burn of 9 ticks touched something once). Two things had to be right before
the proof said even that: the first series refused the way out as "enters terrain not loaded" because the simulation saw only the
live model (the flight's obstacle check also sees the cache); and the fly-over's stops lie on the line home, 96 apart, so `tripOut`
looks at the ground 64 beside it first.

### The regressions (the final code; bds-fly3 for fly-route-land and fly-route, bds-fly2 for the rest)

| suite | result |
|---|---|
| fly-route-land (the room's route takeoff, the stack's ledge, the holes' vertical) | 7 of 7 green |
| fly-route | 3 of 3 green |
| fly-course, FLY_AREA 71520,69472 | 8 of 8, twice (the base commit on the same area the same day: 8 of 8 and 7 of 8, the slalom) |
| fly-cave trip C (`FLY_CAVE_STYLE=1`, one run, three times over the day) | arrived each time: 81.8, 98.0 and 94.1 s; damage 0, 0 and 3.8 |
| fly-land | 4 of 5: `!fly stop in the air` waits 60 s for a "landed (stopped)" reply that a trip superseded by `!fly stop` no longer says ("a superseded trip's line not said"); the flight itself landed `stopped` 15.6 s after its start. The base commit fails the same case the same way |

Each suite was run with nothing else on the machine.

### What `!test goto home from cave_start 3` on the Realm should show

- At the start of every run `fly: route takeoff: N exits under open sky; <cell> (36 cells away): 21 ticks, 1 rockets, ...; the climb
  after it: roof: down at ...: refused -> no route takeoff (1 simulated, ...)`, then the takeoff-site search or the walk out, and a
  takeoff outside whose line is a jump's or vertical's `clear`, or a route takeoff's `the climb after it: clear at burns of 15, 9,
  21, 12, 18 ticks (through the exit at tick ..., open sky at tick ..., the heading from ... at the exit to the target's by tick
  ...)`.
- No `flight: nothing clears the solid ahead in the climb` within a second of `route takeoff: out through the exit`, and no
  `flight: ended (roof)` 11 to 18 blocks under the start. One flight a run that leaves the ground and arrives.
- `route: the corridor ahead is blocked` still follows `route: start` once (the same plan again: see the open points).
- `flight: the first rocket at tick N, G gliding ticks in: the server's glide confirmed at tick C` once a flight.
- A rocket "fired nothing" line may now be followed by `that rocket did fire, the write-off was wrong`: that is the evidence the
  matching still loses rockets, and how late their entities come.
- The time: 136 s a run before. The roof flight, its landing and the walk out of the hollow were 44 to 73 s between the first
  takeoff and the one that flew home; a walk from cave_start to open sky and a takeoff there is about 40 steps. Expect 95 to 110 s.
- With `flyCaveExit` on as well: `the way out at <cell> (about 89 cells under the roof, 5 goals): about 57 ticks, 4 rockets; the
  climb after it: clear at burns of ...`, then `flight: route takeoff: out through the exit after 54 to 76 ticks`, `open sky over
  the body`, `the climb's heading reached the target's`; or its proof's refusal and the walk out as above. Expect 75 to 85 s where
  it is proven.

### Open points (Track F9a)

- **The way out has never flown on a server.** Offline it is proven and flies at every burn; on the replica its proof passed at
  the nominal burn and refused it at 9 ticks (one hit in the simulation, on a plan one tick shorter than the offline one), so the
  bot walked out. `flyCaveExit` ships off for that reason.
- **The proof is as good as its simulation.** Five burns, every rocket of a simulation the same; no latency; the model's world.
  A takeoff can fail where its proof passed, and then ends as before.
- **Three to four rockets where the owner uses one.** The way's waypoints follow the flood's way along the floor, down to the
  passage's low point and up again; the owner flies one rising line. Boxes as high as the air over the cell did not change the plan
  (the same 48 ticks and 4 rockets, the search 650 ms against 200).
- **The recorded paths are not used.** The planner would take them as a preferred way (the recording's cells in place of the
  flood's in `wayGoals`) and a heading profile for the climb in place of `climbYaw`'s turn; the proof stays as it is.
- **The mid-flight rockets that "fire nothing"** are a hypothesis until the Realm's log shows the new lines.
- **The fixture is not the Realm.** The fixture has an opening to the sky near cave_start that the Realm's flood did not find; the
  replica, built from it, behaves like the fixture.
- **The decision takes seconds** (4 s on the fixture): two of them are searches that run out their budget on cells of one opening.
  An exit beside one that had no plan is still tried, as Track F3 had it (a hole's second cell may plan where its first does not).
- **Underground to underground** (cave_start to cave_end without going out) is the corridor's business and untouched: its
  windows are flown by the corridor's own driver, which shares none of this track's changes.
- **The second plan at the start is explained, not removed: `route/tracker.ts` is as it was.** Two corrections were built (the
  comparison made `burnHazard >= 0 && burnHazard >= i`, first for every driver, then only for the route takeoff behind an option)
  and both were taken out again because of fly-course's rings (bds-fly2, FLY_AREA 71520,69472, two runs a course, a course passes
  when one of them completes). With either correction in the tracker no rings run completed in six whole-course runs (0 of 12),
  the last four of them alone on the machine (the rings flown alone, three and four runs a batch, did complete one run of each
  batch); with the tracker file as before this track and everything else of this track in place, the course was 8 of 8 four
  times, and the base commit 8 of 8 and 7 of 8 (the slalom). The second correction changes nothing the course's driver executes,
  as far as the code can be read, so the cause is not understood; the file was left alone rather than argued with.

## Learned exits (Track F9b)

Flight v2, Track F9b, [decisions/0078](decisions/0078-learned-exits.md); learned paths as guides, part 1 (the exit). After Track
F9a the takeoff from inside the owner's cave is refused by its proof and the bot walks 102 blocks to open sky before it flies:
35 s of the Realm's 90.6 s a run. The owner flies that stretch in 3 to 4 s on one rocket and recorded seven takes of it with
`!learn`: "It doesn't have to follow me to a tee but it should be able to recognize the flight path (like through the cave
entrance)."

```
the route takeoff (commands-fly.ts routeTakeoffFor, route/takeoff.ts planTakeoffRoute), flyCave and flyLearned on:
 the recordings in <config dir>/paths (learn/store.ts)  ->  their flights (learn/guide.ts guidesOf: a stretch off the ground,
   12 blocks or more, cut at every gap; a line of points a block apart, the rockets fired on it)
 matched by geometry, never by name (learn/match.ts matchExits):
   it left the ground within 4 blocks of the body (3 in height), under a roof, and comes out under open sky
   the nearest takeoff first, a line that itself grazes a block after those that do not; at most 3 tried
 each: the PROOF (glide.ts routeTakeoff), the whole takeoff simulated at every burn from 9 to 21 ticks and at two
   mixes of them, each burn's end seen two ticks late:
   the follower along the line (learn/follow.ts), out under open sky, then the climb of Track F9a
   proven: taken, nothing else is tried     refused: one line, the next take
 none matches, or none proven: the exits and the ways out of Track F9a, as without a recording
 the flight (brain.ts guideTakeoff): the follower flies the line; out once the body is past the line's first open sky and
   has open sky over it; then the climb keeps its heading and turns to the goal as the path ahead clears (climbYaw)
```

### Files

| File | What |
|---|---|
| `bot/src/skills/fly/learn/guide.ts` | a recording as its flights: `guidesOf`, `Guide` (points a block apart, their recorded ticks, the rockets, `grounded`, `landed`), `guideNearest`, `guidePoint`, `guideLength`, `guideHead`, `guideTail` |
| `bot/src/skills/fly/learn/match.ts` | `matchExits` (a way out from where the body stands), `matchEntries` (a way in to a goal under a roof: built for the next track, nothing flies it), `MATCH_NEAR`, `MATCH_UP`, `OPEN_POINTS`, `OUT_AFTER`, `IN_BEFORE` |
| `bot/src/skills/fly/learn/store.ts` | `PathStore` (the folder's recordings, a file read again only when it changed), `parsePath` |
| `bot/src/skills/fly/learn/follow.ts` | `GuideFollower`: the body's place on the line, the aim, the look chosen by its glide over the horizon, the rockets; the `FOLLOW_*` numbers |
| `bot/src/skills/fly/route/takeoff.ts` | `TakeoffRouteOptions.learned`, `learnedRoute`, `LEARNED_TRIES`, `TakeoffRoute.guide`; the learned ways tried before the exits |
| `bot/src/skills/fly/glide.ts` | `routeTakeoffOptions` carries the guide; `routeTakeoff` proves a learned line at `LEARNED_PROOF_BURNS` (every burn) and `LEARNED_PROOF_MIXES`, each burn's end seen late, the cells it asks remembered for the proof, a hit's place in its line; `simulateFlight`: `burn` by the rocket's number, `endLag`, `SimResult.firstHit` |
| `bot/src/skills/fly/brain.ts` | `guideTakeoff` (the follower in the tracker's place, the hand-over under open sky, a lost line lands); `BrainOptions.routeTakeoff.guide`; `routeTakeoffEnd` `'off the line'` |
| `bot/src/chat/commands-fly.ts`, `bot/src/tasks/process/fly.ts` | `routeTakeoffFor` reads the paths, matches them and writes the decision's line; the flight's start line names the learned line |
| `bot/src/config/settings.ts`, `bot/src/chat/help.ts` | `flyLearned` (default off) |
| `bot/scripts/cave-exit-probe.ts` | `--paths`, `--takes`, `--learned follow\|waypoints`, `--async`, `--snapshot`, `--at`, `--trace`, `--replica` (the replica's model: the shell, the terraces, the flat world), `--end-lag`, burns as `a/b` (a first rocket of a ticks, b for the later ones); the simulations get the terrain columns (`--no-terrain`: without) |
| `bot/test/unit/skills/fly-learned-exit.test.ts` | the guard tests: synthetic recordings through synthetic caves |
| `bot/test/e2e/fly-cave.test.ts` | `tripOut` with `FLY_CAVE_LEARNED=<folder>`: the recordings moved with the replica, `flyLearned` on |

### What was measured first (the fixture, `scripts/cave-exit-probe.ts`, the PC, 2026-11-10)

**Why the searched way out needs four rockets and fails at a burn of 9.** Three things, each measured on the fixture.

- The waypoints. They are cut every 24 cells from the flood's way, and a flood of unit steps knows no slope. Against the owner's
  seven lines: the first two waypoints lie at the floor, 3 to 6 blocks beside the owner's line and 1 to 4 under it; the third is
  11 over the second only 9 blocks farther on (a climb of 50 degrees inside the passage) and 5 over the owner's line; the fourth
  is level with the third. Each is a box of 3 x 3 x 3. The owner climbs 12 to 19 degrees all the way.
- The rockets. Every goal is its own search (pieces of one goal) that returns the first plan to reach it, and the heuristic
  counts the way left at the boosted speed with a weight of 2: a rocket's 20 ticks of cost are earned back in about 24 ticks of
  flight, and a rocket may be fired again from the ninth tick of a burn. The plan fires at ticks 3, 24, 36 and 46, burns 47 of
  its 57 ticks, flies 80 blocks to get 67 from the start and turns six times by 29 to 87 degrees, left and right in turn.
- The burn of 9. The third rocket is fired as the body leaves the steep climb with a turn of 45 degrees to make. Ending 6 ticks
  early it leaves the body 1.7 to 2.0 off its reference, the tracker asks for a new plan seven times in twelve ticks, and the
  body meets the passage's wall 4 ticks past the third goal, 17 over the start where the owner is 10 to 13 over it.
- What it is not. The takeoff from standing: the plan's first edge is the jump and a rocket at tick 3 along the bearing of the
  first waypoint, which is what the owner does. The margin: at 0.2, 0.25 and 0.3 with risk weights of 0.5, 2 and 2 the plans
  have 4 to 5 rockets and, with the planner a tick late, 12, 12 and 11 of 13 burns come out clean, after up to 165 ticks under
  the roof. The open point: it turns the plan's last ticks by 87 degrees, but the hit comes two goals before it.

**Why the fixture's probe did not show it.** Track F9a's probe searched in its own thread: an answer comes within the tick that
asks. The bot's planner is a worker. With every answer a tick late (`--async --snapshot`) the fixture gives the Realm's line for
line: the same plan (57 ticks, 4 rockets, 6 076 nodes) "clear at the nominal burn; hits a solid 1 time at a burn of 9 ticks:
refused". Flown anyway at the 13 burns it came out clean at 11 of them, on 3 to 6 rockets, 70 blocks out after 3.0 to 5.2 s;
at a burn of 11 it ran out its 200 ticks under the roof on 10 rockets in two runs of three and came out after 164 ticks on 9
in the third (the searches end on wall-clock budgets, so runs differ). In the bot a search of 250 to 600 ms answers 5 to 12
ticks late, which no simulation that waits for every answer shows.

**The recorded line: as waypoints, or followed.** Both were built and measured on the owner's takes (six of the seven leave the
ground within 4 blocks of cave_start; the seventh 7 away).

| | the line as waypoints for the search (a 3 x 3 x 3 box every 12 blocks) | the line followed (`learn/follow.ts`) |
|---|---|---|
| takes with a takeoff | 3 of 6 (the other three: no plan in 2 s) | 6 of 6 |
| what is planned | 56 to 71 ticks, 3 to 4 rockets, turns of 45 and 90 degrees between the boxes | nothing: the line itself |
| burns 9 to 21 flown with no hit, the planner in the thread | 37 of 39 | 78 of 78 |
| the same with the planner answering a tick late | 37 of 39 | 78 of 78 (it asks no planner) |
| rockets to the way's end | 2 to 5 in the thread, 2 to 9 a tick late | 1 to 2 |
| 70 blocks from the start | 3.0 to 4.1 s in the thread, 3.0 to 8.3 s a tick late | 3.2 to 3.5 s |
| the decision | the search up to its 2 s; 0.2 to 1.7 s to a plan and one simulation | 0.25 s a take at five burns, no search |

(These rows are the follower as first measured against the waypoints: single burns, every burn's end known at once. The proof
as it shipped is in the next table.)

**The recorded heights are feet heights in the air too.** A recording's `y` is the position the server sends less the standing
eye height, 1.62, and a gliding body's eye is 1.2 lower than a standing one's: were the position the eye's, every touchdown out
of a glide would show a step of 1.2 up. The seven in the fourteen recordings show none (the last samples in the air run down to
the first on the ground at the glide's own sink), so a line's points are where the feet were.

### The pieces

**A recording's flights** (`guide.ts guidesOf`). The samples with one no speed explains dropped (over 80 blocks a second from
the sample before, where the samples round it agree); every run of samples off the ground of 12 blocks or more is a flight,
cut where the recorder lost sight (a gap of a second) so that nothing is drawn through what was not seen. It starts at the last
sample on the ground when that lies within 2 blocks (`grounded`: a takeoff; the sample may be seconds old, a player standing
still sends nothing, so its time is taken as a tick before the jump's) and ends at the first one after it (`landed`). The line is
resampled a block apart along the samples, each point with the tick it was passed and each rocket with its tick and place.

**The match** (`match.ts matchExits`). A grounded flight whose first point lies within `MATCH_NEAR` 4 blocks of the body
horizontally and `MATCH_UP` 3 in height, does not begin under open sky, and has `OPEN_POINTS` 4 points in a row with nothing over
them up to the cruise height (the route grid's rule: an unknown cell is a roof). The line is kept `OUT_AFTER` 16 blocks past the
first of those. The recording's name is carried for the log and decides nothing. The matches come the nearest takeoff first;
`planTakeoffRoute` then puts a take whose own line passes within `FOLLOW_MARGIN` of a block (`follow.ts lineRoom`: the gliding
box on the line's points from 3 blocks along it to its open sky) after those that keep it. Of the owner's six, the nearest
(0.2 from cave_start) passes a block beside its start at 0.27 and the next (0.8) keeps 0.88: the next is tried first, and it is
the one whose simulated flight has 1.4 blocks to the nearest solid under the roof where the nearest take's has 0.7.

**The follower** (`follow.ts GuideFollower`). Each tick: the nearest point of the line ahead of the last place (never behind
it); an aim on the line as far ahead as the body flies in `FOLLOW_HORIZON` 6 ticks (4 to 12 blocks); 54 looks round the aim
(yaw 0, 6, 14, 28 and 45 degrees either way, pitch 0, 8 and 18 either way and 30 down), each flown 6 ticks on the glide formula
with the swept box kept `FOLLOW_MARGIN` 0.3 clear, on the burn the body reports and on the burn ending as early (9 ticks) and as
late (21) as it can; the look with the least distance to the line over those ticks and no solid met is flown. A body standing
beside a block keeps half the berth it has, as the search's first edges do. Before the glide it jumps and looks along the line.
The first rocket is asked for when the body has been off the ground as long as the recording was when it fired (the brain adds
its own rule: not before the glide's third tick, and the controller's wait for the server's flag); a later recorded rocket at
its place on the line, unless one burns there; and one more whenever the body is under `FOLLOW_SPEED` 1.0 a tick with more than
6 blocks of line ahead. The line is lost: 5 blocks off it for 5 ticks; with no glide 30 ticks after the jump; with no block of
progress along it in 30 ticks (`FOLLOW_STUCK`); and when the best look still ends in a solid within the horizon two ticks
running. That last test is on the bare box, not the berth (a look that passes within 0.3 of a block is a graze and is flown: the
owner's line does so beside cave_start; one that meets it is a crash), and then no rocket goes and the body brakes first, the
look turned round at pitch -20 until it is under 0.25 a tick. A wall put across the passage after the proof (the unit test's)
is stopped 2 blocks short of on the one rocket; as first built the follower held the body against it on four.

**The takeoff** (`brain.ts guideTakeoff`). The follower flies in the route tracker's place and the rest is the route takeoff's:
the glide asked from the first tick in the air, the rocket's rules, the counters. Out: past the line's first open point with the
sky check's 3 x 3 free over the body up to the cruise height, or the line's end. The climb is Track F9a's (the heading kept,
then turned 4 degrees a tick towards the goal while the path ahead is clear). The recording's own curve past the mouth is not
flown: it leads where the recorder went. A lost line lands (`roof`), as a way out that loses its plan does.

**The proof** (`glide.ts routeTakeoff`). The same simulation as for every route takeoff, and for a learned line more of it,
because each costs a twentieth of a second without a search:

- every burn from 9 to 21 (`LEARNED_PROOF_BURNS`, the five first). The five are not the range: on the replica the take nearest
  cave_start cleared the five and met a solid at a burn of 14 (below), and a line drawn from the flood cleared the five and met
  a wall at 11;
- the burns mixed (`LEARNED_PROOF_MIXES`; `simulateFlight`'s `burn` may be a function of the rocket's number): a first rocket of
  21 ticks with 9 for every later one, the flight with the least energy (after a long burn the follower fires no second rocket
  under the roof, and the climb's own are short), and 9 with 21 after it;
- every burn's end seen two ticks late (`endLag`, `GLIDE.boostEndLag`). The input loop boosts until the rocket's remove_entity,
  which comes two inputs after the burn has ended, so the brain asks for its next rocket that much later than a simulation that
  knows the end at once: a climb on rockets back to back has a gap after each.

A refusal for a hit or for water says where (`hits a solid 1 time (the first at tick T in the climb, U over the start and D
blocks from it)`, `ends in water (at tick T in the ...)`). The cells a proof asks are remembered while it runs (three million
questions for one proof on the owner's cave, of a world that does not change meanwhile). The other route takeoffs' proofs are
untouched: five burns, no lag, the same lines.

**The decision's line.** `fly: route takeoff: 6 learned ways out from here (15 recorded flights, 6 leaving the ground within 4),
N exits under open sky; the learned way out along <name> (it left the ground 0.8 from here, 69 blocks to open sky in 52 ticks, 1
rocket): clear at burns of 15, 9, 21, 12, 18, 10, 11, 13, 14, 16, 17, 19, 20 ticks and of 21 then 9, 9 then 21 (through the exit
at tick 60, open sky at tick 60, ...) -> out along the learned line <name> to <cell>, then the climb curving to heading H (15
simulated, T ms)`. In the
flight: `learned line: rocket 1 asked for 1 blocks along it, 11 ticks off the ground (where the recording fired one)`, and
`route takeoff: out along the learned line <name> after 60 ticks, 2 rockets (open sky over the body, 68 of 80 blocks along it, at
most 0.67 off it, steered 3 ticks); the climb keeps this line until the sky is open, then turns to heading H as the path ahead
clears`.

### Offline, the owner's cave (`scripts/cave-exit-probe.ts --cruise 133 --paths <folder>`, the PC, 2026-11-10)

The probe's simulations now have the terrain columns, as the bot's own have (the simulated climb keeps the terrain floor; Track
F9a's probe flew without, `--no-terrain`), so the first two columns are measured again here.

| | Track F9a's way out, the planner in the thread | the same, the planner answering a tick late (as the bot's does) | this track: the learned line, each of the six takes |
|---|---|---|---|
| the proof | clear at the five burns | "clear at the nominal burn; hits a solid 1 time at a burn of 9 ticks: refused" (the Realm's and the replica's line) | clear at the thirteen burns and the two mixes |
| burns 9 to 21 flown (13) | 13 of 13 out, no hit | 11 of 13 out with no hit (a hit at 9; at 11 never out: 201 ticks and 10 rockets under the roof, then down) | 13 of 13 out with no hit, and four mixes (21 then 9, 9 then 21, 18 then 9, 20 then 12): 102 of 102 for the six takes, every burn's end seen two ticks late |
| under the roof | 54 to 73 ticks, 3 to 4 rockets | 56 to 99 ticks and 3 to 6 rockets where it came out | 55 to 62 ticks, 1 to 2 rockets (one where the first burn is a long one) |
| 70 blocks from the start | 3.0 to 3.9 s, 21 to 27 over the start, on 3 to 5 rockets | 3.0 to 5.2 s where it came out, on 3 to 6 rockets | 3.2 to 3.5 s, 28 to 38 over the start, on 2 to 3 rockets (the way out's, and the climb's first towards the cruise height) |
| the body off the line | | | at most 0.7 and 1.1 (the two takes begun within a block of cave_start, at its height), 1.5 to 1.8 (the four begun 2 blocks off and 2 up: the join) |
| the nearest solid | | | under the roof 0.7 blocks from the gliding box for the nearest take, 1.4 for the second (the recorded lines themselves pass 0.3 to 0.9 from a block within their first 7 blocks, beside cave_start, and keep 1.2 to 3.5 of room from 16 blocks on, but for one take that passes the mouth's rim at 0.8); after the hand-over 3.1 to 3.7, at the mouth's rim, and nothing nearer for the 352 ticks simulated; the climb steers for nothing |
| the decision | 4.8 s | 4.2 s to the refusal | 0.8 s for a take that clears (15 simulations, no search) |

From the four corners of cave_start's cell (0.4 each way from its centre) the same: proven, 52 of 52 single burns out with no
hit. The owner: 70 blocks out after 3.0 to 3.7 s, 24 to 45 over the start, on one rocket; they level off at 43 to 70 over the
start where the bot climbs on to its cruise height, which is what its second and third rockets by then are for.

The decision's time elsewhere: 0.5 to 0.6 s for the unit test's cave on the test host (`node scripts/mac-run.mjs -- pnpm --filter bot
exec vitest run --project unit test/unit/skills/fly-learned-exit.test.ts --silent=false`: 15 simulations; the same on the
PC), and 1.3 to 1.8 s on the replica's bot, whose cells are the live model's (15 simulations, the take tried first proven; 1.5
to 2.1 s in the series before, when the nearest take was tried first and refused at its second: 17). The owner's recordings were not taken to the test host, so the fixture's number is the PC's.

### On the server (bds-fly2, the replica, `FLY_CAVE_ONLY=tripOut FLY_CAVE_STYLE=1 FLY_CAVE_REUSE=1`, 2026-11-10)

`FLY_CAVE_LEARNED=<folder>` gives the test the owner's recordings: it moves them as the replica is moved (x and z by a multiple
of 16, the heights kept), writes them to a temporary folder the bot reads as its paths folder, and turns `flyLearned` on.

| | Track F9a (its own runs, 2026-11-09) | this track, `flyLearned` off (the default) | this track, `FLY_CAVE_LEARNED` (the final code) |
|---|---|---|---|
| arrived | 5 of 5 | 5 of 5 | 6 of 6 |
| seconds to the goal | 71.6 to 73.0 (median 72.3) | 70.6 to 72.3 (median 71.5) | 59.9 to 65.4 (median 63.4) |
| flights a run | 1 (a vertical takeoff) | 1 (a vertical takeoff) | 1 (the route takeoff along the learned line) |
| the walk before the takeoff | 32 blocks to open sky | the walk to open sky; the takeoff 11 blocks from cave_start as the crow flies | 0: every run leaves the ground at cave_start |
| flights ended `roof` | 0 | 0 | 0 |
| damage | 0 | 0 | 0 |
| rockets a run | 6 to 8 | 6 to 8 | 6 to 7 |
| rockets that fired nothing | 0 | 0 | 0 |
| the route takeoff at cave_start | the hall's exit planned and refused by its proof, 1.7 s | the same: two cells of the opening with no plan, the hall's exit refused by its proof, 1.8 s | 6 learned ways out; the take 0.8 from cave_start tried first (its line has the follower's berth, the nearest take's has not) and proven at the thirteen burns and the two mixes, the simulated climb steering 29 ticks for the shell; 15 simulated, 1.3 to 1.8 s |
| under the roof | | | the first rocket at tick 9, 6 gliding ticks in (the glide confirmed at tick 4 or 5); out after 58 to 59 ticks on 1 to 2 rockets (the second 54 to 69 blocks along the line, the body at 0.78 to 0.85 a tick; none in one run of the six), at most 0.98 off the line, no steering |

All five series, as the proof grew (the last is the final code):

| the proof | runs | arrived | what flew |
|---|---|---|---|
| five burns (as every route takeoff's) | 5 | 4 | the take nearest cave_start, proven. Four runs home in 60.8 to 63.8 s. In the fifth the first burn was a long one (no second rocket under the roof); the takeoff was out as in the others, and the climb then met the replica's shell (below) 6 under its top, 176 blocks from cave_start; the flight ended there and the trip fell from that height: 71 of damage, no arrival |
| every burn from 9 to 21 | 8 | 8 | that take refused ("clear at the nominal burn; hits a solid 1 time at a burn of 14 ticks"), the next one proven and flown: 59.4 to 67.1 s, 0 damage |
| every burn, the two mixes, the burn's end seen late | 6 | 6 | the same: 59.5 to 64.3 s, 0 damage |
| the same proof; the follower gives the line up for a crash ahead; the proof's cells remembered | 6 | 6 | the same take, the nearest refused at its second simulation ("ends in water at a burn of 9 ticks"): 60.9 to 64.7 s, 0 damage; 17 simulations in 1.5 to 2.1 s |
| the same proof; the takes whose own line has the follower's berth are tried first (the final code, the column above) | 6 | 6 | the take 0.8 from cave_start, tried first and proven, none refused: 59.9 to 65.4 s, 0 damage; 15 simulations in 1.3 to 1.8 s |

**Where the replica is not the Realm, and what that means.** Under the roof it is the Realm's cave as far as anything shows: the
replica is the fixture's box cell for cell (the fixture has no chunk it does not know), and Track F9a's way-out search returns
the same plan on the Realm and on the fixture node for node (6 076 nodes), which another passage would not give. The opening
to the sky that the fixture and the replica have and the Realm's flood did not find (Track F9a) is 15 over cave_start and about
10 blocks from it on the side away from the line; no take passes it. The difference is beyond the mouth. The replica's box
stands inside a stone shell one block thick, from the flat world up to the box's top, far over the hill the cave lies under,
and the flight home crosses it 172 to 190 blocks from cave_start. The Realm has no shell. So the cruise height on the replica
is the shell's and not the hill's, and the climb after the mouth has a wall to get over that the Realm does not have. Simulated with the terrain floor,
as the bot flies (the probe, `--replica` against the fixture): on the replica's model the climb steers 21 to 42 ticks for the
shell and passes its top with 0.4 to 1.1 blocks to spare at every burn; on the fixture, which is the Realm's ground as the cache
has it, the climb steers for nothing and is never nearer than 3.1 blocks to a solid after the hand-over (the mouth's rim). That
half block is what the first series' fifth run lost. The replica's bot refuses the take nearest cave_start with one proof or
another (a solid met at a burn of 14; with the burn's end seen late, water at a burn of 9) where the probe on the replica's
model proves all six: the bot's model is the live one (the terrain's columns known live, from the cache or not at all, and a
cell it has not been sent is a wall to the follower), and the probe's is the fixture whole. What it means for the Realm: none of
this is the cave's or the line's. The Realm's proof flies the real ground beyond the mouth, where the fixture says the climb
is free, and which take it then proves is the live model's to say; the one tried first is the one the replica flew (0.8 from
cave_start: the take 0.2 from it grazes a block by itself and now comes after). The decision's line names the take and says
what a refused one met, and where. What the replica did show: five
burns are not a proof of a climb with half a block to spare, and a simulation that clears a solid by half a block says "clear"
as one that clears it by 30 does (the open points).

### The regressions (bds-fly3 for fly-route-land and fly-route, bds-fly2 for the rest; `flyLearned` off)

| suite | result |
|---|---|
| fly-route-land (the room's route takeoff, the stack's ledge, the holes' vertical) | 7 of 7 green, twice |
| fly-route | 3 of 3 green, twice |
| fly-course, FLY_AREA 71520,69472 | 8 of 8 green with none of this track's other jobs running. A run before it, while this track's probe and unit jobs ran beside it, was 7 of 8: the rings course completed neither of its two runs (1 and 2 of 5 rings). Not run a third time |
| fly-cave trip C (`FLY_CAVE_STYLE=1`, 5 runs) | 5 of 5 arrived, damage 0: 88.8 to 93.2 s in four, 143.6 s in one (5 walks and 33 ticks in the cave's water on its way in, the case Track L2's table has too; Track F9a's three runs took 81.8 to 98.0 s). The trip takes off from the home pad: none of this track's code runs in it with the setting off |
| fly-cave tripOut, the setting off | the middle column above: as before this track |

`route/tracker.ts` and `route/search.ts` are untouched.

### What `!test goto home from cave_start 3` on the Realm should show (`flyCave on`, `flyLearned on`)

- At the start of every run, after `fly: vertical takeoff: the column over the start is open only 6 up`: `fly: route takeoff: 6
  learned ways out from here (15 recorded flights, 6 leaving the ground within 4), 31 exits under open sky; the learned way out
  along <name> (it left the ground 0.8 from here, 69 blocks to open sky in 52 ticks, 1 rocket, its line 0.88 from the nearest
  block): clear at burns of 15, 9, 21, 12, 18, 10, 11, 13, 14, 16, 17, 19, 20 ticks and of 21 then 9, 9 then 21 (through the exit
  at tick 59, open sky at the same tick, the heading from within a few degrees of the goal's at the exit to the target's a tick
  on) -> out along the learned line <name> to <cell>, then the climb curving to heading H (15 simulated, T ms)`. No
  takeoff-site search and no `walking out towards home` after it. The counts are the recordings' as they are on 2026-11-10
  (seven ways out, seven ways in and one of those in two pieces: 15 flights; 6 of them leave the ground within 4 blocks of
  cave_start); the take is the second nearest, tried first because the nearest grazes a block by itself.
- `fly: to home (N blocks): cruise y ..., a route takeoff along the learned line <name> out to <cell> (52 ticks, 1 rockets
  recorded), then the proven climb curving to heading H`.
- In the flight: `learned line: rocket 1 asked for 1 blocks along it, 8 ticks off the ground (where the recording fired one)`;
  `the first rocket at tick 9 or a few later, G gliding ticks in: the server's glide confirmed at tick C`; unless the first burn
  is one of the longest, `learned line: rocket 2 asked for 54 to 70 blocks along it (the body at 0.8 a tick with line ahead)`;
  then `route takeoff: out along the learned line <name> after 58 to 59 ticks, 1 to 2 rockets (open sky over the body, 70 of 85
  blocks along it, at most 1.0 off it, steered 0 ticks)` (the replica's numbers, which are the fixture's), `open sky over the
  body ... 0 ticks after the exit`, `the climb's heading reached the target's`.
- No `flight: ended (roof)`, no `nothing clears the solid ahead in the climb`, one flight a run.
- A refusal instead (`...: hits a solid 1 time (the first at tick T in the climb, U over the start and D blocks from it) at a
  burn of N ticks: refused`, then the next take, or the hall's exit and the walk out as today) means the Realm's cave or the
  ground beyond its mouth is not the fixture's where that take runs, or the bot stood somewhere else; the line says which burn
  met what and where. All takes refused: the run is the 90 s one, plus the proofs' time.
- `route takeoff: the learned line <name> lost after N ticks (...): no climb without the line here, landing` and a flight ended
  `roof` under the roof: the flight left what its proof flew (a correction, a rocket that fired nothing). The trip then walks on
  from where it came down.
- The time. Today 90.6 s a run: 0.5 s of deciding, 35 s of walk to open sky, a flight of 710 to 770 ticks from there (36 to 38 s),
  14 s of walk at home. With the learned way the walk out goes, the decision takes 1 to 2 s (15 simulations for a take that
  clears: 1.3 to 1.8 s on the replica's bot) and the flight starts 46 blocks farther from home: expect 55 to 60 s a run, one
  flight.

### Open points (Track F9b)

- **It has not flown on the Realm.** Offline on the fixture and on the replica (which is built from the fixture) it flies; the
  Realm has latency, a server's own rocket timing and the real cave. `flyLearned` ships off for that reason.
- **The proof is a simulation, and "clear" has no margin.** Fifteen flights (every burn, two mixes, the burn's end seen late),
  no network latency, the model's world. A simulated climb that passes a solid by half a block is "clear": on the replica
  every proven take's climb passes the shell's top so, and 30 of the 31 flights of the five series got over it (the one that
  did not flew a take the five-burn proof had passed and every later proof refused). On the fixture nothing is nearer than 3.1
  blocks after the hand-over. A berth for the climb in the proof (say, nothing within 2 blocks from 20 ticks after the exit) or the jump
  takeoff's own rule (a climb that had to steer is no first choice) would refuse every take on the replica, for its shell,
  and none on the fixture; neither is built, because the replica would then show nothing. A rocket that fires nothing in the
  climb (the Realm has them) is not simulated either.
- **The line must begin where the bot stands.** A takeoff 5 or more blocks from every recording's start does not use one (the
  seventh take begins 7 from cave_start); walking to a recorded start, or joining a line part of the way along it, is not built.
  A recording made from a block two over the floor is flown from the floor beside it (the join costs up to 1.8 off the line and
  is proven).
- **Out is where the sky is open, and the recording's curve after that is not used.** On the owner's cave the line points near
  the goal's heading there by chance. A goal on the other side turns 4 degrees a tick from the exit's line as the path clears
  (Track F9a's rule), which the proof flies; it may refuse a goal the recorder never flew towards.
- **By 70 blocks out the bot has fired 2 to 3 rockets where the owner fires one.** One or two get it out (two when the first
  burn is a short one: the body is then under 1.0 a tick before the mouth); the next is the climb's first towards the cruise
  height, which lies over where the owner levels off (43 to 70 over the start). The cruise height is the flight's business,
  not the takeoff's.
- **Three takes are tried and the first that proves clear is flown.** The order is the nearest takeoff first, with the takes
  whose own line passes within the follower's berth of a block after the others; it is not the take with the most room in its
  simulation, and a fourth to sixth take are never tried: each refused take costs up to 15 simulations, about 0.1 s each on
  the live model.
- **The way in is not flown.** `matchEntries` finds five of the owner's seven recorded ways in at cave_start (touchdowns 0.4 to
  2.2 blocks from it; of the other two one ends in the air where the recorder lost sight, and one stands again 6 blocks off): 65 to 76 blocks under the roof after
  the 24 kept in the open, 86 to 105 ticks, no rocket on them, 1.3 to 1.8 blocks a tick at the last open sky, 0.7 to 1.1 ten
  blocks before the touchdown and 0.2 at it. Flying one needs what the exit did not: a hand-over from the cruise onto the line's
  first point at the line's speed and heading (the landing search aims at a cell today, not at a line in the air); the follower
  holding the recording's speed, which it has in the guide's ticks and does not use (it only knows "too slow: a rocket"; the
  owner's last climb is the brake); a touchdown on the recorded cell; and a proof that ends in a landing there, where the
  takeoff's ends in a climb.
- **The searched way out (`flyCaveExit`) is as Track F9a left it**, and the cause is known now (above). The follower on a line
  drawn from the flood is the way to mend it: a crude one (the flood's way pulled straight with a block of berth, the corners
  rounded) was proven at the five burns and flew 12 of 13 burns clean on 1 to 2 rockets, 70 blocks out after 2.9 to 3.0 s, with
  one hit at a burn of 11. Not in the repository.
- **The proof of the route tracker's takeoffs waits for every plan.** A simulation cannot know how late the worker answers; the
  room, the hole and the stack of Track F3 plan once and fly, so they are not touched by it, a way out that re-plans is.
- **The panel's poll payload is 8 bytes under its bar** (20 092 of 20 100) with the `flyLearned` row: the next setting moves it.
- **Two loaders.** `chat/commands-learn.ts loadPaths` (the `!learn list` commands) and `learn/store.ts PathStore` (the flight)
  both read the folder; the store checks every sample and remembers what it read. `commands-learn.ts` was not this track's to
  change.

## Learned entries (Track F9c)

Flight v2, Track F9c, [decisions/0080](decisions/0080-learned-entries.md); learned paths as guides, part 2 (the entry). After
Track F9b the bot flies out of the owner's cave along a recorded line and still goes in as before: a landing on a cell beside
the cave's mouth, about 14 s of window proofs, one window that bails out, a walk: 25.6 s from the landing to the goal on the
Realm, of 81.8 s a run. The owner does not land outside at all: seven recorded takes glide down a hill, through the mouth and
65 to 76 blocks under the roof with no rocket and stand beside the goal after 4.3 to 5.3 s. "fly through caves and land
underground."

```
a flight to a goal (tasks/process/fly.ts watchEntry), flyCave and flyLearnedEntry on, once it is in the air:
 the recordings in <config dir>/paths  ->  the flights that stood again within 4 blocks of the goal, under a roof, after
   open sky (learn/match.ts matchEntries: by where they stand, never by name)
 each as a LINE (learn/entry.ts entryLine):
   the hand-over WINDOW: 24 blocks of its open air, ending 20 before its last open sky, flown at 0.9 a tick or more
   a LEAD-IN before it: the window's heading and slope drawn straight backwards, up to 40 blocks, through free air only
   the touchdown: the goal's own cell, or where the take does not fly to that the nearest standable cell within 2 blocks
   of it that it does (round 2, "The cave changes"); the line ends where it comes nearest the touchdown
 each PROVEN (proveEntry): 39 flights from the hand-over to standing, the recording's own state and every extreme of what
   the hand-over allows (3 beside the line, 5 over, 2 under, 0.5 to 1.25 of its speed, 25 degrees off its heading; early,
   in the middle, late); no hit, no water, the line never lost, standing within 2 blocks, coming down under 0.45 a tick
   on the live model, the world cache where the live model has nothing yet; every cell asked is remembered
 of those that clear, the one with the most room: the flight is RETARGETED to it (the landing it had is the fallback)
 the cruise (brain.ts cruise): to the lead-in as to a route landing's corridor; a dive along the line for the height left;
   a helix beside the lead-in's start when it comes in too high
 the HAND-OVER: on the lead-in to the flier (entryJoin: near the line, heading along it; open air)
   in the window the flier COMMITS: the body inside the proof's box (entryCatch) and the proof confirmed on the live world
   (every remembered cell the same: entryWorldSame)          not committed by the window's end: MISSED -> a go-around,
                                                             twice at most, then the fallback (climbing away first)
 the flier (EntryFlier): the follower along the line, no rocket, never faster than the recording (a tick of looking back),
   the touchdown: the brake as late as it still stops over the goal's cell, the creep onto it, the sink; standing
   the line lost under the roof: brake, the nearest ground (`roof`), as a learned exit
 no recording that ends there, the setting off, every proof refused: nothing of this runs
```

### Files

| File | What |
|---|---|
| `bot/src/skills/fly/learn/entry.ts` | the entry: `entryLine` (window, lead-in, touchdown), `EntryFlier` (the follower, the commit, the touchdown), `entryJoin` / `entryCatch` (the two steps of the hand-over), `flyEntry` / `entrySteps` / `proveEntry` / `entryCases` (the proof), `entryWorld` / `entryWorldSame` (the proof's cells, and the proof against the live world), `entryAim` (where the cruise aims), `EntryHandoff`, the `ENTRY_*` numbers |
| `bot/src/skills/fly/learn/fresh.ts` | round 2: a fixture's export time against the recordings' (`fixtureFreshness`): the stale-fixture warning of the probe and the cave e2e |
| `bot/src/skills/fly/learn/follow.ts` | `FollowOptions.entry` (`FollowEntry`: no jump, no rocket, the checked glide ended where the touchdown's brake begins, the speed governor `FOLLOW_TAP_*`, the aim ahead of a body far off the line `FOLLOW_JOIN_AIM`, the wider lost distance while joining), `FollowOutput.crash`; a rocket that fired nothing: `FOLLOW_DUD_TICKS`, the place found again, the rocket asked for again; `FOLLOW_SWITCH` (the probe's) |
| `bot/src/skills/fly/plan.ts` | `LandingTarget.entry` (a type) |
| `bot/src/skills/fly/brain.ts` | the phase `entry`; in the cruise: the hand-over to the flier, `entryHelix`, the dive in `routeSink`, the escape; `entry`, `entryMissed`, `entryFallback`, `entryStood`, `confirmEntry`; `FlightStats.entry`; `BrainOptions.entryTries` / `entrySneak`; the `ENTRY_*` numbers of the approach |
| `bot/src/skills/fly/controller.ts` | `confirmEntry` passed on, `FlightReport.entry`, the line for an entry given up (three small additions: the file is not this track's) |
| `bot/src/skills/fly/glide.ts` | `simulateFlight`'s `dud` (a rocket that fires nothing: the body unboosted, the brain shown the predicted one for `DUD_SEEN_TICKS`), `LEARNED_PROOF_DUDS`, `routeTakeoff`'s `dud` verdict |
| `bot/src/skills/fly/route/takeoff.ts` | a learned way out that does not survive a dud first rocket is kept for last (`TakeoffProof.dud`) |
| `bot/src/tasks/process/fly.ts` | `FlyDeps.entry`, `EntryOffer`, `watchEntry` (the decision in the air, the retarget, the confirmation), `watchLanding` taking the fallback back |
| `bot/src/chat/commands-fly.ts` | `entryFor` (the match, the lines, the proofs, the decision's line), `entryClass` (cells in the world cache's classes), `entryOn`; `!fly` to a goal with a recorded way in flies the plain way; the walk for the last step after an entry |
| `bot/src/config/settings.ts`, `bot/src/chat/help.ts` | `flyLearnedEntry` (default off) |
| `bot/scripts/cave-learned-entry-probe.ts` | the fixture's probe: `--mode lines` (the takes), `catch` (sweeps and the proof by take), `trace` (one entry tick by tick), `approach` (the whole flight from standing in the open: `--starts`, `--burns`, `--cruise-over`, `--replica`) |
| `bot/scripts/cave-exit-probe.ts` | `--dud` (every flight's first rocket fires nothing), `--old-dud` (the follower as Track F9b left it) |
| `bot/test/unit/skills/fly-learned-entry.test.ts` | the guard tests: synthetic recordings into a synthetic cave |
| `bot/test/e2e/fly-cave.test.ts` | trip C with `FLY_CAVE_LEARNED=<folder> FLY_CAVE_ENTRY=1`; `FLY_CAVE_ONLY=round` (in along a learned entry, out along a learned exit) |

### What was measured first (the fixture, `scripts/cave-learned-entry-probe.ts`, the PC, 2026-11-10)

**The takes.** Seven recordings of the way in; five stand again within 4 blocks of cave_start under its roof after open sky
(of the other two one ends in the air where the recorder lost sight, one stands 6 blocks off). Each is 114 to 153 blocks from
its takeoff on a hilltop to its touchdown, 65 to 76 of them under the roof in 72 to 87 ticks. Three were flown with a rocket
at the takeoff and pass the open part at 1.4 to 1.9 a tick; two glide off the hill and reach 1.0 to 1.4. All five turn about
70 degrees and dive 30 to 45 degrees through the mouth. Two of them come in over the goal's floor and stand on a ledge 2
over it, 2.1 and 2.2 from the goal; three cross a dip 4 blocks under the goal 10 blocks before it and climb out of it at 13
to 28 degrees while the speed falls from 1.2 to 0.2 a tick: the climb is their brake. The line's open part runs 1 to 4 blocks
over the hill's flank; its first 30 to 40 blocks are the jump and a slow start.

**The follower as Track F9b left it, started on the line in the open.** It flies the line through the mouth and under the
roof. What it does not do:

| | what happened | what was built for it |
|---|---|---|
| the speed | at the line's end 1.6 to 1.8 a tick where the recording had 1.0 to 1.1: a follower tracks the place, and the recordings' pull-up before the touchdown is a matter of speed. It met the wall behind the goal at 1.25 a tick | the governor: over 1.1 of the recorded speed at its place, one tick of looking straight back (a fifth of the speed, the direction kept), never two in a row |
| the line's end | "every look ends in a solid": a line that ends on the ground always does. Lost 11 to 14 blocks before the touchdown | the checked glide ends where the touchdown's brake has begun; the touchdown: the brake as late as it still stops over the cell, or a tick before it would meet a solid |
| the recorded touchdown | one take rises onto a ledge 5 over the goal and drops off it, two stand on a ledge 2 up: the last blocks of a recording are its recorder's landing | the touchdown is the goal's own cell; the line ends where it comes nearest that |
| the dip | the three takes that cross it stall-climb out at 0.2 a tick; the follower stands in it, 2 to 6 from the goal | nothing: their proof refuses them (below) |
| a body far over the line | it aimed at the line 4 to 12 blocks ahead and came down on it at 70 degrees, at 0.9 a tick | the aim at least 2.5 times the body's distance from the line ahead |

**What the flier then catches** (one axis at a time from the window's middle, start and end; `--mode catch`). The take with
the most room: up to 8 blocks to one side and 4 to the other (the hill), 5 under the line and 8 over it (16 at the window's
start), at 0.7 to 2.1 a tick whatever the recording had, the heading up to 60 degrees off. The other take that clears is
narrower. The proof's box is what both hold with the extremes stacked: 3 beside, 5 over, 2 under, 0.5 to 1.25 of the
recording's speed within 0.8 to 2.0 a tick, 25 degrees.

**The cell beside the mouth and "no approach (wall 200)".** The landing search's simulated approaches to that cell end
`wall` (the approach's glide meets a solid before the touchdown; 200 is that verdict's base cost): the cell lies in the
hill's flank under the slope the approaches come down. It does not matter here: the entry does not land at the mouth.

### The pieces

**The line** (`entryLine`). A match's recording from its window on, with the lead-in before it. The window is looked for
backwards from 20 blocks before the last open sky, while the recording flew 0.9 a tick or more, 24 blocks at most (a window
under 4 blocks: no line). The lead-in: the direction of the window's first 8 blocks and their slope (kept between 6 and 20
degrees down), drawn backwards a block at a time for up to 40 blocks while the gliding box at the point is a block clear of
every solid: on the owner's two takes 28 and 40 blocks. Its points carry the window's own speed. No rocket is on the line.

**The follower's entry mode** (`follow.ts`). No jump and no wait for a glide (a body that stands has landed; one in the air
without a glide has lost the line); no rocket asked for; the aim never beyond the line's end, and at least `FOLLOW_JOIN_AIM`
2.5 times the body's distance from the line ahead; the line lost only 28 blocks off it while the body is before the window's
end (5 from there on, as on the way out); the checked glide of each look ended where the touchdown's brake has begun (within
0.75 + 3.6 a block a tick of the touchdown); the governor (`FOLLOW_TAP_OVER` 1.1, `FOLLOW_TAP_PITCH` -30). A look that ends
in a solid before the line's last 14 blocks is what it was: two ticks, the brake, `lost`.

**The touchdown** (`EntryFlier`). On the line's last 14 blocks, every tick: the station keeping's own law (brake.ts
`keepLook` with `holdPitch`) rolled out on the glide formula until the body is under 0.35 a tick. It begins when that
roll-out stops within 0.75 of the goal's cell or past it, or when begun a tick later it would meet a solid that it does not
meet begun now, or when the follower's own look ends in a solid. Then the look back while the body is fast (the height
held: what the body came with, between 0.75 and 3 over the floor), the creep onto the cell, the sink at 0.15 a tick. A body
that has come down under the cell's floor beside it (too slow for a step) sinks where it is.

**The proof** (`proveEntry`, `entryCases`). One flight is `flyEntry`: the flier on `stepBody` from a state, committed, until
the body stands, loses the line or 400 ticks have gone. 39 states: at the window's middle, start and end, the recording's
own; 3 right and left; 5 over; 2 under; slow; fast; the heading 25 right and left; and four corners (over, fast and to a
side with the heading turned in; under, slow and to a side with the heading turned out). A state inside the ground (the box
reaches into the hillside) is left out; the recording's own three are not. `room` is the least distance any of the flights
kept from a solid before its touchdown; `roofTicks` the longest from the line's last open sky to standing. A collision in
the air that takes more than 0.15 a tick off the body's speed is a hit; a slower one is a touch and is counted apart (the
goal's cell has a wall 0.2 beside a body standing on its centre, and the creep brushes it in some flights). The simulations
run in slices of 12 ticks with the event loop in between.

**The proof's world, and its confirmation** (`entryWorld`, `entryWorldSame`, `commands-fly.ts entryClass`). Every cell is
one of four: air, a solid (an unknown cell is one), water, what is never entered. These are the world cache's own classes
(`world/cache/classes.ts cellClassOf`), and a live block is classed the same way, so the live block and the cache's stand-in
for it are the same cell. A proof made while the goal is still far away reads the cache; the answer to every cell it asked
is kept (11 200 cells on the replica). While the flight comes in, the live model is asked the same cells every 5 ticks:
`unknown` while any is not loaded, `changed` at the first that differs, `same` when all agree. Only `same` lets the flier
commit.

**The hand-over** (`brain.ts cruise`, `entry`; `entryJoin`, `entryCatch`). A target with an entry is a point in the air (the
window's end; its `top` is the height the cruise should have 44 blocks before it, no lower than the flight's clearance over
the ground under the lead-in) with a bearing: the cruise's corridor machinery brings the body in along the line. Every
cruise tick the body is held against the lead-in: within 8 beside it, heading within 45 degrees of it, at 0.45 a tick or
more, not under it by more than 3, and over it by at most 4 blocks and 0.35 for each block of line left to the window's end:
then the flier has it (`learned entry: onto the line of <name> N blocks before its hand-over window (the lead-in) ...`). The
flier flies the lead-in and, from the window's start, tests the commit every tick; committed, it says so with the body's
state (`learned entry: on the line <name> N blocks before its roof (S beside it, U over it, V a tick where the recording had
R, the heading H degrees off its own): inside what the proof flew`). At the window's end uncommitted: `missed`, with why.

**The way down to the lead-in.** The level glide and the steeper glide of a route landing's hand-over as they are; beyond
them a dive along the line at the slope still needed and 6 degrees more, 40 at most (`routeSink`). A body that reaches the
lead-in's start (within 44 blocks of it) higher than the join allows flies the helix (`entryHelix`): a circle of 14 blocks
beside the start, on the side whose ground is lower, that touches the line at the start heading along it. The cruise's own
test takes the body at the first pass that is low enough.

The helix's descent is steered to that pass. A glide cannot fly level: in a circle this tight it sinks 0.19 of a block for
every block flown at pitch 0 and 0.36 at pitch 30 (measured in the circle at about 1 block a tick), so a lap costs 20 to 36
blocks of height and nothing less. The first version dived at pitch 30 to 12 over the start and "levelled" at pitch 5: where
the last lap ended was where the arrival height happened to put it. On the replica that was the hand-over at 6 to 11 over
the line in 8 runs of 9 and, in the ninth, a pass just too high for the hand-over, one more lap, 20 blocks lower, under the
line, and a glide that went on low over the hill the line lies along and stood on it (0.7 damage, the run finished by the
corridor in 160 s). What it does now:

- **The plan.** The body is to cross the start `ENTRY_HELIX_UNTIL` 8 over it. When the helix begins, the laps are counted
  once: the fewest with which the steepest descent (`ENTRY_HELIX_SINK.hi` 0.33 a block) still comes to the start no higher
  than the hand-over takes there. A body still more than 6 blocks outside the circle flies to it along its tangent, and
  that straight piece counts.
- **The pitch**, every tick: the height still over the pass divided by the blocks still to fly to it (the rest of this lap
  and the whole laps left), turned into the pitch that sinks so much (between pitch 0 and pitch 30 in proportion, 35 at
  most; level over 1.5 a tick, 20 down under the stall speed).
- **A pass** is the body coming by the start along the line's heading; it ends 8 blocks beyond the start, and each one
  takes a lap off the count. The last pass is flown along the line itself, not the circle, and ends later the higher the
  body is: the hand-over's test finds the body's place on the line in three dimensions, so a body high over a line that
  comes down is "on" it only some blocks farther on (0.4 for each block of height).
- **The last pass with no hand-over** (the body still too high: a descent that began level takes a second to sink at
  all): one more lap when the height still pays for one (`learned entry: the start of <name> passed N over it with no
  hand-over (...): one more lap of the circle`), else a miss at once. A lap costs 20; the flier takes 22 over the start;
  between the two there is a band a few blocks wide from which neither works, and that is a go-around.
- **A go-around for a learned entry** climbs to a lap's worth over the pass height (`ENTRY_HELIX_AGAIN` 34 over it) and
  turns back in only with that height, so the body comes back with a lap to spend. (The brain's own go-around height is
  the hand-over's height and 6: it brought the body back 26 to 27 over the start, into the same band, and a second pass
  was missed like the first: one flight of 14 given up.)
- **No circle** on a side where a column under it is unknown, where the ground under the last lap (the ring 12 to 18
  blocks from the centre, the flattest glide's height over each column) is within `ENTRY_HELIX_CLEAR` 3 of the body, or
  from where the flattest glide would reach the start more than `ENTRY_HELIX_LOW` 4 under the pass height. A circle that
  sinks 6 under its plan, or is flown for 500 ticks, is a miss: the go-around climbs out along the line on a rocket. It
  never goes on as a low glide.

With the laps on a plan, the body comes onto the line 8.6 to 8.7 over it whenever it had a lap to spend: on the replica's
model from 102 to 115 over the start at 13 burn lengths, and in every one of the replica's runs below.

**A miss, a refusal, a lost line.** A miss (`entryMissed`): the go-around of the brain, out along the line and back onto the
lead-in; after `ENTRY_TRIES` 2 misses, or with no rocket, the fallback (`entryFallback`): the landing the flight had before
the entry, after a climb of 24 blocks away from the line when the body is beside it (the rocket on the first of four looks
whose boosted path is clear: turning back along the line or straight on, at 30 and 45 degrees up; none clear: the flight
lands at once on the nearest ground before the line's roof, `learned entry: no way up and out from where it was given up
...: landing on the nearest ground, within N blocks`). The proof not confirmed by the
window: a miss. The live world different: the fallback at once. A line lost after the commit: `learned entry: the line
<name> lost ...: no glide without the line under a roof, landing`, and the flight ends `roof` on the nearest ground.

**The exit's dud rocket** (`glide.ts`, `follow.ts`). `simulateFlight`'s `dud`: the rocket is spent and gives no boost; for
`DUD_SEEN_TICKS` 5 ticks (the rocket hand's `ROCKET_ADD_WITHIN`) the brain is shown the body the input loop would have
predicted (the same inputs with the boost) and a burn, then the real body, behind it. The learned exit's proof flies that
for its first rocket with the next one at 15, 9 and 21 ticks (`LEARNED_PROOF_DUDS`): 18 simulations where there were 15.
The follower: a burn that ends within 8 ticks was none; the body's place on the line is looked for again from the line's
start, and the rocket is asked for again on that tick whatever the speed. `planTakeoffRoute` keeps a take that clears all
but the dud in hand and flies it only when none of the takes tried survives one.

### Offline, the owner's cave (`scripts/cave-learned-entry-probe.ts --paths <folder>`, the PC, 2026-11-10)

**By take** (`--mode catch --cases`): the proof's 39 entry states (the grid above), each flown from the hand-over to standing.

| take | recorded speed in its window | the proof | standing from the goal's cell | from the last open sky to standing | the least room | the proof's time |
|---|---|---|---|---|---|---|
| A (it stood 2.2 from the goal, on a ledge 2 up) | 1.65 to 1.68 a tick | clear from 39 of 39 | 0.2 to 0.7 | 65 to 69 ticks on the line (3.3 to 3.5 s), 138 at most (6.9 s) | 0.39 | 1.9 s |
| B (2.1 from the goal, the same ledge) | 1.41 to 1.69 | clear from 39 of 39 | 0.0 to 0.8 | 75 to 77 ticks on the line (3.8 to 3.9 s), 133 at most (6.7 s) | 0.13 | 2.1 s |
| C (0.4 from the goal) | 1.07 to 1.32 | refused at its own state: stands 5.7 from the goal and 4 under it (the dip) | | | | 0.05 s |
| D (0.7) | 1.64 to 1.67 | refused at its own state: 4.3 from the goal, 3 under it | | | | 0.04 s |
| E (1.8) | 1.06 to 1.31 | refused at its own state: 5.8 from the goal, 4 under it | | | | 0.05 s |

Take A is the one flown (the most room). No flight of the 78 met a solid or water or lost the line; every one came down at
0.14 a tick or slower and stood 57 to 138 ticks (2.9 to 6.9 s) after the line's last open sky, the longest from the states under the line and
slow (half the recording's speed) in the window's middle and at its end; 19 of them touched the wall beside the goal's cell once in the touchdown's creep. Against where the recordings themselves stood, the bot stands 2.1 to 2.2 away: it stands on the goal's
cell, they stood on the ledge beside it.

**The whole flight** (`--mode approach`: standing in the open, the takeoff, the cruise, the hand-over, the entry), the code
as shipped. Seven places 62 to 250 blocks from the goal on every side the fixture has ground on.

| | take A (the one flown) | take B |
|---|---|---|
| the cruise at its own height (49 to 130 over the goal), rockets of 9, 12, 15, 18 and 21 ticks | 35 of 35 standing on the goal's cell; 28 on the first pass, 7 after one go-around (three of the places, each at one or two of the burns); 12.3 to 31.6 s from standing in the open | at 15 ticks only: 7 of 7 (0.0 from the cell's centre), 2 of them after one go-around; 11.5 to 35.3 s |
| the cruise 62, 70, 84 and 137 over the goal, rockets of 15 ticks | 28 of 28; 26 on the first pass, 2 after one go-around (one place, at 62 and 70) | |
| standing from the goal's centre | 0.1 to 0.9 | 0.0 |
| from the commit to standing | 84 to 107 ticks | 101 to 117 |
| from the line's last open sky to standing | 55 to 71 ticks (2.8 to 3.6 s) | 69 to 79 ticks (3.5 to 4.0 s) |
| off the line while joining | up to 22 blocks (taken from above) | up to 22 |
| contacts between the hand-over and standing | 8 of the 63 flights: one touch each in the touchdown's creep (0.25 to 0.26 a tick, 2.7 to 2.8 from the goal: the wall beside its cell) | 2 of the 7: a touch in the creep (0.12 to 0.13 a tick) |
| given up | none | none |
| the replica's world, from its home pad (trip C's whole flight, the cruise 137 over the goal), rockets of 9 to 21 ticks | 13 of 13 standing on the goal's cell, 41.4 to 42.4 s, the helix from 102 to 115 over the lead-in's start, 3 laps, the hand-over 8.6 to 8.7 over the line in every one | refused there (its lead-in runs into the replica's shell) |

(One of the 7 places is a hillside: its takeoff brushes the slope at its 8th tick in every flight, with either take; that
contact is the takeoff's.) Six more places 85 to 238 blocks out, take A, rockets of 15 ticks: 6 of 6 standing on the
goal's cell on the first pass, 11.9 to 22.6 s. (A seventh has a roof over its takeoff and never flew; an eighth has no
ground in the fixture.)

The go-arounds are the band between what the flier takes and what a lap costs: a takeoff's climb that ends beside the
lead-in's start 20 to 24 over it, or a first descent onto the start that was begun level and came out a few blocks high.
Each cost take A 5 to 10 s and ended standing on the goal (take B from a cruise 137 over the goal: 7 of 7 standing, 2
after a go-around that cost about 20 s). Before the go-around was given its own height for an entry, one such flight in
14 missed twice and gave the entry up.

**The give-up, low at the window's end.** Measured on an earlier state of this code, where take B from one place was handed
over 3 blocks before the window, 7 beside the line and 7 over it, was not in the box by the window's end and was given up
after its second miss. First version: a climb back along the line. Low at the window's end the hill is behind and the roof
ahead; no rocket's path was clear, none was fired, and the path-ahead check flew the body on towards the mouth for 30
ticks (it scraped the mouth's lip on its way out). Now the rocket goes on the first clear look of four (turning back, or
straight on and up, at 30 and 45 degrees), and with none clear the flight lands at once (`roof`) on the nearest ground at
least `ENTRY_ESCAPE_BEFORE` 4 blocks before the line's last open sky: there within 13 blocks, standing beside the mouth 55
from the goal after 19.8 s with no contact, as the landing without a recording stands there. (Without that cap the
emergency landing takes safe ground up to 60 blocks ahead; in the unit tests' straight passage that was the hall's floor,
flown to on nobody's proof.) With the code as shipped that flight is handed over after a go-around and stands on the goal:
no fixture flight gives the entry up any more, and the give-up is covered by one unit test.

**The exit and a first rocket that fires nothing** (`scripts/cave-exit-probe.ts --paths <folder> --takes --dud`: each of
the six takes out of cave_start flown by the follower with its first rocket spent for nothing, the next one burning 9,
12, 15, 18 and 21 ticks; `--old-dud`: the follower as Track F9b left it).

| take (nearest the body first) | out under open sky, this track's follower | the follower as it was | rockets under the roof | 70 blocks out after |
|---|---|---|---|---|
| 1 (it grazes a block beside its start) | 0 of 5: lost on the ground after 19 ticks, off the line | 0 of 5, the same | | |
| 2 | 5 of 5 | 5 of 5 | 2 to 3 | 3.5 to 3.8 s |
| 3 | 5 of 5 | 5 of 5 | 2 to 3 | 3.5 to 3.8 s |
| 4 | 5 of 5 | 5 of 5 | 2 to 3 | 3.5 to 3.8 s |
| 5 | 5 of 5 | 5 of 5 | 2 to 3 | 3.5 to 3.8 s |
| 6 | 5 of 5 | 5 of 5 | 2 to 3 | 3.5 to 3.8 s |

(The five that come out are under open sky 61 to 68 ticks after the takeoff.) The bot's own choice there is as Track
F9b left it: the takes whose line keeps the follower's berth are tried first, the first of them (take 2) is proven, now
with the dud (18 simulations where there were 15, about 1.0 s), and flown; take 1 is not reached. A take like it that
is reached (it clears every burn and fails the dud) is kept in hand and flown only when no other take tried survives a
dud: the unit tests' case. The Realm's one failed exit (a recorded take from a body 1.2 blocks off its start) comes out in the simulation with
either follower, 3 of 3: the fixture does not reproduce that failure. What the follower does about a dud (a burn under 8
ticks is none, the place found again from the line's start, the rocket again on that tick) is shown by the unit tests
only.

### On the server (bds-fly2, the replica, `FLY_CAVE_ONLY=tripC FLY_CAVE_STYLE=1 FLY_CAVE_REUSE=1`, 2026-11-10)

`FLY_CAVE_LEARNED=<folder> FLY_CAVE_ENTRY=1` gives the test the owner's recordings (moved as the replica is, into a
temporary folder the bot reads as its paths folder) and turns `flyLearnedEntry` on.

**Home to cave_start** (trip C: `!fly` from the home pad; every run arrived, 0 in water).

| | runs | landings outside the cave | bail-outs | go-arounds | from the last open sky to standing | seconds to the goal | damage |
|---|---|---|---|---|---|---|---|
| before, the Realm's way (`FLY_CAVE_PLAIN=1`: the plain flight to the goal's landing, the rest from there) | 5 | 5 of 5: 9 to 13 blocks from the goal and 15 to 26 over it, then a walk of 28 to 32 blocks | 0 | 0 | 13.2 to 20.9 s (the landing to the goal) | 61.2 to 71.9, median 61.5 | 0 |
| before, the corridor trip | 3 | 3 of 3: 20 to 60 blocks from the goal, 27 to 37 over it, then 1 to 3 walks | 0 (no window flown) | 0 | 40 s and more | 93.6, 95.0, 139.1 | 0 |
| `flyLearnedEntry` on, the helix as first built (a dive to a height, then "level") | 9 | 1 of 9 | 1 | 0 | 59 to 70 ticks in the 8 | 43.8 to 45.3 in the 8; the ninth 160.3 | 0 in the 8; 0.7 in the ninth |
| the helix steered to its pass, two earlier states of it (the laps counted again every tick) | 16 | 0 | 0 | 0 | 59 to 65 ticks | 43.7 to 51.4, median 44.3 | 0 |
| as shipped | 8 | 0 | 0 | 0 | 61 to 65 ticks (3.1 to 3.3 s) | 43.3 to 44.4, median 44.0 | 0 |

In the 24 runs of the last two rows: one flight a run, standing 0.2 to 0.5 from the goal's centre, 90 to 96 ticks from the
commit to standing, the hand-over 8.6 to 8.7 over the line every time after 3 laps of the helix (begun 102 to 117 over the
lead-in's start), the proof's 11 200 cells confirmed on the live world in every run, the decision in 2.5 to 3.7 s. The
ninth run of the first helix is the one described under "The way down to the lead-in": it is why the helix is steered.
The 51.4 s run flew the same entry (96 ticks from its commit); its flight took 986 ticks where the others took 835 to
865, all of it before the hand-over: a lap's worth of ticks, probably a fourth lap (in that state the laps were counted
again every tick and the log has no line that says so). With the count fixed when the helix begins, the 8 runs as
shipped took 828 to 848 ticks, 8 to 11 rockets and 4 to 8 corrections each.

**The round trip** (`FLY_CAVE_ONLY=round`: in along the learned entry, then `!goto` home from where the entry left the
body, out along Track F9b's learned exit with `flyLearned` on).

| | rounds | in: standing at cave_start | in: seconds | out: arrived at home | out: seconds | where the flight out left the ground | roof ends, rockets that fired nothing | damage |
|---|---|---|---|---|---|---|---|---|
| as shipped | 3 | 3 of 3 (0.2 to 0.4 from the goal, one flight, no go-around, 91 to 95 ticks from the commit) | 43.6, 43.9, 44.0 | 3 of 3 | 62.3, 64.2, 58.8 | where the entry stood, 0 blocks walked | 0, 0 | 0 |
| an earlier state (the helix's laps counted every tick) | 4 | 4 of 4 | 51.0, 44.4, 44.7, 44.3 | 4 of 4 | 61.7, 59.6, 62.0, 61.8 | the same | 0, 0 | 0 |

Each way out is one flight along a learned line (5 to 7 rockets), begun from the cell the entry's touchdown left the body
on: the exit's matcher takes the body there as it takes one that walked to cave_start.

**Where the replica is not the Realm.**

- The replica is the fixture's box inside a stone shell as high as the box, on a flat world. The shell's edge lies 10 to 14
  blocks beside the hand-over window and its top far over the hill: the flight from home crosses it some 60 blocks before
  the window and arrives 100 to 117 over the lead-in's start. Every replica run therefore flies the helix (3 laps, about
  10 s); on the Realm the cruise is expected to come down its glide line onto the lead-in with no helix. The replica's
  44 s is not the Realm's time.
- Take B's lead-in runs into the shell: on the replica it is refused before its proof (`the recorded line itself is within
  0.3 of a block in its hand-over window`), so only take A is offered there. On the fixture both prove and A is chosen for
  its room.
- The replica's bot starts on the home pad: no walk to a takeoff site (16 to 18 s of the Realm's run).
- A local server: no latency, the goal's chunks arrive as fast as the server sends them, a correction every few hundred
  ticks (4 to 9 a flight here).
- The fallback's own way (the landing as without a recording, taken back by the process after an entry is given up) did
  not happen on the replica: the one run that did not end along the entry was the first helix's, which stood on the hill
  and finished by the corridor. A miss with a go-around has not happened on a server at all.

### The regressions

The PC, bds-fly3 and bds-fly2 (the cave trips and `fly-course` on bds-fly2), 2026-11-10, by exit code; `flyLearnedEntry`
off in all of them.

| gate | result |
|---|---|
| `fly-route-land` | **not clean: 5 of 7 runs.** As shipped: exit 1, exit 1, then exit 0 three times; two earlier states: exit 0 each; the commit this track starts from, run the same hour from a plain copy of it: exit 0 twice. The two failures are one case each, 6 of 7 passing: a flare where the brake was planned that stood on the rim of the 1 x 1 hole, 2 over its floor (0 damage); and a route landing between the stacked platforms handed to the tracker 26 over the cell where it has 10 (a climb that topped out 9 over the cruise height on a 150-block flight), 24 re-plans, 2.5 damage against a wall. Neither flight carries an entry or goes around, and for such a flight this track changes no line of the brain that runs (the hand-over, `routeSink` and the go-around read the same values); but 5 of 7 against 2 of 2 does not prove it (see the open points) |
| `fly-route` | 3 of 3 (as shipped; and twice on earlier states) |
| `fly-walk` | 2 of 2 (as shipped; and once on an earlier state) |
| `fly-land` | exit 1, 4 of 5 (as shipped, and the same on an earlier state): the 8 landings on their platforms (0.02 to 0.79 off, 0 damage, one go-around at the wall in one run); its `!fly stop in the air` case times out after 60 s, as it does on the commit this track starts from |
| `fly-cave` trip out with `FLY_CAVE_LEARNED` (Track F9b's learned exit, now with the dud in its proof) | two series of 5. Every run left the ground at cave_start along the learned line and was out under open sky after 59 ticks on 2 rockets, none fired nothing. 9 of 10 arrived home in 59.9 to 69.0 s (Track F9b: 59.9 to 65.4), 0 damage. The tenth: out as the others, then its climb met the replica's shell 115 blocks on and the flight ended standing on it, 6 under its top; the walk home from there went down its side in drops of 10 and 12 blocks and died of them. That is Track F9b's own failure on the replica (1 in its 31; with the round trips this track has 1 in 17), after the exit, in code this track did not change; the Realm has no shell |
| `fly-cave` trip C, the Realm's way with the setting off (`FLY_CAVE_PLAIN=1`) | 3 of 3 arrived in 62.3, 62.5 and 61.7 s (61.2 to 71.9 before this track), each by the landing 13 blocks from the goal and the walk, 0 damage; no line of the entry in any log |
| `fly-course`, `FLY_AREA=71520,69472`, on bds-fly2 (bds-fly3's truth pack has no `course` command) | **not clean: exit 1 in 4 runs of 4**, 7 of 8 each time: one passage station did not pass all its goals in either of its two runs (the rings three times, the slalom once). The commit this track starts from, from a plain copy of it in the same hour: exit 1 once (the slalom), exit 0 once. The bare route driver the gate flies (`route/live.ts`) and everything it imports (`tracker.ts`, `search.ts`, `grid.ts`, `rocket.ts`) are untouched by this track, and Track F9b had 7 of 8 and then 8 of 8 here. The rings alone, six legs each (`FLY_COURSE_ONLY=rings FLY_COURSE_RUNS=6`): exit 0 with this track's code, exit 1 from the commit before it (none of its six legs through all five rings). The station is a coin on either code (see the open points) |
| `pnpm lint` (the PC) | exit 0 |
| `pnpm -r test` (the Mac) | exit 0: 213 test files and 2431 tests passed in `bot` (1 skipped), 21 of them `fly-learned-entry.test.ts` |

### What `!test cavestart 3 from home` on the Realm should show (`flyCave on`, `flyLearnedEntry on`)

- At the start, in place of the two `corridor:` lines (`plan 1 to cave_start: none ...`, `gave up ...`): `fly: cave_start has a
  recorded way in: the plain flight, its end along the learned entry when that proves clear`. The walk to the takeoff site and
  the takeoff as today (`fly: landing for cave_start: the goal's ground is not loaded yet`, `flight: to ... (hold)`).
- A few seconds into the flight, one line: `fly: learned entry: 5 recorded ways in to cave_start (15 recorded flights, 5
  standing again within 4 of it); <take> (it stood again 0.4 from the goal): stands 5.7 from the touchdown and 4.0 under it
  from mid on the line (the recording's own state): refused; ...` (three takes so, the dip) `...; <take> (it stood again 2.1
  from the goal): clear from 39 entry states (up to 3 beside the line, 5 over and 2 under it, 0.5 to 1.25 of its speed, 25
  degrees off its heading, early and late): standing at most 0.8 from the touchdown, 133 ticks at most from the last open sky,
  never nearer than 0.13 to a block; <take> (2.2 from the goal): clear from 39 entry states ... never nearer than 0.39 to a
  block -> in along <take> (the most room: 0.39): onto its line N blocks from the goal and M over it at about 1.7 a tick, 45
  blocks of open air to its roof, 70 under it to the touchdown on the goal's cell (87 simulated, T ms; K cells from the world
  cache: to be confirmed on the live world before the line is committed to)`. The numbers are the fixture's: the Realm's
  ground is the fixture's as far as anything has shown. T was 4 to 5 s on the PC for the two whole proofs; the Realm's is
  not measured.
- `flight: retargeted to <a point in the air> (half 2)`, then every 5 s `fly: the learned entry's proof for cave_start waits
  for the live world: N of M cells not loaded yet` until the body is some 150 blocks from the goal, then `flight: learned
  entry: the proof of <take> stands on the live world (M cells the same)`.
- The one thing the replica could not show: whether that confirmation comes before the window when there is no helix to
  wait in. If it does not, the first pass is `flight: go-around 1: the learned entry <take> missed (the proof is not
  confirmed on the live world yet) ...`, and the second pass, after a climb and a lap of the helix, is the lines below:
  a run of 60 to 70 s instead of 48 to 56.
- No helix is expected: the Realm's cruise comes down its glide line and crosses the hill before the line with its clearance,
  about 10 over the lead-in's start where the flier takes 22. (`flight: learned entry: N over the lead-in of <take> where the
  flier takes at most 22: down in a circle of 14 beside its start ...` would be one: 3 to 10 s more.)
- `flight: learned entry: onto the line of <take> N blocks before its hand-over window (the lead-in), M before its roof (S
  beside the line, U over it, V a tick, the heading H degrees off its own)`; `flight: learned entry: on the line <take> 45
  blocks before its roof (...): inside what the proof flew, the follower has it to the touchdown`; `flight: learned entry: the
  touchdown begins (...), 70 to 80 ticks after the commit`; `flight: learned entry: standing 0.1 to 0.7 from the goal along
  <take>: 95 to 110 ticks after the commit, 61 to 70 from the line's last open sky (26 to 30 of them the touchdown), at most
  N off the line, slowed 1 ticks`.
- `flight: landed at <cave_start>, 0.1 to 0.7 from the centre; ... learned entry <take> (landed, 1 joined, 0 missed, N ticks
  from the commit)`, a walk of under a block, `test cavestart N/3: arrived in T s; damage 0, ... 0 bail-outs`. One flight a
  run; no `corridor:` line, no `route: ... bailing out`.
- The time. Today 81.8 s a run: 16 to 18 s of walk to the takeoff site, a flight of 33 to 34 s that ends on the hill, 25.6 s
  from there. With the entry the flight is at the lead-in after about 21 s and stands 5 to 6 s later: expect 48 to 56 s a
  run, an estimate from the replica's 44 to 45 s (which has the helix and no walk to a takeoff site).
- A refusal: the decision's line ends `-> no learned entry: the landing as without a recording (S simulated, T ms)` and the
  run is today's (the proofs ran in the air). Too late (a short flight): `fly: the learned entry for cave_start comes too late
  for this flight`.
- A miss: `flight: go-around 1: the learned entry <take> missed (<why>: N beside the line, N over it, too slow, the proof is
  not confirmed on the live world yet, past the hand-over window ..., the circle beside its lead-in cannot come to the start
  high enough ...) at ...; out along its line and onto the lead-in again`, a climb, `flight: learned entry: N over the
  lead-in of <take> ...: down in a circle of 14 beside its start, 1 lap and the rest of one ...` and then the lines above
  (10 to 20 s more). Two misses: `flight: learned entry: <take> given up (...; 2 windows missed): the landing as without a
  recording`, `flight: retargeted to ... (the learned entry given up)`, `fly: the learned entry for cave_start was given up:
  the landing as without it (looking for one)`, and today's landing and corridor after it: today's run and 20 to 40 s.
- The world changed since the bot last saw it: `flight: learned entry: <take> given up (the proof does not stand on the live
  world (the cell x y z is not what the proof flew))`.
- A lost line under the roof: `flight: learned entry: the line <take> lost N of M blocks along it (...): no glide without the
  line under a roof, landing`, `flight: ended (roof) at ...`; the corridor or the walk goes on from where it stands.

### The cave changes (Track F9c, round 2)

Round 1 was deployed and tried on the Realm with `flyCave on` and `flyLearnedEntry on`: `!test cavestart 3 from home`
arrived 3 of 3 in 82.8 s a run with one bail-out each, as without the setting (81.8 s). The entry was refused in every
run, three takes in the dip as expected and both flyable takes with `hits a solid 1 time ...`, and the fallback flew.
Nothing was hurt: a refusal is the flight as it was.

**Why.** The fixture round 1 proved on was exported three days before the owner recorded the takes. Between the two the
cave changed: the bot's own cobblestone from a pillar climb stands one cell off the goal's corner, and a cell at feet
level directly beside the goal, on the side the line comes in from, is no longer air. Round 1's "39 of 39" was flown in
a cave that no longer exists; the Realm's refusal was the proof doing its work on the one that does.

**What reproduced.** On a fixture exported from the Realm bot's world cache that morning
(`CAVE_FIXTURE_DIR=<today's export>`), the probe gives the Realm's line word for word: the same five verdicts, the same
ticks and blocks along the line.

**What is in the way** (the 39 states of each take to the goal's own cell, today's cave):

| take | clear of 39 | the cases that fail | where |
|---|---|---|---|
| A | 36 | mid under; mid over, fast, left; early right | the body creeps along the floor towards the goal, meets the cell beside it at feet level and stands 1.8 short of the goal |
| B | 38 | late under, slow, left | the same cell, the same place |
| C, D, E | 0 | all | the dip, 3 to 4 under the goal, as on the old fixture |

The pillar is not what refuses them: it shows as touches in some flights. The flights that still pass end on top of the
new cell, one block up, or come to the goal over it. What that cell holds is not known: the owner stood in it at whole
height in two takes, so it was empty or without a collision box when they recorded. The world cache keeps four classes
(`world/cache/classes.ts cellClassOf`): a cell with any collision box in the bot's shape tables is `solid` (a carpet a
sixteenth high and a slab as much as a cube; so are a bed, a chest, a lantern, a flower pot, a candle), a cell with none
is `air` (a torch, a sign, a button, a lever, plants, a pressure plate, a rail; also a ladder and a snow layer, which
the game does give a box), and the dangerous ones are `avoid`. To tell a carpet from a cube the cache would have to keep
a cell's height or its box. The proof does not guess: a `solid` cell is a full block.

**What was changed.**

- **The touchdown is chosen, the goal's own cell first** (`learn/entry.ts entryTouchdowns`, `chooseTouchdown`). The
  candidates are the standable cells within `ENTRY_TOUCH_REACH` 2 blocks beside the goal and one level over or under its
  floor (a solid under the feet, the feet and the head in air; an unknown or a liquid cell is none), in the order of their
  distance from the goal, the goal's own level before the level under it before the level over it. For each in turn the
  take's line is cut where it comes nearest that cell; the recording's own three states are flown first (three
  simulations refuse a cell), then the whole proof of 39. The first cell that clears is the take's. A take whose own
  states fly to none of 6 cells in a row is given up; a take gets 3 whole proofs at the most.
- **Every flight of a proof must also stand within 2 blocks of the goal** (`ENTRY_GOAL`), whichever cell the touchdown is:
  `stands 2.4 from the goal` refuses a cell as a hit does. The walk for what is left is the one there already.
- **The full box stays.** With another touchdown both takes clear all 39 states of the box as it was; no smaller box was
  needed, and none is built.
- **A refusal says where**: `hits a solid 1 time (the first at tick 70, 134 blocks along the line, x y z from the
  goal)`: blocks east, up and south of the goal's feet, so the next refusal on the Realm is read in one look. The decision's
  line names each cell tried (`to the goal's cell: ...; to the cell dx dy dz from it (1.0 beside): clear from 39 entry
  states ...: standing at most 1.2 from the touchdown and 1.2 from the goal`) and the one flown (`... to the touchdown on
  the cell dx dy dz from the goal's (1.0 beside it; every flight of the proof stood within 1.2 of the goal)`).
- **The proof's cases in another order**: the recording's own three states, then the twelve corners that stack the
  extremes, then the single extremes. A cell that does not hold fails after about 15 simulations where it took up to 37.
- **The decision takes longer and says so**: 8 to 9 s on the owner's cave (3 s before), in the air, in slices. No new take
  is begun after `ENTRY_BUDGET_MS` 10 s; one begun before that is finished.
- **A stale fixture is said first** (`learn/fresh.ts`): the probe and the cave e2e print the fixture's export time against
  the newest recording, `WARNING: STALE FIXTURE ...` when a recording is newer than the fixture.
- **The replica's box can be built again by itself** (`FLY_CAVE_REUSE=surroundings`, the surroundings as they stand, every cell of the box set again: 30 s. A whole build over a replica that stands does not work: its fills are sent from stops on the flat ground, which a standing replica has under its terraces, so the bot is put inside stone and the fills' chunks never load; the build now says so at the first such stop. A whole rebuild needs a world without a replica. One part of today's box could not be sent at 1800 characters, `spawn EPERM` on the PC for the same part on each of five attempts; `FLY_CAVE_PART_CHARS=1500` cuts the parts elsewhere and all 359 went).

**Offline, the whole flight** (`--mode approach`, the 13 places and the cruise heights of round 1, rockets of 9 to 21
ticks; the touchdown the bot chooses):

| fixture | take and its touchdown | flights | standing by the goal | from the goal | first pass, after one go-around | commit to standing | last open sky to standing | contacts on the way in |
|---|---|---|---|---|---|---|---|---|
| today's | A, a cell one block beside the goal and a level under its floor | 69 | 69 | 0.8 to 1.2, on the goal's level or a block over it | 60, 9 | 80 to 103 ticks | 52 to 66 ticks (2.6 to 3.3 s) | none |
| today's | B, the same cell (7 places, rockets of 15 ticks) | 7 | 7 | 0.7 to 1.2 | 5, 2 | 92 to 110 | 60 to 77 | none |
| round 1's | A, the goal's own cell | 69 | 69 | 0.1 to 0.9 | 60, 9 | 84 to 107 | 55 to 71 | 8 touches in the creep |
| round 1's | B, the goal's own cell | 7 | 7 | 0.0 | 5, 2 | 101 to 117 | 69 to 79 | 2 touches |

The proofs behind them, all with the box as it was (39 states): on today's fixture take A is refused at the goal's cell
and at the next cell (a hit each), and clears to the third: every flight within 1.2 of the touchdown and of the goal, 145
ticks at most from the last open sky (7.3 s), never nearer than 0.39 to a block; 67 simulations, 3.5 s. Take B likewise:
0.6 and 1.2, 128 ticks, 0.13; 99 simulations, 5.0 s. Takes C, D and E are refused at their own state at every cell (6
simulations each). The whole decision: about 9 s on the PC. On round 1's fixture both takes clear to the goal's own
cell, with round 1's numbers: nothing there is worse.

**On the server** (bds-fly2, the replica's box built again from today's export):

| | runs | standing by the goal, no landing outside | bail-outs | from the goal | seconds to the goal | from the last open sky to standing | damage |
|---|---|---|---|---|---|---|---|
| the setting off (the Realm's way, `FLY_CAVE_PLAIN=1`) | 3 | 0 of 3: each lands 51 blocks from the goal and 26 over it | 1 to 3 a run | | 68.2 to 71.3 | | 0 |
| the entry on, before the slip was handled | 12 | 12 of 12 | 0 | 0.8 to 1.1 | 43.9 to 45.8 | 54 to 62 ticks | 0 |
| the entry on, as shipped | 6 | 6 of 6 | 0 | 0.8 to 1.1 | 43.9 to 46.4 | 55 to 60 ticks in five, 84 in one (4.2 s) | 0 |
| the round trip, as shipped | 3 | in: 3 of 3 (0.8 to 1.7 from the goal), 44.0 to 46.1 s; out along the learned exit: 3 of 3, 60.4 to 61.8 s | 0 | | | 52 to 57 ticks | 0 |
| the trip out with `FLY_CAVE_LEARNED` (the learned exit in today's cave) | 5 | 5 of 5 arrived in 61.6 to 65.1 s, each off the ground at cave_start, out under open sky after 59 ticks | | | | | 0 |

Every entry run: one flight, the decision `-> in along <take A> (the most room: 0.38) ... to the touchdown on the cell
dx dy dz from the goal's (1.0 beside it; every flight of the proof stood within 1.2 of the goal)` after 5.1 to 6.0 s
(the replica offers take A only: take B's lead-in runs into its shell), then `walked to cave_start`: the trip ends
within 0.3 of the goal. The body stood on top of the cell beside the goal, a block over the floor, in most runs.

**The slip.** In one round trip of an earlier state the body stood on that single block, slid off it a second later and
was in the air again. The brain took it for a body far from its landing (an entry's target is the window's end, 90
blocks away), ended the flight `lost`, and the trip, which walks after a landing but not after `lost`, said nothing
more: the run timed out standing a block from the goal. Now a body that is in the air again after an entry stood comes
down where it is (`brain.ts bounce`: `learned entry: in the air again after standing (it slid off what it stood on)`),
the flight ends as a landing, and the walk for what is left follows an entry that stood whatever the flight was called.
It happened three times in the 9 runs as shipped; all three ended at the goal.

**The regressions** (each alone, nothing else of this track running):

| gate | exit code | |
|---|---|---|
| `fly-route` | 0 | 3 of 3 |
| `fly-walk` | 0 | 2 of 2 |
| `fly-land` | 1 | 4 of 5: only `!fly stop in the air`, red on main |
| `fly-route-land`, first run | 1 | 6 of 7: the route landing between the stacked platforms took 11.3 damage against a wall (686 ticks, one go-around). The flight has no entry: the gate uses no recording and the setting is off |
| `fly-route-land`, second run | 0 | 7 of 7 |
| `fly-course` pinned, first run | 1 | 7 of 8: the rings (neither of its two legs through all five) |
| `fly-course` pinned, second run | 0 | 8 of 8 |
| `pnpm lint` (the PC) | 0 | |
| `pnpm -r test` (the Mac) | 0 | 2438 tests passed in `bot` (1 skipped), 28 of them `fly-learned-entry.test.ts` |

The two gates that failed once failed alone, with nothing else of this track running, and passed on the next run. The
coordinator's comparison of `fly-route-land` between the commit before this track and this track's (three runs each,
alternating) had 0, 0, 0 against 0, 1, 0.

**Open points of round 2.**

- **It has still not flown on the Realm**: the first series there was refused, and everything since is the fixture and the
  replica built from it.
- **The cell beside the goal is not known.** The proof takes it for a full block. If it is lower than that, the bodies
  that stand "on top of it" will stand lower than the proof says, by less than a block.
- **Standing on a single block beside the goal** is where most replica runs ended, and three slid off it. A touchdown
  that weighs a cell's room (how many standable cells round it) would choose the floor first; the order is by distance.
- **The decision is 8 to 9 s on the owner's cave.** A proof kept from one flight and checked against its cells at the
  next (the confirmation's own test) would make the later flights of a series instant; it is not built.
- **The bot's own blocks.** The navigator leaves its pillar where it climbed. What the flight would ask of it: to take a
  pillar down again where that is cheap, or to keep a list of the blocks it set so they can be taken out later, and not to
  pillar within a few blocks of a waypoint that has recorded flights. Nothing in the entry depends on that.
- **`fly-route-land` and `fly-course` fail about one run in three or four by themselves**, on this track's code and on
  the commit before it. They say little about a change until that is mended.


**What the entry does when the cave changes between two flights.** The proof is made at the start of the flight on the
live model and, where that has nothing, the world cache. If the bot has seen the change, the proof sees it: the goal's
cell is refused and another cell is tried, or the entry is refused and the flight is the one without a recording. If the
bot has not seen it (a block set while it was away), the proof passes on the old cells, and the live confirmation finds
the changed cell before the commit: the entry is given up for the fallback (`the proof does not stand on the live world
(the cell ... is not what the proof flew)`), and the next flight proves on the cache as it now is. There is no second
proof in the air: at that point the body is about 5 s from the window and a proof takes 4 s and more.

**What the Realm should show now** (`!test cavestart 3 from home`, `flyCave on`, `flyLearnedEntry on`): the lines of round
1 with these differences.

- The decision's line, 8 to 10 s after the takeoff: three takes `to the goal's cell: stands ... from the touchdown and ...
  under it ...; its own state does not fly to N more cells beside the goal either: refused`; the two flyable takes each `to
  the goal's cell: hits a solid 1 time (the first at tick T, N blocks along the line, x y z from the goal) from <case>; to
  the cell dx dy dz from it (1.0 beside): hits a solid ...; to the cell dx dy dz from it (1.0 beside): clear from 39 entry
  states (...): standing at most 1.2 from the touchdown and 1.2 from the goal, ... never nearer than 0.39 to a block`, then
  `-> in along <take> (the most room: 0.39): ... to the touchdown on the cell dx dy dz from the goal's (1.0 beside it; every
  flight of the proof stood within 1.2 of the goal) (about 170 simulated, 8 to 10 s; ...)`.
- `flight: learned entry: standing 0.8 to 1.2 from the goal (1.0 over it)` or with no height: on top of the cell beside
  the goal, or on the goal's level beside it. Then a walk of a block or two: `walked to cave_start`.
- If the cell beside the goal is gone by then, the first cell clears and the lines are round 1's.
- The time is round 1's estimate and a second or two for the walk: 50 to 58 s a run against 82 s. An estimate.
- The confirmation's timing with no helix is still the one thing the replica cannot show.

### What a drawn line would need (the next track: no recording)

Everything from `entryLine` on takes a `Guide` and asks nothing else of a recording: points a block apart, the tick each
was passed, `landed`, and the blocks along it to its last open sky. `matchEntries` is the only step that needs a recorded
flight. A line drawn from the flood (the goal's hall flooded back to open sky, as `route/takeoff.ts waysOut` floods out)
would need:

- **A shape a glide can fly.** The flood's way is cells with no slope and no radius (Track F9b measured it against the
  owner's line: 3 to 6 blocks beside it, 1 to 5 over or under it, a 50 degree step inside the passage). The entry needs a
  descent all the way (a glide cannot climb unless its speed pays for it: three of the owner's own takes are refused for a
  climb of 4 blocks at the end), turns no tighter than the glide turns at that speed (90 degrees in 12 to 20 ticks, a radius
  of 6 to 15 blocks), a berth of a block where the passage has it, and the takes' profile at the end: in over the goal's
  floor by 1 to 3 blocks, heading at the goal's cell.
- **A speed for every point.** The governor, the window and the proof's speeds read the recording's ticks (`guideSpeed`).
  A drawn line has none: the glide formula rolled along it gives them (the speed a glide holds on that slope), and that
  roll-out is also the test of the first point.
- **Open air before the roof.** A window of 24 blocks that ends 20 before the roof and free air behind it for the lead-in
  (`entryLine` draws the lead-in itself) and for the helix beside its start. A mouth in a cliff face with no run-up has no
  window: no entry.
- **A touchdown cell.** Standable, the line coming in over its floor, no wall within the brake's reach behind it on the
  line's heading (3.6 blocks a block a tick of speed), or the proof refuses.
- **Its own box.** `ENTRY_BOX` is what two takes of one cave hold. A drawn line through a tighter passage may clear a smaller
  box only: the proof can be run on a shrinking box and the hand-over given the box that cleared (`EntryFlier` and
  `proveEntry` take the box already).
- **The proof, unchanged.** It is what makes a drawn line as safe as a recorded one, and it is the same code. The exit
  likewise (Track F9b's experiment: a crude drawn line flew 12 of 13 burns clean; with the dud case 18 simulations).

### Open points (Track F9c)

- **It has not flown on the Realm.** Offline on the fixture and on the replica (built from the fixture, a local server with
  no latency) it flies. `flyLearnedEntry` ships off for that reason.
- **The approach in the open is not proven.** The proof begins at the commit. Before it the body is the cruise's and the
  flier's on the lead-in, in open air, guarded by the commit's test, the path-ahead check and the go-around. Offline the
  body was committed on the first pass in 54 of take A's 63 flights from every side (the other 9 after one go-around) and
  in 5 of take B's 7; on the replica in every run since the helix is steered.
- **A body that reaches the lead-in's start a few blocks too high costs a go-around.** The flier takes 22 over the start; a
  lap of the helix costs 20 at the least. Passing the start 20 to 24 over it, the body is too high for the one and too
  low for the other: a miss, a climb to a lap's worth over the pass, a lap, the hand-over: 5 to 10 s. Offline 9 flights of
  63, from three of seven places near the line (a takeoff that tops out beside the start; a first descent begun level).
  A smaller circle for that one lap (10 blocks across the turn: a lap of 60 blocks costs 13) would close the band; it is
  not built, and whether the body turns that tightly is not measured. The Realm's trip comes from far away along
  its glide line and is not expected in the band; a trip that begins near the line can be.
- **The give-up low at the window's end** (the rocket on the first clear look, else the landing at once before the roof)
  was flown offline on the fixture in one flight of an earlier state of the code and has one unit test. No fixture
  flight reaches it with the code as shipped, and it has not happened on a server.
- **The go-around itself has not flown on a server** for an entry: no replica run has missed.
- **`fly-route-land` failed twice in seven runs** with this track's code (two different landings, neither with an entry)
  and in none of two from the commit before it. The code read line by line says a flight without an entry is flown as
  before; the runs are too few to say the same. Both failures came within a quarter of an hour of each other.
- **`fly-course` was 7 of 8 in each of four runs** with this track's code (the rings three times, the slalom once) and 7
  of 8, then 8 of 8, from the commit before it. Nothing the gate flies was changed, and the rings flown alone went the
  other way (this track's code passed in six legs, the commit before it did not). Its bar is one clean leg in two for
  each passage station; over this night's runs a rings leg came through all five rings 3 times in 10 from the commit
  before and at least 2 in 14 with this track's (a passing run prints no table), so the gate fails every second run or so
  by itself. A gate that tells nothing either way is worth its own track.
- **One of 17 flights out along the learned exit ended on the replica's shell** after it was out, and the walk from there
  died of two falls (Track F9b's 1 in 31, on the replica only). A flight that ends on a height it did not choose and is
  then walked off it is not this track's, and is worth its own look.
- **Three of the owner's five takes are refused.** They stall-climb 4 blocks out of a dip onto the goal's floor; the flier
  has no such climb and stands in the dip. A cave with only such recordings has no learned entry.
- **The bot stands on the goal's cell, not where the recording stood.** For the two takes that fly that is 2.1 and 2.2 from
  the recorded touchdown (a ledge 2 over the floor beside the goal).
- **One box for every line** (`ENTRY_BOX`), measured on two takes of one cave. The take with the most room would hold a wider
  one (8 over, 60 degrees).
- **A touch is not a hit.** A contact in the air that takes less than 0.15 a tick off the speed is counted apart: one in 19
  of the 78 flights of the two proofs, none in the others; it is the touchdown's creep against the wall beside the goal's cell. Flying into a wall costs health from
  0.3; the server's own threshold was not measured for this.
- **The proof takes 2 s a take on the PC's fixture** (39 flights), in the air, in slices; 4 to 5 s for the owner's five takes
  (three refused in a flight each, two proven). On the replica's bot (the PC, a server beside it) the decision took 2.5 to
  3.7 s in the air (46 simulations: three takes refused at their own state, one whose lead-in the replica's shell blocks,
  one whole proof). The Realm's host was not measured: the recordings were not taken there.
- **A proof on the cache needs every cell it asked live before the window.** On the replica the last of 11 200 cells came
  about when the body reached the lead-in's start, some 150 blocks from the goal: the confirmation's line stands before
  the helix's first line in 2 of the 24 runs and between it and the hand-over in the other 22 (the test's notes carry no
  times, so where in the helix's 14 s is not known). The helix hid the question. A flight with no helix has the lead-in
  and the window from the start to the commit, 2 to 3 s, and whether the cells are there by then was not measured: a
  server that sends the goal's chunks later than that shows as a first pass missed (`the proof is not confirmed on the
  live world yet`) and a go-around. A cell that never
  loads is a miss, twice, then the fallback: 20 to 40 s lost.
- **The helix needs the ground known under it** on one side of the lead-in's start and 3 blocks of room under its last lap;
  else the flight misses the window and goes round or falls back. Its 100 to 117 blocks on the replica took about 10 s.
  Its sink numbers (`ENTRY_HELIX_SINK`) were measured in the simulator's circle and held on the replica's server (the
  hand-over 8.6 to 8.7 over the line in every run); a server whose glide differs would show as a hand-over height that
  wanders, and under 4 below the plan as a miss.
- **The go-around after a miss is the brain's own**, out along the line and back. It is not tuned for a line that runs
  along a hillside.
- **A flight taken over in the air** (`!goto` while flying) is not asked for an entry; nor is a flight that starts within
  60 blocks of the line (the proof would come too late).
- **With the setting on, `!fly` to a goal with a recorded way in never takes the corridor trip**: the plain flight carries
  the entry, and the corridor is only its fallback's.
- **The dud rocket on the fixture.** Five of the six takes out of cave_start survive a first rocket that fires nothing at
  every burn of the next one (out after 61 to 68 ticks on 2 to 3 rockets), with the follower as Track F9b left it and with
  this track's; the sixth, the take that grazes a block beside its start, is lost on the ground in both and is now kept for
  last by its proof as well as by its line's room. The take and the place of the Realm's one failed run come out too in the
  simulation: the fixture does not reproduce that failure, and the follower's finding its place again is verified in the
  unit tests only.
- **Files outside this track's.** `plan.ts` (a field of `LandingTarget`) and `controller.ts` (`confirmEntry`, the report's
  `entry`, one log line) were touched; `brain.ts`'s `descend` got the entry's pitch; `health/panel/budgets.ts` and
  `panel.md` for the page's budget (below).
- **Duplication left.** The probe's world set-up is `cave-exit-probe.ts`'s again; the two learned test files each have their
  rig and their `record`.
- **The panel's bars moved** for the one new settings row: the poll payload 20 100 to 20 200 (20 151 with the row), the
  full state 38 500 to 39 000 (38 525), and the page's budget `PANEL_BUDGETS.html` 128 000 to 130 000 (128 663 in the
  worst case: the rows added since the last raise had taken it to within one row).

## Drawn lines (Track F9d)

Flight v2, Track F9d, [decisions/0081](decisions/0081-drawn-lines.md). After Tracks F9b and F9c the bot flies out of the
owner's cave and into it along lines the owner recorded. The owner (2026-11-10): "Does this mean that if we get it
working, it can fly in and out of caves? or is this just that it can follow a learned path and adapt it?" It was the
second: without a recording the takeoff under a roof had only Track F9a's searched way out, which its own proof refuses
in that cave every time. This track draws the line a recording would have given, from the world alone, and proves and
flies it as a recorded one. Two faults of other parts were settled with the same tool (the flight flown offline at every
burn, tick for tick): a route landing that was handed over too high, and the learned entry's missed first pass. The
route landing took two rounds: the first capped the hand-over's height alone and made a landing under a roof worse (the
band the tracker lands from was quoted, not measured); the second measured the band and found, behind it, the tracker
searching every landing again from its own touchdown.

```
a takeoff under a roof (commands-fly.ts routeTakeoffFor, route/takeoff.ts planTakeoffRoute), flyCave on:
 1 a recording that left the ground here (flyLearned)                          Track F9b
 2 a DRAWN line (flyCaveExit; learn/draw.ts drawExits)                         this track
     the flood     by cost, under the roof, to the cells under the real sky (26 neighbours, a step beside a solid dearer)
     the line      each way's points on one slope from the takeoff's height to the exit's, inside the passage (rise);
                   pulled straight with a berth (pull); the corners rounded (round); 16 blocks on past the roof, rising,
                   or straight up the open column of a pit; a block apart
                   two lines a berth (0.9, 0.6, the follower's): heights clear of what is beside the line, and heights
                   between the floor and the roof alone
     the roll      the follower along it on the physics from standing, at the nominal burn: its ticks are the line's;
                   a line it loses, or that meets a wall, is no line
     the PROOF     as a recorded line's (glide.ts routeTakeoff): every burn from 9 to 21, two mixes, a first rocket
                   that fires nothing; the lines in the order of their roll's time to open sky, three at most
   the flight (brain.ts guideTakeoff): the same follower; out with open sky over the body; then the climb of Track F9a,
     and where every heading has a wall and the sky is open overhead (a pit), straight up until one clears (climbUp)
 3 the exits, as before (Track F9a); the searched ways out are no longer asked for
```

### Files

| File | What |
|---|---|
| `bot/src/skills/fly/learn/draw.ts` | the drawn line: `floodOut`, `middle`, `rise`, `pull`, `round`, `resample`, `drawLine`, `rollLine`, `drawExits`, `DrawnLine`, the `DRAW_*` numbers |
| `bot/src/skills/fly/learn/guide.ts` | `Guide.drawn`, `guideSaid` (the log's name for a line: learned or drawn) |
| `bot/src/skills/fly/learn/follow.ts` | the notes say `drawn line` for a drawn one |
| `bot/src/skills/fly/learn/entry.ts` | `entryTouchdowns`: at one distance a floor's cell before a single block's top (`ENTRY_TOUCH_FLOOR`) |
| `bot/src/skills/fly/route/takeoff.ts` | `TakeoffRouteOptions.drawn`, `drawnRoute`, `DRAWN_TRIES`, `TakeoffRoute.drawn`; the drawn lines tried after the recordings and before the exits |
| `bot/src/skills/fly/brain.ts` | `climbUp` (straight up out of a pit); the guide takeoff's time by the line's own ticks; `entrySink` and `sinkTap` (the way down onto a lead-in), `ENTRY_SINK*`, `ENTRY_HELIX_ALONG`; the route landing's hand-over: `capPitch`, `capCoast`, `ROUTE_CAP_*`, `handIn`, `ROUTE_HAND_UP`, `ROUTE_HAND_BAND`, `ROUTE_HAND_*`; `landingChoice`: a cell under a rim is the brake's |
| `bot/src/skills/fly/route/tracker.ts` | `firstBlocked`: a route landing's corridor is checked in the search's own grid (the landing cell's floor is no obstacle near it) |
| `bot/src/chat/commands-fly.ts`, `bot/src/tasks/process/fly.ts` | `flyCave` and `flyCaveExit` ask for the drawn lines; the decision's and the flight's lines name them |
| `bot/src/config/settings.ts` | `flyCaveExit`'s description (no new setting) |
| `bot/scripts/cave-drawn-probe.ts` | the drawn exits on the private fixture, from one waypoint or all of them |
| `bot/scripts/route-land-probe.ts` | the gate's route landings offline at every pair of burns, a hash of every tick; `--dist 300` and the cells `room` and `cliff` for the unit suite's whole trips; each hand-over's height and speed, and how many lie in the band |
| `bot/scripts/cave-learned-entry-probe.ts` | `--mode arrive`: the end of a long flight retargeted to its entry in the cruise |
| `bot/test/unit/skills/fly-drawn-exit.test.ts`, `fly-route-cap.test.ts`, `fly-learned-entry.test.ts` | the guard tests |
| `bot/test/e2e/fly-cave.test.ts` | `FLY_CAVE_EXIT=1`: tripOut along a drawn line |

### The route landing that arrived too high (the gate fly-route-land)

**Same or different.** The gate failed 5 runs of 22 with Track F9c's code and 1 of 17 from the commit before it.
`scripts/route-land-probe.ts` flies the gate's stacked platforms (a route landing under a roof 2 above, 150 blocks out)
on the physics with the first rocket burning 9 to 21 ticks and the later ones 9 to 21, from five starts and first looks,
and hashes every tick's position. The two commits fly the same ticks:

| | flights | the two commits |
|---|---|---|
| to the hand-over (no search) | 845 (169 pairs of burns, 5 starts) | the same output byte for byte |
| whole flights, the planner on a node budget (6 000, no wall clock) | 64 (8 x 8 burns) | the same output byte for byte; 17 not clean on both, each handed over 13 or more over the cell |

So Track F9c changed nothing such a flight flies. What differs from run to run is the burns.

**The cause.** The hand-over's height is set by how long the first two rockets happen to burn: 10 to 27 over the cell
(441 of the 845 over 13; what the tracker lands from at once is 8 to 10, the band below). A first burn of 17 ticks or
more needs one rocket and is handed over 10 over. A first burn of 9 to 12 needs a second climb rocket, and the cruise held the climb's pitch for
the whole of it ("the whole burn goes into height"): 10 to 27 over, growing with its length. A first burn of 13 to 16
ended 6 short, and the cruise fired top-ups the climb did not need: its `projected` height counts the rise still to
come as the rise squared over 0.08, and on a level look a body coasts a third farther (0.6 a tick: 6.2 blocks, not 4.5),
so the first rocket's momentum had not carried when the second went. Each top-up was flown at its pitch for its whole
burn, and before the hand-over the speed was bled by a pull-up, which from 1.55 to 1.05 a tick is 8 blocks more. On a
150-block flight there is nothing to glide that off with: a level glide sinks a tenth of a block a block, the S-turns a
quarter. And where two blocks of surplus were left 11 blocks before the hand-over, the sink needed "a block" read as a
quarter: S-turns began there and the body was handed over 6 blocks beside the corridor's line, 35 degrees off it.

**The band** (round 2; `ROUTE_HAND_BAND`). The first fix of this track capped the height and was sent back: the unit
suite's whole trip to a cell under a roof 3 above, 300 blocks out, was handed over 10.6 over the cell at 1.03 a tick and
took 8 rockets and 277 ticks of partial plans to land, where the code before took 71 ticks (handed over 12.1 over, but
at 0.79 a tick and from the side: it had S-turned all the way in). What the tracker lands from had been taken from the
earlier tracks' line ("5 to 13 over the cell at 0.65 to 1.3 a tick"); measured, it is narrower, and the height and the
speed go together. One search from each state, straight in on the bearing a block inside the hand-over, and then the
tracker on the physics from each state to standing (8 heights, 9 speeds, 2 distances), onto the stack's 2-high slot,
into that room and into a pocket in a cliff face:

| handed over | a whole plan at once, and a landing with no rocket |
|---|---|
| 8 to 10 over the cell at 0.7 to 1.2 a tick | every state, all three cells (270 of 270 landings) |
| 10.5 over | the room only at 0.9 a tick and under; the stack at any speed, the pocket to 1.05 |
| 11 over | the room only at 0.7 |
| 7 over | from 0.8 to 1.1 a tick |
| 6 over | a whole plan from 1.0 a tick (the search alone; not landed) |

A slow body sinks more a block (a level glide falls 0.15 a tick whatever its speed: 0.19 a block at 0.8, 0.14 at 1.05),
so a high hand-over wants a slow one; the first fix bled every body to 1.05 a tick whatever its height.

**The fix** (`brain.ts`, a route landing within `ROUTE_CAP_RANGE` 204 blocks of its cell, lined up; one line of
`route/tracker.ts`; the search is untouched):

- a burning rocket climbs no higher than the hand-over's line (the hand-over's height and a tenth of a block for every
  block still to fly, taken 25 blocks on) and a block: its pitch is the climb whose coast, were the burn to end this
  tick, is the height still missing (`capPitch`), so the top does not depend on the burn's length;
- the rise still to come is counted as it is (`capCoast`: the rise squared over 0.05 and 0.017 a block a tick of rise);
- no top-up within 30 blocks of the hand-over while the level glide still arrives 6 over the cell;
- on the line or over it the speed goes by a tick of looking straight back, not by a pull-up; a rise still left over the
  line goes on a look 20 down;
- the height aimed at is the planner's own entry's (9 over the cell 40 out, on the level glide's line back to the
  hand-over: `ROUTE_HAND_UP`, 9.6 over at 44 out), where the first fix aimed at the glide line's 10 and a block more;
- a surplus the steeper glide does not sink is flown down straight along the corridor's line by the entry's way down
  (below), to where the last 12 blocks begin, that stretch's own sink over the hand-over's height (`ROUTE_HAND_DROP`).
  No S-turns inside the range: they left the body 9 to 14 blocks beside the line at the hand-over;
- in those last 12 blocks a body that would still arrive over the height flies at the speed whose glide sinks what is
  left (`handIn`: a tick of looking back when it is a tenth faster; the speed wanted is never under 0.72 a tick, and
  the slowest of 1 352 hand-overs was 0.71), so what comes in high is handed over slow, and lower than it would have
  been;
- the tracker's check of the plan's corridor sweeps in the search's own grid, in which the landing cell's floor is no
  obstacle near the cell (`firstBlocked`, `sweepGridFor`). It swept the whole grid: every landing plan was "blocked" two
  ticks before its end by its own touchdown and was searched again from the middle of its last manoeuvre, five to
  eight times a landing. Where one of those searches found nothing (the stack's slot: plans that pass its lip with 0.13
  to 0.17 of clearance) the tracker fired a rocket and flew round the platform: from hand-overs inside the band, 4 of
  126 landings of the slot and 14 of 338 whole flights (7 of them not clean). With the search's grid: 0 and 0, and one
  re-plan a landing.

Offline (`scripts/route-land-probe.ts`; whole flights with the planner on the tracker's own node budget, 40 000, and no
wall clock; "floundering" is a rocket fired while landing or more than 100 ticks with the tracker):

| | the code before | this track |
|---|---|---|
| the stack 150 out, the hand-over, 845 flights (169 pairs of burns, 5 starts) | 10.1 to 26.8 over the cell (median 13.8) at 0.68 to 1.14 a tick | 7.8 to 10.1 over at 0.71 to 1.05; 830 inside 8 to 10, 13 at 7.8 to 8.0 over and 1.0 a tick, 2 at 10.1 over and 0.8 |
| the stack 150 out, whole flights | 169: 25 not clean, 92 floundering | 845: 0 not clean, 0 floundering, 54 to 69 ticks with the tracker |
| the stack 300 out, 169 | handed over 10.0 to 13.9 over at 0.77 to 1.43; 3 not clean, 10 floundering | 8.2 to 9.6 over at 0.79 to 1.05; 0 and 0, at most 68 ticks |
| the room under a roof 300 out | handed over 10.3 to 13.9 over at 0.77 to 1.37 (169); of 25 whole flights (5 x 5 burns) 3 not clean and 24 floundering, 344 ticks with the tracker and 11.4 rockets a flight | 169: 8.2 to 9.5 over at 0.83 to 0.99; 0 and 0, at most 78 ticks, 1.6 rockets a flight |
| the pocket in a cliff face 300 out | handed over 10.1 to 15.2 over at 0.77 to 1.41 (169); of 25 whole flights 1 not clean and 5 floundering | 169: 8.2 to 9.5 over at 0.81 to 1.05; 0 and 0, at most 67 ticks |

The unit suite's whole trips (`fly-route-landing.test.ts`, 300 blocks, the nominal burn, seeds 5 and 11 fly the same):

| trip | | ticks | rockets | ticks with the tracker | re-plans | handed over | lands |
|---|---|---|---|---|---|---|---|
| the stacked platforms, 2 high | before | 359 | 3 | 68 | 7 | 11.5 over at 1.02 a tick | 0.58 off |
| | the first fix | 313 | 3 | 73 | 6 | 10.5 over at 0.89 | 1.34 off (the far row of the platform's nine cells, 0.4 from its edge: any of the nine is the goal, so inside by the goal's rule and near its edge by chance) |
| | now | 298 | 3 | 66 | 0 | 9.3 over at 0.90 | 0.48 off |
| the stacked platforms, 3 high (the brake's corridor, no tracker) | before and now | 495 and 509 | 4 | 0 | 0 | | 0.01 off |
| a cell under a roof 3 above | before | 374 | 2 | 71 | 7 | 12.1 over at 0.79, 12 blocks beside the line | 0.72 off |
| | the first fix | 517 to 537 | 9 to 10 | 277 to 297 | 30 to 37 | 10.6 over at 1.03 | a hit in 4 runs of 6 on the test host |
| | now | 300 | 2 | 64 | 1 | 9.1 over at 0.84 | 0.38 off |
| the route takeoff out of the 3-high stack, landing in the open | before and now | 284 | 1 | 8 (the takeoff) | | | on the cell |

**The 1 x 1 hole's `landed_off`** (0.37 from the centre, two blocks over the floor, the same numbers on both commits).
An undisturbed flight never does it offline (the brake lands every one of 305). With the body moved a third to
two-thirds of a block once in the approach, as a correction of the server moves it, 68 of 280 flights end so, at the
gate's own numbers (0.42 off after 265 ticks, "landing flare"). After the correction the brake's plan misses for a tick;
the flare's simulated settle lands in the hole with a tenth of a block to spare each side and costs less; flown, it
comes down a third of a block off and stands on the rim. `plan.ts` says of `LandingTarget.rim` that only the brake
comes down inside it: `landingChoice` now gives a cell under a rim to the brake alone. The same 280 flights: 0.

### The entry's first pass

**Where the height went.** On the Realm 7 of 8 learned entries missed their first pass: the body came to the lead-in's
start 27 over it where the flier takes 22, flew a circle of "0 laps and the rest of one", passed the start 20 to 21 over
it at 1.56 a tick, went around, flew a lap and was handed over: about 8 s. The flight is retargeted to its entry some
270 blocks before the lead-in, 59 over it. `--mode arrive` flies that (the body in the cruise, retargeted 320 blocks from
the entry's aim on the bearing it comes from) and the code before this track misses the same way. Three things:

- the cruise flew level until 130 blocks before the lead-in, 46 over it: a level glide at 1.5 a tick sinks a tenth of a
  block a block;
- its dive (the slope still needed and 6 degrees, 20 to 26 here) sank the fast body 0.14 a block: a glide's fall a tick
  depends on its look alone (0.149 at pitch 0, 0.227 at 20, 0.339 at 30) whatever its speed, so the slope flown is that
  fall over the speed, and looking down makes a fast body faster, not steeper;
- the circle of no whole lap is a straight piece flown at the circle's law, which is level over 1.5 a tick.

The ground matters too: on that bearing it lies 16 blocks higher than the lead-in's start some 60 blocks before it, so
the flight's terrain floor holds the body 29 over the start there, and the cruise's aim is its clearance over the ground
under the lead-in (13 over its start).

**The way down** (`brain.ts entrySink`). It begins as soon as the body is lined up on the lead-in and higher than a
level glide brings down. Each tick the pitch is the one whose fall is the slope still needed at the body's speed
(`ENTRY_SINK`, at most pitch 30); where that is not enough, or the body is over 1.6 a tick, the look goes straight back
for a tick (level: 1.5 a tick becomes 1.19 and the fall stays), never two ticks running and not under 0.9. It keeps 3
blocks over the terrain floor and rides it (a body under the floor fires a rocket, which took it over the lead-in again
and into a lap). Slopes to 0.38 a block; where the lead-in is steeper away than that it is not flown at all (round 2:
the lap beside the lead-in's start follows whatever is done, and on the replica a body slowed to 0.9 a tick first came
to that lap 2 to 3 s later). A body that comes in along the lead-in (before its start, within the hand-over's reach
beside it, heading within 25 degrees of it) flies no circle of no whole lap; one that comes to the window from the side
is brought round by the circle's last piece as before.

| offline, the fixture, 30 arrivals (89 to 109 over the goal at the retarget, 25 beside the bearing either way, 1.4 and 1.6 a tick) | before | this track |
|---|---|---|
| on the first pass (no go-around, no window missed) | 20 | 30 |
| from the retarget to standing | 14.9 to 26.9 s (median 20.6) | 14.6 to 18.7 s (median 15.5) |
| the circle beside the lead-in's start | every flight its last piece; 10 a whole lap after the go-around | 20 its last piece (from beside the line), none a lap |
| flights that fired a rocket | 15 (10 of them two) | 4 (one each: the terrain floor) |

From standing in the open on seven sides of the cave at three burns (`--mode approach`, 21 flights): 20 on the first
pass, one after a go-around (which the code before has as well; before, 16 of the 21).

**The touchdown's order** (`entry.ts entryTouchdowns`). At one distance from the goal a cell of a floor (two or more of
the four cells beside it standable at its level) comes before a single block's top or a hole's bottom, then the levels
as before. On the fixture the choice is the same cell as before (it is a floor's): where the body stands in the end is
the flier's touchdown, not the list's (the open points).

### What was measured first (the drawn line; the fixture, `scripts/cave-drawn-probe.ts`, the PC, 2026-11-10)

The first line drawn (the flood's way through its cells' middles, pulled straight) dipped a block under the takeoff's
height within three blocks and met the block beside cave_start in its roll: the flood's cheapest cells run a block or
two over the floor and follow every step of it. A flight out climbs: the owner's seven takes rise 12 to 19 degrees all
the way. Putting the points on one slope from the takeoff's height to the exit's gave a line that climbs 13 to 15
degrees and rolled. In the deep cave the same heights put points where the column was free and something jutted out
beside it (no room at all in places): the heights now keep the berth from what is beside the line. Those in turn lie
under the lip beside cave_start, over which a body that has just jumped is: so both are drawn and the roll chooses.
The deep cave's only opening is the bottom of a pit: the line goes on straight up there, and the climb with it.

### Offline, the owner's cave (`scripts/cave-drawn-probe.ts`, the recordings withheld, the PC, 2026-11-10)

**cave_start** (`--from cave_start --cruise 133 --each`):

| | the searched way out (Track F9a, as the bot's planner answers) | the recorded line (Track F9b) | the drawn line |
|---|---|---|---|
| the proof | refused: clear at the nominal burn, a hit at 9 | clear: 13 burns, 2 mixes, the dud | clear: the same 18 simulations |
| burns 9 to 21 flown out with no hit | 11 of 13 | 13 of 13 | 13 of 13 |
| under the roof | 56 to 99 ticks, 3 to 6 rockets | 55 to 62 ticks, 1 to 2 rockets | 48 to 50 ticks, 1 to 2 rockets |
| open sky over the body | | | after 2.4 to 2.5 s |
| the line | 6 turns, a climb of 50 degrees in the passage | the owner's: 12 to 19 degrees | 77 blocks, 61 to open sky, 13 to 15 degrees; at most 1.39 off it |
| the decision | 4.2 s to the refusal | 0.8 s | 1.8 to 2.0 s: 0.8 to 0.9 s the flood, 5 lines and their rolls, the rest the proof |

**From every underground waypoint** (`--from all --radius 400 --budget 60000`; 13 burns flown where a line is proven):

| waypoints | a proven drawn exit | open sky over the body | why not |
|---|---|---|---|
| cave_1 | yes, 13 of 13 | 1.0 to 1.1 s | |
| cave_3 | yes, 13 of 13 | 0.7 s | |
| cave_start | yes, 13 of 13 | 2.4 to 2.5 s | |
| cave_shortcut | yes, 13 of 13: into the pit and straight up | 1.1 to 1.3 s (the pit's bottom) | |
| cave_8 | yes, 13 of 13: 122 blocks of line, 2 rockets | 3.5 to 3.6 s | |
| cave_2 | | | under open sky: no roof to get out from |
| cave_4, cave_5, cave_6, cave_7 | | | no place to stand at the waypoint (no floor under its cell, or no two cells of air) |
| cave_9 | no | | the start: 2 of air over it (a jump takes no glide under 3) |
| cave_10 | no | | a line of 148 blocks rolls; the proof loses it at the nominal burn |
| cave_11 to cave_14, cave_16, cave_18 | no | | no line a glide can fly: the roll meets a block or finds no look clear, 40 to 161 blocks along (204 to 385 drawn) |
| cave_15, cave_17, cave_19, cave_20, cave_21, cave_end | no | | a line of 274 to 419 blocks rolls (174 to 295 ticks, 4 to 6 rockets) and is clear at the nominal burn; lost at a burn of 9 (cave_21: 12) |

Every waypoint has a flood to the sky (the deep cave's is one opening, 34 800 cells). The drawing and the rolls take 0.4
to 1.3 s by the mouth and 1.9 to 3.0 s in the deep cave; the proofs 0.5 to 5.4 s.

### Unit tests (`fly-drawn-exit.test.ts`, synthetic caves)

A straight passage; a passage with a bend; a shaft straight up through a mesa (the line under it and up, the climb
straight up out of it); a hall with two exits (both drawn; the first line refused, the other exit's is flown); a sealed
cave, a crack one cell wide and a start under two of air (no line: the takeoff's other lines as without the option); a
wall set across a line after it was drawn (the proof refuses it; flown all the same, the follower stops short and lands
under the roof). `fly-route-cap.test.ts`: the planner has a whole plan from the corners and the middle of the band onto
the stack's slot and into the room; the stack's hand-over inside what the tracker lands from at eleven pairs of burns;
the room 300 out at five (in the band, no rocket while landing, at most 100 ticks with the tracker); the stack's whole
flight at the four pairs that ended in rockets round the platform (no plan "blocked" by its own touchdown, no rocket);
the hole under a correction. Its whole flights run the planner on a node budget with no wall clock: the same flight on
any host.
`fly-learned-entry.test.ts`: the first pass from 16 to 36 over the lead-in; the touchdown's order.

### On the server

**The replica** (bds-fly2, the PC; the box built again from the fixture of 2026-11-10 with `FLY_CAVE_REUSE=surroundings
FLY_CAVE_PART_CHARS=1500`, then `FLY_CAVE_REUSE=1 FLY_CAVE_STYLE=1`; 2026-11-10; `FLY_CAVE_REPORT=<file>` writes the
table, which a passing run does not print):

| | runs | arrived | seconds to the goal | what flew | `roof` ends | damage |
|---|---|---|---|---|---|---|
| tripOut, `FLY_CAVE_EXIT=1`, no recordings: the drawn line | 6 | 6 | 62.7 to 73.5 (median 66.0) | off the ground at cave_start every run, one flight: the route takeoff along the drawn line, left after 50 to 52 ticks on 1 to 2 rockets, at most 1.29 off it. The decision 3.6 to 3.7 s: 2.0 to 2.1 s the flood (8 580 cells), 5 lines and their rolls on the bot's live model, the rest the proof's 18 simulations | 0 | 0 |
| tripOut, `FLY_CAVE_EXIT=1` and `FLY_CAVE_LEARNED` | 4 | 4 | 62.4 to 64.7 (median 63.6) | the recorded line, as before (the take 0.8 from cave_start); nothing is drawn | 0 | 0 |
| tripOut, both off | 3 | 3 | 97.8 to 102.2 | as before: a walk to open sky (the takeoff 55 blocks from cave_start), a vertical takeoff | 0 | 0 |
| trip C, `FLY_CAVE_LEARNED FLY_CAVE_ENTRY=1`, round 1's code | 6 | 6, standing 0.8 to 1.2 from the goal | 47.3 to 48.7 | no go-around, no bail-out; the circle from 104 over the lead-in (the replica's shell), the hand-over 8.6 to 8.7 over the line; 53 to 60 ticks from the last open sky | | 0 |
| the round trip (`FLY_CAVE_ONLY=round`), round 1's code | 3 | in 3 of 3, out 3 of 3 | in 47.4 to 48.9, out 60.2 to 63.2 | in along the learned entry, out along the recorded line | 0 | 0 |
| trip C, the final code (round 2: no way down over `ENTRY_SINK_SLOPE`) | 6 | 6, standing 0.9 to 1.1 from the goal | 45.1 to 46.8 (median 45.7) | no go-around, no bail-out; the circle from 105 to 117 over the lead-in, three laps and the rest of one; the hand-over 8.7 over the line; 54 to 59 ticks from the last open sky; flights of 848 to 884 ticks (880 to 922 in round 1) | | 0 |
| the round trip, the final code | 3 | in 3 of 3, out 3 of 3 | in 46.0 to 47.3, out 61.5 to 63.8 | in along the learned entry, out along the recorded line | 0 | 0 |
| tripOut, `FLY_CAVE_EXIT=1`, no recordings, the final code | 3 | 3 | 64.2, 67.5, 67.6 | the drawn line as in the first row: left after 51 to 52 ticks on 2 rockets, at most 1.29 off it; the decision 3.6 to 3.7 s | 0 | 0 |

The drawn line's trips take 2.4 s more than the recorded line's at the median (2.1 s of it the decision), five of the six
within 3.4 s of it; the sixth (73.5 s) climbed higher over the replica's shell on its way home (a flight of 1 344 ticks
where the others have 1 129 to 1 214), after a takeoff like the others'. The rows of the recorded line and of both
switches off were not flown again in round 2: what changed since flies a route landing's cruise, its tracker's check
and the way down onto a lead-in, none of which a takeoff out of the cave or a flight to an open landing runs.

Trip C in round 1 was 2 to 3 s slower than Track F9c's 43.9 to 46.4 s on the same replica: the shell brings the flight
in over 100 over the lead-in, more than the way down can lose, and it slowed the body to 0.9 a tick before a circle it
has to fly anyway. With no way down flown while the slope needed is steeper than the way down flies, the nine entries
of the final code (trip C's six and the round trip's three) take 45.1 to 47.3 s, median 46.0, none with a go-around:
five inside Track F9c's range and four over its top by 0.1 to 0.9 s. So about 2 s of the 3 came back and one is still
missing. The four slow ones are the flights retargeted far enough out that the slope was still under the limit: they
came down early, slowly, onto the terrain floor the shell sets, rode it at the speed they had left and began the circle
lower (105 to 108 over the lead-in, 865 to 884 ticks) but later than the ones that flew level to it (111 to 117 over,
848 to 856 ticks). The test asks the body's slope; what decides is the floor's (the open points).

### The regressions (each gate alone, by its exit code; bds-fly3 for fly-route-land and fly-route, bds-fly2 for the rest)

The final code (round 2), one chain with nothing else of this track running:

| suite | result |
|---|---|
| fly-route-land | 6 runs in a row green, the first six of the final code |
| fly-route | green |
| fly-walk | 4 runs, 4 green |
| fly-cave trip C with `FLY_CAVE_ENTRY=1`, the round trip, tripOut along the drawn line (3 runs) | green; the table above |
| `pnpm lint` (the PC) | exit 0 |
| the unit suite on the test host (`node scripts/mac-run.mjs --name f9d -- pnpm -r test`) | exit 0 on the final code (2 503 passed, 1 skipped, 83 s; the whole trips as in the table of the route landing above, landed on one or two searches each), and run five times more in a row after this page's last edit for the hand-back |

Round 1's code (not run again; kept for what they say about the gates themselves):

| suite | result |
|---|---|
| fly-route-land | 6 runs in a row green (7 of 7 each). The run before those six failed at `pocket #1` (`landed_off` at the cliff's foot after a go-around, by the flare; a corridor landing with no route and no rim): offline the pocket, the 3-high stack and the room of the gate are flown tick for tick as before this track (25 flights each), so it is none of this track's lines; it was not among the 39 runs of the three comparisons |
| fly-walk | 2 green, 2 red of 4 runs: the house, `landed_off` 11 to 12 from the centre after two "alternative landing instead of a go-around" retargets, arrived by the walk, damage 0. The commit before Track F9c fails the same case the same way in 1 of 4 runs on the same day (the same flight: a top 41 over the ground, the circle from 25 above) |
| fly-land | 4 of 5: `!fly stop in the air`, red before this track |
| fly-course, `FLY_AREA=71520,69472` | 8 of 8, then 7 of 8: the rings (3 of 5 rings in both legs) |
| the unit suite on the test host | exit 0 in the one run of round 1; then 4 failures in 6 runs at the whole trip to the cell under a roof (a hit, after 8 rockets round the room): the reason for round 2 |

### What the Realm should show

`!test goto home from cave_start 3` with `flyLearned off` and `flyCaveExit on` (`flyCave on`):

- at each start, after the vertical takeoff's refusal: `fly: route takeoff: N drawn ways out (a flood of about 8 800 cells
  under the roof, 2 to the open sky, drawn and rolled in T ms), 31 exits under open sky; the drawn way out drawn 1 (to
  <cell>, about 49 cells of the flood, 61 blocks to open sky, rolled in 47 ticks on 2 rockets, drawn with a berth of 0.6,
  its roll 0.54 from the nearest block): clear at burns of 15, 9, 21, 12, 18, 10, 11, 13, 14, 16, 17, 19, 20 ticks and of
  21 then 9, 9 then 21 and with a first rocket that fires nothing (the next at 15, 9, 21) (through the exit at tick 50,
  open sky at the same tick, ...) -> out along the drawn line drawn 1 to <cell>, then the climb curving to heading H (18
  simulated, T ms)`. No takeoff-site search, no `walking out`;
- `fly: to home (N blocks): cruise y ..., a route takeoff along the drawn line drawn 1 out to <cell> (47 ticks, 2 rockets
  rolled), then the proven climb curving to heading H`;
- in the flight: `drawn line: rocket 1 asked for 1 blocks along it, 8 ticks off the ground (the takeoff's)`, the first
  rocket's line, mostly `drawn line: rocket 2 asked for ... (the body at 0.8 to 1.0 a tick with line ahead)`, then `route
  takeoff: out along the drawn line drawn 1 after 48 to 52 ticks, 1 to 2 rockets (open sky over the body, 65 of 77 blocks
  along it, at most 1.3 to 1.4 off it, ...)`, `open sky over the body`, `the climb's heading reached the target's`;
- no `flight: ended (roof)`; one flight a run;
- the time: the recorded line gives 57.6 s a run there. The drawn line's flight is the same length (48 to 50 ticks under
  the roof against 55 to 62) and its decision one to two seconds longer on the PC (the flood and the rolls; the Realm's
  host was not measured): expect 58 to 62 s a run;
- a refusal instead (`the drawn way out drawn 1 (...): hits a solid ... at a burn of N ticks: refused`, then the next
  line, then `-> no route takeoff` and the walk out, 90 s) means the live cave is not the fixture's where the line runs;
  `no way under the roof to the open sky` or `no drawn way out (...)` that the flood or the roll found nothing;
- `route takeoff: the drawn line drawn 1 lost after N ticks (...): no climb without the line here, landing` and a flight
  ended `roof`: the flight left what its proof flew; the trip walks on from there.

`!test cavestart 3 from home` (`flyLearnedEntry on`):

- as before up to the decision and `flight: retargeted to ...`;
- then no `learned entry: 27 over the lead-in ...: down in a circle of 14 beside its start, 0 laps and the rest of one`
  and no `go-around 1: the learned entry ... missed`: the next entry line is `learned entry: onto the line of <name> N
  blocks before its hand-over window (the lead-in) ... (about 2 to 5 beside the line, 12 to 16 over it, 0.9 to 1.1 a
  tick ...)`, then the commit, the touchdown, `standing 0.8 to 1.2 from the goal`;
- the landed line with `0 go-arounds`, 3 to 4 rockets (none for a go-around) and no `descent helix` (a circle's last
  piece, `helix r14 ... from N over it`, with no go-around after it is the body coming to the window from beside the
  line: fine);
- the time: 52 s a run with the go-around in 7 of 8; offline the same arrival is 5 s shorter at the median (20.6 to 15.7
  s from the retarget to standing): expect 44 to 48 s a run. A go-around in more than one run of five means the live
  ground before the lead-in is not the fixture's, or the retarget comes later than offline (the way down needs the room).

A flight to a cell only the route lands (under a roof 2 or 3 above: a slot, a room, a pocket; measured from 150 and
300 blocks; nothing to switch on):

- `route landing: handing over to the route tracker 43 to 44 out, 8 to 10 over the cell at 0.7 to 1.05 a tick`, never
  `a rocket burning`; before this track the same line read 10 to 27 over;
- then one `route: start: plan 55 to 80 ticks, 0 rockets ...` and at most one or two more plans (`the plan ran out`);
  no `route: the plan's corridor is blocked at tick N of N+2` two ticks before a plan's end, which every landing had
  five to eight times; no rocket of the landing's; standing 55 to 80 ticks after the hand-over;
- a hand-over outside those numbers, or `partial plan (the nodes budget ran out ...)` right after it, means the flight
  came to its corridor late (handed over beside the line) or the planner's host is slower than the test host: say which
  line it was.

### On the Realm (2026-11-10, this track's code, the live kit)

- `!test goto home from cave_start 3` with `flyLearned off` and `flyCaveExit on`: 3 of 3 arrived, 57.2 s a run (58, 57,
  56), damage 0, no bail-out, one flight a run, no `roof` end. The decision line read as predicted: 5 drawn ways out, a
  flood of 8 823 to 8 865 cells, drawn and rolled in 635 to 651 ms, the whole decision 1.7 s on the Realm's host (18
  simulated). Out along the drawn line after 48 to 51 ticks, on 1 rocket twice (at most 1.3 off the line) and on 2 once
  (that flight at most 3.78 off it, in its last blocks). The recorded line gave 57.6 s a run there.
- `!test cavestart` from home with `flyLearnedEntry on`, two series: 8 of 8 arrived with no window missed and no
  go-around, damage 0: five runs at 47.9 s a run (47, 54, 44, 51, 44), then three at 43.7 s (45, 44, 43); before this
  track 51.7 s a run with a go-around in 7 of 8. The 54 s run began with a takeoff that came down again 15 ticks after
  it left its site, and then flew another take, whose start it passed too high: one more lap of the circle, no
  go-around. Four of the eight stood on the single block beside the goal; none slid off it.
- With `flyCaveExit` on, a takeoff inside a closed room (the home: a flood of 260 cells, none to the open sky) finds no
  drawn way in 5 to 13 ms and walks to its takeoff site as before.

### What a drawn way in would need (designed, not built)

`entryLine`, `proveEntry` and `EntryFlier` take any `Guide` (Track F9c's note). A drawn entry is the same flood run from
the goal's touchdown outwards, the line reversed: it must descend all the way (a glide climbs only on speed it has), so
the first question is whether the opening lies over the goal. On the fixture, by the flood's exit against each
waypoint's height: cave_start (15 over it, 61 blocks), cave_1 (13 over, 23 blocks) and cave_3 (2 over, 13 blocks) have
their opening above them; every waypoint of the deep cave lies 11 to 41 over the bottom of its only opening, and
cave_shortcut 4 over it: a way in there ends in a climb, which three of the owner's own takes were refused for. Then:
`rise` from the exit's height down to a point a block or two over the touchdown's floor, heading at it; the speeds from
a roll of the glide formula along it (a drawn line has no recorder's clock: `rollLine` gives the exit's); 24 blocks of
open air ending 20 before the roof for the window, which is the line's tail drawn backwards along the mouth's freest
heading, and `entryLine`'s own lead-in before it; a touchdown from `entryTouchdowns`; its own box from the proof on a
shrinking one. Behind a new setting, default off.

### What underground to underground needs

A line between two places under one roof: the flood by cost from the start to the goal's touchdown instead of to the
sky; `rise` between the two heights; no tail; the takeoff's half (the jump, the one rocket, the follower's rockets by
speed) as here, and the entry's half at its end (the governor, the touchdown, `EntryFlier`), with the hand-over between
them a place on one line and not a window in the open. The proof is the union of the two: every burn, the mixes and the
dud from standing, ending standing within 2 of the goal. What is missing is in the table above: lines of 150 blocks and
more are lost at a short burn, so the follower needs more than its 6 ticks of look and its one speed rule in a passage
(a speed for every point of the line, as an entry has; a rocket's burn planned for the bend after it), and the drawing
needs a width for every point, not three berths for the whole way.

### Open points (Track F9d)

- **The drawn line has not flown on the Realm.** `flyCaveExit` is off there and by default.
- **The deep cave.** Five of the 19 waypoints a body can stand at under a roof have a proven exit. Lines of 150 blocks
  and more roll at the nominal burn and are refused at a burn of 9: the generality ends where the follower's does.
- **The drawing's time.** A flood of 34 800 cells, its lines and rolls took 1.9 to 3.0 s on the PC before any proof
  (0.8 s at cave_start): the body stands meanwhile. The takeoff's budget bounds the proofs, not the drawing; the
  Realm's host was not measured.
- **With `flyCaveExit` on, any takeoff under a roof with a flood to the sky may be drawn**: a room, a base. It flies
  only what its proof cleared.
- **The climb straight up** begins where eight headings are walled at the climb's pitch within 20 ticks; a pit wider
  than that reach is climbed as any hillside is.
- **The band is measured straight in.** Three cells (the stack's slot, a room under a roof, a pocket in a cliff face),
  the body on the bearing heading in, sinking as a level glide does. The cruise hands over so now (no S-turns inside
  204 blocks); a flight that reaches its corridor late and is handed over beside the line or across it is outside what
  was measured, and so is a cell with a rim (the holes and the shaft are the brake's since this track).
- **The S-turns are flown only beyond 204 blocks now**, where they begin only for a body 38 blocks and more over the
  hand-over's height; inside, the same body comes down straight. `routeSink`'s S-turn half is kept for that and has no
  flight in the tables above.
- **The tracker's corridor check** is changed for a route landing alone; a course's or a cave's tracker checks as before
  (the cave's already swept in the search's grid). The other lever weighed, a higher price for flying near a solid in
  the landing's searches (`riskCost` 2 or 5 for 0.5), left 3 of 144 landings of the stack floundering where there were
  7 and changes which plan every landing chooses: not taken.
- **A hand-over 10.5 and more over the cell at 1.0 a tick and more** still finds no whole plan into the room (the
  search, not the tracker's check). The cruise does not hand over there (0 of 1 352 offline); a flight disturbed late
  could.
- **The first pass from the side.** A body that comes to the window from the side still flies the circle's last piece
  under its old law; one flight of 21 offline goes around there, as before.
- **The way down before a circle it cannot avoid.** Where the flight comes in far higher than the way down can lose (the
  replica: over 100 over the lead-in), `entrySink` slowed the body to 0.9 a tick and the circle's laps were then flown
  slower: trip C on the replica was 2 to 3 s longer than before this track. Round 2: no way down while the slope needed
  is over `ENTRY_SINK_SLOPE`. That brought back 2 s; the entries are still about a second slower than Track F9c's at the
  median (45.1 to 47.3 s over nine against 43.9 to 46.4), in the flights that are retargeted far out. The test should ask
  the terrain floor, not the body: no way down where the floor's highest column ahead, less what the flier takes over
  the line (22), is steeper away from the lead-in than `ENTRY_SINK_SLOPE`. On the fixture that keeps the way down (the
  ground there is 29 over the lead-in's start 60 blocks before it: 0.12 a block); under the replica's shell it would
  not begin. Not built: it needs the floor's column from `terrainNeed`, the 30 arrivals flown again and every gate.
- **fly-walk's house and fly-route-land's pocket** fail by chance on the commit before this track too (the house 1 run in
  4; the pocket once in this track's 7 runs and in none of the 39 before): both are landings this track does not fly
  differently, and both are a flare that comes down beside its cell.
- **Where an entry stands.** The Realm's entries stand on a single block beside the goal: the touchdown's cell is a
  floor's already, and the body comes down on what is under it at the brake's end. Not changed.
- **The roll and the brain's takeoff are two loops** over the same follower (`rollLine`, `guideTakeoff`): the roll is a
  first test, the proof flies the brain's.
- **Duplication left.** `cave-drawn-probe.ts` has `cave-exit-probe.ts`'s world set-up a third time; the drawn and the
  learned unit tests each have their rig.

## Drawn lines, the way in and under one roof (Track F9e)

Flight v2, Track F9e, [decisions/0082](decisions/0082-drawn-entries-and-hops.md). After Track F9d the bot flew out of a
cave along a line nobody recorded from five of the nineteen roofed places of the owner's cave it can stand at, into a
cave only along a recording, and between two places under one roof not at all. The owner: "fly through caves and land
underground", "fly from cave_start to cave_end, taking the shortcut if able, else 100% through the waypoints", and "if
it's pathfinding from underground to another spot underground, I should try to find it without having to get out
first". This track is the rest of the drawn line: longer ways out, a way in, and a flight that never leaves the roof.

```
a takeoff under a roof (commands-fly.ts autoFly, routeTakeoffFor), flyCave on:
 0 a goal under a roof as well: a HOP (flyCaveHop; learn/hop.ts)                 this track
     the flood     by cost, aimed at a standable cell by the goal; a hole in the roof over the way is passed, the
                   open air beyond it is not
     the line      the taut line between the two heights, pulled and rounded; it ends on the touchdown
     the flight    the follower from standing (its rockets by speed, a last one 56 to 44 blocks before the touchdown,
                   none after it), then the entry's flier from 14 blocks before the touchdown: the brake, the sink
     the PROOF     the whole flight from standing to standing (glide.ts routeHop): every burn from 9 to 21, two mixes,
                   a first rocket that fires nothing; each stands within 2 of the goal with no hit
 1 a recording that left the ground here (flyLearned)                           Track F9b
 2 a DRAWN line out (flyCaveExit; learn/draw.ts)                                Track F9d, longer lines this track
     the heights   the taut line through the passage's bands (taut), a top rounded 40 wide
     the speeds    for every point (lineSpeeds): a falling line a block a tick, a top by its radius, less before it
     the follower  takes speed off a body faster than the point allows (a tick of looking back), holds a rocket back
                   before a slow place and over a line that falls
 3 the exits, as before (Track F9a)

a flight to a goal under a roof (commands-fly.ts entryFor), flyCave on:
 1 a recording that stood again by the goal (flyLearnedEntry)                   Track F9c
 2 a DRAWN line in (flyCaveEntry; learn/drawin.ts)                              this track
     the flood     from a standable cell by the goal out to the cells under the real sky
     the line      a way out's, 50 blocks on into the open along the freest heading rising 20 degrees, REVERSED; it comes
                   down all the way (a climb of more than 1.5 blocks under its roof: refused)
     the speeds    the line's own, 1.2 a tick in the open, 0.75 on the touchdown; its times are those added up
     then as a recorded one: the window and the lead-in (entryLine), the proof's 39 states (proveEntry), the flier
 3 as before: the landing by the mouth, the walk
```

### Files

| File | What |
|---|---|
| `bot/src/skills/fly/learn/draw.ts` | `taut` (the heights), `DRAW_ROUND_OVER` (a top rounded wide), `lineSpeeds` and the `DRAW_CAP_*` numbers, `floodTo` (the aimed flood to a cell, `DRAW_SKY_NEAR`), `floodOutSteps` (the flood in slices), `drawWays` and `rollDraft` (drawn at once, rolled one by one), `rememberedGrid`; `drawLine`'s tail by options (a way in's) |
| `bot/src/skills/fly/learn/drawin.ts` | the drawn way in: `drawEntry`, `drawEntries`, `chooseDrawnEntry`, `ticksOf`, the `DRAW_IN_*` numbers |
| `bot/src/skills/fly/learn/hop.ts` | the hop: `drawHop`, `drawHops`, the `HOP_*` numbers |
| `bot/src/skills/fly/learn/follow.ts` | a drawn line's speeds: the tick that takes speed off (`FOLLOW_CAP_*`), the rocket held before a slow place and over a falling line (`FOLLOW_FALL*`), the look chosen again for the tick a rocket goes on; a hop's last rocket (`FOLLOW_HOP_*`); one tick's cells in a cube of bytes |
| `bot/src/skills/fly/learn/guide.ts` | `Guide.speeds`, `Guide.hop`, `entrySaid` |
| `bot/src/skills/fly/glide.ts` | `routeHop` (the hop's proof), `SimResult.hard` and `HARD_HIT`, `routeTakeoffOptions` passes the hop |
| `bot/src/skills/fly/brain.ts` | `guideTakeoff`: a hop's hand-over to the entry's flier; `climbUp`: over the pit's rim (`PIT_OUT_*`); the entry's lines say `drawn entry` for a drawn one |
| `bot/src/skills/fly/route/takeoff.ts` | the drawn lines rolled and proven one after another; `TakeoffRoute.hop` |
| `bot/src/chat/commands-fly.ts`, `bot/src/tasks/process/fly.ts` | `hopFor` (before any takeoff, in `autoFly`), `drawnEntryFor` (after the recordings, in `entryFor`), the decisions' lines |
| `bot/src/config/settings.ts`, `bot/src/chat/help.ts` | `flyCaveEntry`, `flyCaveHop` (both default off) |
| `bot/scripts/cave-drawn-probe.ts` | `--trace <burns>` (every tick of a line at a burn), `--fuzz n` (a burn of its own for every rocket) |
| `bot/scripts/cave-learned-entry-probe.ts` | `--drawn`: the way in drawn from the world, through the same modes |
| `bot/scripts/cave-hop-probe.ts`, `cave-probe-world.ts` | the hops on the private fixture: one pair, every pair of a route, a chain; the probes' world in one place |
| `bot/scripts/drawn-bench.ts` | what a decision costs on a host, on a synthetic cave |
| `bot/test/unit/skills/fly-drawn-ways.test.ts` | the guard tests |
| `bot/test/e2e/fly-cave.test.ts` | `FLY_CAVE_DRAWN_ENTRY=1` (trip C and the round trip along a drawn way in), `FLY_CAVE_ONLY=under` (cave_start to cave_end by `!goto`, `FLY_CAVE_HOP=0` for the setting off) |

### What was measured first (the lost lines traced; the fixture of 2026-11-11, `scripts/cave-drawn-probe.ts --trace 9`, the PC)

On the base, the same five waypoints as in Track F9d's table have a proven exit on the new fixture. The three lines the
brief names, each flown at a burn of 9 with every tick printed:

| from | the line | where and why it is lost |
|---|---|---|
| cave_10 | 173 blocks; it falls 31 to 39 degrees from 8 blocks on | at the nominal burn too. The takeoff's rocket ends 14 blocks along it with the body at 1.67 a tick, flying 21 degrees down where the line goes 30 down. Nothing takes speed off: 1.95 a tick 47 blocks along, 2.5 over the line, and where the passage levels out no look within six ticks clears the solid ahead: braked, lost |
| cave_15 | 300 blocks; 110 blocks along it goes over a sill | the line hugs the floor: 28 degrees up one side, 25 to 46 down the other within 20 blocks. The fourth rocket is asked for at the sill's foot (the body under a block a tick), its 9 ticks end on the top at 1.65 a tick, and the body's path turns down 2 degrees a tick where the line turns 50 in ten blocks: 5.7 over the line 30 blocks on, one contact, lost |
| cave_end | 437 blocks; the same sill 260 blocks along it | the same: its seventh rocket there, the burn's end on the top, 5.7 off the line 298 blocks along it, lost |

One cause in all three: a line that falls away in front of a body with a rocket's speed. Nothing but gravity bends a
glide downwards (0.03 to 0.05 a tick a tick), so the curve a body can follow over a top grows with the square of its
speed; and on a line that falls, a fast body flies flatter than the line whatever it looks at (a glide's fall a tick
depends on its look alone), and leaves it upwards.

### Longer lines: what changed

- **The heights** (`taut`). Track F9d put every point on one slope from the takeoff's height to the exit's and pressed it
  into its own passage: where the exit lies under the passage's sill that is the floor's shape. Now each cell of the
  way has its band of heights as before and the line through the bands is the taut one: straight where they allow,
  bent only where it touches a floor or a roof. Over the sill: 10 degrees up to it, then down from it, where it was 28
  up and 46 down. Where nothing is in the way it is the one slope as before (cave_start's line is the same 77 blocks).
- **A top rounded wide** (`round`, `DRAW_ROUND_OVER`): a corner whose slope falls 5 degrees or more gets a radius of 40
  where the air allows, the others 8 as before.
- **A speed for every point** (`lineSpeeds`): 1.7 a tick at the most (a burn's own speed and a little: a dive is flown
  no faster than a burn); 1.05 on a line that falls steeper than 12 degrees; over a top the root of 0.045 times its
  radius; round a corner a fifth of its radius; never under 0.8; and before a slow place 0.07 less a block.
- **The follower** (`follow.ts`, for a line that carries speeds; a recorded line has none and is flown as before). A body
  with no rocket burning that is faster than its point allows (by a tenth and 0.05) looks straight back for a tick,
  level: a fifth of its speed goes and its fall stays, so a body over a falling line comes down onto it. A body that
  rises steeper than the line does 4 blocks ahead of it looks back and 75 degrees down (the level look takes nothing off
  a rise). Never two ticks running; nothing under a burn (the velocity follows the look there). The next rocket waits
  until the body is slower than nine tenths of the least speed the line has within 12 blocks; over a line that falls
  1.4 blocks in the next 8 there is none unless the body is under 0.55 a tick; and the look of the tick a rocket goes on
  is chosen again with the burn (a look steep enough to bring a glide down onto a falling line is a dive into the floor
  under a rocket: one contact on the sill before this).
- **The climb out of the pit** (`brain.ts climbUp`). The deep cave's only opening is the bottom of a pit, and with a
  burn of its own for every rocket 5 of 40 flights from cave_end and 3 of 40 from cave_shortcut (a proven exit since
  Track F9d) ended under the pit's rim: "the path ahead is clear" was said on four more ticks of burn, the burn was a
  short one, and the climb's own pitch met the rim. The way straight up now ends where a line from the body along the
  held heading, rising 0.3 a block, is free for 20 blocks as well: the same seeds, 60 of 60 from each.
- **The decision's time.** The lines are drawn at once and rolled and proven one after another, the widest berth first
  (`drawWays`, `rollDraft`; before, every line was rolled before the first proof). The flood's cells are keyed by a
  number, a step's cost is looked at once a cell, and the follower's looks of one tick remember their cells in a cube
  of bytes: two fifths of a proof's time was a map's lookups.

### Offline, the owner's cave: the way out from every waypoint (`scripts/cave-drawn-probe.ts --from all --radius 400 --budget 60000 --fuzz 40`, the recordings withheld, the PC, 2026-11-11)

The 19 roofed waypoints a body can stand at (cave_2 is under open sky; cave_4 to cave_7 have no place to stand). "Burns":
the proven line flown at each of the 13 burns from 9 to 21, out with no hit. "A burn of its own": 40 more flights, every
rocket of each burning its own 9 to 21 ticks (seeded), which the proof does not fly.

| waypoint | before (the base, this fixture) | now | the line to open sky | burns | open sky over the body | rockets | a burn of its own for every rocket |
|---|---|---|---|---|---|---|---|
| cave_1 | proven | proven | 23 blocks | 13 of 13 | 1.0 to 1.1 s | 1 | 40 of 40 |
| cave_3 | proven | proven | 13 | 13 of 13 | 0.7 s | 1 | 40 of 40 |
| cave_start | proven | proven | 60 | 13 of 13 | 2.4 to 2.5 s | 1 to 2 | 40 of 40 |
| cave_shortcut | proven | proven: into the pit and straight up | 31 | 13 of 13 | 1.1 to 1.3 s | 1 | 40 of 40 |
| cave_8 | proven | proven | 99 | 13 of 13 | 3.6 to 4.2 s | 2 | 40 of 40 |
| cave_9 | no: 2 of air over the start | no: the same (a jump takes no glide under 3) | | | | | |
| cave_10 | no: lost at the nominal burn | proven | 147 | 13 of 13 | 5.7 to 6.1 s | 2 to 3 | 40 of 40 |
| cave_11 | no line a glide can fly | proven | 173 | 13 of 13 | 6.9 to 7.4 s | 2 to 3 | 40 of 40 |
| cave_12 | no line a glide can fly | proven | 207 | 13 of 13 | 8.4 to 8.9 s | 2 to 3 | 40 of 40 |
| cave_13 | no line a glide can fly | proven | 232 | 13 of 13 | 8.8 to 9.6 s | 3 to 4 | 40 of 40 |
| cave_14 | no line a glide can fly | proven | 252 | 13 of 13 | 9.8 to 10.4 s | 3 to 4 | 40 of 40 |
| cave_15 | no: lost at a burn of 9 | proven | 273 | 13 of 13 | 10.6 to 11.5 s | 3 to 4 | 40 of 40 |
| cave_16 | no line a glide can fly | proven | 285 | 13 of 13 | 11.2 to 12.1 s | 4 | 40 of 40 |
| cave_17 | no: lost at a burn of 9 | proven | 317 | 13 of 13 | 11.9 to 12.8 s | 4 to 6 | 40 of 40 |
| cave_18 | no line a glide can fly | proven | 343 | 13 of 13 | 12.4 to 14.1 s | 5 to 6 | 40 of 40 |
| cave_19 | no: lost at a burn of 9 | proven | 367 | 13 of 13 | 13.7 to 15.0 s | 5 to 6 | 40 of 40 |
| cave_20 | no: lost at a burn of 9 | proven | 389 | 13 of 13 | 14.8 to 15.3 s | 5 to 7 | 40 of 40 |
| cave_21 | no: lost at a burn of 12 | proven | 403 | 13 of 13 | 15.2 to 16.0 s | 5 to 7 | 39 of 40: at burns of 17, 18, 11 the third burn ends before a bend that climbs, the body 2.4 under the line there, no look clears the wall: braked, one contact at 0.4 a tick, down under the roof |
| cave_end | no: lost at a burn of 9 | proven | 413 | 13 of 13 | 15.3 to 16.8 s | 5 to 7 | 40 of 40 |

**18 of the 19 have a proven drawn exit** (5 before), cave_end and cave_10 among them; 719 of the 720 flights with a burn
of its own for every rocket are out with no hit. The waypoint `start` (beside cave_start) is proven as well. The body is
at most 0.9 to 4.7 off its line.

**The decision's time** (the PC; the flood, the lines, the roll and the proof of the first line that rolls; three runs
each with nothing else running):

| from | the flood and the lines | in all | before this track |
|---|---|---|---|
| cave_start | 0.07 to 0.08 s (8 855 cells, 12 lines) | 0.64 to 0.65 s | 1.6 to 2.2 s (0.7 s the flood, the lines and their rolls) |
| cave_end | 0.22 s (34 794 cells, 6 lines) | 3.3 to 3.7 s | 2.7 s to its refusal after 2 simulations; a whole proof of that line would have taken 6.4 s (2.3 s the flood, the lines and their rolls) |

The private fixture does not go to the test host. `scripts/drawn-bench.ts` flies the same code on a synthetic cave (six
halls joined by a winding tunnel) on both hosts: a way out of 599 blocks: the flood and six lines 0.33 to 0.52 s on the PC and 0.29 to 0.32 s on the test host, the proof's 18 simulations 5.6 to 7.5 s and 5.5 to 5.6 s; a hop of 473 blocks: 0.38 to 0.44 s and 0.32 s, its proof 2.8 to 3.8 s and 2.3 s (three runs each; the PC with the replica's server running beside it). So the test host is as fast as the PC or a fifth faster: cave_end's
decision there takes about 3 to 3.7 s (an estimate), and the long hop's about 3.6 s (an estimate).

**When the budget ends** (`TAKEOFF_BUDGET_MS`, 6 s): no roll and no proof is begun after it; one that runs is finished
(a proof is 18 simulations; cave_end's take 3 s). The next line is then said as `not tried (N ms gone)`, the exits are
not tried either, there is no route takeoff, and the trip walks out as it did before.

### A drawn way in (`learn/drawin.ts`, `flyCaveEntry`)

`entryLine`, `proveEntry` and `EntryFlier` take any line (Track F9c's note), so a drawn way in needs only the line:

- **The flood** runs from a standable cell by the goal (the goal's own when a body can stand in it, else the first of
  `entryTouchdowns`) to the cells under the real sky: the same flood as a way out's, in slices (`floodOutSteps`), because
  a way in is drawn while the bot flies and the input loop wants its turn.
- **The line** is drawn outwards as a way out's (the taut heights from a block over the touchdown to the opening, pulled,
  rounded) and carried on 50 blocks into the open: of the headings that are free that far (a block's berth, open sky
  over every point) the one whose line lies highest over the ground under it and under the lead-in to come, straight
  on from the roof winning a tie. It rises 20 degrees away from the roof: at 14 degrees the cruise came to the lead-in's
  start 28 to 39 over it where the flier takes 26 (the ground under a lead-in sets how low the cruise may be), flew a lap
  beside it or missed the window twice (cave_1: 13 of 30 arrivals); at 20 the line's start lies 10 higher and no flight
  of the 60 to cave_start and cave_1 flew a circle at all. Then the points are reversed.
- **It comes down all the way.** What the line climbs from its roof's edge to the touchdown is added up: more than 1.5
  blocks (the last blocks' pull-up is less) and it is no way in. A glide climbs only on speed it has, and no rocket is
  fired near a touchdown under a roof.
- **The speeds** are the line's own (`lineSpeeds`): 1.2 a tick at the most, 1.05 where it falls steeper than 12 degrees,
  less before a top or a corner, and 0.75 on the touchdown, the last 10 blocks coming down to it. The line's times are
  those speeds added up (`ticksOf`): the flier's governor reads its speed for a place off them, as off a recording.
- **Then it is a recorded entry**: the window is 24 blocks of the line's open part ending 20 before its roof, the
  lead-in 40 blocks before that, the touchdown one of `entryTouchdowns`, the proof `chooseTouchdown`'s (its own three
  states, then all 39), the flier `EntryFlier`. The line is drawn on one memory of the world and proven on another:
  the cells a proof made on the world cache is confirmed by later are the proof's own, not the flood's nine thousand.
- **The order at a covered goal** (`entryFor`): a recording that matches and proves clear (`flyLearnedEntry`), then the
  drawn line (`flyCaveEntry`), then as before. At most 3 drawn lines get a whole proof, and none is begun 10 s after the
  decision began (`ENTRY_BUDGET_MS`, as for the recordings).

**Offline, the fixture** (`scripts/cave-learned-entry-probe.ts --drawn --to <goal> --mode arrive --overs 89,94,99,104,109
--sides -25,0,25 --speeds 1.4,1.6`, the recordings withheld, the PC, 2026-11-11): Track F9d's 30 arrivals from the
Realm's side (the body in the cruise, retargeted to the entry 320 blocks from its aim).

| goal | the decision | the line | standing within 2 of the goal | no go-around, no window missed | hits | from the retarget to standing | under the roof |
|---|---|---|---|---|---|---|---|
| cave_start | 1.3 s: a flood of 8 855 cells, 9 lines drawn, the second proven (45 simulated: the first stood 3 under the touchdown from its own state) | 52 blocks in the open, 60 under the roof coming down 15 | 30 of 30 (0.3 to 1.0 from it) | 30 of 30, none by way of a circle | 0 | 16.2 to 18.8 s (median 17.2) | 64 to 69 ticks |
| cave_start along the recording (Track F9d's table, flown again) | | | 30 of 30 | 30 of 30 | 0 | 14.6 to 18.7 s (median 15.5) | |
| cave_1 | 0.6 s: 8 836 cells, 5 lines, the first proven (39 simulated) | 52 in the open, 22 under the roof coming down 13 | 30 of 30 (0.1 to 1.2) | 30 of 30, none by way of a circle | 0 | 14.1 to 18.6 s (median 15.4) | 28 to 39 ticks |
| cave_3 | 0.6 s: 3 252 cells, 1 line, proven (42 simulated) | 52 in the open, 12 under the roof coming down 2 | 30 of 30 (0.0 to 0.9) | 30 of 30, every one by the circle beside the lead-in (35 to 45 over its start) | 0 | 17.0 to 23.9 s (median 22.4) | 26 to 28 ticks |

The drawn entry to cave_start takes 1.7 s more than the recorded one at the median and 0.1 s more at the most: the
recording dives at the mouth 25 to 42 degrees, the drawn line comes down 20 and 14 at a block a tick.

**What is refused** (`--drawn --to <goal> --mode none --radius 400`): at every waypoint of the deep cave (cave_8, cave_10,
cave_12, cave_15, cave_18, cave_21, cave_end, cave_shortcut asked) the flood's one way to the sky is the bottom of the
pit, and the line has 2 to 11 blocks under open sky before its roof, or none on any heading, where the hand-over needs
44: `no drawn way in (... only 9 blocks of the line under open sky before its roof (the hand-over needs 44))`, in 0.2 to
0.3 s with nothing simulated. A way in there is a way down a pit and then up a passage: a hop from the pit's bottom,
which has no touchdown a proof stands on (below). A goal whose opening lies under it is refused for its climb (the unit
test's hall), and a goal with a cliff beside its lead-in for the cruise's height (the replica, below).

### Under one roof: the hop (`learn/hop.ts`, `flyCaveHop`)

**What the cave allows** was measured before the shape was chosen (`scripts/cave-hop-probe.ts`):

- The legs between the owner's waypoints are 13 to 49 blocks of line. A rocket burns 9 to 21 ticks: 15 to 35 blocks of
  flight that nothing shortens. A line under 48 blocks is therefore not flown at all (below), and 16 of the 22 legs are
  that; four more start in water and one under 2 of air. **Hops from waypoint to waypoint are not the shape**: of the
  22 only cave_start to cave_1 is flown.
- Lines over several waypoints are flown: two apart 9 of 21, four apart 11 of 19 (the rest are too short, start in
  water or under 2 of air, or end in water).
- **The line from cave_start to cave_end is proven as one**: 548 blocks through the passage the waypoints mark (it
  flies over the water of cave_4 to cave_7), never under open sky for more than a hole in the roof.

So the shape is **one line as far as it is proven**, tried from where the body stands to the goal itself. Where it is
not proven the trip walks as it did, and the walk is watched: every `flyRecheckBlocks` of it the hop is asked again,
and flown from the place one is proven from.

**The pieces.**

- **The flood** (`floodTo`) is the way out's by cost, aimed at a standable cell by the goal (the cost so far and the
  straight distance still to go). A cell under the sky is passed where a roofed cell of air lies within 8 of it on one
  of eight headings (a pit, the stretch before a mouth) and is no way on farther out: without that the search flooded
  the open air (341 000 cells for one pair) and with it it stays the cave's size. The last three cells before the goal
  need no room round them, as the first.
- **The line** (`drawHop`) is the taut line from a block over the start to a block over the touchdown, pulled and rounded
  as a way out's, then the touchdown itself. It may climb; it climbs on its burns. Its speeds are a way out's, coming
  down to 0.75 a tick on the touchdown over the last 12 blocks.
- **The last rocket** (`Guide.hop`, `follow.ts`). Under a burn nothing takes speed off, and a burn that ended where the
  touchdown's brake begins would push the body back the way it looks. So no rocket is fired later than 44 blocks before
  the touchdown (the longest burn's 35 blocks of flight and the brake's room), and a body 56 to 44 blocks before it with
  none burning and under 1.45 a tick fires one: what flies the rest is that burn's speed, whatever its length (after
  the shortest the body glides 41 blocks, after the longest 21). A line under 48 blocks has no place for it: walked.
- **Two fliers on one line** (`brain.ts guideTakeoff`, `entry`). The follower flies from standing (the jump, the
  takeoff's rocket, the rockets by speed) to 14 blocks before the touchdown; there the entry's flier takes the body on
  the same line, committed at once (what was proven is this very flight: there is no window and no box to be in), and
  flies the last blocks as an entry's: the governor, the brake over the touchdown, the sink. A rocket still burning at
  that place burns on and nothing is taken off under it. Open sky over the body is no end of a hop, and there is no
  climb after it. Losing the line brakes and lands, as on a way out.
- **The proof** (`glide.ts routeHop`) is the whole flight from standing to standing: the nominal burn, every burn from
  9 to 21, the two mixes and a first rocket that fires nothing, each burn's end seen two ticks late. Each must stand
  within 2 of the goal (beside it, and over or under it), dry, with no contact that took more than 0.15 a tick off the
  body's speed (`HARD_HIT`; flying into a wall costs health from 0.3). A first rocket that fires nothing may bring the
  body down short of the goal instead, with no hit and dry: that is said in the decision's line and the hop is flown
  all the same (the body stands by its start again and the trip asks again; the other lines begin on the same blocks,
  and proving them was three more seconds of standing on the replica).
- **Where it is asked** (`commands-fly.ts hopFor`, in `autoFly` before any takeoff and before the `flyMin` test):
  `flyCave on`, `flyCaveHop`, the start and the goal both under a roof, the goal more than 48 blocks off (a hop is
  measured by its line, not by the straight distance: the two ends of the long line lie nearer each other than
  `flyMin`). It is drawn and proven on the live model with the world cache behind it (a line of some hundred blocks
  runs beyond what the server has sent; in the air the follower steers by the live model alone, which has the cells
  round the body by then). At most 3 lines are proven and none is begun 6 s after the decision began
  (`HOP_BUDGET_MS`). The flood reaches 320 blocks from the start and 150 000 cells. A watched walk (`watchWalk`) asks
  again from where it is, and where a hop is found there it is drawn and proven once more from where the walk stopped.

**Offline, the fixture: cave_start to cave_end** (`scripts/cave-hop-probe.ts --from cave_start --to cave_end --each
--fuzz 60`, the recordings withheld, the PC, 2026-11-11):

| | |
|---|---|
| the line | one line of 548 blocks through the passage the waypoints mark (465 cells of the flood), 51 from its lowest point to its highest; never out of the cave |
| the decision | 4.2 s: 0.9 s the flood (76 832 cells looked at) and 6 lines, 3.3 s the proof's 18 simulations of the first |
| the proof | standing within 0.9 of the goal at every burn, both mixes and with a first rocket that fires nothing |
| flown at the 13 burns from 9 to 21 | **13 of 13 standing by cave_end** (0.1 to 0.9 from it), 0 hits of any kind, 19.1 to 21.1 s on 8 to 11 rockets, at most 3.6 off the line; the flier takes the body 362 to 397 ticks after the jump |
| flown share | all of it: the body leaves the ground on cave_start and stands again on cave_end |
| a burn of its own for every rocket | 60 of 60 standing within 2 of the goal with no hit |
| the way back, cave_end to cave_start | proven (the second line; the first met a block at a burn of 9): 545 blocks, 13 of 13, 20.4 to 22.3 s on 7 to 10 rockets, 40 of 40 with a burn of its own for every rocket |
| against the walk | the same `!goto` with `flyCaveHop` off on the replica: see "On the server" |

**The shortcut is never taken.** cave_shortcut lies beside the bottom of the pit, and cave_end close by and a little
over it; the air between them is a slot one to three cells wide that rises steeply. A line needs the gliding
box's width and a berth each side: the flood (three cells wide, two high) does not pass it, and with the room rule
lifted near the goal the line through it is no line a body keeps its berth on. From cave_shortcut the only proven way to
cave_end is the long one (397 blocks, round by cave_8 to cave_21). And cave_start to cave_shortcut itself (162 blocks:
out of the upper cave's mouth, under the open sky for a stretch, down the pit) is refused: every flight of its proof
ends in the water at the pit's bottom beside the touchdown. So with or without the shortcut's waypoint the flight from
cave_start to cave_end is the one line through the waypoints' passage.

**Every pair of the route** (`--pairs cave --skip 1,2,4`: each waypoint to the next, to the next but one, and to the one
four on; 62 pairs; a proven line flown at the 13 burns):

| pairs | proven | flown at 13 burns | why not |
|---|---|---|---|
| each waypoint to the next (22) | 1: cave_start to cave_1 (49 blocks) | 13 of 13 standing, 0 hits | 16 too short to fly (13 to 43 blocks of line, under 48); 4 start in water (cave_4 to cave_7: no place to stand); 1 starts under 2 of air (cave_9) |
| to the next but one (21) | 9: cave_start to cave_2 (78 blocks), cave_1 to cave_3, cave_10 to cave_12, cave_11 to cave_13, cave_12 to cave_14, cave_15 to cave_17, cave_16 to cave_18, cave_17 to cave_19, cave_18 to cave_20 (48 to 64) | 13 of 13 each, 0 hits, 2.4 to 7.9 s on 1 to 2 rockets | 4 too short (27 to 47); 4 start in water; 1 under 2 of air; cave_2 to cave_4 and cave_3 to cave_5 end in the water there; cave_8 to cave_10 (49 blocks up 26) hits a block in the flier's part, 31 blocks from its start |
| to the one four on (19) | 11: cave_start to cave_4 (131 blocks), cave_8 to cave_12 (109, up 26), cave_10 to cave_14, cave_11 to cave_15, cave_12 to cave_16, cave_13 to cave_17, cave_14 to cave_18, cave_15 to cave_19, cave_16 to cave_20, cave_17 to cave_21, cave_18 to cave_end (72 to 111) | 13 of 13 each, 0 hits, 3.3 to 5.7 s on 1 to 3 rockets | 4 start in water; 1 under 2 of air; cave_1 to cave_5 ends in water; cave_2 to cave_6 and cave_3 to cave_7 have no cell to stand in by the goal |
| longer | cave_start to cave_8 (234 blocks, 12.3 to 14.4 s), cave_3 to cave_8 (145), cave_8 to cave_end (323, 11.8 to 12.7 s), cave_shortcut to cave_end (397) | 13 of 13 each, 0 hits | |

A hop's decision takes 0.3 to 0.5 s for a line of 50 to 60 blocks and 0.6 to 0.9 s for 100 (the PC). Two of the lines
(cave_8 to cave_12, cave_8 to cave_end) come down short of the goal with no hit when their first rocket fires nothing
(the takeoff climbs 45 degrees there): flown all the same.

### On the server

**The replica** (bds-fly2, the PC, 2026-11-11; the box built again from the fixture of 2026-11-11 with
`FLY_CAVE_REUSE=surroundings FLY_CAVE_PART_CHARS=1500`, then `FLY_CAVE_REUSE=1 FLY_CAVE_STYLE=1`; `FLY_CAVE_REPORT=<file>`
writes the table):

| | runs | arrived | seconds | what flew | damage |
|---|---|---|---|---|---|
| tripOut, `FLY_CAVE_EXIT=1`, no recordings: the drawn line | 3 and 3 (the final code) | 6 of 6 | 59.6, 64.4, 66.6 and 61.8, 59.6, 58.6 | one flight a run from cave_start: the route takeoff along the drawn line, left after 50 to 51 ticks on 2 rockets, at most 2.32 off it, no `roof` end. The decision 1.2 s (3.6 to 3.7 s in Track F9d): 0.1 s the flood (8 569 cells) and 12 lines, the rest one roll and the proof's 18 simulations | 0 |
| tripOut, `FLY_CAVE_EXIT=1` and `FLY_CAVE_LEARNED` | 3 | 3 | 60.5, 66.3, 61.9 | the recorded line, chosen first; nothing is drawn | 0 |
| tripOut, both off | 2 | 2 | 114.5, 116.3 | as without them on this fixture: a walk of 12 blocks, a vertical takeoff | 0 |
| trip C, `FLY_CAVE_DRAWN_ENTRY=1`, no recordings | 3 | 2 | 90.7, 91.9; one not in 600 s | **the drawn entry is refused every run**: `but the ground beside its lead-in keeps the cruise 93 over the line's start (a cliff beside it; over 60 there is no way down onto it): refused`. The replica's shell has a wall at the box's edge, and the only heading out of the mouth with 50 blocks of free air runs within 6 blocks of it; the fixture's own ground there is a hillside (30 of 30 offline). So the flight lands by the mouth and the rest goes on as without it: the same trip with no entry at all (`FLY_CAVE_PLAIN=1`, 4 runs) takes 72.8, 71.7, 87.1 and 74.7 s. The run that did not arrive landed on another cell (23 from the goal, 31 over it) and its walk did not end in the 600 s the test allows | 2.2, 0 and 1 (the windows after the landing) |
| the same before that test (the line proven, the cruise 100 over it) | 2 | 2 | 138.4, 145.7 | the window missed twice (`never on the lead-in`), a go-around, then the landing as without it | 0 and 6.8 |
| trip C, `FLY_CAVE_LEARNED FLY_CAVE_ENTRY=1 FLY_CAVE_DRAWN_ENTRY=1` | 6 | 6, standing 0.8 to 1.1 from the goal | 43.6 to 47.0 (median 45.9) | the recorded entry, chosen first: no go-around, 54 to 62 ticks from the last open sky (Track F9d: 45.1 to 46.8 s) | 0 |
| the round trip, no recordings (`FLY_CAVE_DRAWN_ENTRY=1 FLY_CAVE_EXIT=1`) | 3 | in 3, out 3 | in 75.1, 85.1, 83.7; out 63.6, 63.0, 63.2 | in: the entry refused as above, the landing by the mouth and the rest; out: along the drawn line | 0 |
| the round trip, `FLY_CAVE_LEARNED FLY_CAVE_ENTRY=1` (no `FLY_CAVE_EXIT`) | 3 | in 3, out 3 | in 45.4, 45.5, 45.6; out 55.7, 112.6, 115.3 | in: the recorded entry. Out: once along the recorded line; twice the three takes tried were refused from where the trip in left the body (`the way out ended off the line`; 1.1, 2.4 and 0.3 from where they left the ground) and it walked out as with the switches off: a recorded line is followed by the same code as before (below), and with no `flyCaveExit` there is no drawn line behind it | 0 |
| the round trip, `FLY_CAVE_LEARNED FLY_CAVE_ENTRY=1 FLY_CAVE_EXIT=1` (the gate's) | 3 | in 3, out 3 | in 45.3, 45.8, 46.4; out 60.1, 59.8, 115.4 | in: the recorded entry, no go-around, 52 to 59 ticks from the last open sky. Out: twice along the recorded line; once nothing was proven from where the body stood, three recorded takes and three drawn lines (`down before the exit (landed_off)`, `the way out ended off the line`), and it walked 155 blocks to a takeoff site | 0 |
| under one roof, cave_8 to cave_end, `flyCaveHop` on (`FLY_CAVE_ONLY=under FLY_CAVE_UNDER=cave_8,cave_end`) | 5 | 5, standing 0.1 to 0.6 from the goal | 15.9 to 17.0 | one flight a run, all of the way: a hop of 323 blocks of line, the flier's place after 214 to 231 ticks on 6 rockets. The decision 2.2 to 2.4 s | 0 |
| the same, `FLY_CAVE_HOP=0` | 2 | 2 | 98.4, 28.1 | the walk: it dug its way in the first run and walked through what it had dug in the second | 0 |
| under one roof, cave_start to cave_3, `flyCaveHop` on | 5 | 5, standing 0.1 to 0.6 from the goal | 6.8 to 7.6 | a hop of 92 blocks of line, the flier's place after 55 to 68 ticks on 1 to 2 rockets. The decision 0.7 to 0.9 s | 0 |
| the same, `FLY_CAVE_HOP=0` | 2 | 2 | 48.5, 48.4 | the walk (213 ticks of it in water) | 0 |
| under one roof, **cave_start to cave_end**, `flyCaveHop` on | 2 (150 s and 600 s allowed) | 0 | | **no hop on the replica**: `no way under the roof to the cell 0 0 0 from the goal's (41 776 cells looked at) -> no hop` in 0.6 s, then the walk as before, which was 43 and 23 blocks from the goal when the runs ended. The flood stops between cave_3 and cave_8 (cave_3 to cave_8 asked alone: the same line): the server's water lies there where the fixture has air over its water cells. In the replica's own model offline (`scripts/cave-hop-probe.ts --replica`) the line is proven as on the fixture, 548 blocks | 3 and 3 |

So on a server: the drawn way out as before (6 of 6); hops of 92 and 323 blocks, 10 of 10: the first 7 times quicker than its walk, the second 6 times quicker
than a walk that digs its way and 1.7 times quicker than the walk through what was dug; the recordings still chosen first. Not on a server: the drawn way
in (refused for the replica's wall) and the long line (the replica's water). Both are the fixture's results above.

**Where the walk after an entry ends, the way out is not always proven.** After the entry's landing the trip walks to
the goal's cell, and that walk ends 0 to 0.3 from the cell's centre. Where it ended 0.3 from it (the first take's
lift-off 1.1 from the body) every way out was refused from there, the recorded takes (`the way out ended off the line`,
`down before the exit (landed_off)`) and, in the one such run with `flyCaveExit`, the three drawn lines as well; the trip
then walks 155 blocks to a takeoff site and takes 113 to 116 s where the line takes 56 to 64. Where it ended 0 to 0.2
from the centre the first take was clear. Counted over the round trips with the recordings on this replica: **this
tree 4 of 10** (2 of 3 and 1 of 4 with no `flyCaveExit`, 1 of 3 with it), **the base's code 1 of 7** (598b14bd's bot
folder flown from a copy beside this one, 3 and 4 runs; the same refusal, 116.4 s); Track F9d's table has none in 6 on
its replica (the box of the fixture of 2026-11-10). Offline in the replica's model (`scripts/cave-exit-probe.ts --replica
--paths <dir> --at <dx,dz>`, with and without `--takes`), from the cell's centre and from three places 0.9 to 1.3 beside
it, the base's code and this tree's give the same output at all four. So this is older than this track and not its
follower (a recorded line has no speeds); the two rates are not told apart by 17 runs. Nothing steps the body to the
cell's centre, or to where a take left the ground, before the proof: an open point.

### The regressions

**With this track's settings off nothing changes.** Checked offline, tick for tick: the base's `bot/src` and
`bot/scripts` (598b14bd) beside this tree's, the same flights on both, the outputs compared (the milliseconds taken
out). `scripts/route-land-probe.ts` hashes every tick's position: the gate's stacked platforms to the hand-over at 169
pairs of burns, 25 whole flights of them, 9 of the room 300 out, 3 of the hole; `scripts/cave-exit-probe.ts` with the
recordings (the learned exit from cave_start: its proof and the 13 burns); `scripts/cave-learned-entry-probe.ts` with
the recordings (the learned entry's cases, one flight each). **The same output on both, in all six.** A recorded line
carries no speeds and no hop, and the follower's new branches ask for them; the follower's cube of cells answers what
the grid answers. What does change without a new setting: every drawn way out (`flyCaveExit`, on live): its heights,
its speeds, the rockets by them, the climb out of a pit, the order the lines are tried in.

The final code, each gate alone with nothing else of this track running, by its exit code (bds-fly3 for fly-route-land
and fly-route, bds-fly2 for the rest; the PC, 2026-11-11):

| suite | result |
|---|---|
| fly-route-land | 6 runs in a row, exit 0 six times (7 of 7 each, 463 to 497 s a run) |
| fly-route | exit 0 (3 of 3) |
| fly-walk | 4 runs, exit 0 four times |
| fly-land | **exit 1**: 4 of 5; `!fly stop in the air (a ground target 300 blocks out)` timed out waiting for its reply. The base's code flown on the same server right after: exit 1, the same case, 4 of 5 (the case that is red on main) |
| fly-course, `FLY_AREA=71520,69472` | **exit 0, 1, 1, 1** in 4 runs (the two asked for and two more): 7 of 8 in the three, `rings` each time (neither of its two flights passed all five goals; `ground` after 1 to 3). The base's code on the same server, 3 runs: exit 0, 1, 0, `rings` the same way. The rings are flown by the test's own driver (`route/live.ts`, the tracker, the search, the grid, the rocket hand): none of those files, and nothing they import, is changed by this track |
| fly-cave trip C with `FLY_CAVE_ENTRY=1` and the recordings | exit 0; 6 of 6 along the recorded entry (the table above) |
| fly-cave, the round trip with the recordings | exit 0 three times (10 trips): in 10 of 10 along the recorded entry, out 10 of 10 arrived, 6 along the recorded line and 4 on foot ("Where the walk after an entry ends", above) |
| fly-cave tripOut along the drawn line (`FLY_CAVE_EXIT=1`, no recordings) | exit 0; 6 of 6 (the table above) |
| `pnpm lint` (the PC) | exit 0 |
| the unit suite on the test host (`node scripts/mac-run.mjs --name f9e -- pnpm -r test`) | a first run exit 0 (2 531 passed, 1 skipped, 95.5 s); then three in a row: exit 1, 0, 0, the one failure `nav-worker.test.ts > planner worker: a real worker thread > the navigator walks the interim answer, splices in the final one, and plannerThreads 0 plans in-thread` (the walk's timing, not a file of this track); and three more in a row after this page's last edit for the hand-back |

### What the Realm should show

`!test goto home from cave_end 3` (a drawn exit from the deep cave; `flyCave on`, `flyCaveExit on`, both on live;
`flyLearned` may stay on: no recording leaves the ground there):

- at each start: `fly: route takeoff: ..., 6 drawn ways out (a flood of about 34 800 cells under the roof, 1 to the open
  sky, drawn in about 250 ms), N exits under open sky; the drawn way out drawn 2 (to <cell>, 349 cells of the flood, 413
  blocks to open sky, rolled in about 300 ticks on 6 rockets, drawn with a berth of 0.9, its roll 0.3 from the nearest
  block): clear at burns of 15, 9, 21, 12, 18, 10, 11, 13, 14, 16, 17, 19, 20 ticks and of 21 then 9, 9 then 21 and with
  a first rocket that fires nothing (the next at 15, 9, 21) (through the exit at tick 310 or so, open sky at the same
  tick, ...) -> out along the drawn line drawn 2 to <cell>, then the climb curving to heading H (18 simulated, about 3.5
  s)`. The first line drawn does not roll and is not named. No takeoff-site search, no `walking out`;
- `fly: to home (N blocks): cruise y ..., a route takeoff along the drawn line drawn 2 out to <cell> (about 300 ticks, 6
  rockets rolled), then the proven climb curving to heading H`;
- in the flight: `drawn line: rocket 1 asked for 1 blocks along it ... (the takeoff's)`, then four to six times `drawn
  line: rocket N asked for ... blocks along it ... (the body at 0.9 to 1.0 a tick with line ahead)`; `route takeoff: out
  along the drawn line drawn 2 after 306 to 336 ticks, 5 to 7 rockets (open sky over the body, about 418 of 428 blocks
  along it, at most 2.8 off it, ...)`; `route takeoff: open sky straight over the body and a solid ahead on heading H at
  the climb's pitch (a pit): straight up until the path ahead clears`; `route takeoff: up out of the pit: 20 to 30 blocks
  straight up in 14 to 20 ticks, the path ahead on heading H is clear from here`; `the climb's heading reached the
  target's`;
- no `flight: ended (roof)`; one flight a run;
- the time: 15.3 to 16.8 s from the jump to open sky over the body (offline), the decision 3.5 s before it, then the
  pit and the flight home as from cave_start, which takes 57 s a run there: expect 70 to 80 s a run;
- a refusal instead (`the drawn way out drawn 2 (...): ... at a burn of N ticks: refused`, then `-> no route takeoff`
  and the walk out) means the live cave is not the fixture's where the line runs (the bot digs and pillars there);
  `the drawn way out ...: not tried (N ms gone)` that the host took over 6 s; `route takeoff: the drawn line drawn 2
  lost after N ticks (...): no climb without the line here, landing` and a flight ended `roof` that the flight left
  what its proof flew (one flight in seven hundred offline): the trip walks on from there, and takes off again where a
  line is proven.

`!test cavestart 3 from home` with `flyLearnedEntry off` and `flyCaveEntry on` (`flyCave on`):

- as before up to the takeoff; some seconds into the flight `fly: drawn entry: no recorded way in to cave_start: a
  flood of about 8 850 cells under the roof from the goal, 2 to the open sky, 9 lines drawn; drawn in 1 (...): to the
  goal's cell: stands 2.9 from the touchdown and 3.0 under it from mid on the line ...: refused; drawn in 2 (the opening
  <its offset> from the touchdown (49 cells of the flood), a berth of 0.9 over the floor and under the roof; 52 blocks in
  the open, 60 under the roof coming down 15): to the goal's cell: clear from 37 entry states (...): standing at most 1.2
  from the touchdown, ... -> in along the drawn line drawn in 2: onto its line 92 blocks from the goal and 30 over it at
  about 1.0 a tick, 45 blocks of open air to its roof, 60 under it to the touchdown on the goal's cell (45 simulated, 1.5
  to 3 s; N cells from the world cache: to be confirmed on the live world before the line is committed to)`;
- `flight: retargeted to ...`; `flight: drawn entry: the proof of drawn in 2 stands on the live world (N cells the
  same)`; `flight: drawn entry: onto the line of drawn in 2 N blocks before its hand-over window (the lead-in), ...`;
  `flight: drawn entry: on the line drawn in 2 45 blocks before its roof (...): inside what the proof flew, the follower
  has it to the touchdown`; `flight: drawn entry: the touchdown begins (...)`; `flight: drawn entry: standing 0.3 to 1.0
  from the goal along drawn in 2: about 110 ticks after the commit, 64 to 69 from the line's last open sky ...`; the
  landed line with `0 go-arounds`; then a walk of a block or none;
- the time: the recorded entry gives 43.7 to 47.9 s a run; offline the drawn one takes 1.7 s more from the retarget to
  standing at the median: expect 45 to 50 s a run;
- `-> no drawn entry: the landing as without it` means every line's proof was refused on the live cave (the reasons
  are in the line: a block by the goal, `the way in climbs`, `but the ground beside its lead-in keeps the cruise N over
  the line's start`): the flight lands by the mouth and the rest goes on as before, 80 s or so. `go-around 1: the drawn
  entry drawn in 2 missed (...)` means the cruise did not come down onto the lead-in (the ground before it is not the
  fixture's, or the flight came from another side): once is the price of a lap, twice gives the entry up.

`!test goto cave_end from cave_start 3` with `flyCaveHop on` (`flyCave on`, `autoFly on`):

- at each start: `fly: hop: to cave_end under the roof: about 77 000 cells looked at, 6 lines drawn in about 1 s; hop 1
  (548 blocks of line, 465 cells of the flood to the cell 0 0 0 from the goal's, a berth of 0.9, 51 from its lowest to
  its highest): standing within 0.9 of the goal at burns of 15, 9, 21, 12, 18, 10, 11, 13, 14, 16, 17, 19, 20 ticks and
  of 21 then 9, 9 then 21 and with a first rocket that fires nothing (the next at 15, 9, 21); 413 ticks at the nominal
  burn on 9 rockets -> along the drawn line hop 1 to the touchdown 0 0 0 from the goal's cell (18 simulated, 4 to 5
  s)`;
- `fly: to cave_end (N blocks): ..., a hop along the drawn line hop 1 under the roof to a touchdown at <cell> (about 470
  ticks; no climb, no cruise)`;
- in the flight: `drawn line: rocket 1 asked for 1 blocks along it ... (the takeoff's)`, seven to ten more by speed;
  `hop: 534 of 548 blocks along the drawn line hop 1 after 362 to 397 ticks, 8 to 11 rockets (at most 2 to 3.6 off it,
  slowed N ticks, ...): the touchdown's flier has it from here`; `drawn entry: the touchdown begins (...)`; `drawn entry:
  standing 0.1 to 0.9 from the goal along hop 1: ...`; `flight: landed ...`; `arrived at ...`;
- the time: 19.1 to 21.1 s of flight and 4 to 5 s of deciding: 25 to 30 s a run;
- `-> no hop` (with the reason: `no way under the roof`, `too short to fly`, a refusal at a burn) and the trip goes on
  as it did; `route takeoff: the drawn line hop 1 lost after N ticks (...)` and `flight: ended (roof)`: the body came
  down under the roof short of the goal; the trip walks on, and asks for a hop again where it stands when it flies.

The live settings each needs, besides `flyCave on` and `flyRoute` not off (both so today): the first `flyCaveExit on` (so
today), the second `flyCaveEntry on` with `flyLearnedEntry off` (to see the drawn one; with both on the recording is
chosen), the third `flyCaveHop on`.

### Unit tests (`fly-drawn-ways.test.ts`, synthetic caves)

The taut line (straight where free, bent at a sill and under a low roof, inside its bands); the speeds (a level line
the most, a falling line a block a tick, a top the least and less already before it). A tunnel 200 blocks long with
three bends, the first over a top (a ramp up 24 at 45 degrees, a sill, as steep down the far side, a bend north, a
bend west): without the speeds the follower loses it at a burn of 9, with them it is flown out at 9, 12, 15, 18 and 21;
the lines drawn at once and rolled one by one. A drawn entry into a hall through a mouth above it (drawn from the
touchdown outwards, in the open at least the hand-over's length, no rocket, proven, flown to standing from the window's
start, middle and end); refused where the hall's only opening lies under it (`climbs`) and where it is sealed. The
flood to a cell (aimed, and no wandering of the open air for a hall that is not joined); a hop between two halls
joined by a straight passage (the last rocket's place and the flier's, the proof's 19 simulations, flown at 9, 15 and
21 to standing by the goal with no hit), by one with a bend, and by one that climbs 14; a way too short to fly; a
block set across the line after it was drawn (the proof refuses the hop; flown all the same, the follower stops short
and comes down with no hard hit); a chain of three hops, each drawn and proven from where the last one stood. The
settings' defaults.

### Open points (Track F9e)

- **Nothing of this track has flown on the Realm.** `flyCaveEntry` and `flyCaveHop` are off there and by default; the
  longer lines fly under `flyCaveExit`, which is on there, at the next takeoff under a roof.
- **The proof's burns are one length for all the rockets of a flight, and two mixes.** A line of five to eleven rockets
  flies with as many lengths. The probes fly that (719 of 720 over the 18 exits, 60 of 60 and 40 of 40 on the long hop
  and its way back); the proof does not, and six more simulations a line would not find one flight in seven hundred.
  The one that failed braked and came down under the roof with a contact at 0.4 a tick.
- **A bend with no rocket burning.** The speeds know a top and a tight corner; a wide bend that climbs, come to under a
  line's height at a burn's speed, is where the one failure was. And a hop whose last 44 blocks hold a right-angle bend in
  a passage 9 wide is refused (the unit test's first geometry): the body flies them on the last burn's speed alone.
- **A hop has a least length** (48 blocks) and a place for its last rocket because nothing shortens a burn. Legs under
  that are walked; a rocket that could be cut short (the slot switch of the catalogue, unmeasured) would fly them.
- **The start under 2 of air** (cave_9): no line. A walk of a few cells to a place with 3 of air is not looked for.
- **The shortcut.** Not taken: its last piece is a slot one to three cells wide, and a touchdown by the pit's bottom ends
  in its water. A flight down the pit from above (a way in that ends in a climb) is neither a way in nor a hop here.
- **A way in is refused where the cruise cannot come down to it** (`DRAW_IN_AIM_OVER`): the ground within 6 blocks of the
  lead-in sets the cruise's height (`entryAim`), and a cliff beside it leaves the body 60 and more over the line's start
  with no room for a circle. The replica has such a cliff (its shell's wall at the box's edge, beside the
  mouth); the fixture's own ground there is a hillside. Other headings out of that mouth run along the hillside within
  3 blocks of the window and their proofs' states start on it: no line on the replica.
- **The way in's heading is the ground's choice, not the flight's.** A flight that comes from the other side flies
  round to the lead-in as it does for a recorded one.
- **The hop is asked by `!goto`** (the automatic flight), and again by a watched walk as it gets on. `!fly <waypoint>` and
  the corridor trips do not ask it. The asking again has not been seen to find a hop on a server: on the replica the
  walk from cave_start never came to a place one is proven from in the ten minutes the run had.
- **With `flyCaveHop` on any two places under one roof more than 48 blocks apart may be flown between**: a base, a hall.
  It flies only what its proof cleared. Every such walk first asks for a hop, and a watched walk asks again every
  `flyRecheckBlocks`: a flood of up to 150 000 cells in one piece (0.1 to 1.3 s) each time.
- **A way out from where the walk after an entry ended** is refused when that is 0.3 from the cell's centre (4 of 10
  round trips on this replica, 1 of 7 on the base's code; "On the server"): recorded takes and drawn lines alike, and
  the trip walks out, a minute slower. A step to the cell's centre, or to where a take left the ground, before the
  proof is not built.
- **The decision's times are the PC's**; the test host's are an estimate from a synthetic cave (the fixture does not go
  there). A hop's flood and lines are not sliced: the body stands while they run (0.9 s for the long line).
- **A drawn way in is drawn in the air**: its flood yields every 1 500 cells; drawing one line (10 to 30 ms) does not.
- **Duplication left.** The probes' world set-up is in `cave-probe-world.ts` for the new probe; the three older probes
  keep their own copies. The new unit tests have their own rig, as the drawn and the learned ones.

## What the Realm showed (Track F9e, round 2)

Flight v2, Track F9e round 2, [decisions/0082](decisions/0082-drawn-entries-and-hops.md) (the addendum). Round 1 was
deployed and flown on the Realm (2026-11-11). The drawn way in flew 3 of 3 (48 to 50 s, no damage) and cave_start's drawn
way out still flew; the drawn way out of the deep cave found no way, the hop from cave_start found none, and five hop
flights from cave_end's side lost their line under the roof and cost 2.8 to 5.7 health each. Two numbers of round 1 (18
of 19 ways out; cave_start to cave_end) were not what the bot did. This round is what was wrong and what changed.

### What the cell 116 blocks along was: a corner the proof knew, and a rocket that burned ten ticks longer than the model

The line was not lost on a cell the cache did not have. Where the first flight was stopped, the server's body stood
flat against the corner of the passage, at a block both exports of the world cache have as a solid (the one of before
the series and the one of after it differ in 399 of 9.8 million cells, none of them near any of the places a flight was
lost). The place was inside the live model when the hop was decided: the flood of the way out from cave_end counted
12 650 cells on the Realm, which on the fixture is every cell within the flood's own 128 blocks, so the live model
reached nine chunks or more (the bot asks for ten), and the corner lies well inside that.
The proof flew the line past that corner with its berth.

What the log shows at every loss is a body that was not where the model had it. The server's correction just before
moved the model's body 1.1 to 1.3 blocks; six ticks later the two were 3.8 to 7.8 blocks apart, the server's body
stopped. In the flights that arrived the same pairs of corrections are there (up to 6.1 blocks), and twice the server's
body stood still in mid air with no wall near it and no damage, 22 ticks after a rocket: the follower asked for its
next rocket for `the body at 0.24 a tick` and `at 0.10 a tick`.

**The cause is the rocket.** Every burn this project had measured (Track F0: 9 to 21 ticks, n 175) was of the rocket
the script API gives the test kit, which has no flight duration. A rocket a player crafts has flight duration 1 and
burns ten ticks longer:

| | burn (ticks) | where from |
|---|---|---|
| the script API's rocket (no flight duration) | 9 to 21 | Track F0, BDS, n 175 |
| a crafted rocket (paper and one gunpowder, flight duration 1) | 21 to 30 measured, mean 25.6 (n 55); taken as 19 to 31 | BDS (bds-fly2), `FLY_ENV=burn FLY_ROCKETS=crafted`, this round |
| the owner's own recorded takeoffs out of the cave | a rocket's speed (1.55 to 1.7 a tick) held for 22 to 33 ticks in 7 of 7 | the recordings' positions |
| the bot on the Realm | cave_start's way out on 1 rocket in 5 of 5 flights, where the replica's plain rockets need 2 | the Realm's logs |

The input loop boosts until the rocket's removal, but at most `GLIDE.boostMaxTicks` (22): with a crafted rocket the
model's burn ended at 22 ticks and the server's body flew on its rocket for up to ten more. Under a burn the velocity
follows the look; without one a glide turns slowly: in a passage that bends the two bodies part by a block every few
ticks, and the follower steers the one that is not there. And round 1's speed tap (a tick of looking straight back when
no rocket burns and the body is over its line's speed) was flown while the server's rocket still burned: under a burn
that look takes all of the speed, not a fifth: the stops in mid air.

**Reproduced on the replica**, the hop cave_8 to cave_end (323 blocks) with crafted rockets, 5 runs a side:

| | flown whole, standing by the goal | lost the line | damage | seconds |
|---|---|---|---|---|
| plain rockets, round 1 (its replica table) | 5 of 5 (0.1 to 0.6 from it) | 0 | 0 | 15.9 to 17.0 |
| crafted rockets, the bot taking them for plain ones (`FLY_CAVE_PLAIN_BURN=1`: round 1's behaviour) | **0 of 5**: two ended 5.7 and 6.0 from the goal, three lost the line (`no look clears the solid ahead 163 blocks along the line (braked to 0.17 a tick)`, `ended (lost)`), two of those not there in 120 s | 3 | 4.2, 3, 2 in three runs | 11.5 to 33.7 |
| crafted rockets, the kit's burn (this round), two series | **8 of 10** (0.1 to 0.8 from it), 4 rockets where the plain ones take 6 | 2: off the line 46 and 54 blocks along it in the first burn's climb, braked, down with no hit; the trip went on (a second hop; the walk) | 0 in the flights; 1.3 on one walk through water | 16.4 to 17.7; the two others 51.6 and 57.9 |

Every run of the middle row has `rocket 2 asked for 37 blocks along it, 28 ticks off the ground (the body at 0.24 a
tick ...)`: the Realm's own line.

### The burn of the rockets at hand (`skills/fly/burn.ts`)

- **The item's flight duration is read** (`world/index.ts`: the NBT's `Fireworks.Flight`, `ItemStack.flight`).
  `burnRange(flight)`: 9 to 21 and ten more a step; `burnOfHotbar`: from the shortest burn of any rocket in the hotbar
  to the longest.
- **The model's burn** (`rocket.ts`): the loop's boost runs until the rocket's removal, at most the longest burn of the
  rocket used and a tick (32 for a crafted one), not 22.
- **A line carries its burn** (`Guide.burn`): the recorded, the drawn and the hop lines of a takeoff are made with the
  kit's burn (`commands-fly.ts kitBurn`, `route/takeoff.ts`), and the follower's looks (the burn ending as early and as
  late as it can), the roll (the nominal burn) and the proofs (`glide.ts routeTakeoff`, `routeHop`: the nominal burn,
  every burn of the range, the two mixes, the three after a first rocket that fires nothing: 18 or 19 simulations as
  before) all fly that range. For the plain rocket the numbers and the order are what they were.
- **A hop's last rocket** (`hop.ts hopLast`): 73 to 61 blocks before the touchdown for a crafted rocket (its longest
  burn is 52 blocks of flight) where the plain one has 56 to 44; a line under 65 blocks is walked (48).
- The decision's line says it: `rockets that burn 19 to 31 (flight duration 1) ticks`.

What is NOT changed: the flight in the open (the climb, the cruise, the landings) and the route tracker's plans
(`route/types.ts BURN`) still think in 9 to 21. In the open a longer burn is height and speed to spare; a planned route
landing or takeoff through a narrow place with crafted rockets is flown on a model ten ticks short (the open points).

### As the bot runs (`learn/under.ts`, `scripts/cave-under-probe.ts`)

Round 1's probes ran on the whole fixture with a radius of their own; the bot ran on its live model with the world
cache behind it, with its own radius and caps. Now the decisions of a flight under a roof are one module
(`learn/under.ts`: `pickHop`, `pickExitPiece`) that `commands-fly.ts` and the probe both call, and the probe's world is
the bot's two layers: the fixture is the world CACHE (a chunk it never saw and everything beside its box unknown), the
LIVE model is the chunks within `--live` chunks of the body (9: what the Realm's flood sizes bound; a body that has just
arrived had 3), and `--cold` has nothing live at the first decision. The fixture is the wide one (the old box grown 160
blocks each way: the box's edge is no longer the cave's). A trip is flown to its end: a decision, the proven line at
every burn of the kit, the body stood where the nominal flight stood, the live model moved there, the next decision.
Every number below is from that probe with crafted rockets (19 to 31), on the PC.

### No rocket into cells never seen live: pieces

The rule: **a line is drawn, proven and flown only through cells of the live model**; an unknown cell is a solid for the
proof's body and for the follower alike. The cache says where the way goes on. The way is looked for once, on what was
ever seen (the live model, the cache behind it); where it lies in the live model it is flown whole; where it leaves the
live model the flight is a PIECE of it: a hop to a floor under the way, `UNDER_STOP` (12) cells short of the first cell
the live model does not have, proven from standing to standing like any hop. The body stands, the chunks ahead are
sent, and the trip asks again at once from where it stands (`runAuto`, at most `PIECES_MAX` 12): hops, standing in
between, by need.

Why this and not a confirmation running ahead of the body with a set-down where it fails: a piece needs no new way of
flying and no stopping distance (it ends in a touchdown that was proven, by the flier that lands every hop); a set-down
"where the line was last confirmed" has no floor under it for the 200 cells of this cave's way that run over water; and
nothing has to be confirmed in the air, because nothing was proven on the cache. What it costs is the standing: 0.9 to
2.3 s of deciding a piece. A cell that only the live model has (a block placed since the cache saw the place) is in the
way's own search when it is inside the live model, and is seen by the next decision when it is beyond it.

- A piece's touchdown (`standNear`): a floor (three of the four cells beside it standable), dry (no water within 2),
  up to 10 under the way's cell and 2 beside it, free air between.
- A body that has just arrived (a teleport, a respawn, a reconnect) has no chunks: a decision under a roof first waits
  for the live model 5 chunks each way round the body, at most 3 s (`commands-fly.ts liveRound`), and says so.
- The proof's world for a hop is the live model alone now (round 1: the cache's solids where the live model had
  nothing).

**The block the live layer alone has** (`--hop cave_end,cave_start --block n`: a 3 x 3 x 3 lump set in the live layer
on the cache's way, n cells along it): at 20 (inside the first burn), 116 (the Realm's place), 200 (a bend, beyond the
first decision's live model) and 440 (before the last flier's place): the trip arrives every time, in 4 pieces, every
flight at 13 burns standing within 2 of its cell, 0 hits over 0.15 a tick; the lines go round the lump. A lump across a
whole passage is no way (the unit test).

### The hop's flood (`draw.ts floodTo`)

From cave_start the flood ended at its cap (150 001 cells) on the Realm with no way found, and the wide fixture does the
same (150 004). The cause: for the search to a cell, "under a roof" meant any solid over the cell, and on the real
ground round the mouth every cell under a tree was that: the search ran across the forest floor. A roof is a thick one
now (`DRAW_ROOF_THICK`: 8 solid cells or more over the cell): cave_start to cave_end is found in 50 529 cells and 0.35
to 0.6 s. The cap stays 150 000 cells (3.3 s on the PC when it is reached). An aim weight (`aim`) is there for the probe
and changes little (142 000 cells at 3): not used.

**cave_start to cave_end and back** (warm; the wide fixture; crafted rockets):

| | pieces | blocks flown | flight | deciding in all | every flight at 13 burns |
|---|---|---|---|---|---|
| cave_start to cave_end | 3 (91, 131 and 337 blocks of line) | 559 | 22.9 to 24.4 s | 4.2 s (0.9, 1.0, 2.3) | standing within 2 of its cell, 0 hard hits |
| cave_end to cave_start | 4 (137, 213, 126, 91) | 567 | 22.2 to 26.0 s | 4.7 s (1.1, 1.7, 1.0, 0.8) | the same |
| either, cold (nothing live) | 0 | | | 0.3 s | the way is found on the cache (466 and 464 cells) and nothing is flown: `the live model ends 0 cells along a way of 466`. The bot waits up to 3 s for its chunks before it decides |

One line of 548 blocks (round 1's headline) is flown only where the whole way lies in the live model, which the nine
chunks round cave_start do not hold.

**Every pair of the route** (`--pairs cave --skip 1,2,4`, one decision each; a crafted rocket's least line is 65
blocks): each waypoint to the next 0 of 22 (17 too short: 13 to 49 blocks; 4 with no place to stand at the start; 1
under 2 of air); to the next but one 2 of 21 (cave_start to cave_2, 78 blocks; cave_2 to cave_4, 67; 14 too short: 27 to
64); to the one four on 11 of 19 (72 to 131 blocks, 3.4 to 7.7 s; 1 not proven, 2 with no cell to stand in by the
goal). 13 of 62, where round 1's plain rockets had 21.

### The way out of the deep cave

The Realm's flood stopped at `DRAW_RADIUS` (128 blocks) with every cell of the live model looked at; cave_end's way out
is 413 blocks of line. Now the drawn way out is looked for as far as `EXIT_RADIUS` (448) through up to 150 000 cells, on
the live grid as before (so its reach is the live model's); and where the live model holds no way out, the way on the
cache is flown in pieces (`pickExitPiece`, in `autoFly` when the takeoff is refused under a roof, with `flyCaveExit`).

**As the bot, warm, the wide fixture, crafted rockets** (`--exit all`): the 19 roofed waypoints a body can stand at:

| waypoint | how | open sky after (flight) | deciding in all |
|---|---|---|---|
| cave_1, cave_3, cave_start, cave_shortcut | the drawn way out | 0.8 to 2.5 s | 0.3 to 0.7 s |
| cave_8, cave_10 | the drawn way out | 3.4 to 6.0 s | 1.2 to 1.5 s |
| cave_11 to cave_16 | one piece, then the drawn way out | 7.2 to 12.0 s | 1.9 to 2.8 s |
| cave_17 to cave_20 | the drawn way out | 11.3 to 15.3 s | 2.7 to 4.1 s |
| cave_21, cave_end | two pieces, then the drawn way out | 15.8 to 18.6 s | 3.8 s |
| cave_9 | none: 2 of air over the start | | |

**18 of 19 out, every flight of every piece at 13 burns clean** (round 1's table: 18 of 19 on the whole fixture at
radius 400 with plain rockets). No single decision took over 2.3 s; the longest sum is 4.1 s. A decision that runs
longer than the 6 s budget begins no further proof and the trip walks, as before. **Cold** (cave_start, cave_end,
cave_10): no way out is flown with nothing live (0.04 to 0.14 s); the bot waits up to 3 s for its chunks first.

### The trip after `no hop` (out, 60 degrees round, into the hillside) and two words

The Realm's trip from cave_start to cave_end with no hop found flew the ordinary way: the route takeoff along the drawn
way out, then the climb curving to a near goal, and took 4.3 and 6.8 damage right after the exit
in two of three runs. That is `autoFly` for a goal over `flyMin` with a route takeoff, which the commit before this
track has line for line (`commands-fly.ts autoFly`, `routeTakeoffFor`; `brain.ts` the climb's curve): this track changed
which line leaves the cave, not what follows it. Its proof flew that curve at burns of 9 to 21; the Realm's rocket
burned 19 to 31, so the body came out of the exit faster and turned under a burn the proof never flew. With the kit's
burn the proof flies the real one. Not built: the cheap rules (hold the exit's line until the body is over the terrain;
or no flight at all for a goal under a roof that near when no hop is proven): with a hop or a piece found, the trip
does not take that way; where none is found it still does (the open points).

The wait's line and the landed line of a drawn entry said `learned entry`: they say `drawn entry` now
(`process/fly.ts`, `controller.ts`, the entry's stats carry the word).

### On the server (the replica, bds-fly2; 2026-11-11)

`FLY_ROCKETS=crafted`: the kit's rockets are crafted by the bot (paper and gunpowder), as a player's are;
`FLY_CAVE_PLAIN_BURN=1`: the bot takes them for plain ones all the same; `FLY_CAVE_OUT_FROM=<waypoint>`: the trip out
begins there.

| | runs | arrived | seconds | what flew | damage |
|---|---|---|---|---|---|
| **crafted rockets**, cave_8 to cave_end, `flyCaveHop` on (the table above: two series) | 10 | 10 | 16.4 to 17.7 (8 runs); 51.6, 57.9 | 8 flown whole on 4 rockets, standing 0.1 to 0.8 from the goal, the decision 2.1 to 3.1 s; 2 left the line in the first burn, came down with no hit and went on (a second hop; the walk) | 0; 1.3 on one walk |
| crafted, cave_start to cave_3 | 3 | 3 | 7.6, 9.9, 7.6 | one flight of 92 blocks on 1 rocket (2 with plain ones), standing 0.3, 3.3 and 0.5 from the goal (the second stood in the water beside it) | 0 |
| crafted, tripOut, `FLY_CAVE_EXIT=1`, no recordings | 3 | 3 | 63.4, 65.9, 66.4 | the drawn way out from cave_start, 5 rockets a trip | 0 |
| crafted, tripOut from cave_end and from cave_10 | 2 and 2 | 0 and 1 (107.7 s) | 420 s allowed | **the replica's box holds no way out from either**: `0 drawn ways out ...; no way under the roof to the open sky (..., within 448)` and `fly: way out: ... no way under the roof to the open sky in the world cache either`: the server's water closes the pit's bottom where the fixture has air over its water cells. The trips walked; twice the flight after a vertical takeoff came down on the box's rim after 90 ticks and the walk fell down the replica's cliff (the box stands 230 blocks over its flat world) | a death in 2 of the 4 runs (falls on the walk), 3.4 in a third |
| **plain rockets**, cave_8 to cave_end, `flyCaveHop` on | 3 | 3 | 16.2, 16.6, 17.0 | one flight on 6 rockets, standing 0.0 to 0.9 from the goal (round 1: 15.9 to 17.0) | 0 |
| plain, tripOut, `FLY_CAVE_EXIT=1`, no recordings | 3 | 3 | 64.3, 65.2, 65.4 | the drawn way out (round 1: 58.6 to 66.6) | 0 |
| plain, trip C, `FLY_CAVE_LEARNED FLY_CAVE_ENTRY=1` | 3 | 3 | 45.1, 45.2, 45.6 | the recorded entry, no go-around (round 1: 43.6 to 47.0) | 0 |
| plain, the round trip, `FLY_CAVE_LEARNED FLY_CAVE_ENTRY=1 FLY_CAVE_EXIT=1` | 3 | in 3, out 3 | in 45.0, 45.6, 46.7; out 59.9, 60.5, 63.1 | in: the recorded entry; out: twice the recorded line, once the drawn one; none on foot | 0 |

Not on a server: the pieces (the replica's box holds no trip that needs one: its water cuts the long ways) and the wait
for the live model. Both are the probe's results above.

### The regressions

**Against round 1's code** (d6ea5fed's `bot/src` and `bot/scripts` beside this tree's, the same flights on both with
the plain rocket, the old probes on the fixture of 2026-11-11, the outputs compared with the milliseconds taken out):
the route landings (the stacked platforms to the hand-over at 169 pairs of burns; 9 whole flights of the room 300 out),
the learned exit from cave_start (its proof and 13 burns), the learned entry's cases, **the drawn exit from cave_start
(its proof and 13 burns), the drawn exits from cave_end and cave_10 at radius 400, and the drawn entry's 30 arrivals:
the same output on both, in all seven.** The two hops (cave_8 to cave_end, cave_start to cave_end; proof and 13 burns):
the same line and the same flights; one number differs, the cells the flood looked at (65 389 before, 50 503 now: the
thick roof). What changes for the bot with plain rockets and no new setting: a drawn way out is looked for 448 blocks far
(cave_start's is the nearest and the same; the deep ones are found now); a hop is drawn and proven on the live model
alone, in pieces where the way leaves it; a decision under a roof waits for the live model of a body that has just
arrived. With crafted rockets every line under a roof is made, proven and flown with their burn.

The final code, each gate alone, by its exit code (the PC, 2026-11-11; plain rockets, as the gates fly):

| suite | result |
|---|---|
| fly-route-land (bds-fly3) | 6 runs in a row, exit 0 six times (7 of 7 each, 450 to 506 s a run) |
| fly-route (bds-fly3) | exit 0 (3 of 3) |
| fly-walk (bds-fly2) | 4 runs, exit 0 four times |
| fly-cave trip C with the recordings, the round trip, tripOut along the drawn line | exit 0 each; the table above (trip C 3 of 3, the round trip in 3 and out 3 flown, tripOut 3 of 3) |
| `pnpm lint` (the PC) | exit 0 |
| the unit suite on the test host (`node scripts/mac-run.mjs --name f9e -- pnpm -r test`) | three in a row on this round's code: exit 0, 0, 0 (2 539 passed, 1 skipped, 83 to 85 s); and three more in a row after this page's last edit for the hand-back |

### What the Realm should show

Everything below with the live kit's rockets (crafted: every decision's line names them: `rockets that burn 19 to 31
(flight duration 1) ticks`; a line without those words means the hotbar's rockets carry no flight duration).

`!test goto home from cave_end 3` (`flyCave on`, `flyCaveExit on`):

- at each start `fly: route takeoff: rockets that burn 19 to 31 ...; 0 drawn ways out (a flood of about 17 000 cells
  under the roof, 0 to the open sky ...); no way under the roof to the open sky (..., within 448)` and then `fly: way
  out: about 34 800 cells looked at in about 250 ms; hop 1 (...) -> a piece of it: N blocks of line to a cell N of 350
  cells along it (the way out: the live model ends N cells along its 350); the trip asks again from there`; or, where
  the Realm's live model reaches ten chunks, the drawn way out at once (`6 drawn ways out (a flood of about 33 000
  cells ...)`);
- one or two flights of 5 to 9 s that end `landed` standing under the roof (`flight: hop: ...`, `drawn entry: standing
  ...`), each followed at once by the next decision; then `-> out along the drawn line drawn N` and the flight home;
- 16 to 19 s of flight to open sky and about 4 s of deciding before the flight home: 75 to 90 s a run;
- no `flight: ended (roof)`; a `lost after N ticks` means a body off its line again: say the ticks and the place.

`!test goto cave_end from cave_start 3` and `!test goto cave_start from cave_end 3` (`flyCaveHop on`, `autoFly on`):

- `fly: hop: to cave_end under the roof (rockets that burn 19 to 31 ...): about 50 500 cells looked at in about 400
  ms; hop 1 (...): standing within N of the goal at burns of 25, 19, 31, 22, 28, ... -> a piece: 91 blocks of line to a
  cell 78 of 466 cells along the way (the live model ends 180 cells along a way of 466); the trip asks again from
  there`; then a second piece (about 130 blocks), then `-> along the drawn line hop 1 to the touchdown 0 0 0 from the
  goal's cell` (about 340 blocks); the other way four flights (about 140, 210, 125 and 90 blocks);
- no flood at its cap (`150001 cells`), no flight out over the top;
- 22 to 26 s of flight and 4 to 5 s of deciding: 30 to 35 s a run, damage 0;
- on the replica 2 of 10 crafted flights of one hop left their line in the first burn's climb, braked and came down
  with no hit: a `lost after about 46 ticks (N off the line ...)` and a second hop from where it stood is that.

`!test goto home from cave_start 3` with a cold start (the body teleported in just before):

- `fly: the live model round the body was not loaded (N of 121 chunks missing): waited N ms for it (0 still missing)`,
  then the route takeoff's line with `12 drawn ways out (... 2 to the open sky ...)` as on a warm start, the same
  flight, about 57 s a run. `(N still missing)` after 3 000 ms and `0 drawn ways out` again would mean the Realm sends
  the chunks slower than that: say the numbers.

The live settings: `flyCave on`, `flyCaveExit on` (so today), `flyCaveHop on` for the two hop series; nothing new.

### Unit tests (`fly-under.test.ts`, a synthetic tunnel)

The burn by flight duration, the hotbar's range, the proof's burns (the plain rocket's as they were), the last rocket's
place for a crafted rocket. A hop decided on two layers: the whole way in the live model (one hop, proven at 25, 19, 31
...); the live model ending on the way (a piece: standing short of its end, every point of its line in the live model,
flown at 19 and 31 to standing with no hit; then the rest as one hop once the chunks are there); no live model (nothing
flown, the line says where it ends); a block only the live model has (across the passage: no way; beside it: the line
goes round, through no cell of it); where the live model ends and the floor under the way. The flood to a cell with a
canopy 200 by 200 beside the cave's mouth: found in under 30 000 cells.

### Open points (Track F9e round 2)

- **Nothing of this round has flown on the Realm.** The burn's range for a crafted rocket is 21 to 30 measured on BDS
  (n 55) and taken as 19 to 31; flight durations 2 and 3 are taken as ten ticks more a step and were not measured.
- **Two of ten crafted flights of the 323-block hop left their line in the first burn's climb on the replica** (46 and
  54 blocks along it, 4.6 and 5.6 off it), where the proof's thirteen burns keep within 2. Braked and down with no hit.
  Not understood: the simulation's follower knows a burn's end two ticks late, the real one three ticks and the round
  trip late.
- **The rest of the flight stack thinks in 9 to 21**: the climb, the cruise and the route tracker's plans
  (`route/types.ts BURN`, read-only for this track). A route landing or a searched route takeoff with crafted rockets
  is planned and proven on burns ten ticks short. The gates fly the plain rocket (`FLY_ROCKETS=crafted` flies a
  player's).
- **The live model's reach is modelled** as the chunks within nine of the body. The Realm's number is nine or more.
- **A piece ends on a floor.** Over the flooded stretch of this cave a piece has none for 200 cells of the way; with
  the live model under nine chunks wide the trip would stop before it and walk.
- **The trip after no hop** still flies out and over to a near goal under a roof (above).
- **The inventory model has a crafted item without its NBT** until the server sends the slot again (the craft's own
  answer carries none): the bot would take rockets it crafted itself for plain ones until then. The owner's come out of
  boxes, with their NBT.
- **A way out from where the walk after an entry ended** (round 1's open point) is as it was.
- Round 1's `HOP_TRIES` and `HOP_BUDGET_MS` (`commands-fly.ts`) are `learn/under.ts UNDER_PROOFS` and
  `UNDER_BUDGET_MS` now (3 lines proven at most, no proof begun after 6 s).

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

## Learned paths

`!learn <name> [player]` records a flight the owner flies while the bot watches (skills/fly/learn/recorder.ts,
chat/commands-learn.ts). The bot keeps what the server sends it about that player: the position and look (move_player,
about 20 a second), on-ground, and the rockets that appear next to them. The recording ends by itself 8 s after the
player has flown and then stands still on the ground, at `!learn stop`, or after 10 minutes. `!learn list`,
`!learn show <name>` and `!learn delete <name>` manage the saved paths.

- **Where the paths live:** `<config dir>/paths/<name>.json` (`BEDROCKBOT_PATHS_DIR` overrides). They hold the owner's
  coordinates, so they never go into the repository.
- **What the bot can see:** only players in the chunks around it. Stand the bot near the hard part of the path (a cave
  mouth, a narrow gap) before flying it: with the bot op'd, `/tp <bot> <you>`. A stretch flown out of view is recorded
  as a gap and shown in the summary line.
- **What a path is for:** a demonstration of a line that works, not a script to replay to the block. The flight
  planner uses a path near its own route as a guide (a reference to steer along, the entry of a cave, where a rocket
  was fired); the planner and the tracker still decide every tick.
- **Heights:** a sample's `y` is the eye position less 1.62 (the standing eye height). A gliding body sits lower, so
  heights in the air are approximate.
