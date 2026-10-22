# Pathfinding and goto (`bot/src/skills/nav`, `bot/src/skills/terrain`, `bot/src/skills/index.ts`)

PLAN.md section 4.3, Phase 3 (tasks 3.3 to 3.6) and Phase 7 (tasks 7.1, 7.2 and the planner half of
7.3: Navigation v2). Decision records: [decisions/0005-pathfinding.md](decisions/0005-pathfinding.md)
(v1) and [decisions/0009-navigation-v2.md](decisions/0009-navigation-v2.md) (v2). The input loop and the
movement model underneath are in [movement.md](movement.md).

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
await skills.goto(goal, { allowBreak: true });              // may dig through blocks (Digger)
await skills.goto(goal, { allowPlace: true });              // may pillar up (needs the place action)
await skills.goto(goal, { closeDoors: true });              // closes doors / gates it opened
skills.cancel();                                           // the running goto resolves 'interrupted'
skills.status();   // health, food, damage, corrections, motions, inWater, lastGoto report
```

`goto` resolves `{ ok: true }` or `{ ok: false, reason }` with `reason` one of `unreachable` (no path,
a goal nobody can stand in, or 3 failures: stuck, move timeouts, failed plans, failed actions),
`timeout` (default 6000 ticks), `interrupted` (cancel or a new goto).

## Layers

| File | What |
|---|---|
| `terrain/shapes.ts` | Collision boxes per block state from minecraft-data's bedrock `blockCollisionShapes` (1.26.30 data). Doors: the panel from the state (`doorBoxes`; the data has one box for every door state). Fences, panes, bars: `connectedBoxes(kind, mask)` (post plus arms). `blockInfoOf(name, states)` builds a BlockInfo without a connection (tests). |
| `terrain/classify.ts` | `TerrainClass` per state (cached): boxes, top, floor, liquid, danger, leaves, climbable, friction, `penalty` / `costFactor` (leaves, soul sand, honey, slime, mud, ice: 1 + 4), `openable` (door / trapdoor / gate) and `open`, `doorUpper`, `connect` (fence / pane), `fullCube`, `gravity` (sand, gravel, concrete powder, anvils ...), `protect` (containers, beds, spawners ...), `roof` (blocks the sky: any box but leaves, liquids). Unknown runtime ids are 1.5-high obstacles. |
| `terrain/query.ts` | `worldSource(world)` (chunk store state ids; `columnTop` from the highest non-empty subchunk; `minY` / `maxY`), `boxesAtCell` (neighbour-aware boxes: fence arms, the upper door half from the lower one), `blockQueryOf(source)`: the physics' `BlockQuery`. |
| `nav/costs.ts` | `TICKS` (walk, sprint, jump air time, fall table) derived from `input/physics.ts`; `PathCosts`, `DEFAULT_COSTS`, `dropCost`. |
| `nav/actions.ts` | `NavActions` (dig / place / useBlock / throwawayItems), `NavBlockFace`, `breakBlocker` (the breaking safety rules). |
| `nav/grid.ts` | `NavGrid`: cached classes, `stand`, `standThrough` (doorways), `free`, `freeColumn`, `crossing` (door / gate passage along x or z), `skyTop` / `underground` (per-chunk sky column cache), `factor`, `invalidate`. |
| `nav/astar.ts` | `PathSearch` (resumable A*: `step(sliceMs)`), `findPath` (one go), `locateNode`. |
| `nav/goals.ts` | Goal predicates and the octile heuristic (blocks; the search multiplies by `costs.walk`). |
| `nav/follower.ts` | `PathFollower`: a path leg to per-tick MoveCommands; `PressGuard` (no accidental double taps). |
| `nav/navigator.ts` | `Navigator`: segments, plan-ahead, legs and actions, re-planning, per-move timeouts, retreat, the report. |
| `index.ts` | `BotSkills` facade: wires `actions.dig` to the Digger (not `this.dig()`, which would cancel the goto) and the world inventory (best tool, throwaway blocks); `place` / `useBlock` are wired by Track O's PlaceSkill / UseSkill. |

## Nodes and moves

A node is the cell that contains the feet: feet height in `[y, y + 1)`. The floor is either a partial
block in the cell itself (slab 0.5, carpet 0.0625, snow layer, soul sand 0.875, bed 0.5625 ...) or a
block whose top is exactly 1 in the cell below. The body (0.6 x 1.8) must find every cell from the feet
up to `feet + 1.8` free (no collision box, no liquid, no hazard). Fences, walls, gates and unknown
blocks (1.5 high) are obstacles, never floors. Costs are ticks (`DEFAULT_COSTS`):

| Move | Where | Condition | Cost (ticks) |
|---|---|---|---|
| walk | 4 cardinal | feet rise <= 0.5625 (auto-step), or a step down within 0.5625 | `walk`: 3.564 (sprint allowed) or 4.633 |
| diag | 4 diagonal | same feet height exactly; both side cells standable at it | `walk` x sqrt 2 |
| jump | 4 cardinal | rise in (0.5625, 1.25]; the start column free up to the target's head | `jump` 9 |
| drop | 4 cardinal | target column free from the feet to the head, fall through free cells, at most 3 blocks | `walk` + fall(n) (5 / 7 / 9) + `landing` 2; + `irreversibleDrop` 30 when higher than 1.25 |
| walk through a doorway | 4 cardinal | door / gate cells let the 0.6-wide corridor pass now, or after a toggle (needs `useBlock`) | `walk` + `door` 10 per toggle |
| dig-through | 4 cardinal, same level | `allowBreak` + `dig`; full-block floors; the 1 or 2 body cells are breakable (rules below) | `walk` + per block (break ticks + `dig` 12) |
| pillar-up | straight up | `allowPlace` + `place` + a throwaway block in the inventory; full-block feet; head room above | `jump` + `place` 10 |

Every move into node B also pays: B's floor `costFactor` (x 5 on leaves, soul sand, honey, slime, mud,
ice) on the base cost, and `underground` (6) when a roof block is anywhere above B's head. Water, lava
and hazards are never entered. Heuristic: `walk` x octile distance (no move is cheaper per block, so it
is admissible). Path nodes carry `cost` (the move's ticks, for the per-move timeout) and `act`
(`dig` cells, `use` doors, `place` block).

**Surface preference.** `NavGrid.skyTop(x, z)` is the highest `roof` block of a column (anything with a
box except leaves, and liquids), scanned down from the column's highest non-empty subchunk and cached
in a 16 x 16 array per chunk; a block update in the column resets it; an unloaded column is "unknown"
(no penalty, not cached). `underground` (default 6 ticks per node) and `irreversibleDrop` (default 30)
are `PathCosts` fields (`path.costs` in NavigatorOptions, or per `findPath`). The best partial path
ends at the node with the lowest heuristic plus accumulated irreversible-drop penalty, so a segment
never ends at the bottom of a pit when a node on the rim is as close.

**Doorways.** `crossing(x, y, z, axis)`: a door / gate cell is clear when no box of it (doors: the
lower half's state, also for the upper half) blocks the corridor x or z in [0.2, 0.8] a body walking
along that axis through the cell's centre sweeps; `toggle` when the toggled state would be clear (an
open gate has no box; a door panel swings to the perpendicular edge); else blocked. Only cardinal walks
enter or leave doorway nodes.

**Breaking rules** (`breakBlocker`, Baritone's): no unknown, air, liquid or unbreakable blocks; never a
block next to water or lava (6 neighbours); never one with a gravity block on top; never the floor
under the start or the target (no dig-down move); never containers, beds, spawners, lecterns, hoppers,
furnaces and the like (`TerrainClass.protect`), doors and gates, or names in `protectedBlocks`; never a
cell a dig already failed on during this goto. Break ticks come from the break-time table with the
best hotbar tool (`chooseTool`, docs/digging.md), or an empty hand without an inventory.

Search limits: a main plan 20 000 nodes / 40 ms of search time, a plan-ahead 20 000 / 100 ms
(`segmentNodes`, `mainMs`, `segmentMs`; `path.maxNodes` / `path.maxMs` override both); a search runs at
most `sliceMs` (8) per tick. `status`: `found`, `partial` (limit hit, or the search touched unloaded
world; `unknown` / `limited` say which), `none` (exhaustive and fully known: unreachable).

## Following a path

Per tick, from `InputLoop.onBeforeStep` (the command applies to the same tick):

- **Legs**: the path is walked in legs that end before a node with an action (or at a door to close).
  The body stops on the leg's last node, the action runs, the next leg starts.
- **Aim** (pure pursuit): the farthest node up to 6 ahead that is reachable in a straight line on the
  same feet height (footprint half-width 0.31, sampled every 0.2 blocks, on cells standable at that
  height). Doorway cells are not standable for this check, so doors are approached head on.
- **Turn** towards the aim at most 30 degrees per tick; `forward` while the aim is within 50 degrees.
- **Jump** when on the ground, facing the step within 25 degrees and within 1.4 blocks of the next
  node (or pushing against it).
- **Drops**: approach the edge at <= 0.12 blocks/tick, release forward in the air when the drift would
  carry past the landing centre.
- **Sprint** on straight walkable runs longer than 5 blocks, never within 3 blocks of a jump, a drop or
  a stop; a sprint ends by releasing forward for one tick (BDS keeps a sprint while forward is held).
- **No double taps**: `PressGuard` delays a forward re-press within 7 ticks of the previous one.
- **Stop**: release forward when the coasting distance covers the rest; done within 0.3 of the last
  node's centre and below 0.03 blocks/tick.

**Actions** (the navigator releases the movement keys and leaves yaw / pitch to the action):

| Action | Runs | Done when |
|---|---|---|
| dig | `actions.dig(p)` per cell, the higher cell first; skipped when the cell is already free | every cell is free; a failure marks the cell not breakable and re-plans |
| use (door / gate) | `actions.useBlock(p)` when the cell still blocks the move's axis | `crossing` along the axis is clear (40 ticks at most); with `closeDoors` a close is scheduled on the first node out of the door cell |
| close | `actions.useBlock(p)` on that node | the door / gate blocks the axis again |
| place (pillar-up) | `actions.place(p, 'down')` from standing; the action jumps and clicks the top of the block below once the feet are above the cell (Track O's PlaceSkill: jump tick 4, feet +1.17, 6 ticks per step) | the result is ok and the body stands on the new block; landing back at the old height is a failure |

Block updates at cells the running goto's actions change never trigger re-plans.

## Segments, re-planning and stuck handling (`Navigator`)

| Trigger | Action |
|---|---|
| start, or any re-plan below | main search from the body's node (sliced; the body waits, keys released) |
| a partial segment with fewer than `aheadNodes` (64) nodes left | plan-ahead from its last node, spliced on when ready (the leg runs on, no stop) |
| the end of a partial segment, no plan-ahead coming | re-plan (`partial`) |
| the main search ends at unloaded world with no progress (path of 1 node, `unknown`, not `limited`) | wait 10 ticks and plan again, up to `unloadedWaitTicks` (200) in a row: not a failure |
| `correct_player_move_prediction` (if `replanOnCorrection`), `set_entity_motion`, a teleport | re-plan (`correction`) once on the ground |
| `World.onBlockUpdate` within 1 block (x / z) and y - 1 .. y + 2 of a node not yet passed, whose movement signature (boxes, floor, liquid, danger, cost factor, roof, open ...) changed | invalidate, re-plan (`block`); updates that change nothing the planner reads (grass to dirt) only invalidate the cache |
| the move under way (straight line from the last node passed to the aim) takes more than 2 x its estimate + 10 ticks | re-plan (`timeout`), failure + 1 |
| no progress (remaining path not 0.05 shorter) for 40 ticks | re-plan (`stuck`), failure + 1 |
| an action fails or times out (dig 600 ticks per block, use / place 100) | re-plan (`action`), failure + 1 |
| a failure while the body is not on a safe node (in water / lava, airborne, no standable node) | retreat first: steer to the last safe node (forward, jump in water or against a wall) for up to 60 ticks |
| no standable node under the body, or the best node is the start | wait 20 ticks, failure + 1 |
| 3 failures | `unreachable` |
| the main search says `none`, or a `block` goal is a cell nobody can stand in | `unreachable` at once |

The report (`skills.status().lastGoto`) has each plan (reason, tick, status, nodes, expanded, ms,
slices), segments, corrections, motions, stuck and move timeouts, failures, distance, sprint ticks,
`maxTickMs` (longest tick in the navigator, planning included), `planMs`, action counts, retreats and
ticks waited for unloaded chunks.

## Status, health and falls

`BotSkills.status()`: health and food, the last 20 health drops (`falling: true` with `fallDistance`
when the body landed from more than 3 blocks within the 20 ticks before), corrections, knockback
motions, teleports, inWater / inLava, the last goto.

## Measured

### v2 (bds-move, BDS 1.26.60.6, 2026-10-29)

| Test | Result |
|---|---|
| ticks per block, 50-block straight run, steady part (blocks 10 to 40) | walking 4.633 (table 4.633), sprinting 3.562 to 3.565 (table 3.564); whole runs incl. start and stop 4.72 and 3.84 |
| 6-step staircase | 9.0 ticks per step, landing to landing (table `jump` 9) |
| drops, from 0.5 blocks before the edge to the landing | 3 blocks: 12 ticks (fall 9); 1 block: 8 ticks (fall 5); table (whole block + landing) 15.6 and 11.6 |
| hill with a cave mouth on the line (4 terraces, 53 wide, 1-wide tunnel) | over the top (feet -55.75), 0 underground ticks, 0 ticks in the tunnel, 292 to 295 ticks; 0 corrections in 2 of 4 runs, 1 in the other 2 (error 0.418 along the motion, the client ahead, about 1.5 blocks after the last jump onto the top: see Known gaps) |
| 3-deep pit on the line | never entered (lowest feet -60.000), 86 ticks, 0 corrections |
| 200-block cross-country (slab ramp, 2-block drop, mounds, wall with gap, water ditch, cave hill, pit, trees) | v2: ok, 803 ticks (40.2 s), 213.1 blocks walked, 2 segments (main + one plan-ahead), max 9.3 ms in any tick, 0 underground ticks, never in the pit or water, 0 corrections. v1 on the same course: ok, 809 ticks (40.4 s), 212.1 blocks, 61 ticks through the cave tunnel, one plan of 105 ms inside a single tick, 11 plans (block updates) |
| planner time per segment (200-block course) | main plan: the 40 ms budget, 5741 nodes, sliced over 5 ticks; plan-ahead to the goal 0.4 ms. Before the main budget and the block-update filter (earlier run): 5 plans of 100 / 54 / 6 / 2 / 1 ms, each over at most 13 ticks of 8 ms |
| dig-through: 41-wide 3-high dirt wall | not allowed: around it, 181 ticks, 46.3 blocks, 0 digs; allowed: 2 blocks dug (by hand), 121 ticks, 16.0 blocks; 0 corrections |
| fence line (30 long, a gap, a corner) | along it and back through the gap: 0 collision ticks, 0 corrections |
| unit: 1000 random paths on a generated 128 x 128 hilly world | p50 1.7 ms, p95 7.0 ms, p99 10 ms, max 18 ms (v1: 0.8 / 4.2 / 6.8 / 28) |

On 1.26.60 the world model resolves fences, glass panes and iron bars to unknown runtime ids (the block
data is 1.26.30); the planner treats them as 1.5-high obstacles, so the fence suite passes, but the
fence-arm shapes only run in the unit tests until the registry knows those states.

### v1 (bds-move, BDS 1.26.51.1, 2026-10-28)

| Test | Result |
|---|---|
| 3.3: 10 random points within 30 blocks, sprint allowed | 10/10 reached, 0 corrections over 273.6 blocks (697 sprint ticks), end within 0.18 of the centre, truth diff 0.0000 |
| 3.4: 10-high staircase | 0 corrections, 118 ticks |
| 3.4: drop 3, then 3 + 1 to the ground | 0 corrections, no fall damage |
| 3.4: around the water and lava pools | 0 corrections, never in a liquid; a goal in the water is `unreachable` at once |
| 3.5: 100 blocks over hills (`long` layout) | ok in 19.4 s (388 ticks), 104.9 blocks walked, 0 corrections, 3 plans |
| 3.6: wall placed mid-path by `truth:fill` | re-planned on the block updates, ok, 0 corrections |
| 3.6: goal sealed off by a 3-high ring | `unreachable` after 80 ticks (3 failed re-plans) |
| strict server (threshold 0.001) | every correction carried error 0.0000 |

## Tests

| Test | What |
|---|---|
| `test/unit/skills/terrain.test.ts` | shapes, classification, the physics BlockQuery |
| `test/unit/skills/physics-terrain.test.ts` | slabs, fences, carpets, ice, water, sprint rules, knockback |
| `test/unit/skills/physics-terrain-v2.test.ts` | door panels (Track O's measured rule), door / gate / trapdoor classes, fence and pane arms, walking along a connected fence, `crossing`, the sky cache |
| `test/unit/skills/astar.test.ts` | stand rules, every v1 move with tick costs, limits, corner rule, liquids, leaves, partial paths, `locateNode`, the 1000-path benchmark |
| `test/unit/skills/nav-sim.test.ts` | closed loop without a server: flat goals, sprint, stairs, drops, slabs, pools, lava, a wall built mid-path, stuck -> unreachable, timeout, cancel, 20 goals on a hilly world |
| `test/unit/skills/nav-v2.test.ts` | closed loop, v2: tick costs, the cave hill and the pit (also with 12-node segments), irreversible drops, 290 blocks in many spliced segments without stopping, sliced searches, unloaded world, irrelevant block updates, move timeouts, retreat after a knock into a pool, dig-through (and its safety rules), pillar-up out of a pit and onto a plateau, doors and gates (opened, closed behind) with fake actions |
| `test/e2e/nav-flat`, `nav-hill`, `nav-long`, `nav-wall`, `nav-knockback` | v1 suites (tasks 3.3 to 3.6), still green on v2 |
| `test/e2e/nav-costs.test.ts` | ticks per block / step / drop vs the cost table |
| `test/e2e/nav-surface.test.ts` | cave hill (surface only), pit on the line (never entered) |
| `test/e2e/nav-cross.test.ts` | 200-block cross-country: 0 corrections, no tick over 100 ms |
| `test/e2e/nav-dig.test.ts` | dirt wall: walked around without `allowBreak`, dug with it |
| `test/e2e/nav-fence.test.ts` | fence line: never collided with |
| `test/e2e/nav-place.test.ts` | pillar-up (cliff, pit) and door / gate; skipped with a message until the navigator has `place` / `useBlock` actions |

The e2e tests use `bds-move` (udp/19146). The v1 layouts (`nav-worlds.ts`: `flat`, `hill`, `long`, `wall`)
have fixed areas; every v2 suite builds in its own random chunk-aligned area (`privateOrigin()`, x 2048
to 10 000, z -8000 to 8000), so two runs on one server never share terrain:

```sh
node scripts/bds.mjs --profile move up                       # from the repo root; `... pack` deploys the truth pack
cd bot
BDS_E2E=1 pnpm exec vitest run --project e2e test/e2e/nav-  # every nav suite, v1 and v2 (about 7 minutes)
BDS_E2E=1 pnpm exec vitest run --project e2e test/e2e/nav-cross --silent=false   # one suite, with its summary
```

Env: `MOVE_BDS_HOST`, `MOVE_BDS_PORT` (19146), `MOVE_BDS_CONTAINER` (`bds-move`), `MOVE_SEED` (random goals,
the cross-country layout; default 7), `MOVE_AREA=x,z` (pin a v2 suite's area to reproduce a run),
`MOVE_VERBOSE=1` (corrections, teleports, navigator decisions).

## Known gaps

- Fences, panes and bars are unknown runtime ids on 1.26.60 (world model registry): obstacles of 1.5,
  no arms in the physics. Walls carry their connections in the state and are fine.
- No bridging (placing a block to cross a gap), no dig-down, no digging head room for a jump, no
  descending by digging; pillar-up needs a full-block floor.
- No swimming, ladders, vines, scaffolding, parkour or sneaking along edges.
- Trapdoors are classified (open / closed) but not toggled by the planner.
- Climbing the cave hill's four 1-block terraces in a row (jumping while pushed against each step,
  then accelerating on top) gave one correction of 0.418 (client ahead) in 2 of 4 runs, right after
  the last landing. The follower never sprint-jumps there (checked in the sim); likely a sprint-start
  rule after horizontal collisions in the movement model (input/sprint.ts). Not investigated further.
- Soul sand, honey, slime and ice are only penalised by the planner; the physics models ice / slime
  friction but not the soul sand / honey speed factor.
