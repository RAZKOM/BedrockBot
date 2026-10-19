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
```

## Files

| File | What |
|---|---|
| `types.ts` | `BlockQuery`, `MoveCommand`, `BodyState`, `PhysicsEngine`, `StepResult` |
| `physics.ts` | the own movement model: `stepBody` (one tick), `moveBody` (collide + auto-step), `PHYSICS` constants, `ownEngine` |
| `flags.ts` | `buildInputFlags` (the `input_data` flag set), `buildAuthInput` (the whole packet), `viewDirection` |
| `history.ts` | `applyCorrection` (rewind + replay), `applyTeleport`, packet to server-state conversion |
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

`BlockQuery.solidAt(x, y, z)` answers "is this block a full solid cube?" (`undefined` = unknown).
The model only knows full cubes so far. When any block around the body is unknown the loop does not
simulate: it sends an idle input (no move vector, no movement flags) at the current position.

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

Not modelled yet (see the decision record for the order): non-cube block shapes and per-block
friction, liquids, sneak edge avoidance, climbables, cobweb / powder snow / soul sand / honey /
slime, effects and the movement-speed attribute, knockback (`set_entity_motion`), flight, swimming,
gliding, riding.

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

## Testing

- Unit (`bot/test/unit/skills/`): physics (walk curve against the verify.mjs model, turning, sprint,
  sneak, jump apex and landing, falling, ledge, walls, auto-step), flag builder, packet fields,
  correction replay and teleport handling, and the loop against a fake connection.
- e2e (`bot/test/e2e/skills-input.test.ts`): needs `bds-phys` and `BDS_E2E=1`
  (`BDS_E2E=1 pnpm --filter bot test:e2e`). Target overrides: `PHYS_BDS_HOST`, `PHYS_BDS_PORT`
  (19144), `PHYS_BDS_CONTAINER` (`bds-phys`); `PHYS_VERBOSE=1` logs every correction and teleport.
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
