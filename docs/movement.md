# Movement: input loop and physics (`bot/src/skills/input`)

PLAN.md section 4.3 and Phase 3, tasks 3.1 (input loop) and 3.2 (physics spike, decision in
[decisions/0003-physics.md](decisions/0003-physics.md)). BDS 1.26.51 moves players
server-authoritatively with rewind: the client sends one `player_auth_input` per tick with its input
flags and predicted position, the server simulates the same inputs, and when the results differ it
sends `correct_player_move_prediction`. The input loop is the bot's half of that contract.

```ts
import { InputLoop, flatWorld } from './skills/input/index.ts';
const loop = new InputLoop(conn, { world: { solidAt: (x, y, z) => world.blockAt({ x, y, z })?.solid } });
loop.start();                                  // before conn.connect(), so the spawn is seen
await conn.connect(target);
loop.setCommand({ forward: 1, yaw: 90 });      // held until changed
await loop.waitTicks(40);
loop.release();                                // all keys up, keeps yaw/pitch
loop.state;                                    // { pos (feet), vel, onGround, corrections, teleports, tick, ready, ... }
loop.onEvent((e) => { if (e.kind === 'correction') replan(); });
loop.onBeforeStep((tick, state) => loop.setCommand(controller(state)));  // same-tick control (goto, lookAt)
```

Path planning and following on top of the loop (`goto`, `lookAt`) are in [pathfinding.md](pathfinding.md);
`BotSkills` points `loop.world` at the world model's real block shapes (`skills/terrain`).

## Files

| File | What |
|---|---|
| `types.ts` | `BlockQuery`, `MoveCommand`, `BodyState`, `PhysicsEngine`, `StepResult` |
| `physics.ts` | the own movement model: `stepBody` (one tick), `moveBody` (collide + auto-step), `PHYSICS` constants, `ownEngine` |
| `flags.ts` | `buildInputFlags` (the `input_data` flag set), `buildAuthInput` (the whole packet), `viewDirection` |
| `history.ts` | `applyCorrection` (rewind + replay), `applyTeleport`, `applyMotion` (knockback), packet to server-state conversion |
| `sprint.ts` | BDS's own sprint rules: sticky sprint and the forward double tap (`stepSprint`) |
| `inputLoop.ts` | `InputLoop`: the per-tick driver on top of `Connection.onTick` |
| `world.ts` | `flatWorld()` and `withBoxes()`: BlockQueries for terrain known by construction (tests, spike courses) |

## Inputs

`MoveCommand` = `{ forward, strafe, yaw, pitch, jump, sneak, sprint }`:

- `forward`, `strafe` in -1..1; `strafe` +1 is to the right. They become the wire `move_vector`
  (x = left - right, z = forward - back), normalized when longer than 1 and scaled by 0.3 while
  sneaking; `raw_move_vector` carries the key signs.
- `yaw`, `pitch` in Bedrock degrees: yaw 0 = +z (south), 90 = -x (west), -90 = +x (east),
  180 = -z; pitch +90 = down. Sent as `yaw`, `head_yaw`, `interact_rotation {x: pitch, z: yaw}` and
  the `camera_orientation` unit vector.
- `jump`, `sneak`, `sprint`: keys held. The body jumps when it is on the ground and the 10-tick
  cooldown of a held key has run out; sprinting needs `forward > 0` and no sneak.
- **BDS sprint rules** (`sprint.ts`, measured by bedboo on BDS 1.26.51.1, confirmed by the nav e2e):
  a sprint is sticky: once sprinting (sprint key with forward), BDS keeps the sprint speed while
  forward is held, also after the key is released and `stop_sprinting` is sent; it ends when forward
  is released, on sneak, when the body hit a wall on the previous tick, or when sprinting is not
  possible (`InputLoopOptions.canSprint`, e.g. food <= 6). A forward re-press within 6 ticks of the
  previous press (press to press) starts a sprint by itself. The loop simulates the effective sprint
  (and stores it in the history), while the flags report the raw keys plus `sprinting`. Without
  this, a bot that "stops sprinting" with forward still held is corrected (server faster).

