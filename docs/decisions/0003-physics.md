# 0003: Physics engine for player movement

Date: 2026-10-28. Status: accepted (PLAN.md task 3.2). Server: BDS 1.26.51.1 (`bds-phys`, flat
world, truth pack). Client: bedrock-protocol 3.60.1 through the bot's `Connection` and `InputLoop`.

## Question

PLAN.md section 2 change 3: should the bot depend on LiteLDev/bedboo's Bedrock physics (LGPL-3.0,
`packages/mineflayer-bedrock/lib/physics/*.js`, a prismarine-physics fork), port parts of it, or
keep its own engine? Done-when: the chosen engine shows 0 corrections on flat ground and at most 2
on a 1-block staircase.

## Method

- **Own engine**: `bot/src/skills/input/physics.ts` (task 3.1): ground acceleration 0.098 x move
  vector, ground inertia 0.546, gravity 0.08 with drag 0.98, air inertia 0.91 and acceleration 0.02,
  jump 0.42 with a 10-tick cooldown, sprint x1.3 (air 0.026, jump boost 0.2), AABB 0.6 x 1.8,
  auto-step 0.5625, float32, full cubes only.
- **bedboo**: commit `116859f05a4578d73646e113f15b8653697971f6` (2026-10-20), fetched as a tarball by
  `tools/physics-spike/fetch.mjs` into the git-ignored `.work/` (no git, no install, no scripts).
  `engine.js`, `input.js`, `aabb.js`, `attribute.js`, `math.js`, `index.js` and
  `lib/bedrock/constants.js` were read before loading: pure math, requiring only `vec3`.
  **Loading it standalone worked** (well under the one-hour budget): `bedboo-engine.ts` `require`s
  `physics/index.js` from `.work` and shims a 2-block registry (`blocksByName`, `blocksArray` with
  friction) and `world.getBlock(pos)` returning `{ type, shapes }` from the bot's `BlockQuery`.
- Both engines run inside the **same** `InputLoop` (same flags, ticks, eye offset, rewind/replay,
  teleport handling); only `loop.engine` is swapped, so the numbers compare the physics alone.
- Courses (`tools/physics-spike/courses.ts`), built with `truth:fill` of stone, the bot's world =
  flat ground + the same boxes:
  1. `flat-100`: walk 100 blocks +z, coast 20 ticks.
  2. `stairs-10`: 10 steps of 1 block (3 wide) plus a top platform, forward + jump held.
  3. `drop-3`: walk off a 3-high platform, walk on 4 blocks.
  4. extras to find differences: `sprint-jump-diag` (sprint + jump 80 ticks at yaw -37),
     `stairs-diag` (11-wide staircase at yaw -10 while sprint-jumping), `sneak-edge` (sneak 80
     ticks towards a 3-high edge).
- Each course x engine twice. Live metric: corrections from the start of the run until 10 ticks
  after it, and the final local position vs `truth:pos`. A second live pass on a strict server
  (`server-authoritative-movement-strict=true`, `player-position-acceptance-threshold=0.001`), where
  BDS sends its own state about every 6 ticks, measures the model error directly. Offline: both
  engines on the same scripted inputs, per-tick position divergence.

## Results

### Live, default server settings (threshold 0.5, not strict); `results/live.json`

| Course | Ticks | Own: corrections (run 1, 2) | bedboo: corrections | End vs truth (both) |
|---|---|---|---|---|
| flat-100 | 485 | 0, 0 | 0, 0 | 0.00000 |
| stairs-10 | 144 | 0, 0 | 0, 0 | 0.00000 |
| drop-3 | 67 | 0, 0 | 0, 0 | 0.00000 |
| sprint-jump-diag | 100 | 0, 0 | 0, 0 | 0.00000 |
| stairs-diag | 144 | 0, 0 | 0, 0 | 0.00000 |
| sneak-edge | 100 | 0, 0 (fell off: truth also at y -60) | 0, 0 (stopped at the edge) | 0.00000 |

### Live, strict server (threshold 0.001); `results/live-strict.json`

Corrections arrive every ~6 ticks regardless; what matters is how far our prediction was from the
server state they carry.

| Course | Corrections | With error > 0.001: own | bedboo | Max error: own | bedboo |
|---|---|---|---|---|---|
| flat-100 | 82 to 83 | 0 | 0 | 0 | 0 |
| stairs-10 | 22 | 0 | 0 | 0 | 0 |
| drop-3 | 13 | 0 | 0 | 0 | 0 |
| sprint-jump-diag | 18 | 0 | 0 | 0 | 0 |
| stairs-diag | 23 to 24 | 1 | 1 | 0.0043 | 0.0043 |
| sneak-edge | 18 to 19 | 6 to 7 | 0 | 1.19 | 0 |

`stairs-diag`: one airborne tick next to a step face, server x 0.0043 behind us, identical in both
engines (a rule neither has; harmless at the default threshold). `sneak-edge`: the own engine has
no sneak edge avoidance; the server keeps the player on the platform.

