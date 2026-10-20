# Pathfinding and goto (`bot/src/skills/nav`, `bot/src/skills/terrain`, `bot/src/skills/index.ts`)

PLAN.md section 4.3 and Phase 3, tasks 3.3 to 3.6. Decision record:
[decisions/0005-pathfinding.md](decisions/0005-pathfinding.md). The input loop and the movement
model underneath are in [movement.md](movement.md).

```ts
import { World } from './world/index.ts';
import { InputLoop, flatWorld } from './skills/input/index.ts';
import { BotSkills } from './skills/index.ts';

const world = new World(conn);
const loop = new InputLoop(conn, { world: flatWorld() });   // BotSkills swaps in the real terrain
loop.start();
const skills = new BotSkills({ loop, world });              // before or after connect
await conn.connect(target);
await skills.goto({ type: 'block', p: { x: 30, y: -60, z: -12 } });   // feet cell
await skills.goto({ type: 'near', p: tree, r: 2.5 });
await skills.goto({ type: 'xz', x: 100, z: 40 }, { timeoutTicks: 2400, sprint: false });
await skills.lookAt({ x: 3.5, y: -58.5, z: 7.5 });
skills.cancel();                                           // the running goto resolves 'interrupted'
skills.status();   // health, food, damage (fall damage flagged), corrections, motions, inWater, lastGoto report
```

`goto` resolves `{ ok: true }` or `{ ok: false, reason }` with `reason` one of `unreachable`
(no path, a goal nobody can stand in, or 3 stuck / failed re-plans), `timeout` (default 6000
ticks), `interrupted` (cancel or a new goto). `dig`, `collect`, `openContainer` and `deposit` are
TODO stubs for Phase 4.

## Layers

| File | What |
|---|---|
| `terrain/shapes.ts` | Collision boxes per block state from minecraft-data's bedrock `blockCollisionShapes` (1.26.30 data, same as the registry). prismarine-registry does not attach them for bedrock, so `World.blockAt().boxes` is a full cube for every block whose bounding box is `block` (slabs, stairs, fences, carpets). `blockInfoOf(name, states)` builds a BlockInfo without a connection (tests). |
| `terrain/classify.ts` | `TerrainClass` per state (cached): boxes, top, `floor` (a box with that top covers the centre and top <= 1), liquid + surface height, `danger` (lava, fire, magma, cactus, campfire, sweet berry bush, wither rose, cobweb, powder snow, dripstone, portals), leaves, climbables, friction (ice 0.98, blue ice 0.989, slime 0.8, else 0.6), `penalty` (leaves 4, soul sand / honey / slime / mud / ice 4). Unknown blocks (newer than the block data) are full solid cubes. |
| `terrain/query.ts` | `worldSource(world)` (chunk store state ids, no allocations), `blockQueryOf(source)`: the physics' `BlockQuery` with `boxesAt`, `frictionAt`, `liquidAt`. |
| `nav/grid.ts` | `NavGrid`: cached classes and `stand(x, y, z)` (feet height of a body standing in that cell, `NaN` blocked, `undefined` unknown), `free`, `freeColumn`, `penalty`, `invalidate`. |
| `nav/astar.ts` | `findPath` (A*), `locateNode` (the node under a body, also when it hangs over an edge). |
| `nav/goals.ts` | Goal predicates and the octile heuristic. |
| `nav/follower.ts` | `PathFollower`: path to per-tick MoveCommands; `PressGuard` (no accidental double taps). |
| `nav/navigator.ts` | `Navigator`: goto loop, re-planning, stuck detection, report. |
| `index.ts` | `BotSkills` facade (`Skills` from PLAN.md 4.3), lookAt, status, fall tracking. |

## Nodes and moves

A node is the cell that contains the feet: feet height in `[y, y + 1)`. The floor is either a
partial block in the cell itself (slab 0.5, carpet 0.0625, snow layer, soul sand 0.875, bed 0.5625
...) or a block whose top is exactly 1 in the cell below. The body (0.6 x 1.8) must find every cell
from the feet up to `feet + 1.8` free (no collision box, no liquid, no hazard). Fences, walls and
gates (1.5 high) are obstacles, never floors.

| Move | Where | Condition | Cost |
|---|---|---|---|
| walk | 4 cardinal | feet rise <= 0.5625 (auto-step: slabs, carpets), or any step down in the same cell level | 1 |
| diag | 4 diagonal | same feet height exactly; both side cells standable at that height (no corner clipping, no drops at corners) | sqrt 2 |
| jump | 4 cardinal | rise in (0.5625, 1.25]; the start column free up to the target's head | 2 |
| drop | 4 cardinal | target column free from the feet to the head, fall through free cells, at most 3 blocks (no fall damage) | blocks fallen, at least 1 |