`BlockQuery.solidAt(x, y, z)` answers "is this block a full solid cube?" (`undefined` = unknown).
Optional, all three provided by `skills/terrain`'s `blockQueryOf()`:

- `boxesAt(x, y, z)`: the block's collision boxes (block-local; fences and walls reach 1.5), from
  minecraft-data's `blockCollisionShapes`. When present it replaces `solidAt` for collisions, and the
  layer below the swept region is included for blocks taller than 1.
- `frictionAt(x, y, z)`: slipperiness of the block at `floor(feet.y - 0.5)` (air or unknown: 0.6),
  used for ground inertia `friction x 0.91` and acceleration `speed x 0.16277136 / inertia^3`.
- `liquidAt(x, y, z)`: `{ liquid, height }` (source 8/9, falling 1) or `null`.

When any block around the body is unknown the loop does not simulate: it sends an idle input (no
move vector, no movement flags) at the current position.

## Packet (`player_auth_input`, minecraft-data 1.26.51)

| Field | Value |
|---|---|
| `position` | eye = feet + 1.62 (also while sneaking) |
| `delta` | velocity at the END of the tick (standing still: `(0, -0.0784, 0)`) |
| `tick` | the Connection driver's tick (BigInt, 1 after each spawn); the server echoes it in corrections |
| `input_data` | array of flag names, see below |
| `input_mode` / `play_mode` / `interaction_model` | `mouse` / `normal` / `crosshair` |
| `analogue_move_vector` | `(0, 0)` |

Flags (`buildInputFlags`): level flags every tick the state holds, edge flags on the tick it changes.

| State | Level flags | Edge flags |
|---|---|---|
| move keys | `up` / `down` / `left` / `right` | |
| jump key | `jump_down`, `jumping`, `want_up`, `jump_current_raw` | `jump_pressed_raw`, `jump_released_raw` |
| jump performed | | `start_jumping` (the tick the body leaves the ground) |
| sprint key / sprinting | `sprint_down` / `sprinting` | `start_sprinting`, `stop_sprinting` |
| sneak key / sneaking | `sneak_down`, `want_down`, `sneak_current_raw` / `sneaking` | `sneak_pressed_raw`, `sneak_released_raw`, `start_sneaking`, `stop_sneaking` |
| collisions | `vertical_collision` (also every tick resting on the ground), `horizontal_collision` | |
| teleport | | `handled_teleport` (first input after a `move_player` teleport / reset) |

## Movement model (`stepBody`)