### Offline (`results/offline.json`)

Trajectories are bit-identical (divergence 0) on flat-100, stairs-10, drop-3, sprint-jump-diag and
stairs-diag; sneak-edge diverges from tick 44 (max 3.78 blocks).

### Input loop e2e (task 3.1, `bot/test/e2e/skills-input.test.ts`, default settings)

| Scenario | Corrections | Local vs truth |
|---|---|---|
| (a) idle 60 ticks | 0 | 0.00000, truth unchanged |
| spike C: walk 6 ticks | 0 | 0.00000 |
| (b) walk 100 ticks + coast 20 | 0 | 0.00000 (22.4 blocks) |
| (c) yaw 90, walk 50 + coast 20 | 0 | 0.00000 |
| (d) +3 z position jump, no flags | exactly 1 (local z 3.500 vs server 0.500, error 3.0000), state snapped back | 0.00000 |
| (e) jump in place (key held 3 ticks) | 0 | 0.00000, truth onGround after 20 ticks, apex 1.2522 |

Every teleport (`truth:tp`) while an input was in flight also produced one correction with error 0
at the target; the tests count from after the teleport.

### Observations

- BDS's default acceptance is lenient: walking off an edge while sneaking (which the vanilla client
  never does) was accepted without a correction and the server took our position. "0 corrections at
  default settings" is necessary, not sufficient; use the strict probe for model work.
- On a first run on a fresh (normal difficulty) world something hit or pushed the bot several times
  (mob type not identified): server-side knockback appears as corrections of about 1 block with an
  upward delta of 0.2255. Tests and courses now run peaceful at noon and those vanished. The
  real bot must handle knockback (`set_entity_motion`) before it meets mobs.

## Decision

**Keep the own engine and port specific bedboo rules into it (constants and formulas, with
attribution), one rule at a time, each with a course and a strict-mode check. Do not depend on
bedboo.** Use bedboo as a reference oracle in `tools/physics-spike` (offline divergence + strict
live probe) when adding rules.

Why:

- The own engine already matches the server exactly (strict-mode error 0) on everything Phase 3
  needs on solid terrain: flat walking, turning, sprinting, sprint-jumping, steps, staircases (also
  diagonal), drops. On those courses it is bit-identical to bedboo. The done-when (0 on flat, at most
  2 on the staircase) holds for both engines.
- A dependency is impractical: bedboo is not on npm; `mineflayer-bedrock` is a package inside a pnpm
  monorepo with `workspace:*` dependencies (`@bedboo/bedrock-data`), 14 pnpm patches applied by the
  workspace config, and it pulls mineflayer 4.39 and the whole prismarine stack. A git-URL dependency
  would not resolve the workspace packages or apply the patches, for 6 files of math. The engine's
  API is mineflayer-shaped (mineflayer yaw radians, `PlayerState`, `Vec3`, prismarine-block ids and
  shapes), so the bot would need the adapter anyway.
- bedboo's value is its measured special cases (block shapes and friction, liquids, sneak edges,
  climbables, cobweb, soul sand, honey, slime, effects, flight, elytra) and its recorded traces.
  Those can be ported as constants and formulas with attribution (LGPL-3.0 allows that; no bedboo
  code goes into `bot/`), in the order the bot needs them.

## Next three rules for the own engine

1. **Block collision shapes and per-block friction.** Extend `BlockQuery` to boxes per block (from
   Track B's `BlockInfo.boxes`): slabs, stairs, `dirt_path` and farmland (15/16 high), fences and
   walls (1.5 high), snow layers, carpets. Friction from the block at floor(pos - 0.5), else the
   colliding block under the box nearest its centre, else 0.6, never air's value (bedboo-measured);
   ice 0.98, blue ice 0.989, slime 0.8. Forests and villages are full of these; without them every
   path or slab edge is a correction.
2. **Liquids.** Water: gravity 0.005, drag 0.8, acceleration 0.02, flow push 0.014 per tick, jump
   key +0.04 vertical, 0.3 impulse when pushing against a wall that can be climbed out of; lava 0.02
   / 0.5. The planner will avoid water (task 3.4) but the bot must survive ending up in it.
3. **Sneak edge avoidance.** While sneaking on the ground and not moving up: shrink the box by 0.025
   on x/z, probe 1.01 x step height below, cut the motion in 0.05 steps per axis while unsupported,
   and clip the velocity itself; sneaking box 1.49 high. Measured here: 1.19 blocks of error without
   it. Needed for safe descents and for building or tree-topping from a log.

After those: climbables (ladder, vines: fall at most 0.2, jump climbs 0.2), knockback
(`set_entity_motion` with tick, re-simulating the in-flight inputs), the movement-speed attribute
and effects from `update_attributes` / `mob_effect`, then soul sand, honey, slime and cobweb.