Plus `penalty` of the floor (leaves, slow blocks). Water, lava and hazards are never entered.
Digging is off: `PathCosts.digCost` (default `Infinity`) is the hook for a "dig through" move.
Heuristic: octile distance in x/z (admissible: vertical moves never cost less than the horizontal
walk they include). Search limits: 40 000 expanded nodes or 250 ms, then the best partial path
(closest to the goal by heuristic). `status`: `found`, `partial` (limit hit, or the search touched
unloaded world), `none` (the reachable region is exhausted and fully known: unreachable).

## Following a path

Per tick, from `InputLoop.onBeforeStep` (the command applies to the same tick):

- **Aim** (pure pursuit): the farthest node up to 6 ahead that is reachable in a straight line on
  the same feet height: the body's footprint (half-width 0.31), sampled every 0.2 blocks, stays on
  cells standable at that height. Nodes before the aim count as passed.
- **Turn** towards the aim at most 30 degrees per tick (yaw and head_yaw); `forward` while the aim is
  within 50 degrees of the view.
- **Jump** when on the ground, facing the step within 25 degrees and within 1.4 blocks of the next
  node (or pushing against it). Staircases are climbed with consecutive jumps.
- **Drops**: approach the edge at <= 0.12 blocks/tick (forward released above that), and in the air
  release forward when the air drift (about 10 x speed) would carry past the landing centre.
- **Sprint** on straight walkable runs longer than 5 blocks while facing within 15 degrees, never
  within 3 blocks of a jump, a drop or the final stop. BDS keeps a sprint while forward is held (see
  movement.md), so the follower releases forward for one tick to end it.
- **No double taps**: `PressGuard` delays a forward re-press within 7 ticks of the previous press
  (BDS sprints on a 6-tick press-to-press double tap). Shared by all followers of one goto.
- **Stop**: release forward when the ground coasting distance (speed x 0.546 / 0.454) covers the
  rest; done on the ground within 0.3 of the last node's centre and below 0.03 blocks/tick.

## Re-planning and stuck handling (`Navigator`)

| Trigger | Action |
|---|---|
| `correct_player_move_prediction` (if `replanOnCorrection`, default on), `set_entity_motion`, a teleport | re-plan from the corrected position, once on the ground |
| `World.onBlockUpdate` within 1 block (x/z) and y - 1 .. y + 2 of a node not yet passed | invalidate the cell, re-plan |
| the follower reaches the end of a `partial` path | re-plan |
| no progress (remaining path length not 0.05 shorter) for 40 ticks | re-plan, failure + 1 |
| no standable node under the body, or the best node is the start | wait 20 ticks, failure + 1 |
| 3 failures | `unreachable` |
| `findPath` says `none`, or a `block` goal is a cell nobody can stand in | `unreachable` at once |

Every block update invalidates the grid cache, so a re-plan sees the new blocks. The report
(`skills.status().lastGoto`) lists each plan (reason, tick, status, nodes, expanded, ms), corrections,
motions, stuck events, failures, distance walked and sprint ticks.

## Status, health and falls

`BotSkills.status()`: health and food (from `set_health` / `update_attributes`, tracked by the world
model), the last 20 health drops (`falling: true` with `fallDistance` when the body landed from more
than 3 blocks within the 20 ticks before; measured: a 7-block fall arrives as one drop 20 -> 16 within
20 ticks of the landing), corrections, knockback motions, teleports, inWater / inLava, the last goto.

## Measured (bds-move, BDS 1.26.51.1, default movement settings unless noted, 2026-10-28)