One tick, in this order (vanilla order; bedboo's recorded BDS traces confirm it for Bedrock):

1. Velocity is zeroed when `|v|^2 < 1e-12`.
2. Jump key: cooldown counts down while held, resets on release.
3. Acceleration and friction from the PREVIOUS tick's ground state: on the ground inertia
   `0.6 * 0.91 = 0.546` and acceleration `speed * 0.16277136 / inertia^3` (= speed: 0.1, x 1.3
   sprinting); in the air inertia 0.91 and acceleration 0.02 (0.026 sprinting).
4. Move impulse: move vector x 0.98 x acceleration, rotated by the yaw (float32 degrees, precise
   sin/cos). Walking: `v += 0.098` per tick, terminal speed `0.098 / (1 - 0.546) = 0.2159` blocks/tick.
5. Jump: `vy = max(vy, 0.42)`; sprint-jump adds 0.2 along the yaw; cooldown 10.
6. Collide the 0.6 x 1.8 box (1.49 sneaking) with the solid cubes: Y, then X, then Z; contact
   tolerance 1e-4. If a horizontal axis was blocked while on the ground (or landing this tick),
   retry stepped up by at most 0.5625 and keep the move that went further horizontally.
7. Blocked axes lose their velocity; `onGround` = blocked while moving down (or resting with no
   vertical motion).
8. Gravity and drag: `vy = (vy - 0.08) * 0.98`; friction: `vx, vz *= inertia`.
9. Positions and velocities are float32.

Jump in place: apex 1.2522 blocks, back on the ground after 12 ticks.

**Auto-step under an overhang** (Track AX, 2026-10-30): `moveBody` tries a second step candidate, lifted
only as far as the box swept along the move fits under what is overhead (Java's step: the lift clipped
by `box.expandTowards(move)`), and keeps whichever goes further. From a dirt path (feet 0.0625 below
the next floor) into a 2-high doorway the full 0.5625 lift put the head into the lintel and the body
stopped at the door; with the clipped lift it steps in. bds-dig, 2026-10-30 (`test/e2e/nav-start.test.ts`):
0 corrections on that walk, twice.

**Stairs and partial blocks** (measured on BDS 1.26.60.6, 2026-10-29, docs/pathfinding.md "Stairs and
partial blocks"): the step height 0.5625 is unchanged; a stairs block is climbed from its low side by
two auto-steps of 0.5 (4.6 ticks per step on a 6-step staircase, against 9.0 for a jump onto full
blocks), with 0 corrections. Server feet heights: slab 0.5, carpet 0.0625, farmland and dirt path
0.9375, snow layers `height` n: n / 8 (one layer, height 0: no collision), stairs 0.5 on the low half
and 1 on the high half, upside-down stairs 1. On 1.26.60 stairs arrive as runtime ids the registry
does not know (the new `minecraft:corner` state); before terrain/shapes.ts resolved them the physics
saw a 1.5-high box there and the local body disagreed with the server by up to 0.77 blocks.

**Liquids** (Track AJ, 2026-10-30: water physics applies while the body box shrunk by 0.4 at the feet and the head reaches into a water cell, the liquid height ignored; above that the body moves with air physics; the climb-out lift needs the moved box free of liquid as well as of collisions; `state.inWater` now means "moving with water physics". Older measurements below): water acceleration
0.02, then after the move velocity x 0.8 on all axes and gravity 0.005 (terminal sink 0.025 per
tick), jump key +0.04 per tick, +0.3 upwards when pushing against a wall with free space 0.6 above
the moved box; lava drag 0.5 and gravity 0.02; no flow push. Measured: a body that fell 3 blocks into
2-deep still water floats 60 ticks with 0 corrections (strict mode: error 0); swimming out with jump
+ forward costs 2 to 3 corrections. `state.inWater` / `inLava` report it.

Modelled since Track AJ (docs/pathfinding.md "Movement variety", decision 0032): climbables (ladder, vine, twisting / weeping / cave vines: fall clamped to 0.2, sneak holds, jump sets vy 0.2, a wall hit sets vy 0.2 after gravity, no horizontal clamp; scaffolding does not climb), surface swimming (8.55 ticks per block) and climbing out, 1- and 2-block gap jumps with a sprint run-up, sneaking along deep edges (0.05 back-off steps, 0.025 inset; BDS keeps the sneak speed one tick after release), and a float32 contact tolerance far from the origin (2^-21 x max(|x|, |z|) on the move axis).

Not modelled yet: cobweb / powder snow / soul sand / honey speed factors, slime bounce, effects and the movement-speed attribute, flow push, underwater travel and sprint swimming, flight, gliding, riding.

## Corrections and teleports

- **History**: the last 200 inputs with the state after each.
- **`correct_player_move_prediction`** (prediction type `player`): rewind to the entry with the
  packet's tick, take the server's position (eye - 1.62), `delta` as velocity and `on_ground`, and
  re-simulate every later input. Without a matching entry the server state is adopted as is. Each
  correction increments `state.corrections`, is logged at info with the local and server position
  and the error, and emits a `correction` event. A skill should treat it as truth and re-plan.
- **`move_player`** for the own runtime id: `rotation` only updates yaw/pitch. Any other mode is a
  teleport: position adopted, velocity zero, yaw/pitch taken over, `handled_teleport` on the next
  input. `move_player.tick` is the last input the server had processed: inputs sent after it were in
  flight; the server takes the teleport state for the first of them without simulating it, so the
  loop re-simulates the rest from there. With nothing in flight the next input is sent without
  simulating.
- Observed: an input that was in flight when a teleport happened (it still carries the old position)
  gets one correction with error 0 at the teleport target. Tests count corrections only after a
  teleport has settled.
- **`set_entity_motion`** for the own runtime id (knockback, explosions): the velocity replaces the
  body's velocity after the input with the packet's `tick`, and every later input is re-simulated
  (`applyMotion`); without a matching history entry it replaces the current velocity. The ground
  state is kept: BDS's first tick after the push still uses the previous ground friction (a TNT push
  moved 0.546 x on the second tick). Emits a `motion` event, counted in `state.motions`. Measured:
  TNT next to the bot, 0 corrections (strict mode: error 0).

## Testing

- Unit (`bot/test/unit/skills/`): physics (walk curve against the verify.mjs model, turning, sprint,
  sneak, jump apex and landing, falling, ledge, walls, auto-step), flag builder, packet fields,
  correction replay and teleport handling, and the loop against a fake connection.
- Unit: also `physics-terrain.test.ts` (shapes, ice, water, sprint rules, knockback).
- e2e (`bot/test/e2e/skills-input.test.ts`): runs on `bds-move` (udp/19146, see pathfinding.md) by
  default since Phase 3.3; `BDS_E2E=1` (`BDS_E2E=1 pnpm --filter bot test:e2e`). Target overrides:
  `PHYS_BDS_HOST`, `PHYS_BDS_PORT`, `PHYS_BDS_CONTAINER` (e.g. 19144 / `bds-phys`) or `MOVE_BDS_*`;
  `PHYS_VERBOSE=1` logs every correction and teleport. The nav e2e tests (`nav-*.test.ts`) are
  described in pathfinding.md.
  The test sets the world peaceful at noon first: mobs hit and push the player, and the server-side
  knockback shows up as corrections.

The physics server (flat world, truth pack, port 19144):

```sh
docker run -d --name bds-phys -e EULA=TRUE -e VERSION=1.26.51.1 -e TRANSPORT=raknet -e ONLINE_MODE=false \
  -e ALLOW_LIST=false -e PLAYER_IDLE_TIMEOUT=0 -e ALLOW_CHEATS=true -e LEVEL_TYPE=FLAT -e LEVEL_NAME=phys \
  -e SERVER_PORT=19144 -e DEFAULT_PLAYER_PERMISSION_LEVEL=operator -p 19144:19144/udp \
  -v "<repo>/docker/data/phys:/data" itzg/minecraft-bedrock-server:2026.10.2
# pnpm 12 passes a literal `--` through to the script, so no `--` before the flags:
pnpm --filter @bedrockbot/truth-pack pack:deploy --data <repo>/docker/data/phys --world phys --restart bds-phys
```

BDS keeps a player for about 10 s after a client disconnects; reconnecting with the same name
before that is refused with `server_id_conflict`. The e2e connection enables a short reconnect
policy for quick reruns.

## Physics spike (`tools/physics-spike`)

```sh
cd tools/physics-spike
node fetch.mjs                     # bedboo at a pinned commit into .work/ (tarball, no git, no install)
node run.ts --offline              # both engines on the courses offline: trajectory divergence
node run.ts --repeat 2             # live on bds-phys: corrections, end position vs truth:pos
node run.ts --label live-strict    # same, after setting server-authoritative-movement-strict=true and
                                   # player-position-acceptance-threshold=0.001 (then restore + restart)
```

Courses (`courses.ts`, built with `truth:fill`): `flat-100`, `stairs-10`, `drop-3`, plus
`sprint-jump-diag`, `stairs-diag` and `sneak-edge` to find rules that differ. Both engines run in the
same `InputLoop`; only `loop.engine` changes. Results: `tools/physics-spike/results/*.json`.

## Gliding (Track AU, wave 11)

The elytra glide is a third mode of the body in `stepBody` (`state.gliding`), beside walking and
swimming: `cmd.glide` asks for it, the body glides from the first airborne tick on and keeps gliding
until it touches the ground or water (BDS ignores a voluntary `stop_gliding` in the air: measured on
bds-fly), and `glideVelocity` applies the vanilla fall-flying formula bit for bit in float32 (the
constants in `GLIDE`: gravity 0.08 with the lift `cos² · 0.75`, the dive term 0.1, the pull term 0.04
with 3.2 of lift, the heading alignment 0.1, the drag 0.99 / 0.98, a 0.6-high box), with the firework
boost (`v += l · 0.1 + (l · 1.5 − v) · 0.5` per tick while the rocket lives) applied inside the step
after the lift and before the drag. The flags: `start_gliding` only counts together with a jump press
(`GLIDE_START_FLAGS` in flags.ts), `stop_gliding` goes out on the tick the glide ends; the server
confirms with the own `gliding` actor flag, which the loop also uses to end a glide it still
predicted (`GlideEvent`). Measured on the strict server: level flight sinks 0.15 to 0.17 blocks a tick
at 1.3 to 1.5 blocks a tick with 0 corrections over 220 ticks, a pitched glide stays within 0.0001 of
the server, a 40-degree turn in one tick costs about 6 corrections of at most 0.004; the one real
mismatch is the rocket's life (12 to 18 ticks, the model assumes 15 and `endBoost` re-simulates when
`remove_entity` arrives), worth a correction of 0.05 to 0.35 per rocket. The flight controller, the
landing method and the measurements are in [flight.md](flight.md).