| Test | Result |
|---|---|
| 3.3: 10 random points within 30 blocks, sprint allowed | 10/10 reached, 0 corrections over 273.6 blocks (697 sprint ticks), end within 0.18 of the centre, truth diff 0.0000 |
| 3.3: same, walking only | 10/10, 0 corrections over 311.5 blocks |
| lookAt (yaw 45, pitch -19.47) | truth yaw 45.00 pitch -19.47, max 15 degrees per tick |
| 3.4: 10-high staircase | 0 corrections, 118 ticks |
| 3.4: drop 3, then 3 + 1 to the ground | 0 corrections, no fall damage |
| 3.4: bottom-slab staircase | 0 corrections, no jumps |
| 3.4: around the water and lava pools | 0 corrections, never in a liquid; a goal in the water is `unreachable` at once |
| fell 3 blocks into 2-deep water, floated 60 ticks | 0 corrections; swimming out (jump + forward against the pool wall): 2 to 3 corrections |
| fall of 7 blocks | health 20 -> 16, status flags it as a fall of 7 |
| TNT knockback (`set_entity_motion`) | 0 corrections after the ground-friction fix (1 correction of 0.22 before it) |
| 3.5: 100 blocks over hills (`long` layout) | ok in 19.4 s (388 ticks), 104.9 blocks walked, 0 corrections, 3 plans |
| 3.5: unit, 1000 random paths on a generated 128 x 128 hilly world | alone: p50 0.83 ms, p95 4.2 ms, p99 6.8 ms, max 28 ms; inside the parallel `pnpm -r test`: p50 0.9 to 1.0 ms, p95 5.0 to 5.3 ms, max 17 to 22 ms (shared grid cache; 997 found, 2 partial, 1 none). The first searches of a fresh process are JIT-cold: 20 warm-up searches are timed but not counted, their max was 62 to 74 ms under the parallel run. Cold cache (fresh grid per path, 200 paths): p50 0.85 ms, p95 4.4 ms, max 8.7 ms |
| 3.6: wall placed mid-path by `truth:fill` | re-planned on the block updates (plan 2 at tick 41), ok, 0 corrections |
| 3.6: goal sealed off by a 3-high ring | `unreachable` after 80 ticks (3 failed re-plans) |
| strict server (`server-authoritative-movement-strict=true`, threshold 0.001), all of the above | every correction (BDS sends one about every 6 ticks in strict mode) carried error 0.0000: no hidden model error on these courses |

## Tests

| Test | What |
|---|---|
| `test/unit/skills/terrain.test.ts` | shapes, classification, the physics BlockQuery |
| `test/unit/skills/physics-terrain.test.ts` | slabs, fences, carpets, ice, water, sprint rules, knockback |
| `test/unit/skills/astar.test.ts` | stand rules, every move kind, limits, corner rule, liquids, leaves, partial paths, `locateNode`, the 1000-path benchmark |
| `test/unit/skills/nav-sim.test.ts` | closed loop without a server (FakeConnection + InputLoop + BotSkills on generated worlds): flat goals, sprint, stairs, drops, slabs, pools, lava, a wall built mid-path, stuck -> unreachable, timeout, cancel, 20 goals on a hilly world |
| `test/e2e/nav-flat.test.ts` | task 3.3 |
| `test/e2e/nav-hill.test.ts` | task 3.4, water float, fall damage |
| `test/e2e/nav-long.test.ts` | task 3.5 e2e |
| `test/e2e/nav-wall.test.ts` | task 3.6 |
| `test/e2e/nav-knockback.test.ts` | `set_entity_motion` from a TNT explosion |

The e2e tests use their own server, `bds-move` (udp/19146), and build their terrain with
`truth:fill` (`test/e2e/nav-worlds.ts`: `flat`, `hill`, `long`, `wall` layouts in separate areas):

```sh
docker compose -f docker/compose.move.yml up -d
pnpm --filter @bedrockbot/truth-pack pack:deploy --data docker/data/move --world move --restart bds-move
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e test/e2e/nav- test/e2e/skills-input
```

Env: `MOVE_BDS_HOST`, `MOVE_BDS_PORT` (19146), `MOVE_BDS_CONTAINER` (`bds-move`), `MOVE_SEED`
(random goals), `MOVE_VERBOSE=1` (corrections, teleports, navigator decisions). bds-move runs with
`tick-distance=10` so the truth pack can edit the 100-block course without moving the player along.
For a strict-mode probe set `server-authoritative-movement-strict=true` and
`player-position-acceptance-threshold=0.001` in `docker/data/move/server.properties`, restart, run,
and restore (the correction-count assertions fail in strict mode by design; read the `err` values).

## Known gaps

- Fences and walls use minecraft-data's post-only shapes (no connections to neighbours): the
  planner never walks next to them closely enough to matter, but the physics would collide with a
  connected fence arm late. Doors, trapdoors, gates are obstacles.
- No swimming, ladders, vines, scaffolding, or parkour (gap jumps); no sneaking along edges.
- `near` / `xz` goals inside water or behind unloaded world end with `unreachable` only after the
  failure budget (3 re-plans), not at once.
- Partial paths towards unloaded chunks rely on the chunks arriving while walking (view distance
  10 is about 160 blocks).
- Soul sand, honey, slime and ice are only penalised by the planner; the physics models ice/slime
  friction but not the soul sand / honey speed factor.