## Falls and the water bucket clutch (Track BI, wave 11)

`bot/src/skills/fall/`: the Bedrock fall damage model (`damage.ts`), what a water bucket does to each
block (`waterlog.ts`), the planner's long-fall policy (`policy.ts`, `plan.ts`; the planner side is in
[pathfinding.md](pathfinding.md) "Long falls"), the note on a refused fall (`explain.ts`) and the
`FallGuard` (`clutch.ts`), which `BotSkills` builds for every bot (`skills.falls`). Decision record:
[decisions/0049-long-falls-and-clutch.md](decisions/0049-long-falls-and-clutch.md).

```ts
skills.falls.policy();          // { hpBudget, factor, clutch, ... } or undefined (longFalls off): read before every plan
skills.falls.last;              // the last clutch: predicted HP, target, click tick and reach, placed, recovered, reason
skills.falls.stats;             // { clutches, placed, recovered, refused, waterLeft }
fallDamage(12);                 // 8 (damage.ts); fallDamage(22, 'hay_block') 2; fallDamage(12, 'stone', epfFactor(12)) 4.16
```

### The damage model (measured on BDS 1.26.60.6, bds-gaunt, truth:hurtlog)

| What | Rule | Measured |
|---|---|---|
| counted distance | the drop up to the tick BEFORE the landing tick (the landing tick's clipped move does not count); from rest the body is at D(t) = sum of (v - 0.08) x 0.98 after t ticks and lands on the first tick with D(t) >= h | 12 blocks: D(18) = 12.002 lands, D(17) = 10.807 counts |
| damage | ceil(counted x landing factor - 3) | walking off stone pillars, each height twice: 4 -> 1, 5 -> 2, 6 -> 3, 7 -> 4, 8 -> 5, 9 -> 6, 10 -> 7, 11 -> 8, **12 -> 8**, 13 -> 10, 14 -> 11, 16 -> 13, 18 -> 15, **20 -> 16**, 22 -> 19; teleported: 3.25 -> 0, 3.5 -> 1, 4.5 -> 2, 15 -> 12 (ceil(h - 3) is wrong at 12 and 20, the counted distance is right everywhere) |
| landing factor (on the distance) | hay_block 0.2, honey_block 0.5, beds 0.5 (and a bounce), water (any depth), slime, powder snow 0; slabs, leaves and every other floor 1 | hay 6 / 12 / 22 -> 0 / 0 / 2; honey 6 / 12 / 22 -> 0 / 3 / 8; bed 22 -> 8 + 1 (bounce); water, slime, powder snow 0 at 6, 12, 22; slabs and leaves like stone. Cobwebs and scaffolding gave 0 or the full damage depending on whether the tick ended inside them: counted as 1 |
| armour | no reduction from armour points; EPF = 3 x Feather Falling (boots) + the Protection levels of every worn piece, at most 20; damage x (1 - 0.04 x EPF), fractional (health is a float) | diamond boots: 5 / 8 / 19 (none); FF IV 2.6 / 4.16 / 9.88 (x 0.52); FF I x 0.88; Protection IV boots x 0.84; FF IV + P IV x 0.36; FF IV + 4 x P IV 1 / 1.6 / 3.8 (x 0.2, the cap) |
| health after | health + absorption - damage | |

Enchantments come from the item NBT (`ench`: id 0 protection, 2 feather falling; `world/inventory.ts`
`itemEnchants` -> `ItemStack.enchants`); absorption and "health known" from the attributes
(`World.self.absorption`, `healthKnown`).

### The water bucket clutch (`FallGuard`)

Every tick the body falls (not gliding, not in water), the rest of the fall is simulated with the
movement model (`loop.engine` over the live blocks, the current command) to the landing tick; the
counted fall (this fall so far, the server's way, plus the predicted ticks before the landing) gives
the damage on the landing block. It clutches only when that matters (`policy.ts shouldClutch`, review
B4): the fall would kill, leave less than `fallMargin`, or cost more than half of what is above the margin
(health + absorption - margin); never in creative or spectator; inside home's `protectRadius` and in a fight
(the combat controller busy, or something hurt the bot in the last 3 s outside a fall landing) only when the
fall would kill, so the weapon stays in hand otherwise. Nothing is armed while the fall is slowed where the
model sees no landing (review B3): a ladder or vine in the feet cell (`onClimbable`, as the physics and the server count it: a vine wall beside the fall slows nothing, review M2), a cobweb, scaffolding,
powder snow or a berry bush in the body's cells, a honey block beside it (the wall slide), Slow Falling
(`mob_effect` id 27 for the own runtime id); they also end the counted fall, as a teleport and a body that is
not ready do. When it clutches and a water bucket is in the hotbar (`clutch` setting on, not in the Nether:
`waterWorks`), and the landing block takes a clutch (`waterlog.ts` `clutchTarget`), the bucket is selected
and the view turned down; the landing is predicted again every
tick (a walk's follower lets go of forward in the air and the landing column moves) and the click goes
out on the first tick the landing block's top corner is within 6.5 of the eye (BDS accepts up to 7.19;
or within 7.14 when the landing is 2 ticks away): `item_use / click_block` on its top face, queued
before that tick's `player_auth_input`, so the server places the water before it moves the body into
it. The water is predicted in the movement model until the `update_block` shows it. Once the body is
down, the empty bucket clicks the cell holding the water (face up, only within reach: 5 to the closest
point, 7.19 to the corner) until the `update_block` shows it gone (at most 6 clicks, 5 ticks apart; 18
inside the base); the navigator's follower holds still meanwhile (`Navigator.pauseFollow`), the previous
hotbar slot and pitch come back, and the navigator's re-plans wait until 16 ticks after the pickup
(`Navigator.holdPlans`: a plan from inside the flow found no move, the cells around were flowing water).
The landed phase is bounded (review H1: 100 ticks, 300 inside the base): a bucket that never empties, a
cell out of reach or a lost update ends it, logged and counted as water left (`stats.waterLeft`), as an
unloaded water cell is. An exception in the guard or a dispose mid-clutch runs the same finish (slot,
pitch, the water counted).

Where the water goes (`waterlog.ts`, measured: the bot clicked the top face of each block, the
`update_block` packets and truth:block showed the water):

| Block clicked | Water | Breaks a fall onto it (8 and 12 blocks) |
|---|---|---|
| stone, glass, hay, dirt, any full block that takes no water | a source in the cell above | yes (0) |
| soul sand | a bubble column above | (not tried) |
| bottom slab | inside the slab (layer 1); the feet end inside its cell | yes (0) |
| top slab, stairs (either way up), fences, walls, panes, iron bars, leaves, copper grate, mangrove roots, lantern, scaffolding, ladder, campfire (put out) | inside the block (layer 1), nothing above | no: top slab 4 / 8, stairs 5 / 8, fence 5 / 8, leaves, pane, grate 5 / 8 (the full damage) |
| chest, trapdoor, standing / hanging sign | none: the click used the block (the trapdoor opened, the sign's editor) | |
| snow layer, moss carpet | washed away (flowing water in its cell, the source above) | |

So the clutch target is a full cube that is not waterloggable and not interactive, with air above it
(the source goes there), or a bottom slab (waterlogged); anything else is refused with the reason
(`skills.falls.last.reason`), and the fall is taken as it comes. Picking the water up: `click_block`
on the cell that holds it (the source, or the waterlogged slab itself), face 1, with the empty bucket.
Landings that do no damage (water, slime, powder snow, hay up to 12 blocks) are never clutched.

Measured (e2e, each case twice, all 0 fall damage, the bucket back, no water left):

| Case | Click | Landing |
|---|---|---|
| click lead time (scripted clicks, 20-block fall, 1.4 to 1.5 blocks a tick) | 1, 2 or 3 ticks before the landing (eye 3.9 / 5.4 / 6.8 from the block's corner): 0 damage each; 4 ticks (8.1): refused by the server, 16 damage | |
| planned 30-block drop (`goto`, first version, with Health Boost) | eye 5.90 from the corner, 2 ticks before the landing | 1 pickup click; the goto arrives. Since review B1 a drop beyond the budget is no longer plannable at health 20: the refused 20-block case below |
| planned 15-block drop at health 20, no Health Boost (12 HP within the budget, clutched; after review B1 / B4) | 5.72, 3 ticks before the landing | 1 pickup; the goto arrives (bds-gaunt twice x 2 runs, bds-surv twice) |
| planned 20-block drop (16 HP) with a bucket at health 20 | refused: `unreachable` with the note (`... 20-block drop (16 HP), refused: it would leave 4 HP, the margin is 8`), still on top, 0 damage | |
| reactive, walking off 20 blocks (health 20 since the review: 16 HP) | 5.37, 2 ticks | 1 pickup |
| reactive, walking off 50 blocks (about 3 blocks a tick at the end) | 6.67, 2 ticks | 1 pickup |
| reactive onto a strip of bottom slabs, 20 blocks | 5.77, 3 ticks | the slab waterlogged, 1 pickup from the slab |
| reactive onto top slabs, 12 blocks | refused (`would take the water inside`) | 8 HP, as the model says |

Tests: `test/unit/skills/fall.test.ts` (the model, the table, the policy, the planner's long drops, the
note, the clutch in a closed loop with a fake server), `test/unit/skills/nav-worker.test.ts` (long drops
in the worker), `test/e2e/fall-model.test.ts`, `fall-long.test.ts`, `fall-clutch.test.ts` on bds-gaunt
(`FALL_BDS_PORT` 19188, `FALL_BDS_CONTAINER`; or bds-surv on 19182; `FALL_OUT=<file>` appends the
summaries).
