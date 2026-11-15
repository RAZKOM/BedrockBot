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
await skills.goto({ type: 'any', goals: logs.map((p) => ({ type: 'getToBlock', p })) });   // nearest of several
skills.status().lastGoto.reached;                           // { index, goal }: the member reached
await skills.goto({ type: 'getToBlock', p: chest });         // next to it, in reach, a visible face
await skills.goto({ type: 'yLevel', y: 12 });                // any cell with the feet at y 12
await skills.goto({ type: 'runAway', from: () => zombie.pos, r: 16 });   // flee (a point, points or a function)
await skills.goto({ type: 'surface' }, { allowPlace: true });           // out of a cave or a pit (!top)
skills.nav.blacklist.size;                                  // failed goals / logs / action cells skipped for now
skills.cancel();                                           // the running goto resolves 'interrupted'
skills.status();   // health, food, damage, corrections, motions, inWater, lastGoto report
```

`goto` resolves `{ ok: true }` or `{ ok: false, reason }` with `reason` one of `unreachable` (no path,
a goal nobody can stand in, or 3 failures: stuck, move timeouts, failed plans, failed actions),
`timeout` (default 6000 ticks without progress: the budget restarts whenever the straight-line distance to the goal point improves by a block, with a hard cap of 20 budgets; goals without a point such as surface and runAway keep the plain limit; 2026-10-30: a 1400-block walk on the Realm had timed out after 1120 blocks), `interrupted` (cancel or a new goto), `blacklisted` (the goal, or
every member of an `any`, is on the blacklist).

## Layers

| File | What |
|---|---|
| `terrain/shapes.ts` | Collision boxes per block state from minecraft-data's bedrock `blockCollisionShapes` (1.26.30 data). Doors: the panel from the state (`doorBoxes`; the data has one box for every door state). Fences, panes, bars: `connectedBoxes(kind, mask)` (post plus arms). Stairs: `stairBoxes(states)` (corners), `STAIRS_UP`, `resolveNewerState` (1.26.60 stairs runtime ids, see "Stairs and partial blocks"). `blockInfoOf(name, states)` builds a BlockInfo without a connection (tests). |
| `terrain/classify.ts` | `TerrainClass` per state (cached): boxes, top, floor, liquid, danger, leaves, climbable, friction, `penalty` / `costFactor` (leaves, soul sand, honey, slime, mud, ice: 1 + 4), `openable` (door / trapdoor / gate) and `open`, `doorUpper`, `connect` (fence / pane), `fullCube`, `gravity` (sand, gravel, concrete powder, anvils ...), `protect` (containers, beds, spawners ...), `roof` (blocks the sky: any box but leaves, liquids). `halfTop(c, dx, dz)`: the highest box top in one half of the block. Unknown runtime ids are 1.5-high obstacles, except the ones `resolveNewerState` knows (1.26.60 stairs). |
| `terrain/query.ts` | `worldSource(world)` (chunk store state ids; `columnTop` from the highest non-empty subchunk; `minY` / `maxY`), `boxesAtCell` (neighbour-aware boxes: fence arms, the upper door half from the lower one), `blockQueryOf(source)`: the physics' `BlockQuery`. |
| `nav/costs.ts` | `TICKS` (walk, sprint, jump air time, fall table) derived from `input/physics.ts`; `PathCosts`, `DEFAULT_COSTS`, `dropCost`. |
| `nav/actions.ts` | `NavActions` (dig / place / useBlock / throwawayItems), `NavBlockFace`, `breakBlocker` (the breaking safety rules: a call into the shared rule set below). |
| `nav/baritone/helper.ts` | Track BB (wave 11): the one rule set, Baritone's `MovementHelper` ported over `TerrainClass` (LGPL-3.0, `nav/baritone/LICENSE`, THIRD_PARTY_NOTICES.md): `canWalkThroughClass` / `canWalkThrough`, `canWalkOn` / `fullFloor`, `avoidWalkingInto`, `avoidBreaking` (= `breakBlocker`), `getMiningDurationTicks`, `breakTicksWith` / `bestTool` (Baritone `ToolSet`), `mustBeSolidToWalkOn`, `isReplaceable`, `canPlaceAgainst`, `isBottomSlab`, `isClimbable`, `isStillWater` / `isFlowing`, `ruleCell` (the miner's cell view). Pure, the per-cell rules allocation-free (`ruleCell` / `cellReaderOf` return one small object), over a `CellReader` (`NavGrid.cls`, or `cellReaderOf(source)`); the planner's grid, the worker's mirror grid, the follower's dig actions, the miner's tunnel checks and the Digger's tool choice call it. See "Rules". |
| `nav/baritone/moves.ts` | Track BC (wave 11): the moves that dig, Baritone's `MovementTraverse` / `MovementAscend` / `MovementDescend` / `MovementDownward` / `MovementPillar` cost functions ported over `NavGrid` and the rule set (LGPL-3.0): per move the cells to break in break order and the cost (our movement ticks + `getMiningDurationTicks` per cell, `includeFalling` for a column's top cell), the movements' own refusals (a falling block over a broken head-room cell) and the shaft rules (`shaftBlocker` = `mine/tunnel.ts` `shaftRule` over the grid). Per-search caches of the mining ticks per cell and the shaft verdict per column. `astar.ts` calls it under `allowBreak`; the worker runs the same code. See "Nodes and moves". |
| `nav/grid.ts` | `NavGrid`: cached classes, `stand`, `standThrough` (doorways), `free`, `freeColumn`, `crossing` (door / gate passage along x or z), `skyTop` / `underground` (per-chunk sky column cache), `factor`, `invalidate`. |
| `nav/astar.ts` | `PathSearch` (resumable A*: `step(sliceMs)`), `findPath` (one go), `locateNode`. |
| `nav/goals.ts` | Goal predicates and heuristics (blocks; the search multiplies by `costs.walk`): block, near, xz, any, getToBlock, yLevel, runAway, surface (see Goals). |
| `nav/blacklist.ts` | `NavBlacklist`: goals, `any` members and action cells that failed 3 times, skipped for 6000 ticks (see Blacklist). |
| `nav/follower.ts` | `PathFollower`: a path leg to per-tick MoveCommands; `PressGuard` (no accidental double taps). |
| `nav/navigator.ts` | `Navigator`: segments, plan-ahead, legs and actions, re-planning, per-move timeouts, retreat, the report. |
| `index.ts` | `BotSkills` facade: wires `actions.dig` to the Digger (not `this.dig()`, which would cancel the goto) and the world inventory (best tool, throwaway blocks); `place` / `useBlock` are wired by Track O's PlaceSkill / UseSkill. Track BI: builds the `FallGuard` (`skills.falls`), wires `nav.fallPolicy` / `nav.holdPlans` to it and adds the refused-fall note to an `unreachable` goto. |
| `fall/damage.ts`, `fall/waterlog.ts`, `fall/policy.ts`, `fall/plan.ts`, `fall/explain.ts`, `fall/clutch.ts` | Track BI: the measured fall damage model, the waterloggable table and clutch target, the long-fall policy, the planner's long drops (`longDrops`, called by `astar.ts`), the note on a refused fall, the `FallGuard` (reactive clutch, pickup). See "Long falls" and docs/movement.md "Falls and the water bucket clutch". |

## Nodes and moves

A node is the cell that contains the feet: feet height in `[y, y + 1)`. The floor is either a partial
block in the cell itself (slab 0.5, carpet 0.0625, snow layer, soul sand 0.875, bed 0.5625 ...) or a
block whose top is exactly 1 in the cell below. The body (0.6 x 1.8) must find every cell from the feet
up to `feet + 1.8` free (no collision box, no liquid, no hazard). Fences, walls, gates and unknown
blocks (1.5 high) are obstacles, never floors. A body standing on one anyway starts its walk from a perch, a start
node with no floor of its own (Track R5, "A walk starts from wherever the body stands"). Costs are ticks (`DEFAULT_COSTS`):

| Move | Where | Condition | Cost (ticks) |
|---|---|---|---|
| walk | 4 cardinal | feet rise <= 0.5625 (auto-step), or a step down within 0.5625 (also into the cell below: farmland, dirt paths) | `walk`: 3.564 (sprint allowed) or 4.633 |
| stairs walk (`walk`) | 4 cardinal | a rise or fall of up to 1.25 the body takes as two auto-steps: a stairs block's low half faces the mover (see "Stairs and partial blocks") | `walk` + `stairs` 1 |
| diag | 4 diagonal | same feet height exactly; both side cells standable at it | `walk` x sqrt 2 |
| jump | 4 cardinal | rise in (0.5625, 1.25]; the start column free up to the target's head. From a partial floor high in its cell (feet above `y + 0.75`: a chest 0.95, a dirt path 0.9375) the target can be two cells up (a full block beside the node's own cell, Track AX) | `jump` 9 |
| drop | 4 cardinal | target column free from the feet to the head, fall through free cells, at most 3 blocks | `walk` + fall(n) (5 / 7 / 9) + `landing` 2; + `irreversibleDrop` 30 when higher than 1.25 |
| long drop (`drop`; Track BI) | 4 cardinal | `falls` policy: nothing to land on within 3, the first floor below within `maxScan` (48); harmless, a water-bucket clutch, or damage within the health budget (see "Long falls") | `walk` + fall(n) + `landing` + `irreversibleDrop` + (0 / `clutchCost` 40 / HP x `hpCost` 40) |
| walk through a doorway | 4 cardinal | door / gate cells let the 0.6-wide corridor pass now, or after a toggle (needs `useBlock`) | `walk` + `door` 10 per toggle |
| dig-through (`walk` + `act.dig`; Baritone `MovementTraverse`) | 4 cardinal, same level | `allowBreak` + `dig`; full-block floors; the 1 or 2 body cells ahead are breakable (rules below), the upper one with the falling stack over it (`includeFalling`) | `walk` + per cell (break ticks + `dig` 12) |
| walk through a doorway | 4 cardinal | door / gate cells let the 0.6-wide corridor pass now, or after a toggle (needs `useBlock`); the doorway within a step of the feet, also one cell up from a partial floor (a dirt path or carpet in front of the door, whose own cell is not part of the corridor), and out of it onto a floor a step lower in the cell below (Track AX) | `walk` + `door` 10 per toggle |
| dig-through | 4 cardinal, same level | `allowBreak` + `dig`; full-block floors; the 1 or 2 body cells are breakable (rules below) | `walk` + per block (break ticks + `dig` 12) |
| (dig rules, 2026-10-30) | | every dug block costs `digPenalty` ticks (setting, 60) on top of its break time, so a route walks around anything it can; nothing is broken within `protectRadius` (48) of home (`BreakRules.protectedArea`, `protected_area`), and built blocks (`isBuiltBlock`: planks, bricks, stairs, slabs, glass, doors, wool, concrete, tables, ...) are `protect` like containers everywhere (ores never are: `copper_ore` and `quartz_ore` matched the `copper_` / `quartz_` prefixes until 2026-10-31, every copper ore skipped as `protected`). The miner's approach and sight-line digs and the farmer follow the same rules (`nav.breakRules()`). Track BD: nothing is placed there either: the pillar (plain and break-then-pillar, `astar.ts` `inArea`, the worker alike) is refused inside `protectedArea`, for every goto with `allowPlace` (`!top`, `returnUp`, the mine composite); a miner's shaft is outside the area by construction, but a natural pit 2+ deep inside the base is no longer pillared out of |
| ascend with breaks (`jump` + `act.dig`; Baritone `MovementAscend`, Track BC) | 4 cardinal, one up | `allowBreak`; the start stands on a full block, the target's floor is a full block, the same-level cell is blocked; breaks the head room over the start (x, y + 2), the target's feet cell and the cell over it (the top one with the falling stack); refused whenever a gravity block sits 3 above the start, head room broken or not (Baritone's rule, kept even with `allowGravityAbove`) | `jump` 9 + per cell (break ticks + `dig`) |
| descend with breaks (`drop` + `act.dig`; Baritone `MovementDescend`, Track BC) | 4 cardinal, one down | `allowBreak`; a known full floor two below, the three body cells of the lower column breakable (the top one with the falling stack); never into liquid (liquid cells and cells beside one are refused); into open ground (the two cells over the floor ahead free: a staircase down) only towards a goal below the node, into rock or under a lintel whenever the plain drop is blocked | `walk` + fall(1) 5 + `landing` 2 + per cell (break ticks + `dig`) |
| downward (`downward` + `act.dig`; Baritone `MovementDownward`, Track BC) | straight down | `allowBreak` + `allowPlace` with `throwaway` blocks for the depth below the start + 4 (the pillar back up); only towards a goal below; the shaft rules of `mine/tunnel.ts` `shaftRule` (`moves.ts shaftBlocker`): a known full floor under the dug block, no liquid in it or its 4 side neighbours 1 to 2 below, no pointed dripstone in the 3 x 3 within 3 below, no gravity block over the head, never within 2 of the world floor; the dug block passes the break rules except the under-feet one (this is the one move that digs the floor) | fall(1) 5 + `digDown` 6 + break ticks + `dig` |
| pillar-up (Baritone `MovementPillar`) | straight up | `allowPlace` + `place` + a throwaway block in the inventory; full-block feet; head room above, or (Track BC, `allowBreak`) the cell above the head breakable (`act.dig` then `act.place`; refused under a gravity block) | `jump` + `place` 10 (+ break ticks + `dig`) |
| sneak (`sneak`; ours, Track BC: the owner pointed out that sneaking fits the body through smaller gaps) | 4 cardinal, same level | into, through and out of a cell the body only fits sneaking (`moves.ts sneakFits`): the feet cell passable over a full floor, the head cell blocked only by boxes whose underside is at least `sneakHeight` 1.49 above the feet (a top slab: 1.5; a top trapdoor: 1.81; a bottom slab or a carpet under a top slab: no); a standing body (1.8) is BLOCKED there, so these are sneak nodes: only sneak moves leave them (no jumps, drops, diagonals or digs); the follower holds sneak for the whole move; `moves.sneak` switches it off | `sneakWalk` 15.44 (`walk` / `sneakScale` 0.3; Baritone's SNEAK_ONE_BLOCK_COST is 15.385) |
| swim (into water) | 4 cardinal | a still-water surface cell (see "Movement variety") at the feet level or up to 3 below; the column above it free up to the head | `walk` + fall(n) + `swimEnter` 10 |
| swim | 8 neighbours on the surface | both side cells swim cells for a diagonal | `swim` 8.6 (x sqrt 2) |
| swimOut | 4 cardinal | a standable bank with feet from the water cell's level up to 1 above | `swimOut` 14 |
| climb | up / down a column; onto it from its foot, its side (no floor) or its top | ladder / vine cells (`grid.climb`), the cell above the body passable | `climbUp` / `climbDown` 5 per block; from the side `walk` + `climbEnter` 8, from the top `walk` + `climbDown` + `climbEnter` |
| climbOut | 4 cardinal off a climb node | a floor beside the column, feet from the node's level up to 1 above | `climbUp` x rise + `walk` + `climbExit` 8 |
| hatch down (`climb`; Track BG) | 4 cardinal, then down | a trapdoor (any half, open or closed, any facing) in the walking layer or one below, a ladder / vine under it: onto the ladder below the hatch (see "Trapdoors") | `walk` + `climbDown` per block + `climbEnter` (+ `door` 10 when it is toggled) |
| hatch drop (`drop` / `swim`; Track BG) | 4 cardinal, then down | the same hatch without a ladder under it: a floor within `maxDrop`, or water up to `HATCH_WATER_FALL` 16 below | as drop (`irreversibleDrop` over 1.25) / swim (fall + `swimEnter`) (+ `door`) |
| hatch up (`climb`; Track BG) | straight up | from a climb node to a hatch over the column (closed: toggled from below; open: the climb continues past the panel), then `climbOut` | `climbUp` (+ `door`) |
| parkour | 4 cardinal | 1- or 2-block gap at the feet level, clear up to the head (+3), a floor at most 3 below or water at most 4 below, no lava / hazard / ladder in it; full-block landing at the same height or 1 lower that stops an overshoot; 2-block gaps need 2 standable cells behind the takeoff | g x `walk` + `parkourAir` 12 (1 lower: `parkourAirDown` 14) + `parkourRisk` 10 (+ `parkourRunUp` 12 for g = 2) |

Scaffold walks (2026-10-30, decision 0051; no planner change): `BotSkills.scaffoldGoto` runs a goto with
`allowBreak` + `allowPlace` while a hook on the navigator's `dig` / `place` actions records every block the
walk places (`ScaffoldRecord`, skills/place/scaffold.ts) and counts dug + placed blocks; past the budget it
cancels the walk (`block_budget`). During such a walk the pillar places the throwaway kinds that come back
when dug (`BotSkills.scaffoldItems`: harvestable by the hotbar's tools or the hand, the fastest first). The
collect skill's `hard` option uses it for items the plain walk cannot reach and digs the recorded blocks
again afterwards (docs/wood.md "Pickups that may dig and place"). The feller's pillar does not use the
planner: it places with the PlaceSkill directly (docs/wood.md "Pillar-up").

Every move into node B also pays: B's floor `costFactor` (x 5 on leaves, soul sand, honey, slime, mud,
ice) on the base cost, and `underground` (6) when a roof block is anywhere above B's head. Lava and
hazards are never entered; water only by the swim moves, on its surface (Track AJ), and the dive moves under it (Track W1). Heuristic: `walk` x octile distance, plus for
goals at a known height the levels to it (`columnH`, Goals below: admissible within 4 levels, priced beyond them, so not admissible
overall, as Baritone's GoalBlock is not). Path nodes carry `cost` (the move's ticks, for the per-move timeout) and `act`
(`dig` cells, `use` doors, `place` block).

**Surface preference.** `NavGrid.skyTop(x, z)` is the highest `roof` block of a column (anything with a
box except leaves, and liquids), scanned down from the column's highest non-empty subchunk and cached
in a 16 x 16 array per chunk; a block update in the column resets it; an unloaded column is "unknown"
(no penalty, not cached). `underground` (default 6 ticks per node) and `irreversibleDrop` (default 30)
are `PathCosts` fields (`path.costs` in NavigatorOptions, or per `findPath`). A partial path's end
score adds the accumulated irreversible-drop penalty, so a segment never ends at the bottom of a pit
when a node on the rim is as close (Track BA: the score is Baritone's, see "Segments, re-planning and
stuck handling").

**Doorways.** `crossing(x, y, z, axis)`: a door / gate cell is clear when no box of it (doors: the
lower half's state, also for the upper half) blocks the corridor x or z in [0.2, 0.8] a body walking
along that axis through the cell's centre sweeps; `toggle` when the toggled state would be clear (an
open gate has no box; a door panel swings to the perpendicular edge); else blocked. Only cardinal walks
enter or leave doorway nodes.

**Trapdoors** (Track BG, decision 0048; `grid.ts` `hatch` / `hatchLets` / `isPanel`, `astar.ts` `hatchDown` /
`climbUpInto` / `hatchUse`). A trapdoor in a floor or a ceiling, usually over a ladder shaft, is a vertical
passage. `grid.hatch(x, y, z)` is `CROSS_CLEAR` for an open trapdoor whose panel (one full-height box at most
0.25 thick) leaves the 0.6 body room beside it and beside a ladder's box in the cells y - 1 .. y + 1 (free width
>= 0.62), `CROSS_TOGGLE` for a closed one that would leave that room open and is hand-usable (wooden), else
blocked (iron, too tight, not a trapdoor). An open panel is `passable` (an open trapdoor cell is free to the
body except the panel; it is never a floor). Moves:
- down: from a standable node beside it, a hatch in the walking layer (the cell the feet enter) or in the floor
  layer one below (the ladder ending under it); a ladder / vine under the hatch gives a climb node on it, else
  the column is scanned down for water (a swim node, up to 16 blocks) or a floor within `maxDrop`;
- up: a climb whose next cell up holds a hatch (closed: `act.use` on it, then the climb goes on; open: the
  climb goes past the panel) and `climbOut` beside the column, the panel's side refused by `hatchLets`;
- a closed hatch costs `door` (10) and needs `allowOpen` (`useBlock`); `moves.trapdoor = false` switches the
  hatch moves off (the planner worker gets the flag with `moves`).
The navigator toggles before the move like a door (the use action re-checks `c.open` in the world model after
the click; failures time out and re-plan) and, with `closeTrapdoors` (setting, default true), closes the hatch
behind the body once it is in another column or its head is below the hatch (within reach 4.5; not after a
drop into water). A replan keeps the pending closes. The follower holds sneak on ladders (no slipping off at
the top), keeps the body 0.08 off a panel while climbing, and drops into the tight gap of a panel opposite the
ladder (0.63 for a 0.6 body: within 0.0125 of the middle) by aligning on the floor first with single-tick
forward pulses (BDS corrects a fractional move vector, measured), then walking straight in.
Track BG2 (Realm findings, decision 0048): a click while sneaking with anything in the hand is not a use on
BDS / Realms (the server tries the item and sends the old state back), so `UseSkill` releases sneak from the look
ticks to the tick after the click and presses it again (the navigator leaves sneak to a running use / close). A
close that fails is clicked once more, then left open (`closeFailed` in the report): no goto failure, no retreat.
A re-plan schedules the pending close after the last node whose body is in the hatch cell (a re-plan while
climbing through it, or from a node already out of it, dropped the close before). The climb controller backs
up to a column centre behind the body instead of turning round first. Pillars need the cell 3 above the feet
free (PlaceSkill's head room for the jump), so a 3-high room gets no pillar plan.

**The moves that dig** (Track BC, wave 11; `nav/baritone/moves.ts`, Baritone's movements, LGPL-3.0). Every
move above with `act.dig` lists its cells in break order (the start's head room first, then each column top
first); the follower digs them all before the body moves (nav/actions.ts "the break order"), the Digger's
tool choice as always. `PathOptions.allowGravityAbove` (`Navigator.allowGravityAbove`, `path.allowGravityAbove`;
forwarded to the worker) switches the gravity rule to Baritone's: a stack over a dug cell is paid for
(`includeFalling`) and dug again when it lands (the navigator waits `DIG_SETTLE_TICKS` 12 after such a dig
and once more before the body walks in). `PathOptions.throwaway` (the hotbar's throwaway count, from the
inventory) bounds the dig-down depth. `PathOptions.moves.digAscend` / `digDescend` / `digDownward` turn
the three new moves off (dig-through stays with `allowBreak`). Digging down into open ground is planned only
from nodes above the goal's lowest point (`block` / `near` / `getToBlock` y, `yLevel`, the members of an
`any`; never for `xz`, `surface` or `runAway`, which have no height): without that gate A* digs the whole area under the
search layer by layer, because every open floor ahead is one cheap dig away (9 211 expansions for a goal
inside a dirt block in the 48 x 48 test world, 4 405 with it). Not taken from Baritone: `MovementDiagonal`
breaks nothing either (it edges round one blocked corner, cost x (sqrt 2 - 0.001), and refuses two); ours
refuses any solid corner because the footprint line check would collide; `MovementTraverse`'s bridge
branch (placing the floor ahead), `MovementDescend`'s `dynamicFallCost` (longer falls with breaks, falls into
water, the water bucket) and `MovementFall`'s break column: our drop rules stay (Track BI added long drops and the clutch with its own code, see "Long falls"); `MovementPillar` on ladders
and in water columns.

**Breaking rules** (`breakBlocker` = `nav/baritone/helper.ts` `avoidBreaking`, Track BB; the table in
"Rules" below): no unknown, air, liquid or unbreakable blocks; never a block next to water or lava (6
neighbours); never one with a gravity block on top (or an unsupported one beside it); never the floor
under the start or the target (only the dig-down move digs the block under the feet, under the shaft rules); never containers, beds, spawners, lecterns, hoppers,
furnaces and the like (`TerrainClass.protect`), built blocks, doors and gates, or names in
`protectedBlocks`; never ice (it becomes water) or infested blocks; never a cell a dig already failed
on during this goto. Break ticks come from the break-time table with the best hotbar tool
(`breakTicksWith`: `chooseTool`, docs/digging.md), or an empty hand without an inventory.

Search limits: a main plan 20 000 nodes / 40 ms of search time, a plan-ahead 20 000 / 100 ms
(`segmentNodes`, `mainMs`, `segmentMs`; `path.maxNodes` / `path.maxMs` override both); a search runs at
most `sliceMs` (8) per tick. `status`: `found`, `partial` (limit hit, or the search touched unloaded
world; `unknown` / `limited` say which), `none` (exhaustive and fully known: unreachable).

## Long falls (Track BI, wave 11)

The owner noticed that a bot stuck on top of a mountain declared its goal unreachable, although it could fall
and survive, or clutch with a water bucket. The drop move stops at `maxDrop`
(3 blocks, no damage); with a fall policy (`PathOptions.falls`, read live before every plan:
`Navigator.fallPolicy`, wired by `BotSkills` to its `FallGuard`, docs/movement.md "Falls and the water
bucket clutch") a cardinal neighbour whose column is free from the feet down past `maxDrop` is scanned on
down to `maxScan` (48) blocks (`skills/fall/plan.ts longDrops`, called by `astar.ts` after the plain drop
scan; the worker runs the same code, the policy is a plain object in `WorkerPlanOptions.falls`). On the
first floor below it takes the cheapest of:

| Way | When | Cost on top of the drop's ticks (`walk` + fall(n) + `landing`) and `irreversibleDrop` 30 |
|---|---|---|
| harmless | the landing does no damage (hay from up to 12 blocks, honey up to 6) | 0 |
| damage | the damage (measured model, armour enchantments) within `hpBudget` = health + absorption - `fallMargin` (8) | damage x `hpCost` 40 (a 12-block fall, 8 HP: 320 ticks, about 90 blocks of walking) |
| clutch | a damage drop within the budget that the FallGuard will clutch (`policy.ts clutchHelps`: more than half the budget; `falls.clutch`: a water bucket in the hotbar, the `clutch` setting, not in the Nether; the landing block takes a clutch: a full block that takes no water with air above, or a bottom slab, `waterlog.ts clutchTarget`; the fall at most `clutchMaxDrop` 40; outside `noWater`, home's `protectRadius`). A bucket never makes a drop beyond the budget plannable: a clutch only saves HP, never a life (it can fail; review B1) | `clutchCost` 40 + a quarter of the HP cost (the risk it fails); a tie goes to the damage drop |

Never onto slime or a bed (the body bounces), never into water (the follower's swim move holds forward
through the fall; the FallGuard handles a fall into water anyway), never with `maxDrop` below 3 (the End).
The policy is off (`hpBudget` 0, no clutch) while the health is unknown, the bot burns, or a hostile is
within 16 blocks (`blocked`); harmless landings stay allowed. Those three pass by themselves within seconds, and
the policy says what the budget is once they have (`afterBlock`, Track R4): a goto whose only way is such a fall
holds for it instead of ending unreachable ("A fall closed for a moment (Track R4)" below). With the setting
`hostileFallHp` (0, off) a hostile near caps the budget instead of closing it. A long drop is a `drop` node; the follower
walks it like any drop (creep off the edge, let go of forward in the air), and the FallGuard clutches it by
its own rule (the planned clutch drop is that reactive clutch). Every tick the body still stands before a
long drop the navigator asks the live policy again (`Navigator.dropCheck` = `FallGuard.acceptsDrop`, the
same scan): health dropped, a hostile came, the bucket left the hotbar, the landing changed: the body stops
and re-plans, and that landing stays out of the plans for 200 ticks (`FallPolicy.refused`, review L1). Until a damaging landing's health packet arrives (or for 40 ticks), its predicted damage counts against the budget (review M1: two chained drops on a laggy server). While the water is picked up the follower holds still (`Navigator.pauseFollow`), and re-plans
wait until the flow has receded (`Navigator.holdPlans`, 16 ticks after the pickup). A ladder or vine in the
column ends the scan (no fall: the climb moves).

A goto that ends `unreachable` gets a `note` when a long fall would have reached the goal
(`fall/explain.ts`: one more plan with the budget lifted, in-thread but capped at 25 ms / 15 000 nodes, and not when the blacklist refused the goal): `the way down is a 12-block drop (8 HP), refused:
it would leave 4 HP, the margin is 8` (or `refused: on fire`, `a hostile 10 blocks away`, `health
unknown`, `long falls are off (!set longFalls on)`). `!goto` prints it in parentheses.

Settings: `longFalls` (on), `fallMargin` (8 HP), `clutch` (on), `clutchMaxDrop` (40 blocks). Measured on
bds-gaunt (`test/e2e/fall-long.test.ts`, twice): the 12-block tower walked in 85 ticks, 8 HP (the model's),
0 corrections; at health 12 the note above, the body still on top. The planner cost of the scan: 300 random
paths on the hilly test world, p50 2.44 / p99 18.3 ms without, 2.52 / 18.8 ms with the policy.

## Rules

Wave 11 Track BB (the Baritone port; decision 0043). Baritone's `MovementHelper.java` (the static rules
every movement asks: can I stand here, walk through this, break this, place here, what does breaking
cost) is ported to `nav/baritone/helper.ts` over our `TerrainClass` (shapes from the registry data,
decision 0024) and the block registry's hardness / tool table (`skills/dig`). Before, the rules lived in
three places with gaps between them: `terrain/classify.ts` (the stand / passable classes), `nav/actions.ts`
`breakBlocker` and `mine/tunnel.ts` (the cell checks of the tunnels). Now `NavGrid` (`passable`, `stand`,
`swim`, `crossing`), the planner worker's mirror grid (the same `NavGrid` class over `worker-grid.ts`),
`breakBlocker` (the planner's dig-through and the follower's dig actions, the miner, the farmer, branch
mining), the miner's `TunnelCell` (`tunnel.ts` `tunnelCell` / `wire.ts`) and the Digger's tool choice
(`bestTool`) call the helper, so a rule changes in one place and the worker needs no mirror of its own.
Everything is pure; the per-cell rule functions allocate nothing (`ruleCell` and `cellReaderOf`, off the hot
path, return one small object); a `CellReader` (`NavGrid`, or `cellReaderOf(source)` over any
`TerrainSource`) answers the neighbour lookups. The rules the owner set stay by name: `digPenalty`,
`protectRadius` (`BreakRules.protectedArea`), `isBuiltBlock`, the break rules, the shaft rules of
`mine/tunnel.ts` `shaftRule`. Baritone's settings are fixed constants here (`WALK_ON_MAGMA` false,
`WALK_ON_BOTTOM_SLAB` true, `ASSUME_WALK_ON_WATER` false).

Where Baritone and our measured BDS rules disagree, the safer rule is kept (the "Kept" column):

| Rule | Baritone (`MovementHelper`) | Ours before Track BB | Kept, and why |
|---|---|---|---|
| `canWalkThrough` (may the body occupy a cell) | YES: air, plants, open and closed wooden doors and gates (iron doors NO), a carpet or a snow layer under 3 layers over a floor, a still water source with nothing flowing and no liquid above; NO: fire, cobweb, end portal, berry bushes, powder snow, dripstone, cocoa, skulls, amethyst, azalea, slabs, trapdoors, honey, end rods, lava, flowing water, cauldrons | no collision box (a ladder's thin box aside), no liquid, no hazard, no scaffolding | ours, as a ternary: a still water source is MAYBE and only the swim moves enter it (`NavGrid.swim`: no flow-push model); doors and gates are not "walked through" but planned per axis (`crossing`, `standThrough`; a closed iron door or trapdoor in the way is CROSS_BLOCKED since Track BB, it cannot be opened by hand: `interact/use.ts handUsable`); carpets and snow layers from 2 layers are floors in their own cell (measured, decision 0022) rather than passable; every hazard without a box (fire, berry bush, powder snow, wither rose) is NO |
| `canWalkOn` (a floor) | normal cubes except magma (setting), bubble columns and honey; azalea; ladders and vines; farmland, dirt paths, soul sand; chests; glass; stairs; slabs (bottom per setting, default on); water MAYBE (`assumeWalkOnWater`), lava MAYBE (`assumeWalkOnLava`) | the shape: a box top covering the cell's centre, at most 1 high, not a hazard | ours. Honey stays a floor with the slow penalty (x5) although Baritone refuses it: a bot standing on a honey floor must find its start node (see Known gaps; the physics does not model the stickiness). Magma stays no floor (= Baritone's default; `canWalkOn(c, { allowMagma })` is there for a sneaking follower). Known Bedrock differences: glass panes and iron bars are floors by shape (the body stands on the 1-high post; Baritone says NO), mud is a floor (Bedrock's 14/16 box; Baritone's normal-cube test says NO), ladders are never floors (climb nodes, Track AJ), water never (swim moves), lava never |
| `fullFloor` (the floor of the node above) | (the movements test `canWalkOn` of the block below) | `below.floor && below.top === 1` | ours: a node's floor in the cell below needs a top of exactly 1; partial tops (soul sand 0.875, farmland 0.9375, slabs 0.5) are nodes in their own cell |
| `avoidWalkingInto` | any fluid, magma (setting), cactus, berry bushes, fire, end portal, cobweb, bubble column | `TerrainClass.danger`: fire, soul fire, magma, cactus, lit campfires, berry bushes, wither rose, cobweb, powder snow, pointed dripstone, end portal, nether portal, end gateway, lava cauldron; plus liquids | ours (a superset: wither roses, powder snow, dripstone, portals, lit campfires) |
| `avoidBreaking`: liquids | a liquid above; a liquid source beside; a flowing liquid beside unless it falls on; a block over a liquid is fine | water or lava in any of the 6 neighbours (`next_to_liquid`) | ours (stricter: a flow would reach the body; the owner's rule) |
| `avoidBreaking`: gravity blocks | a falling block above is fine (its break time is counted, `includeFalling`); an unsupported falling block beside is refused (`avoidUpdatingFallingBlocks`) | a gravity block above refused (`gravity_above`) | ours for above (the owner's rule) plus Baritone's beside rule (`gravity_beside`: the block would fall when updated). `BreakRules.allowGravityAbove` (off everywhere) switches to Baritone's way for a move kind that wants it (Track BC) |
| `avoidBreaking`: ice | ice refused (becomes water) | not a rule | Baritone's (`ice`: ice and frosted ice; packed and blue ice do not melt). Bedrock: broken ice over a solid block becomes water too |
| `avoidBreaking`: infested blocks | refused | not a rule | Baritone's (`infested`: `infested_*`) |
| `avoidBreaking`: unbreakable | `ToolSet` returns a negative speed: COST_INF | the break time was Infinity | the rule names it (`unbreakable`: registry hardness -1) |
| `avoidBreaking`: ours | `blocksToDisallowBreaking` (empty), `isPossiblyProtected` (a TODO) | unknown runtime ids, containers / beds / spawners, built blocks (`isBuiltBlock`), doors and gates (`openable`), `protectedBlocks`, `protectedArea` (`protectRadius`), the floor under the feet (`under_feet`) | ours, all of them |
| `getMiningDurationTicks` | 0 when `canWalkThrough`; `1 / strVsBlock` (Java hardness formula) + `blockBreakAdditionalPenalty` (2) x `breakCostMultiplierAt`; `avoidBreakingMultiplier` 0.1 on the speed of crafting tables, furnaces, chests; `includeFalling` adds the stack above, recursively | `breakTicks` (our measured BDS table with the best hotbar tool) + `PathCosts.dig` (`digPenalty` 60, `DEFAULT_COSTS.dig` 12 without the setting), composed inline in `astar.ts` `digThrough` | ours: 0 for a cell with no box, no liquid and no hazard (`digThrough`'s free rule: a hazard without a box such as fire or a berry bush is Infinity, a ladder's box is a built block and Infinity too), the measured table and `digPenalty` otherwise; Infinity for every refused case; no soft multiplier (containers and built blocks are refused outright). The falling recursion is kept behind `allowGravityAbove`. A unit test checks the planner's dig node pays exactly the helper's sum and that fire and ladder cells are refused by both |
| `ToolSet.getBestSlot` / `getStrVsBlock` | the fastest hotbar slot, ties by material cost, silk touch preference, `itemSaver` | `chooseTool` (fewest ticks, then one that harvests, then no tool worn, then the selected slot); worn tools skipped by the Digger (Track S) | ours (`bestTool`, `breakTicksWith`): the Digger, the navigator and the worker call the same function |
| `isReplaceable` (a place target) | air, a one-layer snow layer, large fern / tall grass, `canBeReplaced` | not a rule (pillar-up placed into air only) | Baritone's over Bedrock's replaceable set (air, liquids, fire, grass, ferns, dead bush, seagrass, vines, roots, sprouts, lichen, sculk vein, structure void, light) |
| `canPlaceAgainst` | a normal cube (not bamboo, moving pistons, scaffolding, shulker boxes, dripstone, amethyst) or glass | not a rule | Baritone's over our `fullCube`; unknown blocks never |
| `mustBeSolidToWalkOn` | false for climbables; waterlogged slabs / stairs / trapdoors / scaffolding / leaves by half | not a rule | Baritone's for climbers; the waterlogged cases need layer 1, which the world model does not read (docs/world-model.md): a waterlogged slab answers like a dry one |
| `isBottomSlab` (no ascend from a bottom slab onto a full block) | by state | our stairs / slab walks are measured (decision 0022: a rise within a step is a walk) | Track BC's ascend with breaks starts on a full block (the body's cells are y, y + 1) and lands on one, so the slab case never arises; the planner's own rule stays measured |
| `MovementDownward` / `MovementFall` | dig straight down, fall into water | `shaftRule` (a known solid floor below, no liquid in the column or 1 to 2 below, no dripstone within 3, no gravity block over the top, never within 2 of the world floor) | ours (rule 6): Track BC's `downward` applies them through `moves.ts shaftBlocker`, plus `allowPlace` with the throwaway blocks for the way back; `MovementFall` is not ported |

Track BC (the moves that dig, `nav/baritone/moves.ts`; the table of what Baritone does and what we kept is in
"Measured", Track BC): body cells are tested with `canWalkThroughClass(c) === YES` (the planner's `passable`);
`BreakRules.allowGravityAbove` is forwarded through `PathOptions` and `WorkerPlanOptions` (the worker unit test
compares 20 dig-heavy plans).

Unit tests: `test/unit/skills/nav-baritone-helper.test.ts` (one test per rule, the planner's dig cost against
the helper, the grid's stand rules against the helper), the worker test's rule strip (`nav-worker.test.ts`:
magma, soul sand, berry bushes, powder snow, honey, ice over water, gravel over stone, carpet, snow layers, a
wither rose, farmland, iron doors, infested stone, slabs, a fence, a pane, sand: the mirror answers like the
main grid for every helper function). e2e: `test/e2e/nav-rules.test.ts` on bds-bari (udp/19206, `BARI_BDS_*`;
the nav-* regression suites run there with `MOVE_BDS_PORT=19206 MOVE_BDS_CONTAINER=bds-bari`): a magma strip
walked around, a berry bush line walked around, an ice barrier over lava never dug, a gravel-topped barrier
not dug (and dug once the gravel is gone, the plan's cost carrying the dig ticks), a soul sand floor walked,
slabs and a stairs step walked without a jump.

## Stairs and partial blocks

Measured on bds-move (BDS 1.26.60.6, 2026-10-29; `test/e2e/nav-stairs.test.ts`, block states placed
with the console `setblock` / `fill`, feet heights from `truth:pos`):

| Block (1.26.60 states) | Feet on it | Planner |
|---|---|---|
| stairs `{minecraft:corner, upside_down_bit, weirdo_direction}` | low half +0.5, high half +1 (the body at the centre overlaps the high half: +1) | node = the cell above (feet +1); low half facing the mover: `walk` up and down; high half or side first: jump up, drop down |
| upside-down stairs | +1 everywhere | a full-height floor (jump), the 0.5 overhang below |
| bottom slab `smooth_stone_slab` | +0.5 | walk on and off |
| carpet | +0.0625 | walk |
| farmland, dirt path (`grass_path`) | +0.9375 (block below the feet cell) | walk on and off (a step down into the cell below is a walk, not a drop) |
| snow layer `height` 0 (1 layer) | +0 (no collision) | free cell |
| snow layer `height` n >= 1 (n + 1 layers) | +n / 8 (1: 0.125, 3: 0.375) | floor; walk |

- **`weirdo_direction`**: 0 = high half east (+x), 1 = west, 2 = south (+z), 3 = north; a body walks
  towards the high half to climb (`STAIRS_UP`). Same as minecraft-data's shapes.
- **1.26.60 runtime ids.** BDS 1.26.60 sends every stairs block with the new state `minecraft:corner`
  (none, inner_left, inner_right, outer_left, outer_right). The hashed runtime id includes it, so the
  world registry (1.26.30 data) reports `unknown` for all stairs, which the planner treated as
  1.5-high obstacles and the physics as a 1.5-high box (that was the "does not walk up stairs" report).
  `resolveNewerState` hashes every 1.26.30 stairs state with each corner value and `classify` maps a
  matching unknown runtime id to the stairs block (oak_stairs `weirdo_direction` 0..3, corner none:
  -122484237, -61009414, 465409, 61940232). Other code reading `world.blockAt` still sees `unknown`.
- **Corners** are set by the server from the neighbours (a `setblock` with a corner value is replaced
  at once; removing the neighbour resets it to none). Names as in Java: outer when the block behind
  the high half is a stairs block facing sideways, inner when the block in front of the low half is;
  left = counter-clockwise of the facing (weirdo 0 with a north-facing stairs block east of it:
  outer_left). Shapes: Java StairBlock's quarters (outer: one high quarter, inner: three).
- **Rule** (`PathSearch.stepsUp` / `stepsDown`, from the boxes, `halfTop`): a rise of more than a
  step into a node is a walk when the floor block's half facing the mover is within 0.5625 of the
  feet and the floor's top within 0.5625 of that half; a fall is a walk when the start's floor half
  towards the move is within 0.5625 of both feet heights. So straight stairs from the low side,
  outer corners from a low edge; never full blocks, slabs on blocks, upside-down stairs, inner
  corners, or stairs met from the high half / the side. Head room: as a jump (the start column must be
  free up to the target's head, the body at the low half's height still overlaps it).
- **Feet on a stairs cell.** A body on the low half (feet +0.5) is in the stairs block's own cell;
  `locateNode` returns the node above (feet +1, within its 0.6 tolerance), the follower's "in node"
  and "arrived" tests use the same 0.6. A `block` goal in a stairs cell (a position saved on the low
  half) is planned as the node above it.
- **Diagnostics.** A goto that ends `unreachable` without walking a segment logs one WARN line:
  `goto unreachable without a segment: feet (x, y, z)[ airborne], in <block[states]>, on <block>,
  start node x,y,z feet f | none, goal {...}, why <reason>, plans <reason:status/nodes/expanded/ms ...>`.
  Reasons: `no path (exhaustive search, n nodes expanded)` (with 1 node expanded, Track AX: `: no move
  from the start x,y,z feet f: +x: <cells> ; -x: ...; +z: ...; -z: ...`, `explainStart`: per cardinal
  direction the cells from one below to two above the node's level, each `blocked (<block>)`,
  `doorway feet f`, `unloaded` or `feet f rise r` with `> 1.25`, `(jump)` or `(no head room in a..b)`),
  `the start node is not standable`,
  `no progress possible (no node closer to the goal than the start | no partial end 5+ blocks from
  the start (Track BA, `no_progress`); n expanded[, search limit hit][, touched unloaded world])`, `no standable node at (...)`, `goal cell x,y,z (<block>) is not standable`.

## Movement variety (Track AJ, task 7.7)

Decision record: [decisions/0032-movement-variety.md](decisions/0032-movement-variety.md). Swimming,
ladders and vines, parkour gaps and edge sneaking, each a planner move with a tick cost measured on
bds-move (BDS 1.26.60.6, 2026-10-30) and the follower inputs that execute it; the physics rules
behind them were measured on a strict server (`server-authoritative-movement-strict=true`,
`player-position-acceptance-threshold=0.001`, a private copy of bds-move: every tick the model got
wrong comes back as a correction with the server's position) until scripted inputs gave 0 errors.
To set one up again: copy `docker/data/move` without `worlds/` and `server.properties`, `docker run` the
same image and environment as compose.move.yml on another port (the probes used `bds-movex`, udp 19147),
append those two lines to the generated server.properties, deploy the truth pack with `--restart`, and
point a suite at it with `MOVE_BDS_PORT` / `MOVE_BDS_CONTAINER` (`NAV_TRACE=1` prints the per-tick state
of a goto that got corrections in nav-swim / nav-ladder). Expect corrections with error 0 there (strict
mode also corrects other fields); only the error matters.
All moves are on by default; `PathOptions.moves` (`swim`, `climb`, `parkour1`, `parkour2`) turns them
off per search (forwarded to the planner worker).

**Physics (`input/physics.ts`, measured).**

- Water moves the body (acceleration 0.02, drag 0.8, gravity 0.005, jump key +0.04 per tick) only while
  the body box **shrunk by 0.4 at the feet and at the head** reaches into a water cell (whole cells,
  the liquid height ignored: `LIQUID.waterInset`). A body whose feet are less than 0.4 below the
  top of the surface cell moves with air physics (gravity 0.08, no jump impulse). With jump held a
  floating body bobs with its feet between y and y + 1.05 (surface cell y). The climb-out lift (+0.3
  when pushing against a wall) needs the moved box free of collisions **and of liquid cells**.
  `state.inWater` now reports the water physics (the shrunk box), not mere contact.
- Climbing (the block containing the feet is a ladder, vine, twisting / weeping / cave vines):
  the fall speed is clamped to 0.2 per tick before the move; sneak holds the body (vy >= 0); the
  jump key sets vy = 0.2 before the move (replacing a faster rise, e.g. a jump that carried the body
  into a vine); a horizontal collision during the move sets vy = 0.2 after gravity and drag. No
  horizontal clamp (Java has one, BDS does not). Up and down: 0.2 blocks per tick = 5 ticks per block.
  Verified on 1.26.60 with 0 errors: ladder, vine, twisting vines, weeping vines, cave vines.
  **Scaffolding does not climb that way** (the body stands on it and the server's rules differ: 8
  errors in one probe); the grid treats scaffolding as an obstacle (`grid.ts` `isScaffold`), its
  collision shape from shapes.ts (none) is not trusted.
- Sneak edge avoidance (vanilla maybeBackOffFromEdge, `backOffFromEdge`): on the ground the
  horizontal move of a sneaking body is cut in 0.05 steps towards 0 while the box moved by it and
  0.5625 down meets no block; the test box is shrunk by 0.025 per side (fits the measured stops: the
  box ends 0.029 to 0.038 over the edge block). BDS applies the sneak speed factor also on the first
  tick after the sneak key is released.
- Contact tolerance: float32 positions far from the origin snap past a face they stopped at (ulp
  0.0005 at x 5000), and the next tick walked into the block (local body inside the river bank while
  the server lifted it out: 1 correction of 0.77 per exit in the first nav-swim runs). The
  horizontal tolerance is now 1e-4 or 2^-21 x the larger of |x| and |z| (`contactEpsilon`); a box within it
  stops a move but never pushes the body back by more than 1e-4 (a push-back of up to 0.003 cost a
  correction of 0.006 in nav-compute).

**Grid (`nav/grid.ts`).** `swim(x, y, z)`: a still water cell (liquid depth 0 or a waterlogged plant;
not a bubble column; no boxes) with two free cells above (the bobbing feet rise to y + 1.05) and no
flowing water, lava or hazard beside it (flow push is not modelled); depth-1 water over a floor
(wading) counts too. `climb(x, y, z)`: a climber cell with a passable cell above. A climber's thin box
(a ladder) does not block a cell any more (`free`, `stand`, the head room); `climberLets` keeps a walk
from crossing a ladder's box (entering its cell towards the box is fine: the body stops in front of
it). `variety` bits (water / climber / ladder seen) let the planner skip all of this on terrain
without them (the 1000-path benchmark is unchanged).

**Planner (`nav/astar.ts`).** Swim and climb nodes are flagged; a goal is never reached in them (Track W1:
except a `near` goal around a point in water). Swim nodes are always surface cells; travel under water is Track
W1's dive nodes (see "Water (Track W1)").
Water is entered from a standing node at the feet level or by a drop of up to 3 onto the surface;
left onto a bank up to 1 block above the water cell. A ladder is climbed from its foot (the feet cell
is a climber, the floor below it), entered from its side at the feet level (a shaft without floor) or
from its top (step off over the column: the slide stops on it); left onto a floor beside the column
from its level up to 1 higher (the block behind a ladder at its top). Parkour is planned from a node
next to a hole found by the drop scan (no floor at or 1 below the feet level).

**Follower inputs (`nav/follower.ts` `variety`).**

| Target | Inputs |
|---|---|
| swim | forward towards the farthest swim node (up to 6) whose straight line keeps the footprint over swim cells; jump held in the water (bobs at the surface); no sprint (a sprinting body in water starts swimming, not modelled; a sticky sprint is ended on the bank) |
| swimOut | forward towards the bank, jump held while wet: the push against the bank lifts the body out (+0.3) |
| climb | outside the column: walk to its centre (slowly within 1 block); in it: hold the centre 0.1 off a ladder's box (the middle of a 1 x 1 shaft's free space) with gentle forward / back pulses (touching the box or the opposite wall while sliding would climb); standing on the ladder's top, walk on slowly until the body drops into the column; jump while below the run's end, nothing to slide down, sneak to hold at the run's end |
| climbOut | climb (jump) pushing towards the exit while more than 0.3 below its floor (the push climbs as well), then hold the feet in [floor, floor + 0.15] (jump / sneak) and walk onto it |
| parkour | forward straight at the landing; jump when the body centre is 0.15 (walking) / 0.3 (sprinting) from the takeoff edge and within 0.25 of the lane; a 2-block gap is sprinted, and a body that arrives at the takeoff slower than 0.25 blocks per tick towards the gap (walking is 0.216) backs up 2 blocks first |
| walk / diag (edge sneaking) | sneak while the body centre is within 0.3 of a cell side beyond which the column has no floor within 3 blocks below the feet (or lava / a hazard); no sprint for 10 ticks after a sneak (`edgeSneak`, default on; `Navigator.edgeSneak`) |

**Measured (bds-move, BDS 1.26.60.6, 2026-10-30).**

| What | Result |
|---|---|
| 6-wide, 3-deep river (walls at both ends) | crossed in 105 ticks (37 in the water), 0 corrections, health 20 throughout (server attribute updates every tick, truth:pos at the end) |
| 18-block swimming lane | 8.55 ticks per block on the surface (steady part; 143 ticks in the water for 18 blocks); `swim` = 8.6 |
| 1-deep ditch (wading) | 65 ticks, 0 corrections |
| 10-block ladder in a 1 x 1 shaft, up and out onto the block behind | 96 ticks, 5.00 ticks per block, 0 corrections |
| the same ladder down from the top edge and out of the shaft | 112 ticks, 5.00 ticks per block, 0 corrections (holding the column 0.1 off the ladder: 0.15 touched the opposite wall of the shaft and climbed, 2 to 3 corrections) |
| 10-high vine wall, up onto the top | 96 ticks, 5.00 ticks per block, 0 corrections |
| 1-block gap over a 4-deep pit with water at the bottom, 20 crossings | 20 of 20 landed, 0 falls, 0 corrections; goto 72 ticks for 13.5 blocks |
| 2-block gap (sprinted run-up), 20 crossings | 20 of 20, 0 falls, 0 corrections; 108 ticks (the body arrives walking and backs up 2 blocks for the run-up) |
| 2-block gap landing 1 lower, 20 crossings | 20 of 20, 0 falls, 0 corrections; 108 ticks |
| 1-wide, 20-long bridge with a right-angle turn 7 above the ground, starting 0.22 from an edge, 5 walks each | edge sneaking off: 5 of 5, 0 falls, 0 corrections, 87 ticks; on: 5 of 5, 0 falls, 0 corrections, 72 sneak ticks per walk, 145 ticks |

Both parkour moves landed 20 of 20 and stay enabled. Edge sneaking changed nothing measurable on the
bridge (the follower already holds the lane: 0 falls and 0 corrections either way) and costs time
(sneaking at 0.3 x speed while the centre is near an edge); it stays on as the safety net for a body
pushed towards an edge (knockback, a landing off-centre). It cost 1 correction per walk until the
model learned that BDS keeps the sneak speed for one tick after the release.

Limits: no swimming on flowing water's surface (no flow push model; Track W1 swims through flowing and
falling water under its surface: see "Water (Track W1)"), no sprint-swimming; no scaffolding; no
ladder-to-ladder side steps, no jump off a ladder; parkour only cardinal, 1 or 2 blocks, the same height or
1 lower, and only over water or at most a 3-block drop; no jump up across a gap. Twisting / weeping / cave
vines climb in the physics but have no e2e course.

## Water (Track W1)

Decision record: [decisions/0070-water-travel.md](decisions/0070-water-travel.md). What the owner saw
(Realm, 2026-11-06, `!follow` through a cave): the bot did not know it was in water (`start node none` over
and over while it sank to the bottom), its head stayed under water for 38 s before the surface rule swam it up,
and it could not climb up water. Track W1 plans through water on the surface (Track AJ's swim nodes) and under
it (dive nodes), within the air supply, and keeps a following body at the surface.

**One source of truth (`nav/water.ts`).** The planner, the navigator and the follower read these rules;
nothing else in nav decides "in water" on its own.

| Question | Rule |
|---|---|
| in water (`bodyInWater`) | the water physics test (`InputLoopState.inWater`: the body box shrunk by 0.4 at the feet and the head touches a water cell), or water in the feet cell, or in the cell under it while the feet are less than 0.6 above that cell's top (a body bobbing at the surface leaves the physics test for a tick or two) |
| head under water (`headUnderWater`) | the eye (feet + 1.62) under the water surface of its cell (a source 8/9 high, falling water full) |
| air | the server's `air` (set_entity_data, 0..300; `MobTracker.selfAir`, wired by commands-portal.ts as `skills.nav.air`), else the navigator's `AirClock` (down 1 a tick with the head under, up 4 a tick out of it) |
| water a body moves through (`diveWater`) | any water block without a box or hazard: a source, flowing or falling water, kelp, seagrass; not a bubble column (its push is not modelled) |

Left outside (other owners): survival/surface.ts `headInWater` (the SurfaceProcess, by block name),
fall/damage.ts and fly/landing.ts (liquid names for landings).

**Start node.** `Navigator.preferNode` answers `swim` whenever `bodyInWater`; `locateNode` then finds the
surface node or, under water, the dive node of the feet cell. While a plan is searched or a corridor awaited
the navigator holds the body's depth in water (`idleBody`: jump while it sinks) instead of releasing every key.
A correction while swimming or diving (the server's flow push, a waterfall's lift) re-plans only when it leaves
the body more than 1.5 from the leg (`WATER_ON_PATH`): the water controllers steer from wherever the body is.

**Dive nodes (`NavGrid.dive`, `moves.dive`, on by default, needs `swim`).** A cell of dive water whose head
cell holds dive water or is passable and that is no surface swim node. Moves (`astar.ts` `expandDive`):

| Move | From, to | Ticks |
|---|---|---|
| down (sneak) | a surface or dive node to the dive node under it | `diveDown` 6 (+ `diveEnter` 4 from the surface) |
| up (jump) | a dive node to the dive or surface node over it (a water column, a waterfall) | `diveUp` 8 |
| across | to the 4 neighbours at the same level, the diagonals with both side cells water | `dive` 10.5 (x sqrt 2) |
| in | from a standing node into water at the feet level that is no surface node (under a low roof, flowing water), or a drop into it | walk + `diveEnter` |
| out (`swimOut`) | from a dive node onto a floor beside at the feet level or 1 higher (the cell over the head water or free for the rise) | `swimOut` 14 (+ `diveUp` for the step up) |
| head under water | every move into a node whose eye is under water | + `underwater` 2 |

**Never over a 1-block lip.** A swimming body does not get out onto a bank 2 above the top water cell
(measured, below); no move is planned there (`swimOut` stays at most 1 above the water cell). A pool whose only
rim is a lip is left by digging a step into it (Track W2: "Digging out of water (Track W2)" below).

**The air budget.** The planned ticks with the head under water since the last breathing node (`wet`, the
moves' own ticks, not the preference prices) stay within `airBudget`: from a breathing start (300 - `AIR_KEEP`
110) / `AIR_MARGIN` 1.5 = 126.7 ticks (about 12 blocks across); from a start under water (air - 20) / 1.5, at
least `AIR_MIN_BUDGET` 60 (so a way up is always found). `AIR_KEEP` 110 is above the SurfaceProcess threshold
(100), so the escape never cuts a planned dive. A partial path never ends with the head under water. A `near`
goal around a point under the surface (its cell and the one above are water: a waypoint on a pool's floor, a
player diving) is reached at a dive node within its radius too, when the stretch there plus the way straight up
to air (`diveUp` a water cell; never under a roof) fits `diveGoalBudget` (the same budget without the minimum).
A `near` goal around a point in water but not under the surface is reached at a surface node only (Track AJ).

**Follower (`nav/follower.ts` `dive`).** Towards the node's column (centred in it for a move up or down the
same column: a 1 x 1 shaft, a waterfall), the height held with the server's keys: jump while below the node
(0.135 a tick up), sneak while more than 0.4 above it (about 0.2 a tick down; never with forward: BDS slows a
sneaking swim differently from the model), else jump only while sinking; no sprint. A dive node is reached with
the feet from 0.45 under to 0.55 over its height. Up a column onto the surface: centred in it. A path that is
its start alone at a surface or dive node (a `near` goal reached at once) is held there like a swim / dive node;
a final surface or dive node is reached within 0.7 of its centre.

**Follow (`follow/follow.ts`).** In water with nothing driving the body (close to the target, a plan reached
while the target drifts) the jump key is held: it treads water at the surface instead of sinking (the Realm's
"sank to the bottom while following"). In water `close` holds to the stop distance + 1 (the body bobs) and a
walk in progress is not cut short at the stop distance; "in water" lasts 10 ticks after the physics test drops
(a bob's top). A reached plan counts as settled while the body is within the stop distance + 1 (a target that
drifted less than `replanDistance` is not re-planned for ever).

**Physics (`input/physics.ts`).** The sneak key in water adds -0.04 a tick the way the jump key adds +0.04.
Still not modelled: the flow push (a waterfall lifts faster than the model, a current drifts the body) and
sprint-swimming.

**Coarse layer (`coarse/costs.ts`).** A walker's water volume costs `SWIM_TICKS` 10 a block (the fine
planner's 8.6 on the surface, 10.5 under water across, 8 up; was 3 x `WALK_TICKS` = 12); a horizontal opening
into, out of or between water volumes is walkable at `SWIM_CLEARANCE` 2 x 1 without a floor; up out of water onto
floor cells or into water counts. The layer's types are unchanged; a water volume does not say whether its way
runs on the surface or under it (the fine planner keeps the stretch under water within the air).

**The water course (truth pack `truth:water list | build <name> x y z | clear <name> x y z`).** Six stations
(`packs/truth/src/water-layout.ts`, the same layouts the unit tests plan on): `pool2` (2 deep), `pool6` (6 deep
on a 6-high platform, also a start on its floor), `column` (a 1 x 1 water column 8 high in a stone block, entered
under water from a sunken basin), `waterfall` (falling water in front of a 12-high wall up to a shelf), `lip` (a
pit whose rim is 2 above the water, with one step out in a corner), `tunnel` (two dry rooms joined by a 3-long
sump under a roof). Two server facts shaped them (measured): a water fill with a side open to air beside other
water flows out at once (the column's first inlet spread 4 flowing cells in front of it), so no station has a
water face towards air but at its top; and `setblock ... flowing_water` keeps the kicked cell a source that
falls and also spreads one cell forward, which falls too: the waterfall is 2 wide (`flows` lists the cells the
server ends up with; the e2e compares the bot's world with them: 0 stray, 0 missing on every station).

**Measured (bds-fly, BDS 1.26.60, 2026-11-06).** The probe (a raw client in a 6-deep pool, the model stepped
beside the server):

| What | Server | Model |
|---|---|---|
| idle in deep water | -0.025 a tick down | the same, 0 corrections |
| sneak from a slow sink | v.y -0.158 after 8 ticks, 3.7 blocks in 30 ticks | -0.158 after 8 ticks (2 corrections of 0.81 before the sneak rule, 0 after) |
| jump from the floor | 0.135 a tick up in still water | the same, 0 corrections |
| jump in the waterfall | about 0.17 a tick up | 0.135 (1 correction of 0.2 per climb: not modelled) |
| forward under water | 0.098 a tick steady, 0.089 from rest | the same, 0 corrections |
| forward + sneak under water | 2.5 blocks in 40 ticks | 2 corrections of 0.56 (the follower never sneaks with forward) |
| a current (flowing water at the feet) | drifts the body 0.03 a tick | not modelled (2 corrections of 0.69) |
| forward + jump against a bank 2 over the top water cell, 300 ticks | the feet bob from 0.98 under to 1.55 over the top cell's floor; never out | the same, 0 corrections |
| air under water (no Respiration) | down 1 a tick (300 to 13 in about 290 ticks), refilled within seconds at the surface | `AirClock` |

The e2e (`test/e2e/nav-water.test.ts`, `truth:water` stations, the server's air wired; final run):

| Station | Done | Ticks | Plan (swim, dive, swimOut) | In water | Air low | Health | Corrections |
|---|---|---|---|---|---|---|---|
| pool2 (2 deep, across) | yes | 120 | 9, 0, 1 | 60 | 300 | 20 | 0 |
| pool6 (6 deep, across) | yes | 120 | 9, 0, 1 | 60 | 300 | 20 | 0 |
| column (in under water, 8 up) | yes | 101 | 3, 9, 1 | 75 | 236 | 20 | 0 |
| waterfall (up to the shelf) | yes | 136 | 2, 12, 1 | 84 | 246 | 20 | 1 (0.20, the waterfall's lift) |
| lip (out at the step) | yes | 100 | 3, 0, 1 | 35 | 300 | 20 | 0 |
| tunnel (the 3-long sump) | yes | 118 | 2, 5, 1 | 59 | 252 | 20 | 0 |
| pool6 from its floor (6 under) | yes | 101 | 5, 4, 1 | 67 | 250 | 20 | 0 |
| pool6 from the bank to a point on its floor (`near` r 1.5) | yes, 1.0 from the point | 88 | 8, 4, 0 | 64 | 277 | 20 | 0 |
| follow a player through pool2 (truth:tp moves it across) | yes, on the far bank after 13.1 s | 261 | 9 plans | 158 | 300 | 20 | |

Follow: mid-pool the bot was 3.0 from the swimming target with its feet at the surface (lowest over 4 s 0.7
under the top water cell's floor), air 300 throughout; the same in the three final runs. Before the treading rule the bot sat on the pool's floor
there (air 255 to 175 over 4 s, low 145); before the settled slack it stopped 4.4 from the target.

The model's closed loops over the same layouts (`nav-water.test.ts`): pool2 122 ticks, pool6 122, column 102
(air low 264), waterfall 132 (246), tunnel 118 (255), pool6 from its floor 101 (186 from 200), lip 98, pool6 from
the bank to its floor 88 (292); 0 stuck.

The owner's cave offline (Track F5a's private fixture, the walk navigator in a closed loop over it, route A's 22
legs as F5a's harness walks them, `near` r 1.5 at each leg's feet cell): 15 of 22 legs walked before Track W1, 19
of 22 after. Legs 3, 5, 6 and 7 start or end in the cave's water (a floor under 1 to 7 water cells, a 30-block
flooded passage); before, each failed at once (`no standable node`, `start node none`); now each swims or dives
(129 to 254 of its ticks in water). The 3 legs left fail dry: a start the cache reads as a 2-high step, a 21-high
climb through a narrow shaft (search limit) and a 14-block drop (the long-fall policy is not wired in the
harness).

Limits: no flow push model (a waterfall climbs with 1 small correction; no swimming against a current on the
surface); no sprint-swimming (the swim pose and its 1-high gaps); bubble columns are refused; a start in water at
an explicit `plan(goal, from)` is not located (`locateNode` without the preference; plan from the body's own
position). Out over a 1-block lip or a taller bank: by digging (below).

### Digging out of water (Track W2)

Decision record: [decisions/0070-water-travel.md](decisions/0070-water-travel.md) "W2: digging out". A swimming
body cannot climb a bank 2 above the top water cell on BDS (W1, measured), so a pool or a flooded hole whose only
rim is a lip, or a taller bank, had no way out. The owner's decision: break out, not place. One module says how
(`nav/digout.ts`); the planner plans it in the same search as every other move, so a swim exit wins whenever it is
not far longer.

**The step (`digOut`, `swimOut` with breaks).** From a surface swim node (cell level `cy`, the top water cell)
towards a side with no bank to climb out onto: the block at the water's level beside it (`cy`) must be a full
floor; the lip (`cy + 1`) and, where it is not free, the block over it (`cy + 2`, the head room) are broken, the
higher first, and the body climbs out onto the block at the water's level (feet `cy + 1`: the W1 `swimOut`). The
move is planned from a surface node only (the head out of the water: the air does not run down while the bot
digs; under water the server breaks 5 x slower again). Its price: `swimOut` + per broken block the break time
with the best tool x `WATER_DIG_FACTOR` 5 + the dig penalty (`PathCosts.dig`: the `digPenalty` setting, 60 by
default) + `DIG_OUT_PENALTY` 200 once.
A grass lip by hand: 14 + 90 + 60 + 200 = 364 ticks, about 40 blocks of swimming: a swim exit up to that much longer
wins (the unit tests: the W1 `lip` station's step 4 blocks off is taken, a 40-long canal's far step is not).

**The stair.** The step's node and any node a plain `swimOut` reaches start a staircase (`F_CUT`): from them,
and only from them, a jump with breaks (Baritone MovementAscend, `baritone/moves.ts` `ascend`: the head room over
the start, the target's two body cells) is planned without `allowBreak`, each new node on the stair too (and a
plain jump up from one: a stair cut before), up to `DIG_OUT_MAX_STEPS` 8 steps. A stair from a plain `swimOut` pays `DIG_OUT_PENALTY` at its first dug step. No other
move digs: a walk that may not dig (`allowBreak` off, the default) breaks nothing but its way out of the water
(`PathNode.cut` carries the step count, so a re-plan from a node of the stair goes on up it: `startCut`; a new
goto from the stair gets out of the water again first). With `allowBreak` on the ordinary dig moves do the same.

**The rules.** Every broken cell passes the break rules (`breakBlocker`: protected and built blocks, containers,
beds, doors, inside `protectedArea` (the base around home), a liquid in or next to it, a gravity block above it,
an unsupported gravity block beside it, the blacklist) and one more: a cell the best tool would take longer than
`DIG_OUT_MAX_TICKS` 200 ticks to break from the water is refused as "no tool" (stone by hand: 750; no punching
stone; dirt, grass or sand by hand: 75 to 90, allowed; stone with a wooden pickaxe: 115). Water cannot flow into
the cut (its cells are above the water's level and none is next to a liquid); the navigator plans again after
every block it breaks from the water all the same.

**Trapped.** A search from water that finds no way (none, or a partial that goes nowhere) carries the refused
steps (`PathResult.digOut`: by reason, the first block of each); the goto fails `unreachable` with the reason
`trapped in water: no swim exit and no step to dig (stone: no tool breaks it in time x 20; 50 nodes expanded)`
(nav/digout.ts `trappedWhy`; `lastGoto.why`).

**Navigator (`nav/navigator.ts`).** `Navigator.digOut` (`NavigatorOptions.digOut`, default on; needs the dig
action) sets `PathOptions.digOut` on every plan (also in the worker). A dig action from water treads water (jump
while sinking: the eye stays out of it), never starts a dig while the head is under (waits up to `DIG_HEAD_WAIT`
40 ticks for it to come up, then gives the step up), passes the server's break-time modifiers to the Digger
(`NavActions.dig(p, { conditions })`, `waterDigConditions`: off the ground; else the Digger's timeout at 1.5 x the
dry ticks ends a dig the server is still running), and plans again after each break.

**Measured (bds-fly, BDS 1.26.60, 2026-11-06).** The probe (the body treading water at the surface beside the
lip pit's rim, onGround false for every tick, the eye above the water):

| Block, tool | On the ground (the table) | From the water (server) | Table x the off-ground modifier |
|---|---|---|---|
| grass by hand | 18 | 90 | 90 |
| stone, wooden pickaxe | 23 | 113 | 113 (speed / 5: ceil(112.5)) |
| stone, iron pickaxe | 8 | 38 | 38 |
| dirt by hand, on the pool floor with the head under water | 15 | 75 | 75 (the in-water modifier, on the ground) |

The e2e (`nav-water.test.ts`, the dig-out pools of `truth:water`, final run):

| Station | Done | Ticks | Blocks broken | In water | Air low | Health | Why |
|---|---|---|---|---|---|---|---|
| `lipDirt` (grass lip, by hand) | yes | 147 | 1 | 104 | 300 | 20 | |
| `lipStone` (stone lip, by hand) | no, trapped at once | 1 | 0 | | 300 | 20 | stone: no tool breaks it in time x 20 |
| `lipStone` (wooden pickaxe) | yes | 168 | 1 | 125 | 300 | 20 | |
| `bank3` (a 3-high bank, by hand) | yes | 318 | 6 (the stair) | 163 | 300 | 20 | |
| `lipBuilt` (stone-brick rim, iron pickaxe) | no, trapped at once | 1 | 0 | | 300 | 20 | stone_bricks: protected or built x 20 |

0 corrections, 0 stuck, no stray water after any run (the bot's world against the layout); two runs within 2
ticks of each other. The W1 runs in the same suite as before (pool2 and pool6 122, column 101, waterfall 136, lip
102, tunnel 118, pool6 from its floor 101, the follow on the far bank after 13.0 s). The stations (the W1
lip pit, 5 x 5, water 2 deep, without its step): `lipDirt` (the ground's grass as the rim), `lipStone` (the pit in a
stone block 7 x 7 x 3), `bank3` (the pit through a dirt mound 2 high: the bank 3 blocks above the water's top
cell, the goal on top), `lipBuilt` (a stone-brick rim).

Limits: no dig from under water (a flooded passage with no surface: every cell beside it is next to water, which
the rules refuse anyway); no step dug at the water's own level (that cell is next to the water); a 2-high sand or
gravel bank is refused (the gravity rule: the lower block has sand above it); placing a step is not planned (the
owner's decision).

### When the plain walk finds no way (Track W3)

Decision record: [decisions/0070-water-travel.md](decisions/0070-water-travel.md) "W3: the dig way". The owner's
requirement: when the bot does not fly a route through the waypoints they set, it must walk it, every leg, and
unhurt. The owner's cave rebuilt on bds-fly (Track F5a's replica, the fly-cave e2e `walkA`, 22 legs) walked 21 of
22 legs on main: one leg had no way (a 3-high step: the world cache reads a stair or slab as a full cube, so the
replica has a stone cube where the cave has a step), one leg cost 8 HP (a planned 12-block drop, though an 8-block
dug way existed), and every walk leg of a corridor trip whose waypoint stands on a water floor was refused at once
(`goal cell ... (water) is not standable`: the corridor executor walks to the waypoint's cell, a `block` goal).

**A goal cell in water.** A `block` goal whose cell holds water (a waypoint set standing in shallow water, or a
point on a pool's floor) is reached at a surface swim node in that cell, or a dive node in it within the air
budget (the W1 `diveGoal` rule for a `near` goal under the surface); the navigator no longer refuses it as not
standable (astar.ts `waterBlockGoal`, navigator.ts `waterGoalCell`).

**The levels (`nav/digway.ts`).** A goto plans in levels, each only after the one before it found no way:

| Level | What it plans | When |
|---|---|---|
| 0 | the plain walk (no digging unless the goto allows it); falls only where they do not hurt (the long-fall policy's damage budget held at 0, no clutch) | every goto |
| 1 | the dig way: the moves that dig (`allowBreak`), natural terrain only, at most `DIG_WAY_MAX_BLOCKS = 12` blocks a goto, each priced `DIG_WAY_PENALTY = 100` ticks on top of its break time and the dig penalty, a block the best tool takes longer than `DIG_WAY_MAX_TICKS = 200` ticks to break on the ground refused; still no fall that hurts (a drop is dug down) | the dig way is on (`digWay`), the dig action is wired, the goto does not dig anyway, the budget is not spent |
| 2 | the falls that hurt, as the long-fall policy allows them (decision 0057), the dig way still open with a hurt priced `DIG_WAY_HP_COST = 400` ticks a HP | the policy has damage to give (health known, above the margin, no hostile near, not burning) |

"Found no way" is an exhaustive `none`, a main search that went nowhere (`no progress possible`, after the wait for
unloaded world), or a worker's final plan that says `none`. A level change is not a failure (the goto's failure
count is untouched) and re-plans at once; the retry skip (the same search from the same node) keys on the level. A
corridor waypoint with no way is the corridor's failure first (Track CB: the walk falls back to the raw goal), not
a level change. The natural-terrain test is place/scaffold.ts `isNaturalTerrain` (stone, deepslate, dirt, grass,
sand, gravel, ores ...; never planks, bricks, glass or anything a player builds); every dug cell also passes the
break rules (`breakBlocker`: the protected area around home, a liquid in or next to it, a gravity block above it,
containers, beds, doors, the blacklist). Stone by hand is 150 ticks (7.5 s) a block: allowed; obsidian never. The
dig-out stair of W2 (`F_CUT`) does not count against the budget (it has its own, `DIG_OUT_MAX_STEPS`).

**Settings.** `Navigator.digWay` (`NavigatorOptions.digWay`, default off in the library) is read at every plan; the
session wires it to the setting `digWay` (walking group, default on: tasks/registry.ts). With it off a goto goes
from level 0 to level 2: the long falls of decision 0057 as before, but only when no harmless way exists.

Measured on the owner's cave: see the decision's "W3" addendum (the replica's coordinates stay out of the repo).
The water course has four W3 stations (`W3_STATIONS`, the bot starts on dry ground, the inventory empty, the dig way
on as the session has it): `step2` (a stone block 2 high, 7 x 9: the goal on its top, one block dug), `step3` (the
same block of dirt 3 high: a stair of three blocks cut into its face), `drop6` (the start on a stone plateau 6 high:
every way down is a 6-block fall, 3 HP; the bot digs down instead), `wetGoal` (a 1-deep water floor, 5 x 9, flush
with the ground: the goal is a water cell on it).

The e2e (`nav-water.test.ts`, the W3 stations of `truth:water` on bds-fly, BDS 1.26.60, 2026-11-07; by hand, the
planner worker as the session has it):

| Station | Done | Ticks | Blocks broken | Fall damage | Note |
|---|---|---|---|---|---|
| `step2`, the dig way off | no, unreachable | 443 | 0 | 0 | the level-0 search ran to the edge of the loaded world (115 365 nodes) |
| `step2` | yes | 635 | 1 | 0 | about 20 s of it the level-0 search over the open flat world |
| `step3` | yes | 544 | 3 (the stair) | 0 | |
| `drop6` | yes | 1021 | 6 (stone by hand, 7.5 s each) | 0 | the 6-block fall (3 HP) never taken |
| `wetGoal` | yes | 45 | 0 | 0 | done in the water cell, 25 ticks in water |

0 corrections, 0 stuck, health 20 throughout; the W1 and W2 stations in the same suite as before (pool2 120, column
101, waterfall 136, lip 100, tunnel 118, lipDirt 145, lipStone with a wooden pickaxe 175, bank3 315, the trapped
pools refused at once with their reasons). Without the worker (the in-thread 40 ms search) the `step3` dig-way plan
is cut off: a level change waits for a full search (never on the stand-in's cut-off one while the worker starts).

Limits: the budget is 12 blocks a goto (off a tower 20 high the goto still gets down, digging no more than 12, the
rest a fall at level 2 when the policy allows it); level 0 must find no way before level 1 is planned, so over open
ground the dig way waits for a level-0 search that runs to its budget (`step2` above: about 20 s); a long walk whose level-1 plan is partial walks it (a segment towards a far goal) and may dig on
the way; placing blocks is not part of the dig way (the owner's decision for W2 holds: break out, not place); a
water floor's flowing water is reached diving (a dive node in the goal cell), never swum against a push the
physics does not model.

## Reachability (Track R1)

Decision record: [decisions/0072-reachability.md](decisions/0072-reachability.md). The promise: `!goto` says
"unreachable" only when it is, and then says why. Walking, swimming and digging are the guarantee (flight is the
flight track's). An unreachable answer carries one of four cause classes (SkillResult `cause`, the words in `note`;
the `!goto` reply is `goto: unreachable (<words>)`):

| Class | `cause` | Meaning | Words |
|---|---|---|---|
| (a) | `world` | the world closes the way: no walk, swim or dig gets there even with every owner's rule lifted | `world: no walk, swim or dig gets there` |
| (b) | `rule:<rule>[+<rule>]` | an owner's rule closes it: lifted alone the way opens (several only together: all named) | `rule <rule>: <what it forbids>` |
| (c) | `unloaded` | the goal is in unloaded world (the body heads there first: the frontier end below) | `unloaded: the goal is in unloaded world, walk closer` |
| (d) | `budget` | the searches ran out before they could tell, or a way under the rules exists and the goto did not make it (a walk that stuck): a bug, the bench hunts it | `budget: the searches or the walk ran out before the goal` |

The rules, by the names the bench's oracle uses too:

| Rule | What the owner's rule forbids | Lifted in a "why" search |
|---|---|---|
| `protected_area` | digging inside the base sphere (home, `protectRadius`) | no `protectedArea` |
| `built` | breaking a player's built block; the dig way digs natural terrain only | `PathRelax.built`: the break rules and `digWayBreakTicks` pass built blocks (containers, beds, spawners never) |
| `liquid` | digging a cell with water or lava beside it | `PathRelax.liquid` |
| `gravity` | digging under a gravity block or beside an unsupported one | `PathRelax.gravity` |
| `falls` | a fall that leaves less than `fallMargin` | the policy's budget to health - 1 |
| `dig_budget` | more than `DIG_WAY_MAX_BLOCKS` 12 blocks a goto, or a block slower than `DIG_WAY_MAX_TICKS` 200 | 4096 blocks, `PathRelax.slow` |
| `place` | placing a block (a pillar, a bridge): `!goto` never places | `allowPlace` with 64 throwaway blocks |

**How the navigator says why (`nav/reach.ts`, `GotoOptions.explain`, set by `!goto`).** Where a goto would end
`unreachable` after its searches (the failures run out, the same search from the same node, an exhaustive `none`),
it first asks why, from where the body stands, towards the goto's own goal (not a corridor waypoint), the body
holding still:

1. a goal cell in unloaded world: (c) at once, unless the goto's last search was exhaustive (the owner's rules close the
   loaded world round the body) or its partial plans looped: then the steps below ask for a way to the unloaded world (the frontier end, a "why"
   search's frontier before its bests); a goal cell nobody can stand in: open, over nothing (mid-air) and not sealed,
   `rule:place`, else (a), at once (a natural block the dig way may open is no such cell: its level digs it out);
2. the goal sealed (`sealedPocket`: a flood from the goal cell through everything a body could open, air, water,
   anything breakable, stops at bedrock and lava within 20000 cells, meets no unloaded cell and not the start): (a);
3. one search with every rule lifted: none found, exhaustive: (a); cut by its budget: once more with `BIG_SEARCH` 4 x
   the budget (the rest of the run too), cut again: (d);
4. found: the rules its path breaks are read off it (`rulesOnPath`: its placed blocks, its falls over the owner's
   budget, its dug cells against each break rule, its dig count): one rule is the answer;
5. none read off: the way is open under the rules, (d); several: each alone, those first, then the rest, until one
   opens the way (named alone); none alone: the ones the path broke, together. At most `EXPLAIN_MAX_SEARCHES` 5 searches a goto.

The "why" searches ask whether a way exists, not how good it is: the heuristic weighted (`EXPLAIN_WEIGHT` 8), the
dig price and the dig way's penalty off, the worker's main budget each. No plan they find is walked. A goto
without `explain` (every other caller) ends as before.

**What the bench found, and the fixes** (scripts/reach-bench.ts, below; each class has a station, a unit test or
both):

| Failure class | Seen as | Cause | Fix |
|---|---|---|---|
| a search cut by its budget taken as an answer | ravine and pit pairs unreachable (level 2's fall searches are slow, 25-35 nodes/ms) | a limited no-progress search escalated, counted a failure, recorded "no retry" and said "trapped" like an exhaustive one | asked again once per node, level and waypoint with `BIG_SEARCH` 4 x the budget; a limited worker search records the no-retry only after its bigger search, and never says trapped |
| the goal's floor dug | a tower top reached by a stair cut through its own top (pits:1:13) | the dig way's stair took the goal's floor block | the goal's floor cell is in `noBreak` (station `tower3`) |
| standing on a cell the path dug | a 1-wide stair: three move timeouts, unreachable (pits:3:10) | a move's floor was a cell an earlier move of the same path digs | `astar.ts` refuses a move whose floor its own path dug (`dugOnTheWay`; the oracle has the same rule) |
| a corridor waypoint with no progress | a cliff's edge: the goto waited for chunks past the server's view, the levels never came (long:2:7) | no progress towards a waypoint "touched unloaded world", so it waited | the corridor's failure at once (no failure counted, unless the waypoint's own cell is unloaded), the raw goal with its levels next |
| a dig budget overspent | 14 blocks dug of 12 (caves:1:8) | a plan-ahead from the path's end got the whole budget left, the digs still ahead on the path not counted | a plan-ahead's budget is what is left after the path's digs still to be done |
| a lava death | the follower cut a corner over a lava cell (lava:1:12) | the corner tolerance (0.35) let the body cross the cell beside the node | beside a hazard the follower centres to 0.15 on each node and aims no farther (station `lavaRun`) |
| a turn beside lava | lava:6:0, lava:6:10, lava:7:10 dead once the bench's lava flowed | at a node beside lava the body passed its centre still moving out of a diagonal, or walked on while still turning: the arc crossed into the lava cell | beside lava a turn node is braked into and left below `HAZARD_TURN_SPEED` 0.05 blocks a tick, and no step is taken facing more than `HAZARD_AIM_ERR` 10 degrees off the aim |
| a drop beside lava | lava:11:10 dead after a drop into a cell beside lava | the fall's coast carried the body past the landing's centre | no forward press when the coast from the body's velocity puts its box in lava; a drop into a cell beside lava creeps off at 0.05 blocks a tick |
| a corner cut diagonal to lava | lava:20:9 dead at the turn after a segment's end | a new leg began at a node the body was not centred on; the straight line to the next node swept the box over the lava cell diagonal to the turn | when the line from the body to its aim sweeps the body's box through lava, the follower goes back to the leg's node's centre first |
| a drop held on its ledge | lava:2:12 unreachable after three move timeouts at a 1-block drop beside lava (the slow creep above) | the leg's end brake (within `arrive` of the landing's centre) held the body on the ledge, still standing on it | the end brake waits until the body is off the ledge above a drop |
| a goal under a flooded cave's roof | water:7:10 `budget` after 22 s of "why" searches cut by their budget | the planner ends a plan at a goal under water only with air straight over it (the way up); the oracle counted the water over it up to the roof and called it reachable | the oracle asks for air over the water column as the planner does; the "why" asks no search for such a goal: (a) at once |
| partial ends that lead to each other | lava:14:10, lava:14:12 walking (or standing) until the goto's cap: 2000 plans, or 1247 blocks back and forth | from either of two partial ends the other was the best end of a closed search (towards a corridor waypoint and the raw goal in turn); plan-ahead segments ping-ponged and the skip-ahead held the body in each new copy of its node | a plan-ahead segment that ends on a cell the path already went through is refused (the body walks to the end first); a partial main plan that ends where an earlier partial plan of the goto began (the same level) is no progress: the corridor's failure, the next level, or a failure counted |
| a plan-ahead that comes back over the path | hills:20:13 timed out after 240 plans from the same cell, 1456 blocks walked | the partial end was a dead end; the next segment ran back along the path, then on; the skip-ahead put the body on the copy coming back, the off-path check (its window on that copy) sent it back to the start, and the same three plans came again | `OFF_PATH_LOOP` 6 partial off-path re-plans from one cell (one level) are no progress, as the loop above: the next level (the dig way) arrived in about 2750 ticks. (Splicing the segment in at the cell it comes back over fixed this pair but cost two goals far in unloaded world that arrive by that escalation: rejected) |
| partial ends at unloaded world taken for a loop | the strip of nav-v2 (chunks that come late) unreachable at once | the partial ends at the edge of the loaded world met the loop check above before the chunks came | a loop whose plan touched unloaded world first waits for the chunks, at most `unloadedWaitTicks` 200 a goto, never reset (reset by the plans in between, a far goal waited until the goto's cap) |
| a dive under a low roof | water:12:8 drowned at the mouth of a flooded tunnel two high (water, then air under its roof) | the diving body floats 0.27 over the node; its head met the roof and it stood there | under a block two over the target's feet cell the body is sunk to within 0.19 of the node first and never bobbed up (`DIVE_ROOF_ROOM`) |
| a rule named for a stuck walk | `rule:protected_area` for a goal the owner's way reached (water:8:7) | the search with every rule lifted found a way that broke no rule; the nearest rule was named | no rule on that path: (d) `budget` (the bug is the walk's) |
| an unloaded goal behind a cliff | no progress at a cliff, the way round past the loaded world (unknown:6:1) | the partial end must be 5+ blocks from the start and closer to the goal | at a goto's last level, for a goal in unloaded world, the frontier end: the node touching unloaded world with the lowest g + h (`PathOptions.frontier`, `FRONTIER_MAX_LEGS` 6 a goto) |
| a corridor's last face in the sky (trip C) | the cruise ended over a cave mouth and walked at a cell in the air | a partial corridor's last leg handed the cruise its end face | the leg lands towards the trip's goal (or the standable cell nearest the face); never a walk to a cell nobody stands in |
| a "why" search cut by its budget | long trips answered `budget` (long:1:0, long:1:1) | the search with every rule lifted ran out of nodes under load | once more with `BIG_SEARCH` 4 x the budget before the answer |
| an unloaded goal from a closed pocket | `unloaded` where no walk or dig of 12 left the cave (caves:2:12) | an unloaded goal answered (c) at once, though the owner's rules closed the loaded world | after an exhaustive last search, the "why" searches ask for a way to the unloaded world (`PathOptions.frontier`, the frontier before the bests) |
| a mid-air goal | `world` for a goal over open air (caves:3:7) | a goal cell nobody stands in was (a) | open and over nothing, not sealed: `rule:place` |
| a goal cell in the rock (flyC) | the corridor's walk leg unreachable at once: its end was a stone cell beside the opening | the goal-cell check said "nobody stands there" before the dig way's level; the leg handed over the portal's cell | the dig way's level digs a natural goal cell out; the walk leg ends on the standable cell nearest the portal's |
| a wide opening's centre over the rim (flyC) | the walk down into a pit ended on its rim | the change cell under a wide y opening was the centre column's floor | the dry floor under the opening nearest the way on (`wideOpeningCell`); an unproven window walks to its landing before the stretch's end |

**The oracle (`nav/bench/oracle.ts`).** An exhaustive search, no time or node limit, written apart from the planner
(it reads the bench's voxel palette, not the terrain classes): walk, jump, the doors, drops (harmless within 3,
deeper within the fall budget, into water within 3), parkour over 1 and 2 gaps, swimming on the surface and diving
within the air (a goal under water only with air straight over its water column, as the planner has it), the dig moves (traverse, ascend, descend) under every break rule, the dig-out of water, and
pillaring only with `place` lifted. States carry (dug, damage, wet) labels with Pareto dominance; the goal's floor
is never dug and no move stands on a cell its own path dug. `verdict` runs it under the owner's rules (cumulative
fall budget 12, 12 digs), then with each rule lifted alone, then all: `reachable`, `rule` (with the rules that open
it alone) or `world`. It is checked against the planner (unit test nav-reach-oracle: hand cases for each rule and
class, 80 random pairs plain and 60 that need the rules, the planner with 3 M nodes and the oracle agree on every
one).

(The bench's own fixes: the closed loop ticks on while the skill's goto is pending (it swims up and retries after a
goto that ended under water; the loop used to stop with the navigator idle and hang). Its generators left lava cells
with open air beside them (lava:4:12 died there), and lake water over air that a worm had carved under the lake's
floor (water:8:7 stuck diving into it). The game keeps neither, so `settleLiquid` lets the lava (3 blocks) and the
water class's water (7) fall and spread as the server's does, before the pairs are picked.)

**The bench (`scripts/reach-bench.ts`).** Seeded worlds of nine classes (`nav/bench/worlds.ts`): hills and cliffs,
ravines, worm caves, water (lakes, rivers, flooded caves), lava, builds (houses with and without doors, a fenced
field, a brick compound and a bedrock vault in a protected base), pits and towers, unknown (goals 100 to 180 blocks
out, 4 chunks loaded round the body, no coarse layer) and long trips (200 to 330 blocks, the coarse layer). Each pair
runs the REAL navigator closed loop (`test/unit/skills/reach-sim.ts`: a World fed chunk packets round the body, the
worker with the live budgets scaled to the owner's M4, 1.25 x this PC, the coarse layer over a world cache, the
session's dig way, protection, avoidance and fall policy), and is scored against the oracle: arrived, the verdict,
time, damage, digs, the reply, the cause and whether it agrees. The headline is the false unreachables: pairs the
oracle reaches under the owner's rules that the navigator gave up on.

    node scripts/reach-bench.ts [--classes hills,caves] [--worlds 18] [--jobs 6] [--speed 1.25] [--out f.jsonl]
    node scripts/reach-bench.ts --only pits:3:10 --detail      # one pair: the oracle's witness and the nav log

**Stations (packs/truth/src/water-layout.ts `R1_STATIONS`, built by `truth:water build`).** `lavaRun` (a path
through a lava floor with two corners: walked unhurt), `tower3` (a 2 x 2 stone column 3 high: climbed by the dig
way, the goal floor kept), `vault` (a room sealed in bedrock: `world`), `brickRoom` (a closed stone-brick room:
`rule:built`). The same geometry runs in the bench's closed loop (unit test nav-reach-stations) and on bds-fly
(e2e nav-reach).

**Measured** (this PC, the worker's budgets scaled to the owner's M4 x 1.25, `--jobs 5`; damage in health points of
20). Before the track (the first bench, 837 pairs, worlds 1 to 7 of each class, the generators before
`settleLiquid`): 27 false unreachables of 627 reachable pairs (4.3 %), 1 death (lava), cause agreement 0 (no causes).

| class | before: false of reachable | before: deaths |
|---|---|---|
| hills | 0 of 93 | 0 |
| ravine | 4 of 49 | 0 |
| lava | 1 of 78 | 1 |
| water | 0 of 72 | 0 |
| builds | 0 of 66 | 0 |
| caves | 1 of 62 | 0 |
| pits | 8 of 48 | 0 |
| unknown | 1 of 126 | 0 |
| long | 12 of 33 | 0 |

After (worlds 1 to 20 of every class but long, 2194 pairs, the final code):

| class | pairs | oracle reachable | rule (b) | world (a) | arrived of reachable | false unreachable | deaths | cause agrees |
|---|---|---|---|---|---|---|---|---|
| hills | 280 | 258 | 22 | 0 | 257 (99.6 %) | 1 | 0 | 22 of 22 |
| ravine | 232 | 156 | 76 | 0 | 156 (100 %) | 0 | 0 | 76 of 76 |
| water | 222 | 220 | 0 | 2 | 220 (100 %) | 0 | 0 | 2 of 2 |
| lava | 260 | 225 | 35 | 0 | 225 (100 %) | 0 | 0 | 35 of 35 |
| builds | 260 | 212 | 28 | 20 | 212 (100 %) | 0 | 0 | 48 of 48 |
| caves | 260 | 176 | 84 | 0 | 175 (99.4 %) | 1 | 0 | 83 of 84 |
| pits | 320 | 167 | 153 | 0 | 165 (98.8 %) | 2 | 0 | 149 of 149 |
| unknown | 360 | 360 | 0 | 0 | 358 (99.4 %) | 2 | 0 | - |
| **all** | 2194 | 1774 | 398 | 22 | 1768 (99.7 %) | **6 (0.27 % of pairs)** | 0 | 415 of 416 (99.8 %) |

Damage on the arrived pairs: 0 on 1664, 1-2 on 12, 3-5 on 27, 6-10 on 53, 11-12 on 16. Everything over 2 is in
pits, ravines and hills (level 2's falls, within the fall budget; 11-12 in pits and ravines only); lava, water,
caves and builds stay at 2 or less (3 lava pairs took 1 or 2; the bench does not record the source). Four pairs the navigator reached where the oracle
says a rule closes them: three dug 21 blocks (W2's dig-out of water is not counted in the dig budget), one dug
exactly 12 where the oracle needs a 13th (the two count the last stair step differently). The one cause that does not
agree (caves:5:4) ran to the bench's cap of 6600 ticks without an answer.

The six left, each explained: unknown:6:1 and unknown:18:1 (goals 136 and 156 blocks into unloaded world past cliffs,
no coarse layer: the walk spends the dig budget or the partial ends lead back; `rule:dig_budget`), caves:6:2 (a goal
in the loaded world whose only way runs through unloaded world: no frontier end for it, decision 12), pits:17:5 (a
dig spent before a refused fall; the per-goto dig budget, decision 12), pits:16:11 (the planner finds no 12-dig stair
up the tower that the oracle finds: the last step's count above), hills:16:1 (the body freezes at the bench world's
edge, where the physics has no blocks: a bench artefact).

The long class (trips of 200 to 330 blocks along the coarse corridor, worlds 1 to 6, 95 pairs: the oracle needs
about 4 GB a world, world 1 has 5 pairs only), run apart, four at a time: 35 reachable, 31 arrived, 4 false
(long:2:5, long:2:11 and long:6:5 `rule:dig_budget` after digs spent on the way; long:3:2 `rule:dig_budget` where the
oracle's way needs exactly 12 digs). long:6:5 arrives when run alone (the searches' budgets are wall-clock: four
trips at once plus an e2e cut them short), so the class's number moves with the load. Before: 12 false of 33
reachable. Its causes agree on 47 of 60 rule pairs (15 before the "why" searches also asked for a way to the unloaded world
after partial plans that loop: they answered `unloaded`); the rest name
another rule the loaded world shows (`liquid`, `gravity`, `built`) or ran to the cap, the oracle's answer being the
dig budget or a place, 200 blocks away in unloaded world. No deaths, no damage.

On bds-fly (e2e, this PC): nav-reach 4 of 4 (`lavaRun` walked unhurt, `tower3` climbed with its top kept, `vault`
`world`, `brickRoom` `rule:built`); nav-water 17 of 17. fly-cave on the owner's cave replica with `flyCave` off, three runs: trip C arrived 3 of 3
(0.1 from the goal, 52 to 70 s, no damage); flyC 0 of 9: the flight's underground windows failing (the flight track's,
one run stopped at health 10.8 after 16.6 damage in flight) and the corridor's walk underground answering
unreachable at the roof opening (the limit below).

Limits: the bench's worlds are generated, not the owner's; the 'unknown' class has no coarse layer, so a goal far
past a maze of cliffs can still time out (the body has no memory of where it has been); the explanation costs a few
seconds of searching before the reply; a rule pair is named by what opens the way alone, which is not always what the
owner would change. On the owner's cave replica, flyC's walk down from the roof opening does not arrive: the dry
floor under the opening is a pocket the cave cannot be walked to from. The only walk out of it digs up 6 blocks and
goes round over the surface: about 500 nodes, exactly 12 digs, most of it outside the loaded world. The goto there
answers `rule:dig_budget` (the bench's closed loop on the replica's cells). A loaded goal whose only way runs through unloaded world is
not given the frontier end, which would walk a sealed goal's goto off into the unknown.

### R2: the owner's live settings (allowBreak, allowPlace, digPenalty 500)

Track R2 (decisions/0072-reachability.md "R2") ran the navigator the way the Realm runs it: `allowBreak` on,
`allowPlace` off (on until 2026-11-09, both measured), `digPenalty` 500, sprint, a pickaxe, 2 cobblestone and 64 dirt.
Two live incidents of one evening became private fixtures (`nav/bench/fixture.ts`: a box of the bot's world cache as a bench world, kept out of the
repository in `bot/fixtures-private/`; nothing of the place is in the repository) and were reproduced in the closed
loop before anything was changed.

**Incident 1 (the pillar).** A long `!goto` along the coarse corridor pillared 8 blocks straight up (cobblestone, then
dirt) and answered unreachable from the top. Reproduced to the block: the corridor's mine mode lets a vertical
opening without a floor be "dug or pillared", so its waypoint was a point in the air; the fine plan pillared up to
touch it, the bot's own placed blocks marked the corridor dirty, a new corridor arrived mid-pillar and its waypoint
was unreachable from the top, the opening was marked failed. And with `allowPlace` the searches ran out of budget:
the pillar moves over every flat node took 65 % of a search's expansions (36 779 of 56 212 on the cave entry), so the
partial plans were short and poor.

**Incident 2 (the lake).** The walk from a surface landing into a cave failed over and over ("cut by its budget with
no progress", "no partial end 5+ blocks from the start") and ended with the head under water for 208 ticks. On a
PC at the bench's default speed the walk arrived; at the live planner's speed that evening (below) it failed exactly
as live and drowned in the closed loop. Cause: a partial plan ended on the lake's floor, because one cell in the lake is
passable without liquid (a waterlogged block: the world model does not read the water layer), so the planner thought
the head there was dry; from the floor, every plan's bests were dry nodes worse than the start, so every plan was
"no progress" and the body stayed under water.

**Incident 3 (the long walk out of a cave, from the log).** A `!goto` of 644 blocks from under a roof 13 high took the
corridor in pieces (each search cut at its 500 ms: 81, then 293, then 713 blocks), pillared on its last throwaway block
(one diorite) and answered `place failed: no_item`, then marked one waypoint's portal failed for `walk` and got it back
in the next corridor three times ("corridor waypoint N unreachable (no progress towards it)"). The planner counted
the throwaway blocks only for a dig-down's way back up: any count above 0 allowed every pillar; and the failed mark
was for the leg's mode while the goto's corridors plan in `walk` and `mine`. The goto walked on (360 blocks in 2500
ticks) until the owner's next command replaced it.

The fixes, general:

| fix | where |
|---|---|
| a passable cell without liquid that has water over it counts as water for the head (`submerged`): water over a free cell would flow into it | `NavGrid.submerged` |
| a plan from under water ends with the head out of it: the start is no best and any node with the head out counts, however near (not Baritone's 5 blocks) | `BestSoFar.reset(.., wet)`, `PathSearch` |
| a partial plan never ends standing on a lake's floor with the head under water (a walking node in still water), nor on its own pillar's top | `PathSearch` bests |
| a pillar is tried only with something other than air within `PILLAR_REACH` (8) levels over the feet in the 3 x 3 columns round it (a wall, a ledge, a ceiling, water, unloaded), or the goal over it; open-ground pillars dropped from 65 % to 19 % of the expansions, cheap through the grid's cached column tops | `PathSearch.pillarLeads` |
| the corridor never aims the fine planner at a waypoint in the air (a vertical opening without a floor): the first waypoint on a floor past it | `corridor.ts fineTarget`, `floorless` |
| no corridor re-request and no re-plan onto a new corridor while the body is between its path's pillar moves | `navigator.ts midPillar` |
| a `falls` cause names the fall: `rule falls: a 20-block fall (16 HP) over the fall budget of 12 HP`, or `..., no fall that hurts now: <why>` | `reach.ts fallOnPath`, `fallWords` |
| a goto that digs anyway gets a level 1 when its dig price is above the dig way's (`digPenalty` 500): the same moves at 60 a block, no block budget. At 500 a block a dug way of 9 blocks costs as much as 1000 blocks of walking, past any search's budget: "no progress", `budget` | `navigator.ts digWayOn`, `applyLevel`; `digway.ts DIG_WAY_PRICE` |
| a way the "why" search finds that breaks no rule is walked instead of answering `budget`: the goto plans on with its searches weighted (3 x the heuristic) and digs at the dig way's price, and walks the found way itself when that goes nowhere; twice a goto at most, the failures one short of the limit again | `navigator.ts walkOpenWay`, `adoptOpenWay` |
| the "why" search's way is walked only from the node nearest the body (the weighted plans moved it: "off the path" at once, caves:2:6); a goto that digs anyway, whose searches were cut, plans on weighted once more before a rule the "why" way breaks is the answer (`allowPlace` off: a stair dug up a ravine's wall where the "why" way pillars, `rule place` before) | `navigator.ts adoptOpenWay`, `stepExplain` |
| with `allowBreak` the "why" answer no longer counts the dig way's 12-block budget (a goto that digs freely was told `dig_budget`), and a placed block is a rule only past what a goto that places carries | `reach.ts rulesOnPath`, `navigator.ts ownerOptions` |
| a column's top counts blocks built over the sections the server sent with the chunk (a sky scan started at the highest sent section and missed a build over it: the pillar rule then saw no wall, found on bds-fly) | `terrain/query.ts`, `worker-grid.ts columnTop` |
| the oracle places no block inside the protected base, as the planner does | `bench/oracle.ts` |
| the dig way of a goto without `allowBreak` prices its blocks at the dig way's price at most (60, then its own 100 on top), not `digPenalty` + 100: at 600 a block it found nothing (`dig_budget` on 22 of 553 pairs with `allowBreak` off) | `navigator.ts applyLevel` |
| a path places at most the throwaway blocks the goto carries (counted per node); any count above 0 allowed every pillar before (incident 3: `place failed: no_item`) | `PathSearch.relax`, `PathOptions.throwaway` |
| a corridor waypoint the fine planner cannot reach has its portal marked failed for every mode the goto's corridors plan in (incident 3: the same waypoint failed three times, crossed again in the other mode) | `navigator.ts corridorFailed` |
| a jump up into a node beside lava releases forward in the air once over the step when the coast would pass the node's centre (lava:1:6, `allowPlace` off: the landing slid into the lava beside the node, dead) | `follower.ts` |

**Where and at which budget.** Every R2 number below is from the owner's Mac (the live machine, an M4), through
`scripts/mac-run.mjs`, at `--speed 1`: the live wall-clock budgets as the bot runs them there (2000 ms a search,
500 ms a corridor), not node-bound and not this repository's PC calibration (`--speed 1.25`, Track R1's tables above).
The Mac was shared with the live bot and the owner's `!test` series while they ran (load averages up to about 30; the
runner drops a run to nice 20 during a series), so the walks are, if anything, slower than on a quiet machine. During
the incidents the live bot itself ran on the Mac's efficiency cores (launchd `ProcessType Background`, until
2026-11-09): its searches expanded 28 000 to 100 000 nodes in the 2000 ms where the bench at 1.25 on a PC expands about
140 000, which is why incident 2 reproduced on a PC only at `--speed 0.35`. It runs on the performance cores now.

**The fixtures** (the closed loop, `--fixture incident --repeat 3`, twice with `allowPlace` off, once on; damage in HP
of 20):

| fixture | `allowPlace` off (live since 2026-11-09), 6 runs | `allowPlace` on, 3 runs |
|---|---|---|
| incident 1, from where it stood (`incident-resume`) | 6 of 6 arrived, 4863-5095 ticks, damage 0-1, placed 0, dug 0-1 | 3 of 3 arrived, 4809-5491 ticks, damage 0-2, placed 5-27, dug 0-7 |
| incident 1, from the start (`incident-base`) | 6 of 6 arrived, 4890-5112 ticks, damage 0-3, placed 0, dug 1 | 3 of 3 arrived, 3798-4280 ticks, damage 0, placed 5-22, dug 0-5 |
| incident 1, from the slope (`incident-slope`) | 6 of 6 arrived, 4012-5124 ticks, damage 0-3, placed 0, dug 1-2 | 3 of 3 arrived, 3477-3978 ticks, damage 0, placed 6-7, dug 2 |
| incident 2, the cave entry (`cave-entry`) | 6 of 6 arrived, 1795-1824 ticks, damage 0, placed 0, dug 0 | 3 of 3 arrived, 1993-1998 ticks, damage 0, placed 1, dug 0 |

No end stranded, no death. Before the fixes: incident 1 ended on its pillar's top answering unreachable, incident 2
drowned at the incident's planner speed (the head under water from the lake's floor until the air ran out). With
`allowPlace` off the walks take 2 to 3 times the wall time (15 to 53 s against 5 to 21 s: more and longer searches)
and about the same ticks. Incident 3 has no fixture (its cache box was not kept): the throwaway count has a guard
test (`nav-r2.test.ts`), the waypoint marks in every mode have none.

**The bench, both configurations** (`node scripts/reach-bench.ts --config live|r1 --speed 1`, worlds 1 to 20 of every
class but long, `--jobs 4` on the Mac, the stranded check on every end: the body cannot get back to its start without
a hurting fall while it could from there before the run, its own placed blocks diggable).

The live settings (`--config live --place off`: `allowBreak` on, `allowPlace` off, `digPenalty` 500, sprint; the Mac,
`--speed 1`, the live wall-clock budgets; 4000 s):

| class | pairs | oracle reachable | rule (b) | world (a) | arrived of reachable | false unreachable | deaths | stranded | cause agrees | placed / dug p90 | damage max |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hills | 280 | 280 | 0 | 0 | 279 (99.6 %) | 1 | 0 | 0 | - | 0 / 18 | 1 |
| ravine | 232 | 232 | 0 | 0 | 232 (100.0 %) | 0 | 0 | 0 | - | 0 / 49 | 2 |
| water | 222 | 220 | 0 | 2 | 220 (100.0 %) | 0 | 0 | 0 | 1 of 2 | 0 / 0 | 0 |
| lava | 260 | 260 | 0 | 0 | 259 (99.6 %) | 1 | 0 | 0 | - | 0 / 23 | 0 |
| builds | 260 | 212 | 28 | 20 | 212 (100.0 %) | 0 | 0 | 0 | 48 of 48 | 0 / 0 | 2 |
| caves | 260 | 259 | 1 | 0 | 257 (99.2 %) | 2 | 0 | 0 | 1 of 1 | 0 / 108 | 1 |
| pits | 320 | 295 | 25 | 0 | 294 (99.7 %) | 1 | 0 | 0 | 21 of 21 | 0 / 59 | 8 |
| unknown | 360 | 360 | 0 | 0 | 359 (99.7 %) | 1 | 0 | 0 | - | 0 / 9 | 0 |
| **all** | 2194 | 2118 | 54 | 22 | 2112 (99.7 %) | **6 (0.27 % of pairs)** | 0 | 0 | 71 of 72 (98.6 %) | 0 / 37 | 8 |

Ticks p50 411, p90 1241. With `allowBreak` almost every pair is reachable (the oracle's rule pairs are built blocks
and the pillars a goto without `allowPlace` may not build: towers and pit walls). The six: pits:2:13 and unknown:13:17 (`rule place`:
the "why" way pillars, where the oracle's way digs a stair the searches did not finish), caves:2:12 and caves:17:11
(`unloaded`: the only way runs through unloaded world, R1's decision 12), hills:16:1 (R1's bench-edge artefact) and
lava:20:5 (a timeout: the found plans walk a long way round a hill, the body leaves the path at the same corner every
lap, 30 times, and the interim plans lead back; it arrived twice on a PC at 1.25). The cause that does not agree
(water:7:9, the oracle's `world`) ran to the cap. In 4 pits pairs the navigator arrived where the oracle said `rule
place` (it dug a stair round the tower's side, placed nothing). Damage 8 is two pits pairs whose only way is an
8 HP fall (the oracle's way too). Dug blocks: 30 cave pairs dig 100 or more (the most 291 where the oracle's way digs
122): the level 1 and the open walks dig what the owner's rules allow, at the dig way's price.

R1's configuration (`--config r1`, every rule as Track R1 measured it; the Mac, `--speed 1`, the live wall-clock
budgets; 3050 s):

| class | pairs | oracle reachable | rule (b) | world (a) | arrived of reachable | false unreachable | deaths | stranded | cause agrees | placed / dug p90 | damage max |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hills | 280 | 258 | 22 | 0 | 257 (99.6 %) | 1 | 0 | 0 | 22 of 22 | 0 / 6 | 8 |
| ravine | 232 | 156 | 76 | 0 | 156 (100.0 %) | 0 | 0 | 0 | 76 of 76 | 0 / 6 | 12 |
| water | 222 | 220 | 0 | 2 | 220 (100.0 %) | 0 | 0 | 0 | 2 of 2 | 0 / 0 | 1 |
| lava | 260 | 225 | 35 | 0 | 224 (99.6 %) | 1 | 0 | 0 | 35 of 35 | 0 / 0 | 1 |
| builds | 260 | 212 | 28 | 20 | 212 (100.0 %) | 0 | 0 | 0 | 48 of 48 | 0 / 0 | 2 |
| caves | 260 | 176 | 84 | 0 | 175 (99.4 %) | 1 | 0 | 0 | 84 of 84 | 0 / 6 | 1 |
| pits | 320 | 167 | 153 | 0 | 165 (98.8 %) | 2 | 0 | 0 | 149 of 149 | 0 / 9 | 12 |
| unknown | 360 | 360 | 0 | 0 | 358 (99.4 %) | 2 | 0 | 0 | - | 0 / 9 | 0 |
| **all** | 2194 | 1774 | 398 | 22 | 1767 (99.6 %) | **7 (0.32 % of pairs)** | 0 | 0 | 416 of 416 | 0 / 6 | 12 |

Ticks p50 376, p90 1113. The same seven pairs as on a PC at 1.25: R1's six and lava:14:12, a dig way of 8 blocks whose
partial plans lead back and forth (`dig_budget` from there); it arrives at `--speed 1.6` on a PC and fails at 1.0 and
1.25, a pair on the edge of the searches' budget rather than a rule the fixes changed (in R1's configuration no pillar
is tried, and its ends are dry).

**The long class** (trips of 200 to 330 blocks along the coarse corridor, worlds 1 to 6, 95 pairs, `--jobs 3`; the
Mac, `--speed 1`, the live wall-clock budgets):

| configuration | pairs | oracle reachable | arrived of reachable | false unreachable | deaths | stranded | cause agrees | dug p90 / max | damage max | time |
|---|---|---|---|---|---|---|---|---|---|---|
| live (`--place off`) | 95 | 95 | 60 (63.2 %) | **35** | 0 | 0 | - | 168 / 230 | 1 | 3158 s |
| R1's (`--config r1`) | 95 | 35 | 32 (91.4 %) | **3** | 0 | 0 | 46 of 60 | 10 / 12 | 8 | 5036 s |

R1's configuration matches Track R1's numbers (4 false then: long:2:5, long:2:11 and long:3:2 again, long:6:5
arrives here; causes 47 of 60 then). With `allowBreak` every long pair is reachable for the oracle; the navigator
gets 60 of them there and gives up on 35, all of them pairs whose oracle way digs 36 to 57 blocks and takes a fall
of 11 or 12 HP (the fall budget's edge): `budget`
17 (the "why" search with every rule lifted found only a way towards the unloaded world), `rule liquid` 6, `rule
place` 4, `rule built` 4, `rule gravity` 2 (the "why" search from where the walk stood named a rule the oracle's way
avoids), 2 at the bench's cap. The walks behind them: corridor waypoints the fine planner cannot reach (failed and
replaced), searches cut by the 2000 ms budget and re-run at 4 x, the dig way and the hurting falls tried, then
partial plans that lead back and forth. None died and none was stranded. This is where the live settings are weak:
a dug way with a fall at the budget's edge, over hundreds of blocks, needs more than the fine planner's windows find
at the live budgets (not measured further here: a follow-up track for long walks that must dig).

**Which settings to run live** (each switch alone, worlds 1 to 5 of every class but long; the Mac, `--speed 1`, the
live wall-clock budgets):

| settings (`--config live` and) | pairs | oracle reachable | arrived of reachable | false unreachable | deaths | stranded | cause agrees | placed p90 / max | dug p90 / max | damage p90 / max | wall s p50 / p90 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **live**: `allowBreak` on, `allowPlace` off, `digPenalty` 500 (`--place off`) | 553 | 533 | 531 (99.6 %) | 2 (0.36 %) | 0 | 0 | 20 of 20 | 0 / 0 | 42 / 291 | 0 / 8 | 0.3 / 10.8 |
| `allowPlace` on (live until 2026-11-09) | 553 | 537 | 536 (99.8 %) | 1 (0.18 %) | 0 | 0 | 16 of 16 | 5 / 28 | 10 / 152 | 0 / 0 | 0.1 / 10.3 |
| `allowPlace` on, `allowBreak` off | 553 | 509 | 508 (99.8 %) | 1 (0.18 %) | 0 | 0 | 44 of 44 | 5 / 28 | 5 / 12 | 0 / 12 | 0.1 / 21.2 |
| `allowPlace` off, `digPenalty` 60 | 553 | 533 | 529 (99.2 %) | 4 (0.72 %) | 0 | 0 | 19 of 19 | 0 / 0 | 39 / 288 | 0 / 12 | 0.2 / 9.3 |
| `allowPlace` off, `allowBreak` off | 553 | 441 | 441 (100.0 %) | 0 | 0 | 0 | 111 of 112 | 0 / 0 | 6 / 12 | 0 / 12 | 0.2 / 4.7 |
| R1's configuration (both off, `digPenalty` 60) | 553 | 441 | 441 (100.0 %) | 0 | 0 | 0 | 112 of 112 | 0 / 0 | 6 / 12 | 0 / 12 | 0.2 / 5.5 |

The false ones: live, pits:2:13 (`rule place`) and caves:2:12 (`unloaded`); `allowPlace` on, caves:2:12;
`allowBreak` off, pits:5:2 (`rule dig_budget`: the dig way's 12 blocks); `digPenalty` 60, those two of the live row,
caves:5:10 (`unloaded`) and caves:2:8 (231 blocks dug, at the bench's cap of 6600 ticks). With `allowBreak` off the
dig way of 12 blocks is all a goto digs: fewer goals are reachable (441 or 509 of 553 against 533 or 537), the falls
take more (damage to 12 HP) and the walks take longer (the dig way after the plain searches: p90 21 s). Before the dig
way's price cap (decision 17) `allowBreak` off answered `dig_budget` on 22 of these pairs; now on 1. A `digPenalty` of
60 gains nothing: the level 1 already digs at 60 a goto that needs it, and the owner's 500 keeps the plain plans off
digging where a walk exists. `allowPlace` on digs a quarter as much (p90 10 against 42) and takes no fall damage on these
worlds, but leaves the blocks in the world (5 a goto at p90, 28 at most; up to 27 on the incident fixtures).

On bds-fly (e2e, the Mac's bds-fly through the runner, the live budgets): `nav-cave-entry` (the cave entry walk on a
replica of the fixture's box, moved by a multiple of 16: the cache's fly-over, the coarse layer, `!goto` with the live
settings, `allowPlace` off) arrived 3 of 3 (71 s each, no damage, nothing placed or broken, 54 ticks with the head
under water crossing the lake; one move timeout on the hillside, then on); on a PC with `allowPlace` on it arrived 9
of 9, and 10 of 12 before the open walks (two runs stuck on a hillside's jumps: three move timeouts, then `budget`).
`nav-pillar` (`allowPlace` on: only a pillar climbs) 3 of 3 each: the plateau climbed (5 blocks placed, 112 ticks, no
damage); the walled yard `rule:falls`, naming the 20-block fall (16 HP over the budget of 12 HP), the body back on the
ground. Before the column-top fix the walled yard answered `budget`: the ring, built over the chunks' sent sections,
was not in the column tops. `nav-reach` 4 of 4 and `nav-water` 17 of 17 as before.

Limits: a ledge more than 8 levels over open flat ground with nothing in between is not pillared to (a goal there
is); the stranded fallback (ways down: the own pillar dug, a stair dug) is not added, no stranded end having been
measured once the corridor stopped aiming into the air; with `allowBreak` the level 1 and the open walks dig what the
owner's rules allow, many blocks at times (291 on one cave pair of the bench, the 90th percentile 37): the owner's
price applies first, and only a goto that would otherwise fail digs at the lower one; a goto whose searches were cut
and whose "why" way breaks a rule plans on weighted once more before answering (about 20 s more before a rule
answer); the long class and the incident fixtures are the only walks over a few hundred blocks measured.

### Long dig ways (Track R3)

Track R3 (decisions/0072-reachability.md "R3", decisions 24 to 28) took on R2's weak part: with the live settings
35 of the 95 long trips answered unreachable, every one a way the oracle digs 36 to 57 blocks (a stair down one wall
of the bench's ravine, 19 deep, and up the other, or through the escarpment). Their walks went the same way each time:
the corridor's waypoint across the ravine, the main plan towards it cut by its 2000 ms with no progress, the plan at
4 x the budget cut too, the waypoint failed; three such and no more corridors, then plans towards a goal in the
unloaded world, frontier legs, partial plans that lead back and forth, and a "why" answer naming a rule the oracle's
way avoids or `budget`. The coarse layer could not help: its volume model sees the ravine and the air over the
surface as one volume, so its mine mode gives no dug portal there.

**Why the searches went nowhere.** The heuristic prices a block at a walk's 3.6 ticks. A way that digs pays its dig
price in full before the search looks past it, so a crossing whose stair digs 77 blocks has to expand every node
cheaper than it first: the whole loaded world, and every dig into it. Planner experiments on long:1:2's rim (the
planner alone on the bench world, from the rim to the far side 4 lower):

| dig price a block | heuristic weight | expanded | blocks dug |
|---|---|---|---|
| 500 (the owner's, level 0) | 8 | 659 000 | - |
| 60 (the dig way's, level 1) | 1 | 648 000 (9 s) | 77 |
| 60 | 3 | 537 000 | - |
| 60 | 8 | 312 000 | - |
| 60 | 16 | 103 000 | - |
| 60 | 32 | 22 000 | 89 |
| 30 | 8 | 138 000 | - |
| 20 | 8 | 70 000 | - |
| 12 | 1 | 503 000 | - |
| 12 | 3 | 252 000 | - |
| 12 | 5 | 102 000 | - |
| **12** | **8** | **31 000 (240 ms)** | **84** |
| 0 | 8 | 16 000 | 96 |

The live 2 s buy about 130 000 nodes in the Mac's worker.

**The long dig search** (`digway.ts longDigOptions`, `navigator.ts onMainResult`). When a goto that digs anyway
(`allowBreak`) has a main plan and its bigger retry both cut with no progress, it plans once more from that node, at
that level, towards that waypoint, with the heuristic weighted 8 x (`LONG_DIG_WEIGHT`) and every dug block priced at
12 (`LONG_DIG_PRICE`: the planner's own default dig cost, the time a dig takes beyond its break time; never above the
goto's own price), the level's moves, rules and falls unchanged, before the corridor fails, the level goes up or a
failure counts. Only that one plan: the plan-aheads from its end and every later plan are the level's again, so a
walk that exists is still walked at the owner's price. The log says `the long dig search found a way (N nodes, D
block(s) to dig, E expanded) towards corridor waypoint K`; the goto's report counts them (`longDigPlans`).

The fixes:

| fix | where |
|---|---|
| the long dig search, once a node, level and waypoint, after the bigger plan was cut with no progress too | `digway.ts longDigOptions`, `LONG_DIG_WEIGHT`, `LONG_DIG_PRICE`; `navigator.ts onMainResult`, `startMain` |
| its interim answer is never walked, and a partial answer only towards a corridor waypoint (the corridor's next window re-aims it; on a loaded Mac the long crossings came as partial ways of 30 to 50 nodes and the waypoints failed without them): towards the goal itself a partial end of a greedy search that digs cheaply digs into the way (pits:12:10: into the 2 x 2 tower whose stair up had to be cut inside it; from the holes no stair was left, `rule place`). The planner's nodes do not remember what the way there dug, so a weighted search can close a node it reached the wrong way | `navigator.ts onMainResult`, `startMain` |
| not towards a goal in unloaded world: that search went nowhere for the unknown, not for a dug way (R1's frontier legs walk towards it); it tunnelled 54 and 132 blocks on unknown pairs a walk reaches, and caves:10:6 ran to the cap after 278 | `navigator.ts onMainResult`; `astar.ts goalUnloaded` |
| the goto's own block changes do not mark its corridor dirty (a coarse change in a chunk column the goto changed in the last 2 ticks is its own): every dug block re-planned the corridor, and the new plan from the half-dug stair aimed elsewhere | `navigator.ts attachCoarse`, `onBlock` (`ownChunks`) |
| no re-plan onto a new corridor while the path ahead still has blocks to dig (as for a pillar) | `navigator.ts midDig` |
| from the second found final answer in a row that does not meet the interim path, the re-plan walks no interim answer: it waits for its own final, the bench pacing its ticks meanwhile (the first miss re-plans as before) (lava:20:5: the interim plans led west round a hill, the finals east, 30 laps to the cap) | `navigator.ts onUpgradeResult`, `stepSearch`, `awaitingWorker` |
| a goto that digs anyway whose walk stuck (a move timeout, stuck: the last failure) plans on weighted once before a rule the "why" way breaks is the answer, as one whose searches were cut (lava:1:10, 1 run in 3: three drops on a dug way timed out, then `rule liquid`, where the oracle's way breaks no rule) | `navigator.ts stepExplain`, `walkOpenWay` |
| an "off the path" re-plan logs the path round the body at debug level (the nodes from 3 before the passed one to 3 after the aim) | `navigator.ts pathChecks` |

**The long class** (worlds 1 to 6, 95 pairs, `--jobs 3`; the Mac, `--speed 1`, the live wall-clock budgets,
`--config live --place off`):

| run | pairs | oracle reachable | arrived of reachable | false unreachable | deaths | stranded | dug p50 / p90 / max | damage max | wall s p50 / p90 | time |
|---|---|---|---|---|---|---|---|---|---|---|
| R2 | 95 | 95 | 60 (63.2 %) | **35** | 0 | 0 | 11 / 179 / 230 (arrived) | 1 | 65 / 102 | 3158 s |
| **R3** | 95 | 95 | 94 (98.9 %) | **1** | 0 | 0 | 74 / 99 / 120 | 1 | 25 / 48 | 2137 s |
| R3, the long dig search alone (no bounds yet) | 95 | 95 | 95 (100.0 %) | **0** | 0 | 0 | 79 / 104 / 120 | 4 | 27 / 52 | 2400 s |
| R3 without the long dig search (R2's first 12 false pairs) | 12 | 12 | 0 | **12** | 0 | 0 | 5 / 13 / 16 | 0 | 85 / 113 | 483 s |

Of the 35 R2 answered unreachable, 34 arrive; they dig 85 blocks at p50 (104 at p90; the oracle's ways 49), in 31 s
(51 s at p90). The one left, long:2:13, ran to the bench's cap of 6600 ticks: 1119 blocks walked, three of its corridor's
waypoints failed one after another (a partial dug way towards the first, then
partial plans that lead back and forth), the frontier legs after them too slow for the cap. The 37 that dug and
arrived in R2 too dig 70 / 105 at p50 / p90 now against 70 / 195, in 26 s at p50 against 61: the corridor no longer
re-plans the walk off its own half-dug stair. Damage 1 on one pair. Of the 23 pairs a walk reaches, 10 dig 1 to 6
blocks (6 in R2, as few blocks). The second row is the long dig search before its three bounds (decision 24: the
partial answers and the unloaded goal); with them, on a Mac loaded by two benches and the owner's `!test` series at
once (2 s bought 58 000 nodes instead of 130 000) and no partial answer walked at all, 5 long pairs failed their
waypoints, which is why a partial answer towards a corridor waypoint is walked. The ablation is the same code with
the long dig search turned off: the corridor and interim fixes alone arrive at none of the 12 (`budget` 4, `rule
liquid` 3, `rule place` 2, `unloaded` 1, 2 at the bench's cap).

**The bench** (worlds 1 to 20 of every class but long, 2194 pairs, `--jobs 4`; the Mac, `--speed 1`, the live
wall-clock budgets, `--config live --place off`; 3596 s):

| class | pairs | oracle reachable | rule (b) | world (a) | arrived of reachable | false unreachable | deaths | stranded | cause agrees | placed / dug p90 | damage max |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hills | 280 | 280 | 0 | 0 | 279 (99.6 %) | 1 | 0 | 0 | - | 0 / 18 | 1 |
| ravine | 232 | 232 | 0 | 0 | 232 (100.0 %) | 0 | 0 | 0 | - | 0 / 49 | 2 |
| water | 222 | 220 | 0 | 2 | 220 (100.0 %) | 0 | 0 | 0 | 1 of 2 | 0 / 0 | 0 |
| lava | 260 | 260 | 0 | 0 | 260 (100.0 %) | 0 | 0 | 0 | - | 0 / 23 | 0 |
| builds | 260 | 212 | 28 | 20 | 212 (100.0 %) | 0 | 0 | 0 | 48 of 48 | 0 / 0 | 2 |
| caves | 260 | 259 | 1 | 0 | 257 (99.2 %) | 2 | 0 | 0 | 1 of 1 | 0 / 103 | 1 |
| pits | 320 | 295 | 25 | 0 | 294 (99.7 %) | 1 | 0 | 0 | 20 of 20 | 0 / 59 | 8 |
| unknown | 360 | 360 | 0 | 0 | 359 (99.7 %) | 1 | 0 | 0 | - | 0 / 9 | 0 |
| **all** | 2194 | 2118 | 54 | 22 | 2113 (99.8 %) | **5 (0.23 % of pairs)** | 0 | 0 | 70 of 71 (98.6 %) | 0 / 38 | 8 |
| R2 | 2194 | 2118 | 54 | 22 | 2112 (99.7 %) | 6 (0.27 %) | 0 | 0 | 71 of 72 (98.6 %) | 0 / 37 | 8 |

Ticks p50 391, p90 1213. The five: hills:16:1 (R1's bench-edge artefact) and caves:17:11 (`unloaded`, R1's decision
12) as in R2; pits:2:13 (`rule place`: a 2 x 2 tower 9 high whose only way up is a stair cut inside it; the level's
searches are cut, the long dig search finds no whole way, the "why" way pillars), unknown:13:17 (`rule place`, as in
R2; it arrived in 2 of R3's 4 runs of it) and caves:2:12 (`budget`: R2's `unloaded` there, the only way through unloaded
world). lava:20:5 and lava:1:10 arrive. The cause that does not agree is water:7:9 again. Dug blocks: the p90 over all
pairs is 38 against R2's 37, from pairs that arrive now and dug nothing then (lava:20:5 23 blocks, caves:2:12 21);
over the 2116 pairs that arrived in both runs it is 39 in both, and the bench digs 381 blocks fewer in all (22 420
against 22 801). The long dig search ran on 82 pairs, 72 of them the oracle's rule or world answers (built-up goals,
the pits' towers): an honest unreachable answer takes 47 s at p50 now against 41 (61 against 53 at p90).

**On a loaded Mac** (the long class and the bench at once, the owner's `!test` series running too: a search's 2 s
bought about 58 000 nodes instead of 130 000), before the partial answers towards a waypoint were walked: long 90 of
95, the bench 8 false and one death. The death, lava:7:10, is older than R3: the same pair dies at `--speed 0.4` 3 of
3 with R2's navigator too (and arrives at 0.7 and above, 2 of 2 at 1). Its path walks east along a lava pool's edge
and turns south at a node with lava straight ahead, the turn the joint of two plan-aheads; the body comes into the
turn too fast and its box reaches 0.22 into the lava cell. R1's lava turn rules do not catch it there (not changed here: the
follower's turn by lava at a plan-ahead joint is an open point).

On bds-fly (e2e, the Mac's bds-fly through the runner, the live budgets): `nav-cave-entry` arrived 3 of 3 (70 s each, no damage, 54
ticks with the head under water crossing the lake, nothing placed or broken), `nav-pillar` 2 of 2 (the plateau
climbed, the walled yard `rule:falls`, 3 runs each), `nav-reach` 4 of 4, `nav-water` 17 of 17. The cave entry suite
reads its private fixture from `NAV_ENTRY_DIR`; without the fixture in the checkout it now skips (it failed to load:
vitest collects a skipped block, and the block read the missing fixture).

Limits: a stair dug down from open ground is planned only towards a goal below the node (`digDescend`, Track BC), so a
ravine crossed towards a waypoint at or above its rim is found only when the corridor puts a waypoint lower (it did
on every long pair, 19 of R2's 35 with the goal above the start); the long dig way digs about twice what the oracle's
does (p90 2.25 x: the oracle digs at no extra cost, the long dig search at 12 a block and weighted); the coarse layer
still sees a ravine as open air (its dig portals are not changed here); the follower's corner shortcut that left
lava:20:5's path at the same corner every lap (the aim running ahead of the passed node) is not changed either.

### A fall closed for a moment (Track R4)

Decision record: [decisions/0072-reachability.md](decisions/0072-reachability.md) "R4". On the Realm (2026-11-12) a
flight home landed a few blocks off on a spot whose only way on was a 5.2-block drop (0.4 HP with the bot's armour).
The goto planned the drop at its last level and set off; 1.2 s later a hostile came within 16 blocks, the step-off
check refused the drop (`the 5.2-block drop ahead is no longer safe`), the re-plan had no fall that hurts to give, and
the goto ended `unreachable (rule falls: a 5.2-block fall (0.4 HP), no fall that hurts now: a hostile ...)` at 19.7
health, a few blocks from the goal. The rule that closed it is a moment's: the hostile leaves or is struck down.

**Why the rule is there.** The long-fall policy (decision 0049, Track BI, 2026-10-30) turns every fall that hurts and
every clutch off while a hostile is within 16 blocks (the flee trigger's radius). No measurement came with that part:
no e2e, and the unit test checks its words. What it guards against is measured elsewhere: a fall may leave just
`fallMargin` (8), which is `fleeHealth` (8), and one hit from an enderman (7) or an armed zombie (5.2 through iron,
docs/pve.md) then puts the bot under the flee line beside the mob; in a fight the FallGuard clutches only a fall that
would kill (decision 0049, review B4), so a fall planned as a clutch would land at full damage; and Track M2's dodge on
real ground took falls of 5 to 13 HP in 7 of 12 runs next to skeletons (docs/pve.md "The dodge on real ground"). Those
are the big falls. A fall of a heart at nearly full health is none of them.

**What a goto does now.**

| Case | What happens |
|---|---|
| The "why" answer is `rule falls` alone, the fall closed only by a block that passes by itself (`FallPolicy.afterBlock`: a hostile within 16, burning, the health not sent yet) and the fall fits the budget once it has passed | the goto holds where it stands (the reflex strikes what comes within reach), reads the live policy every 5 ticks, and plans again once the block has been gone 20 ticks (1 s), at the level that takes the fall; at most `FALL_HOLD_TICKS` 600 (30 s) a goto in all, then the answer it would have given, with `; held 30 s for <what>` |
| The fall's landing was refused by the step-off check in the last 200 ticks (`FallPolicy.refused`, review L1) | named `its landing refused at the step-off lately` (before: the "why" search kept the refusal and could answer `world`); held until it ages out. A refusal made only because of a passing block is dropped when the block passes |
| The "why" search with every rule lifted took another way (it digs for nothing, a fall costs its HP: through a tower of planks rather than off it) while such a block is on | the fall rule alone is asked first, so the goto holds for the fall instead of answering `rule built` |
| The block turns into one that does not pass by itself (the health falls under what the fall needs), or the fall needs more than the budget after it | no hold, or the hold ends at once: the answer as before |
| `hostileFallHp` > 0 (setting, default 0) | with a hostile within 16 the budget is min(`hostileFallHp`, health + absorption - `fallMargin` - 7) instead of 0, never a clutch; at 15 health or less (the defaults) it is closed as before. 7 (`HOSTILE_FALL_RESERVE`) is the hardest single melee hit measured on the bot (an enderman), so one more hit after the landing still leaves the flee line. A fall over the cap holds like a closed one |

Only a goto with `explain` (the `!goto` command, the walk after its flight included) holds: it is the one that
knows its cause. The PvE layer's and the chores' own walks answer as before. The hold is on by default: it replaces the answer with a wait and then plans under the same
rules, so no fall is taken that was not allowed before. `hostileFallHp` changes the rule and stays off until it has
run on the Realm; 2 is the value to try (a 5-block fall unarmoured, about 13 blocks at the armour cap).

**Measured offline** (`test/unit/skills/nav-r4.test.ts`, the real navigator in the closed loop of the reach bench,
2026-11-12): a tower of planks 5 high on a grass floor (the dig way never digs a built block, so the only way off is
a 5-block fall, 2 HP), the goal 10 blocks from its edge, a zombie 12 blocks off brought in by the "server" and taken
away again.

| Case | n | Result | Damage | Time |
|---|---|---|---|---|
| no zombie (the control) | 1 | arrived | 2 (the fall) | 85 ticks |
| before R4 (no hold), the zombie from the start | 1 | `unreachable (rule falls: a 5-block fall (2 HP), no fall that hurts now: a hostile 13 blocks away)` | 0 | 8 ticks |
| before R4, the zombie while the body walks to the edge (the Realm's sequence: `no longer safe`, re-plan, unreachable) | 1 | unreachable, the same words | 0 | 23 ticks |
| the zombie from tick 0 to 25 for 40 to 300 ticks | 10 | arrived 10 of 10, 9 held (6 of them refused at the edge first, as on the Realm, 5 in an earlier run: the timing moves it; the tenth stepped off before the zombie came) | 2 each (the fall), 0 deaths | held 40 to 310 ticks, the zombie's stay and up to 0.5 s; 84 to 403 ticks in all |
| a zombie that stays | 1 | held 600 ticks, then `unreachable (rule falls: ...; held 30 s for a hostile 13 blocks away)` | 0 | 609 ticks |
| `hostileFallHp` 2, a zombie that stays | 1 | arrived, no hold | 2 | 85 ticks |
| `hostileFallHp` 2 at 15 health, the zombie for 60 ticks | 1 | held 70 ticks (15 - 8 - 7 leaves nothing to fall with), arrived | 2 | 159 ticks |

**Measured on bds-pve** (`test/e2e/nav-hostile-fall.test.ts`, BDS 1.26.60, 2026-11-12, midnight, the bot with an iron
sword and no armour, the reflex on): the same tower and goal built on the server, a real zombie summoned on the floor
8 blocks out (it cannot climb to the bot), the walk through the PvE layer with `explain` as `!goto` has it.

| Case | n | Result | Damage | Time |
|---|---|---|---|---|
| before (`Navigator.fallHoldTicks` 0) | 10 | 10 unreachable, `rule falls: a 5-block fall (2 HP), no fall that hurts now: a hostile 12 blocks away` | 0 | |
| the zombie taken away 2, 4, 6, 8 or 10 s into the walk (twice each) | 10 | arrived 10 of 10 | 2 each (the fall), 0 from the zombie, 0 deaths | 7.1 to 15.1 s (the zombie's time and 5 s); held 55 to 215 ticks |
| the zombie stays | 10 | 10 unreachable after 30.3 to 30.4 s, `...; held 30 s for a hostile 12 blocks away` | 0 | |
| `hostileFallHp` 2, the zombie stays | 10 | arrived 10 of 10, no hold | 2 each (the fall), 0 from the zombie | 4.2 s |

A zombie summoned on the tower's top beside the bot (tried once while building the test) never struck it in 30 s and
the reflex never struck it either: the goto held the 30 s and answered unreachable. A hostile that neither leaves nor
comes within reach keeps the fall closed for the whole hold; with `hostileFallHp` the bot would have dropped.

The reach bench (no mobs in its worlds; `--config live --speed 1 --worlds 20`, the owner's Mac, 2026-11-12): 2194
pairs, 5 false unreachable (the five of R3), 0 deaths, damage 8 at most. main the same day on the 2083 pairs both runs
finished (one of its workers ran out of memory in the long class, stopped there): 6 false, the sixth lava:7:10, R3's
open death by a lava turn, which arrived in R4's run; no other pair changed its answer or its cause.
The mob e2e on the same tree: `pve-m1`, `pve-combat` and `pve-creeper` on bds-pve 20 of 20 (the goto under attack
arrived in 8.1 s at 20 health); the gauntlet's live kit on bds-gaunt, 33 cells, one death in the first run (husk-1, by
suffocation, no mob hit, no goto running), the cell 3 of 3 alive when run again.

**On the Realm** (2026-11-13, deployed with the hold on and `hostileFallHp` 0): ten walks home after a flight
(`!test goto home from cave_start 5`, twice), nine arrived, the way down from the landing spot costing up to 1.3 HP. No hold
arose: no hostile came within 16 while a fall was the only way, so the hold has run on the test server only. The
tenth walk ended for another reason, open: the flight had set the body down on the top of a fence, the goto found
`no standable node` at the feet three times in two seconds and answered unreachable with no plan and no cause (a body
standing 1.5 over a fence's block has no start node). Not R4's case: nothing passes there, and the hold is not asked.

### A walk starts from wherever the body stands (Track R5)

Decision record: [decisions/0072-reachability.md](decisions/0072-reachability.md) "R5". On the Realm (2026-11-13) a
flight home set the body down on the top of a fence. The goto logged `no standable node` at the feet three times in
two seconds and answered `unreachable` with no plan and no cause, a few blocks from its goal. Four other walks that
began on a fence top the same day started.

**Why one spot failed and the next one did not.** A node is a cell whose floor is a partial block in the cell itself
or a block with its top at exactly 1 in the cell below. A fence, wall or closed gate (top 1.5) is neither, so the cell
over it is never a node. `locateNode` looks in the 3 x 3 cells under the body's footprint, at the feet's level and one
up and one down, for a node whose feet are within 0.6 of the body's. The four walks that started had the body at the
edge of the post's block, so its footprint overlapped the next column. That column had a node 0.5 below the fence top:
a block beside the fence, level with the fence's base, so its floor was 1.0 above that base. The walk that failed had
the body near the middle of a post standing on open ground. Every neighbour floor was 1.5 below the feet, out of reach
of the 0.6, so there was no start. Where on the post the body lands decides it, and a flight's landing is not that
precise. In the log, "in air" means only that the feet cell's block is air.

**The perch.** When no node is found, `locatePerch` (astar.ts) looks for a top the body rests on in the same 3 x 3
columns:

- `NavGrid.perch` gives the height of the top a body stands on in a cell that is not a node. Three cases:
  - a box in the cell below with its top between 1 and 1.5 (fences, walls, gates, a composter or cauldron rim, magma,
    cactus, dripstone);
  - a box in the cell itself with its top under 1 that is not a floor (a hopper's rim, a cauldron's inside);
  - in a bowl (a box at 1 or higher in the cell), the highest box under 1 covering the centre, if nothing higher stands
    in the body's corridor (a hopper's funnel).

  In every case the body's head room up to the feet + 1.8 must be free, and liquids, scaffolding and climbers are never
  a perch.
- The body must stand on that top: its feet at most `PERCH_ABOVE` (0.05) above it and no lower, and one of the boxes
  whose top is at that height under the footprint. The boxes come from `boxesAtCell`, so a fence's arms count: a body on
  the rail between two posts is on a perch.
- The A* search starts from the perch with `startFeet` (the worker gets it too). Only the planner's own moves leave
  it: walks (straight, diagonal, through a doorway at its level), jumps, drops and long drops, each checked as from
  any node at those feet. A perch is never "flat" (`expand`), so none of the moves that need a full floor under the
  feet starts there: no dig, pillar, parkour, sneak, hatch or climb. No move goes into a perch: it is a start, never a
  node of the graph.

So every step that leaves a perch is a step the planner already had, under the same rules: the fall policy, the R4 hold
and the step-off check apply to a drop off a fence as to a drop off a cliff. A perch is used only where `locateNode`
finds nothing, so every start that worked before is the same start. It is on by default, because it only lets a walk
begin.

**The settling wait.** A goto asked while the body is still in the air (just set down by a flight, or knocked up) has
no start until it lands. When no start is found, the body is not on the ground and not in water or lava, the
navigator waits instead of counting a failure: it looks again every 2 ticks, up to `SETTLE_TICKS` 40 (2 s) a goto. 40
ticks is the fall time from rest, by the physics model (gravity 0.08, drag 0.98), of about 48 blocks:

| Fall from rest | 1.5 | 3 | 5.5 | 16 | 30 | 48 |
|---|---|---|---|---|---|---|
| Ticks to land | 7 | 10 | 13 | 23 | 31 | 40 |

A body still in the air after that, or one on the ground with no start, fails as before. The goto's line says
`, N plan(s) from a perch` and `, N ticks settling` when either was used, and the start is logged as `goto: starting
from a perch at x,y,z feet F (on <block>: no standable node there)`.

**Other places a goto ended with no plan because of its start.** These now use the same start (`Navigator.startOf`):
the "why" search's start, the line drawn when no segment is found, the fall note in the reply (`withFallNote`), and
`Navigator.plan` from the body. A plan that came back `none` with an empty path is a start the planner did not accept,
for example when the world changed between the lookup and the search. It used to end the goto at once, or fail a
corridor waypoint. It now counts a failure and plans again in 10 ticks. Left as they are (`home/reach.ts`, the mine's
probe and the panic run use `locateNode` and are reported in decision 41): a goal on a fence top is still `not
standable`. Track R6 (the next section) takes up both.

**Shapes** (`test/unit/skills/nav-r5.test.ts`, the shapes table, 2026-11-13): each block on a grass floor with air
around it, the body on its top at the centre and at four offsets, before and after.

| Shape | Before | After |
|---|---|---|
| fences (oak, spruce, nether brick; posts, rails), walls (cobblestone and the others), fence gates (closed) | no start | perch |
| cauldron and composter rims, a full composter, magma, cactus, pointed dripstone, hopper (rim and funnel) | no start | perch |
| panes, bars, chest, stairs, slabs, bed, anvil, lantern, rods, chain, bell, brewing stand, grindstone, stonecutter, lectern, enchanting table, daylight detector, flower pot, cake, soul sand, farmland, snow layers, carpets, honey, mud, decorated pot, candle, dragon egg, conduit, trapdoors | node | the same node |
| campfire; the inside of an empty cauldron or composter | a node in the next cell (0.31 to 0.44 lower) | the same |
| sea pickle, scaffolding, ladder, piston arm | no start (nothing to stand on, or a climber) | the same |

249 rows (written to `R5_SHAPES_OUT` when it is set). A full composter's top (0.9375, inside its 1-high rim) is a
perch at its centre.

**Measured offline** (`nav-r5.test.ts`, the real navigator in the closed loop of the reach bench, 2026-11-13): a fence
line on a grass floor, the goal 20 blocks off. Each run puts the body at a slightly different spot along the line.

| Case | n | Result | Damage | Time |
|---|---|---|---|---|
| before R5 (perch off, no wait), the Realm's spot on a post | 1 | `no standable node` 3 times, unreachable with no plan | 0 | 41 ticks |
| the control: the same walk from the grass | 10 | arrived 10 of 10 | 0 | 84 ticks |
| a post's centre | 10 | arrived 10 of 10, a perch start | 0 | 92 to 95 ticks |
| the rail between two posts | 10 | arrived 10 of 10 | 0 | 94 to 95 |
| the Realm's spot (the middle of a post) | 10 | arrived 10 of 10 | 0 | 93 to 94 |
| the edge of a post | 10 | arrived 10 of 10 | 0 | 92 to 93 |
| the end of the line | 10 | arrived 10 of 10 | 0 | 94 to 95 |
| landing: 1 over a post, the goto asked at once | 10 | arrived 10 of 10, settled first | 0 | 97 to 101 |
| landing, before R5 | 1 | unreachable with no plan | 0 | 41 |
| a fence on a wall of planks 4 high, a stair of planks down | 10 | arrived 10 of 10 by the stair | 0 | 142 to 145 |
| the same wall with no stair (a 5.5-block drop) | 10 | arrived 10 of 10 | 2 each (the fall) | 106 to 109 |
| the drop, a zombie 12 blocks off for a while | 10 | arrived 10 of 10, held for it first (R4) | 2 each (the fall) | 178 to 268 |
| the drop at 8 health | 1 | `unreachable (rule falls: a 5.5-block fall (2 HP), no fall that hurts now: health 8 with margin 8 ...)` | 0 | 6 |

**Measured on bds-pve** (`test/e2e/nav-perch.test.ts`, BDS 1.26.60, 2026-11-13, noon, no mobs): a spruce fence line
built by the console's `fill` (the server joins the posts north and south: the rows record the connection states), the
goal on the grass 20 blocks off, the walk through the PvE layer with `explain` as `!goto` has it.

| Case | n | Result | Damage | Time |
|---|---|---|---|---|
| before (`Navigator.perch` off, `settleTicks` 0), the middle of a post | 10 | 10 unreachable, `no standable node` 3 times, no plan | 0 | 2.0 to 2.1 s (41 ticks) |
| a post's centre | 10 | arrived 10 of 10, one plan from a perch | 0 | 4.5 to 4.7 s (91 to 93 ticks) |
| the rail between two posts | 10 | arrived 10 of 10 | 0 | 4.6 to 4.7 s |
| the Realm's spot (the middle of a post) | 10 | arrived 10 of 10 | 0 | 4.6 s |
| the edge of a post (0.01 over its side) | 10 | arrived 10 of 10 | 0 | 4.5 to 4.6 s |
| the end of the line (joined on one side only) | 10 | arrived 10 of 10 | 0 | 4.6 to 4.7 s |
| landing: teleported 1 over a post, the walk asked at once | 10 | arrived 10 of 10, 2 to 4 ticks settling first | 0 | 4.6 to 4.8 s |
| the fence on a wall of planks 4 high, a stair of planks down | 10 | arrived 10 of 10 by the stair | 0 | 7.0 to 7.2 s |
| the same wall with no stair (a 5.5-block drop) | 10 | arrived 10 of 10, 3 plans from the perch (the levels up to the one that takes the fall) | 2 each (the fall), 0 deaths | 5.2 to 5.4 s |

The same walk from the grass took 84 ticks offline (4.2 s; not run on the server), so a start on a fence costs
the step down, about 8 ticks.

The reach bench (`--config live --speed 1 --worlds 20`, the owner's Mac, 2026-11-13): 2541 pairs with the long
class, 6 false unreachable, 0 deaths. On the 2194 pairs of R4's run (no long class), the same 5 false unreachable
as R4 and no pair with another answer. The sixth, a long pair interrupted at its 6600-tick budget after 107 dug
blocks, is the same tick for tick on the base before R4. On the 2394 pairs this run shares with that base, the base
had one more false unreachable and one death: R4's lava pair. One worker ran out of memory (a 6 GB heap) on the
sixth pair of long world 1, so 13 of that world's 18 pairs did not run. The base run stopped at the same pair, and
a rerun of that world alone was still on it after 15 minutes.
The mob gates on the same tree: `pve-m1`, `pve-combat` and `pve-creeper` on bds-pve 20 of 20. The gauntlet's live kit
on bds-gaunt, 33 cells: 0 deaths and 55.3 damage in all; the lowest health was 1.1 in `mixed-8`, 28 of its 29.9 from
a witch's potions. R4's `nav-hostile-fall` on bds-pve passed 4 of 4.

**On the Realm** (2026-11-13, deployed): eight walks home after a flight (`!test goto home from cave_start`, five with
`flyLandOver` off so that the flights end on the roofs and fence tops round the landing, three with it on). No walk
began from a perch and none waited to settle: every body had a node under its footprint, so the perch has run on the
test server only. Seven arrived. The eighth is Track R4's hold seen there for the first time: the only way down was a
5.2-block fall (0.4 HP), a hostile stood 15 to 16 blocks away, the goto held its 30 s, the hostile did not leave and
the answer was unreachable with the wait in it, at full health. `hostileFallHp` (off there) is the setting for that
case. With `flyLandOver` on the flight stands on the landing's floor and the walk in needs no fall.

### A goal on a top the stand rule has no node for (Track R6)

Decision record: [decisions/0072-reachability.md](decisions/0072-reachability.md) "R6". The owner's rule for `!goto`:
`unreachable` only when the goal is closed off. Track R5 let a walk start on a fence top. It left the goal side: a
goal on a fence, wall or closed gate top was `not standable` and answered `unreachable (rule place)` in 1 tick, or,
with `allowBreak` on, `unreachable (world)` after 28 plans and about 330 ticks. A player walks up to such a goal, and
onto it when a block stands beside it.

**What a goto does with each goal that is no node** (`test/unit/skills/nav-r6.test.ts`, the real navigator in the
closed loop of the reach bench, a 48 x 48 grass floor, the goal 15 blocks east, 2026-11-13; "default" is
`allowBreak` off, "live" is the owner's settings, `allowBreak` on and `digPenalty` 500; before n = 1, after n = 10
for each changed row, both configurations the same unless stated):

| Goal | Before | After |
|---|---|---|
| inside a solid (planks) | unreachable: `world` (default), `rule built` after 330 ticks (live) | the same |
| in the air | unreachable: `rule place` (live after 323 ticks) | the same |
| no head room | unreachable: `rule place` (default), `rule built` (live) | the same |
| a slab's upper half | arrived, on the node over the slab, 80 ticks | the same |
| over a fence, a wall or a closed gate | unreachable: `rule place` in 1 tick (default), `world` after 333 ticks and 28 plans (live) | arrived next to it with the note, 1.73 to 1.84 from the top's centre, 66 to 67 ticks, 1 plan |
| the same with a block of planks beside it | unreachable, as above | arrived on the top, 0.01 to 0.17 from its centre, 74 to 78 ticks, 1 plan |
| a fence with a bottom slab beside it (a jump of 1.0) | unreachable | arrived on the top by a jump, 0.10 to 0.24 from its centre, 78 to 80 ticks |
| a fence, the block beside it walled in (no head room for the step) | unreachable | arrived next to it with the note, 306 to 308 ticks, 24 plans, 0 failures counted |
| a fence in a line of fences | unreachable | arrived next to it, 66 to 67 ticks |
| a fence at a pit's edge, a block beside it (live) | unreachable | arrived on the top, 0 damage |
| in a cauldron | unreachable: `world` (default), `rule built` (live) | arrived next to it with the note, 0.91 to 1.09 from the inside's centre, 66 to 67 ticks |
| a column goal (a waypoint with no height) over a fence | unreachable after 328 ticks and 27 plans | arrived next to it, 66 to 67 ticks |
| the same with a block beside it | unreachable after 324 ticks | arrived on the top, 74 to 78 ticks |
| a fence in a deck, its four cardinal neighbours fences too (no step onto it) | unreachable: `rule place` (default), `world` after 320 ticks (live) | arrived next to it on the deck, 1.45 to 1.53 from the top's centre, 74 to 77 ticks |
| a column goal with a fence on a roof 2 over a floor (a node under the fence) | arrived on the floor under the roof, 70 to 71 ticks | the same end and plans in 10 of 10 a configuration; ticks the same within 1, as the same run twice |
| a fence on a tower of planks 3 high | unreachable: `rule place` (default), `world` (live) | unreachable `rule place` in both: nothing in reach of it is a node, and a goto places no blocks |

Damage 0 and no death in every row. The reply to `!goto` beside the goal reads `arrived at ... (the goal's cell x,y,z
(on spruce_fence) cannot be stood on (no step or jump leads onto it): stopped 1.76 blocks from it)`.

**Measured on bds-pve** (`test/e2e/nav-perch.test.ts` goal cases, BDS 1.26.60, 2026-11-13, noon, no mobs): one post
built by the console's `fill` on the grass, the walk from 20 blocks off through the PvE layer with `explain` as
`!goto` has it, the owner's default settings.

| Case | n | Result | Damage | Time |
|---|---|---|---|---|
| before (`Navigator.perchGoals` off), a goal over a spruce fence | 10 | 10 unreachable, `rule place` | 0 | 1 tick |
| a goal over a spruce fence | 10 | arrived 10 of 10 next to it with the note, 1.72 to 1.82 from the top's centre | 0 | 4.1 to 4.2 s (83 to 84 ticks) |
| a goal over a cobblestone wall | 10 | arrived 10 of 10 next to it, the same | 0 | 4.1 to 4.2 s |
| a goal over a closed fence gate | 10 | arrived 10 of 10 next to it, the same | 0 | 4.1 to 4.2 s |
| the fence with a block of planks beside it | 10 | arrived 10 of 10 on the top, 0.00 to 0.17 from its centre | 0 | 4.5 to 4.7 s (91 to 95 ticks) |
| the wall with a block beside it | 10 | arrived 10 of 10 on the top, the same | 0 | 4.5 to 4.7 s |
| the gate with a block beside it | 10 | arrived 10 of 10 on the top, the same | 0 | 4.5 to 4.7 s |

**The perch goal** (`astar.ts perchGoal`). A goal cell is a perch goal when it is no node (no stand, no doorway) and
`NavGrid.perch` gives it a top (R5's rule: a fence's, a wall's or a gate's 1.5, a cauldron's or composter's inside).
It is one that a walk may end on (`enter`) when:

- the top is a box in the cell below standing over 1, so the goal's own cell is empty: a fence, a wall, a closed
  gate. A rim round a hollow (a cauldron, a composter) and a top in the goal's own cell (a hopper) are not, because a
  body centred on them drops inside or meets the rim;
- the block is no hazard (magma, cactus and dripstone are perches for a start, never a goal to stand on);
- a box with its top at that height covers a centred body's footprint (0.5 +- 0.3), so the body stops on it, not on
  an arm's edge.

**Onto it.** With `PathOptions.perchGoal` (the worker gets it too), the search gets one more move, the path's last:
from a cardinal neighbour node onto the goal's top. The rise from that node's feet to the top must be 0 to
`MAX_JUMP_RISE` (1.25). Up to a step (0.5625) it is a walk; above that it is a jump, with the head room over the
start free. It is never down onto the top: a move down onto a perch would be a drop, and the fall rules, R4's hold
and the step-off check have no answer for a perch. The move ends the path (`F_PERCH`): nothing leaves the goal's top
and no other perch is a node. So every step but the last is the planner's own under the same rules, and the last
one is a step or a jump up that a player makes.

**Next to it.** When no step or jump can lead onto the top, the walk ends next to the block the top belongs to. The
navigator looks first, statically: an enterable perch with a cardinal neighbour node 0 to 1.25 under the top is
planned onto; anything else is planned beside it. If the way onto it then fails (no plan, no progress, a loop, a
move that does not take), it switches to beside it once, without counting a failure, and plans again at the same
level. "Beside" is a `getToBlock` goal, as a dig or a chest is walked to: one of the 8 columns round it, the cell at
the feet or the head, in reach. For a fence, wall or gate it is the goal's own cell (the air over the post) with no
face asked, so a side cell at the post's level (the ground beside it) and one a level higher (a deck the post stands
in) both count. On the post's block a side cell over the block is never done: a post in a deck had no end, and a
walk switched to beside by a failure ended unreachable (the fence cross in a deck below, before this rule:
unreachable after 316 ticks). For a top inside its own block (a cauldron) it is that block, with its face. It is not
a radius round the top: a radius wide enough for a fence's corner (2.06 from its top) took a column two blocks from a
cauldron. The walk
then ends `ok` with a note that says the goal's cell cannot be stood on, why, and how far the body is from the top's
centre (`GotoReport.perchGoal`: `on` or `beside` and the distance).

**A column goal** (a waypoint with no height such as a world spawn, a walk-out leg of a flight; no chat command
gives one). A column goal is done at any node of the column, so it is
changed only when no cell of the column is a node (`stand` or a doorway, from the cell over its top down to the
world's floor: one pass, once a goto; not decided while part of the column is not loaded). Then the highest cell with
a box, if it is not a liquid, is looked at as a perch goal: the cell over it (a fence's top), else its own cell (a
cauldron's inside). Before, such a goto tried 27 plans before `unreachable`. A column with a node under its top (a
room under a roof with a fence on it, a path under a bridge's rail) keeps the plain column goal and arrives at the
same node as before: a fence on a roof 2 over a floor, 10 runs a configuration, the same end and plans before and
after, the floor under the roof (a first version of the rule sent it onto the roof's fence: unreachable after 321
ticks and 27 plans).

**Left as they are.** A goal on a perch that no step reaches and nothing beside it is in reach of stays
`unreachable` (the tower above: its reason was `world` with `allowBreak` on and is `rule place` now). A goal given as
the fence block's own cell (not the cell over it) is a goal inside a block, as before. The kinds that were not
perches (inside a solid, in the air, no head room) answer as before.

**Starting inside a bowl** (an empty cauldron or composter, R5 decision 41). `locateNode` takes a neighbour node 0.31
lower and the first move needs a jump over the rim. The follower walked into the rim: at a cauldron's centre three
move timeouts and `unreachable` in 62 ticks (at 0.2 off the centre it got out, 69 to 84 ticks). The follower now
jumps when the body is on the ground, pushing forward, blocked sideways, and its feet are on the bowl's inside (the
own cell holds a box with its top at 1 or more and `NavGrid.perch` is within 0.05 of the feet). Measured, 10 starts a
block, at the centre and at offsets up to 0.25 along x and z, the goal 15 blocks off: cauldron 10 of 10 in 70 to 94 ticks, composter 10 of 10 in 69 to 93, no damage.

**Callers asking for a start.** The rule: a caller asking with the body's own position gets `locateStart` (the perch
too); a caller asking about a cell it only considers keeps `locateNode`, because a perch is not a place to send a
body to.

| Caller | Asks about | Now |
|---|---|---|
| `Navigator.startOf` (the main search, the "why" search, the line drawn, `plan` from the body), `withFallNote` | the body | `locateStart` (since R5) |
| `Navigator.plan` with an explicit `from` | a cell the caller names (no caller passes one) | `locateNode`, commented |
| `Navigator.safeHere`, the last safe spot | the retreat's target | `locateNode`, commented (no move goes into a perch) |
| `home/reach.ts probePath` | a probe `from` a point | `locateNode` by default; `{ body: true }` takes `locateStart` and plans from a perch |
| the mine's walk probe (`mine/wire.ts`), the guard's reach probe (`combat/pathReach.ts`) | the body | `probePath(..., { body: true })` |
| the mine's straight probe (`mine/wire.ts`) | the body | `locateStart`, a perch start passed on |
| `miner.ts pickReachable` | | a probe with no start says nothing: the ore stays a candidate (before, it was marked unreachable) |
| the landing probe (`fly/landprobe.ts`), the flight's site and walk-out probes (`chat/commands-fly.ts`) | landing cells it considers | `locateNode` (the flight's files: not changed) |
| the panic run (`pve.ts`) | | no start of its own: it walks through `mover.goto`, which has the perch and the settling wait |
| the unprone path | the body, a floor with no head room | its own start, not the same case: it digs the head room and plans again through the navigator |

The other `stand(` checks outside the planner (combat, targeting, the fall plan, the farm, fire, the feller, the
portal, the surface walk) test cells to stand on or land on, never the body's start, and are unchanged.

**R5's shapes.** The 249 rows of `nav-r5.test.ts`'s shapes table (`R5_SHAPES_OUT`) were written on the base tree and on
this one: the files are byte for byte the same.

**The reach bench** (`--config live --speed 1 --worlds 20`, the owner's Mac, 2026-11-13): 2541 pairs, 0 deaths, max
damage 8, compared pair by pair with R5's run. R5's six (five false unreachable and long:18:3 interrupted at its
6600-tick budget) are the same pairs with the same causes. One more pair, caves:5:10, ended `unloaded` after 1109
ticks and 30 s of wall time; in R5's run it arrived in 2781 ticks. It ran while three unit suites shared the host. Run
alone it arrived 3 of 3 on the Mac (2655 to 2657 ticks, 9.7 s) and once each on the PC on this tree and on the base
(2797 and 2796 ticks). No other pair changed its answer or its cause. As in R5's run, one worker ran out of memory (a
6 GB heap) in the long class. On the final tree (the column rule and the beside goal below) the bench again: 2541
pairs, 0 deaths, max damage 8; against R5's run four pairs changed. caves:5:10 is `unloaded` again, and the base ends
it the same way when its whole world runs (1206 and 1208 ticks, 15 dug). long:2:13 (interrupted at its budget) and
long:7:16 (`budget`) arrived in R5's run, and long:18:3 (interrupted in R5's run) arrived. On the PC, three pairs at a
time, the base and this tree gave long:2:13 interrupted and long:18:3 arrived on both, and long:7:16 arrived on the
base and not here; run alone on this tree long:7:16 arrived (3796 ticks against the base's 3765, 90 dug both). The
long pairs' corridors are planned under a 500 ms search limit (`search limit hit (500 ms)` in their logs), so their
answers move with the machine's load. No bench record carries the note of a walk that ended next to a perch goal.

**The mob gates on the same tree**: `pve-m1`, `pve-combat` and `pve-creeper` on bds-pve 20 of 20; R4's
`nav-hostile-fall` 4 of 4; R5's own `nav-perch` cases 90 of 90 with R5's times; the gauntlet's live kit on bds-gaunt, 33
cells, 0 deaths, 52.2 damage in all, the lowest health 1.9 in `mixed-8` (28 of its damage from a witch's potions);
`gaunt-mine` 2 of 2 and `mine-cave` on bds-farm 4 of 4. On the final tree: `pve-m1` and `pve-creeper` passed and
`nav-hostile-fall` 4 of 4. `pve-combat` failed one or two of its 12 tests in 3 of 4 runs, the base in 2 of 3 the
same evening, the two-zombie flank test failing on both, so the server was flaky that evening. The gauntlet had one
death, creeper-4 by suffocation with no goto running; run again, 5 of 5 alive on this tree and 5 of 5 on the base.
On the merged tree (with Track F12): the unit suite three times on the test host, `nav-perch`'s goal cases 35 of 35
with the same numbers, `pve-combat` 12 of 12.

**On the Realm** (2026-11-14, deployed). A goal on the cell over a closed fence gate that stands in a fence line on
the ground, walked to from the home: 5 of 5 arrived next to it with the note, 2.03 to 2.07 from the top's centre, no
damage; one walk in 112 ticks and four longer ones in 147 to 152, 1 plan in four and 3 in one. Ordinary walks on the
same build: home from a roof's deck 2 of 2 (14.1 s a run) and home from the gate 3 of 3 (10.4 s), no damage; the home's chest probe found 90 of 193 containers in reach, as before the change.
Not seen there: a walk that ends on a top (no perch with a block beside it was tried) and a column goal (none can be
asked for in chat); both have run offline and on the test server only.

**Found there and open: the fence that began Track R5 is no perch.** It stands on a deck under a roof's eave, and a
block of the roof is 1.5 over the fence's top. `NavGrid.perch` asks the full 1.8 of head room, as `stand` does, so
that top is neither a start nor a goal:

- as a start (the body put on the top by the test harness's `/tp`): the server holds the body there in its 1.49-high
  pose; `no standable node` three times and unreachable after 41 ticks with no plan, as before Track R5. The flights
  that ended on that fence no longer do (`flyLandOver`), so no trip has met it since;
- as a goal (the cell over it): it is a goal with no head room, answered as before: the walk went up to the deck and
  stood one block from the fence, then planned 17 times in 1248 ticks (62 s) and answered unreachable.

Both need a body lower than 1.8 in the model (a start in the low pose and its first move out from under the eave) and
are left for a track of their own: Track R7, below.

### A walk that starts or ends where the body is held low (Track R7)

Decision record: [decisions/0072-reachability.md](decisions/0072-reachability.md) "R7". Two things were left open by
R6. A fence under a roof's eave, with the eave's block 1.5 over the fence's top, was neither a start nor a goal. And a
`block` goal whose cell nobody can stand in (inside a block, no head room, in the air) still answered `unreachable`
where a player walks up to it.

**Why the Realm's start failed** (the R6 series' log, 2026-11-14). `NavGrid.perch` asks for the full 1.8 of head room,
as `stand` does. The eave leaves 1.5 over the fence's top, so the top was no perch and no start. The log's "in air" is
the name of the block in the feet cell (`air`), not a body in the air: none of the three lines says `airborne`, so
`onGround` was true. The first of the three failures came with the feet at the top plus 0.5, just after the `/tp`. The
server's answer to the teleport said the body was on the ground, so the settle wait (Track R5, which needs
`!onGround`) did not run. The second and third came with the body resting on the top, and failed on the head room.

**What the server does with a body there** (`test/e2e/nav-low.test.ts` probe cases, bds-pve, BDS 1.26.60,
2026-11-14; a spruce fence line built by the console, the eave 3 over the fence block, 1 run a case and a key in four
eaves: planks over the line, planks over the line and both columns beside it, a bottom and a top stair half):

- On the top, under the eave, the server sets the player's `boundingbox_height` to 1.49 and its `sneaking` flag,
  with no sneak key from the client. The body is held crouched.
- Forward with no key: the body moves at the sneak speed (from the post's centre: 0.529, 0.575, 0.630, 0.688 ... a
  tick) and has no edge back-off. It walks off the top, drops 1.5 onto the grass, and the server stands it up again (1.8)
  once the standing box is clear.
- Forward with the sneak key: the edge rule holds the body on the top, at 0.892 from the post's block's west side.
- Teleported 0.5 over the top: the server first sends the crawl pose (0.6), then 1.49 once the body lands on the top.
- The local model before R7 (a 1.8 box) disagreed with the server: 1 correction a run with the planks eave, 2 with
  the stairs. With the wide eave it stopped at 0.7 and the server accepted that within its tolerance.

**The held-low pose in the model** (`physics.ts heldLow`). A body whose standing box (1.8) meets a block and whose
crouched box (1.49) does not, with no sneak key and not gliding, moves as the server moves it. It has the 1.49 box,
the sneak speed and no sprint. It has no edge back-off, because the server gives none without the key. `BodyState.low`
marks it. `sneaking` stays false, so no `start_sneaking` is sent. `InputLoopState.poseHeight` gives the height the
server last set. With this model the four probes gave 0 corrections, with and without the key.

**The low perch** (`NavGrid.lowPerch`, `astar.ts locatePerch` / `locateStart`). A box top that is no perch only
because the head room is under 1.8 and at least 1.49 is a low perch: a start only, flagged `F_LOW` as well as
`F_PERCH`. From a low perch the planner plans only cardinal walks off and drops down. The crouched head must stay
clear on the way (the cells up to 1.49 over the top in the neighbour column). It plans no step up (it would lift the
crouched head into the eave), no diagonal, no doorway, no climb, no parkour and no pillar. Those moves would need the
full height before the body stands again. `Navigator.lowPerch` (on; `false` gives the behaviour before, for the
tests) and `GotoReport.lowStarts`.

**The settle wait** (`physics.ts restsOn`). When no start is found, a body is waited for as in the air if the
state says it is not on the ground, or if its crouched box rests on nothing (the teleport's answer case).

**The same top as a goal.** A goal on the cell over such a fence is a perch goal (R6) that is never entered
(`low: true`). A body gets onto it only by crouching, and the planner has no crouched move up. So the walk ends next
to it, as R6's goals with no step onto them do. The note says why: `cannot be stood on (under 1.8 of head room: a body
gets onto it only crouching)`.

**A start on a sneak node and the prone pose, as they are.** A body on a full floor under a ceiling between 1.49 and
1.8 is a sneak node already (Track BC `sneakFits`). `locateNode` gives it, and `expandSneak` moves it out sneaking,
so it needed nothing new. A body in the crawl pose (0.6, under a ceiling lower than 1.49) is the unprone path's (dig
the head room and plan again through the navigator), unchanged.

**Measured on bds-pve** (`test/e2e/nav-low.test.ts`, BDS 1.26.60, 2026-11-14, noon, no mobs): the fence line under
the eave as in the probes. Each walk goes through the PvE layer with `explain`, as `!goto` has it, at the owner's
default settings. The start cases walk from the top to 15 blocks east on the grass. A run's spot moves by up to 0.04
along the line.

| Case | n | Result | Damage | Time |
|---|---|---|---|---|
| before (`Navigator.lowPerch` off), from the top's centre, planks eave | 10 | 10 unreachable, `no standable node` 3 times, 0 plans | 0 | 41 ticks (2.0 to 2.1 s) |
| from the top, planks eave: centre / offset along the line / offset across it | 10 each | arrived 10 of 10 each, 1 plan, 0 corrections, 0.03 to 0.08 from the goal | 0 | 77 to 81 ticks (3.8 to 4.0 s) |
| the same, a bottom stair half as the eave | 10 each | the same | 0 | 77 to 81 ticks |
| the same, a top stair half as the eave | 10 each | the same | 0 | 77 to 81 ticks |
| set 0.5 over the top and the walk at once (the Realm's first failure; 8 of 10 started with the state saying on the ground) | 10 | arrived 10 of 10, the settle wait 0 to 2 ticks, 1 correction (the landing) | 0 | 80 to 82 ticks (4.0 to 4.1 s) |
| a goal on the cell over the fence, before | 10 | 10 unreachable, `rule place`, 0 plans | 0 | 1 tick |
| the same goal, planks eave / bottom stair eave | 10 each | arrived 10 of 10 next to it with the note, 1.33 from the goal cell (1.76 from the top's centre) | 0 | 66 ticks (3.3 s) |
| a block of planks as the goal, `beside` off / on | 10 / 10 | unreachable `world` in 1 tick / arrived 10 of 10 next to it with the note, 0.87 from the cell | 0 | 66 ticks (3.3 s) |
| planks where the head goes, `beside` off / on | 10 / 10 | unreachable `rule place` in 1 tick / arrived 10 of 10 next to it, 0.87 | 0 | 66 ticks |
| a cell 2 over the grass, `beside` off / on | 10 / 10 | unreachable `rule place` in 1 tick / arrived 10 of 10 under it, 2.0 | 0 | 69 ticks (3.4 to 3.5 s) |

**Offline** (`test/unit/skills/nav-r7.test.ts`, the real navigator in the bench's closed loop, the Mac, 2026-11-14).
The setup: a 48 x 48 grass floor, the fence line and eave as on the server, and four eaves (planks over the line,
planks over it and the columns beside, a bottom and a top stair half). Both the default and the live settings
(`allowBreak` on, `allowPlace` off, `digPenalty` 500) were run:

- **The start.** Before (`lowPerch` off): unreachable in 41 ticks with 0 plans and 3 failures, in every eave and
  configuration. After, at the centre and the two offsets, 10 runs each: arrived 240 of 240 in 77 to 81 ticks, 1
  plan, 0 damage. Set 0.5 over the top: arrived 10 of 10 in 80 ticks.
- **The goal over the fence.** Before: unreachable `rule place` in 1 tick (default), and `world` after 323 to 330
  ticks and 28 plans (live). After: next to it with the note, 80 of 80 in 66 ticks, 1.74 to 1.75 from the top's
  centre, 0 damage.

**A `block` goal nobody stands in: before and after** (`nav-r7.test.ts`, the same closed loop, the goal 15 blocks
east, the Mac, 2026-11-14, n = 1 a row offline; the changed kinds also ran 10 of 10 on bds-pve, above. "After" is with
`beside`, as `!goto` passes it; without it every row is the "before" column):

| Goal cell | Before, default | Before, live | After, default | After, live |
|---|---|---|---|---|
| inside natural stone underground | arrived, dug in, 320 ticks, 24 plans | arrived, dug in, 103 ticks | the same | the same |
| inside a stone boulder on the grass | arrived, dug in, 301 ticks, 24 plans | arrived, dug in, 83 ticks | the same | the same |
| inside a block of planks | unreachable `world`, 1 tick | unreachable `rule built`, 328 ticks, 28 plans | next to it, 66 ticks, 1 plan, 1.02 from the cell | the same |
| a fence block's own cell | unreachable `world`, 1 tick | unreachable `rule built`, 328 ticks | next to it, 66 ticks, 1.02 | the same |
| no head room, planks over the cell | unreachable `rule place`, 1 tick | unreachable `rule built`, 328 ticks | next to it, 66 ticks, 1.02 | the same |
| no head room, stone over the cell | unreachable `rule place`, 1 tick | arrived, the stone dug, 83 ticks | next to it, 66 ticks | arrived, dug, as before |
| in the air 1, 2, 5 over the floor | unreachable `rule place`, 1 tick | unreachable `rule place`, 314 to 328 ticks, 28 plans | under it, 69 ticks, 1 plan | the same |
| in the air 6 over the floor | unreachable `rule place`, 1 tick | unreachable, 311 ticks | the same | the same |
| in water | arrived, 66 ticks | arrived, 66 ticks | the same | the same |
| in lava | unreachable `world`, 1 tick | unreachable `world`, 350 ticks | the same | the same |
| a fence on a tower 3 high | unreachable `rule place`, 318 ticks | unreachable `rule place`, 321 ticks | the same | the same |

Damage 0 and no death in every row. The reply reads `arrived at ... (the goal's cell x,y,z (oak_planks) cannot be
stood on (inside oak_planks): stopped 0.91 blocks from it)`.


**A `block` goal nobody stands in, for `!goto`** (`GotoOptions.beside`). The owner's rule for `!goto`: `unreachable`
only when nothing in reach can be walked to. A goal a player could walk up to now ends `ok` next to it, decided before
the first plan, with a note that says the cell cannot be stood on, why, and how far the body stopped from it
(`GotoReport.beside`: the kind, what is in the cell, the distance from the feet to the cell's floor centre). Kind by
kind (`Navigator.lookBeside`):

| Goal cell | With `beside` | Why |
|---|---|---|
| inside a built block (planks), a fence or a wall block's own cell | next to it: `getToBlock` on the cell, a face asked for a full cube only | a player walks up to it as to a chest; a fence has no face to ask for |
| inside a natural block (stone, dirt) | dug into, as before, when `allowBreak` or the dig way is on | the cell can be opened and the body then stands in it, which is what was asked; next to it only with no dig at all |
| no head room (a block where the head goes, a floor under it) | next to it (`getToBlock`, no face) | unless that block is natural and `allowBreak` is on: dug out, as before (the live settings) |
| open air with its own column's node 1 to 5 under it, nothing between | under it, on that node | the eye is at most 3.9 from the cell's centre: in reach. With `allowPlace` on, the pillar's search as before |
| open air with no floor within 5 under it | unreachable, as before | nothing in reach can be stood on |
| water | as before (Track W3: reached swimming or diving) | it was a goal already |
| lava | unreachable, as before | a walk is never sent up to lava to end there; how near lava a walk goes is the hazard rules' call, not the goal's |
| a perch with nothing in reach (a fence on a tower) | unreachable, as before (R6) | nothing next to it is a node |

**Only for `!goto`.** `beside` is an option, set only by the `!goto` command (coordinates and waypoints), and so
by the `!test goto` series, which sends that chat line. Every other caller keeps the strict answer. Seven callers give
a goal cell that may not be standable and act on being in it, so an `ok` beside the cell would mislead them:

- the branch miner's pickups (`branch.ts pickUp`, `commands-explore.ts`), whose cell is an ore hole that the planner
  digs open;
- the miner's `intoHole` fallback, which digs over the hole when the walk fails;
- the branch layout's `standOn` and the tunnel's steps (`tunnel.ts runTunnel`), which walk without digging, then dig
  if that fails;
- the quarry's stair climb (`quarry.ts walkStairs`), whose dig over the tread follows a failed walk;
- the portal's step in (`portal.ts`), which steers by hand from where the walk ends.

The rest pick their cell with `stand` or a probe, or check the body's position afterwards. `!home go`, the older
`!goto` handler of `chat/commands.ts` (`commands-nav.ts` takes the name back from it) and the flight's own walks pass
no `beside` and are strict, as before. The flight's wrapper of `pve.walk` passes the caller's options on, so a `!goto`
that flies part of the way keeps `beside` for its walks.

**R6's perch answer checked the same way.** R6 ends a walk next to a perch goal for every caller. No strict caller
gives a fence's top as its goal cell: the misled callers above give dug or digging cells, never the air over a fence.
So R6's answer stays for all.

**`!test goto` and the flight.** The series counts a goto as arrived when the reply starts `arrived at ` and the body
ends within 2.5 of the goal cell's floor centre, the height included. Next to a block (0.9 to 1.8) and under a cell up
to 2 over the floor, that counts as arrived; under a cell 3 to 5 over the floor it does not. The note is not read.
(Track R8 changed this: a noted arrival counts at any distance, and a failure reply is never arrived; see R8's
section.)
The flight's glide down after a walk (`commands-fly.ts glideFallback`) runs only on a walk that failed with no way,
so an `ok` beside the cell takes no glide. That is right when the body stands next to the cell. A beside goal that
cannot be reached still ends `unreachable`, and the glide search runs as before.

**R5's and R6's rows.** The 249 rows of R5's shapes table were written on the base tree and on this one, and the files
are byte for byte the same. R6's 396 table rows have the same replies, notes, ends, plans and damage on both trees. In
29 of them the ticks differ by 1, within the 66 to 67 R6 gives for the same rows.

**The reach bench** (`--config live --place off --speed 1 --worlds 20`, the Mac, 2026-11-14, alone on the host):
2541 pairs, 0 deaths, 0 stranded, max damage 8, and 8 false unreachable, the count of R6's final run. They are
caves:2:12, caves:17:11, pits:2:13, hills:16:1 and unknown:13:17, plus caves:5:10 (`unloaded`, also the base's answer
when its whole world runs), long:2:13 and long:18:3 (both interrupted at their 6600-tick budget). R6's per-pair results
were not at hand, so the first five were compared by count only. R6's final run named long:2:13 and long:7:16;
here long:7:16 arrived and long:18:3 did not. Both are the long pairs whose corridors are planned under a 500 ms search limit, which
R6 found move with the host's load. No bench walk started from a low perch or ended with an R7 note: the bench's
worlds have no eave over a fence, and the bench passes no `beside`. As in R5's and R6's runs, one worker ran out of
memory (a 6 GB heap) in the long class.

**The mob gates on this tree** (2026-11-14): `pve-m1` 4 of 4, `pve-creeper` 4 of 4, `nav-hostile-fall` 4 of 4 and
`pve-combat` 12 of 12 on bds-pve; the gauntlet's live kit on bds-gaunt, 33 cells, 0 deaths, 48.1 damage in all, the
lowest health 1.3.

**On the merged tree** (the coordinator's reruns, 2026-11-14, with Track F13 merged): `nav-low` with 5 runs a case,
75 of 75 walks as in the table (the starts 77 to 83 ticks, the goals 66, the kinds 66 to 69, the before cases
unreachable in 41 ticks and in 1 tick), `nav-perch`, `nav-hostile-fall` and `pve-m1` passed; the unit suite on the
Mac passed three runs (2 880 tests each), and a fourth failed the worker test's interim timing, a known flake on a
loaded host.

**On the Realm** (2026-11-14, deployed; the `!test goto` series, which sets the body down, sends `!goto` and counts
the end). The fence that began Track R5 and stayed open after R6: a spruce fence on a deck under a roof's eave, the
eave's stairs 1.5 over the fence's top.

- **The start.** The body set 0.5 over the top and a walk home of 55 blocks asked at once, 3 runs: 3 of 3 arrived in
  237 to 239 ticks (14 s with the series' own steps), 0 damage. The log each time: the settle wait (4 ticks), `starting
  from a perch ... (on spruce_fence: no standable node there; under 1.8 of head room, the body held crouched)`, the
  server's pose line with the 1.49 box, one plan from the perch (a second, ordinary one on the way in one run), and
  no correction but the teleport's own. Before: `no standable node` three times and unreachable after 41 ticks.
- **The top as a goal.** From the deck one block away, 3 runs: 3 of 3 `arrived at ... (the goal's cell ... (on
  spruce_fence) cannot be stood on (under 1.8 of head room: a body gets onto it only crouching): stopped 1.8 blocks
  from it)` after 2 ticks and 1 plan. Before: unreachable after 1248 ticks and 17 plans.
- **The fence block's own cell as a goal**, from the home, a walk of 51 blocks, 2 runs: 2 of 2 arrived next to it
  with the note (`inside spruce_fence, no room for a body in it`), 1.02 from the cell, in 184 and 192 ticks, 0 damage.
- **As before.** R6's goal over a closed gate 2 of 2 next to it with its note (2.04 from it); an ordinary walk home 2
  of 2; the home's chest probe the same count as before the deploy; no damage in the 12 runs.

Not seen on the Realm: a goal in the air or under a block where the head goes (the test server only), and a low
perch a flight ended on (flights have landed on the chosen site since `flyLandOver`). One reply of the three in a
row at the fence was dropped by the chat rate limit, which is older than this track; the log has the line.

### A `!goto` that stands as near as it gets (Track R8)

Decision record: [decisions/0072-reachability.md](decisions/0072-reachability.md) "R8". The owner's rule for `!goto`:
`unreachable` only when the goal is completely closed off. A player sent to a spot goes as near as they can get and
says where they are. A sweep on the Realm (2026-11-14, `!test goto` to every saved waypoint and a sample of pairs, 45
trips) found two trips that broke it the same way: the walk got as near as it could, then stood and searched for 44 to
65 s, then said `unreachable`.

**Why the two trips stood and searched** (the Realm's log, 2026-11-14).

- *A goal cell inside a nether portal.* The flight landed and the walk came to 1.1 blocks from the cell. R7's
  `lookBeside` took no kind: a portal block has no collision box, so it is not `solid`; the frame's obsidian under it
  makes the cell itself the only node of its column, so it is not `in the air`. The planner never plans a step into a
  portal (below), so every search towards the cell failed. The goto ran the whole ladder: the plan cut by its budget
  with no progress, 4 x the budget, the long dig search, the dig way's level and its three searches, the hurting
  fall's level and its three, a failure, `no retry`, the "why" searches with every rule lifted (cut by their budgets
  too), and `unreachable (budget ...)` after 1303 ticks and 15 plans: 65 s standing 1.1 from the goal.
- *A goal cell over a lone block in a dug-out pit.* The waypoint was saved on ground that has since been dug away. The
  cell is open air; 3 under it stands one block alone in a wide pit. R7's `in the air` kind made the goal the node on
  that block. The walk came to the pit's edge, 6 from the cell (5.5 across), and stood there. No walk reaches the
  lone block: a jump of 5.5 is no move the planner has. The same ladder ran, then the "why" searches found the way
  with `place` lifted (75 nodes), and the answer came after 875 ticks: `unreachable (rule place ...)`, 44 s still.

In both trips every search after the first started from the same node, with the goal less than 8 blocks off, and found
no partial end 5 or more blocks from the start (`BestSoFar`'s `MIN_DIST_PATH`), so each said "no progress".

**Which searches of the ladder can still say something new.** It depends on whether the search from that node was
cut by its budget.

- *Not cut* (it ran out of nodes to expand: exhaustive under its options). A bigger budget expands nothing more. The
  long dig search only prices digs lower, and a search that may dig has already looked at every dug way within its
  rules. Only a level with more options (the dig way, a fall that hurts) can find something new, and the last level
  has them all. One search at the last level, then the answer.
- *Cut by its budget.* Nothing is proven. A 2 x 2 tower 6 high with the goal on its top, 6 from its foot (the reach
  bench's pits:13:11), is climbed by a stair dug into the tower. The dig way's level found it within the main budget
  on one run; the falls' level, with more moves to expand, did not within the same budget; nor did the long dig search
  (weighted). A first version of R8 that jumped straight to the last level's search, or to the long dig search,
  stopped short there. So each level above the current one gets its own search at the main budget, and the last level
  then its bigger search and the long dig search once, as the ladder gives them, and the weighted open walk (R3) runs
  once, as before. What is dropped: the bigger and the long dig searches of every level but the last, the failures'
  three rounds and the "why" searches' bigger retries.

Even with all of it, the budget-cut answers depend on the host's speed: the same pair on the base tree arrived on the
Mac's first bench run and was unreachable on this PC's.

**Cells no move enters.** NavGrid's `stand`, its crossing check and the moves' head check refuse every cell
`avoidWalkingInto` names (`baritone/helper.ts`): any liquid (water only by the swim moves), and every `danger` block
of `terrain/classify.ts` (magma unless `allowMagma`). The `danger` blocks with no collision box are the ones a goal cell
can hold while looking open: nether portal, end portal, end gateway, fire and soul fire, cobweb, sweet berry bush,
powder snow and wither rose. The ones with a box (cactus, campfires, magma, pointed dripstone, a lava cauldron) are R7's
`solid` kind already.

**The rules** (for a goto with `beside`, which only the `!goto` command passes; every other caller keeps the strict
answer, for the seven callers R7 named):

- *A cell no move enters, as a goal* (`BesideKind` `no entry`). A goal cell that holds a hazard with no box, or an open
  cell with one where the head goes, ends next to it, decided before the first plan like R7's kinds: `getToBlock` on
  the cell, no face asked. The note reads `the goal's cell x,y,z (portal) cannot be stood on (portal: a cell the walk
  never enters): stopped 0.9 blocks from it`. Liquids are not in this kind: water is a goal (Track W3), and lava stays
  `unreachable` (R7).
- *R7's node under an air cell is checked.* When the searches from where the body stands find no way onto that node,
  the goal becomes next to the cell instead (`getToBlock` on it, no face: one of the 8 columns round it with the cell
  at the feet or the head), once a goto, if one of those columns has a node at all. No failure is counted for it.
  R6's perch goals already switch the same way (`perchBeside`).
- *An air cell just over a top is that top's node.* When the node of the cell's own column has its feet less than 0.5
  under the cell's floor (a path block's 0.94, farmland, soul sand, a chest's 0.875), the body on it stands where it
  was asked, as the stairs rule above `lookBeside`'s call does the other way. The goal is that node and there is no
  note. Before, the note said `(air, 0.06 over the floor) ... the walk ends under it: stopped 0.07 blocks from it`.
- *A near end* (`Navigator.nearNoWay`). A main search from where the body stands that finds no progress, with the feet
  within 8 (`NEAR_END`) of the goal cell's floor centre, the body standing safely (`safeHere`: on the ground on a node,
  out of liquids) and the cell not lava, is a near end. What runs next is the list above: a search that was not cut
  is followed by one search at the last level; a cut one by each higher level's search, then the last level's bigger
  and long dig searches. Each of these searches (`PathOptions.nearEnd`) ends at the goal, or at the node of the search
  nearest the goal's centre by the eye (`astar.ts`: at least 0.25 nearer than the start, out of water, no
  irreversible drop on the way, not on a pillar, a swim or a climb), cut before its first dig, place or pillar. If it
  walks somewhere, the goto goes on from there as usual. When nothing is left to run, it answers: the "why" searches
  as before, but no bigger one after a cut, and only the rules the open way broke, each with a quarter of the main
  budget (they only name the rule).
- *The answer* (`Navigator.finishShort`, `GotoReport.short`). With the eye within 3.9 (`NEAR_REACH`, R7's reach for an
  air cell 5 over a floor) of the cell's centre: `arrived at X (the goal's cell x,y,z (what) cannot be reached (why):
  stopped D blocks from it)`. Farther: `goto: stopped short (D blocks from the goal's cell x,y,z (what): why)`, a
  failure that is not `unreachable`, since the goal was not reached and a person or a caller must be able to tell.
  "Why" is what the rest of the way needs: `the rest needs a block placed (a goto places no blocks)`, a fall over the
  budget, a built block broken; or `no walk, swim or dig gets nearer`, `the world past here is not loaded`, `no way
  nearer found within the searches' budget`. `GotoReport.nearTicks` counts the ticks from the first near end.
- *Not near.* A goal farther than 8 keeps the whole ladder, as before: the bigger searches there can find a way round a
  wall the first search did not reach the end of. A goal whose own chunks or the 8 round it are not loaded waits as
  before; unloaded world farther off is no reason to wait for a goal 8 away. A corridor waypoint's search is never a
  near end.

**Why on by default with no setting.** It only changes when a `!goto` answers and what it says. Every move, every
safety rule, the fall budget, the hazards and the edge rule are the ones the walk had. The end is where a search
under the same rules walked the body, and `safeHere` holds there. `Navigator.nearEnds = false` gives the behaviour
before, for the tests.

**`!test goto`** (`skills/test/series.ts`). A goto run is arrived only when its reply says so: `arrived at`, no failure
line, and the feet within 2.5 of the goal cell's floor centre or the reply's note says how far the walk stopped (R6,
R7 and R8 notes end `stopped D blocks from it)`). A failure reply with the body within 2.5, or `goto: stopped short`,
is its own end, `short`, counted in the summary line (`0/1 arrived, 1 short`) and in the record's `end`. The record
gains `reply` (`ok`, `fail` or null) and `replyDistance` (the distance the reply states). Before, a run ending 1.1 from
a portal's cell with `goto: unreachable (budget ...)` was counted arrived.

**The wording** (`commands-nav.ts dimensionWords`): `waypoint X is in the End, not in the overworld (!overworld
first)`. Before: `in the the_end`. `commands-portal.ts` builds `in the ${dimensionName(...)}` the same way in several
lines (`already in the the_end`, `beds explode in the the_end`); it is not this track's file and is left as it is.

**Offline** (`test/unit/skills/nav-r8.test.ts`, the real navigator in the bench's closed loop, the Mac at the live
wall-clock budgets, 2026-11-14, 10 runs a row, the start offset by up to 0.4 across the line). The portal: a frame
along x with its bottom row flush with the grass, the goal the portal's lower west cell, the walk from 15 blocks off.
The pit: grass with a pit 11 wide and 12 deep dug round the goal's column, one post left in it with its top 3 under
the goal's cell (where the ground was), the walk from 15 off. "Still" is the ticks from the body's last move to the
answer. "Before" is `Navigator.nearEnds` off, with `beside`.

| Case | Before, default | Before, live | After, default | After, live |
|---|---|---|---|---|
| a goal cell inside a nether portal | unreachable `rule place`, 1 tick, 0 plans, 15 from it | unreachable `world`, 355 to 362 ticks (still 287 to 295), 29 plans, 1.0 to 1.2 from it | next to it with the note, 69 to 70 ticks, still 1, 1 plan, 0.9 to 1.0 from it | the same |
| a goal cell over a lone post in a pit | unreachable `rule place`, 329 to 333 ticks (still 284 to 287), 30 plans | unreachable `rule place`, 414 to 436 ticks (still 368 to 390), 29 plans | `stopped short` 6.1 from it, `the rest needs a block placed`, 61 to 62 ticks, still 16 to 17, 7 plans | the same, 58 ticks, still 12, 6 plans |

Damage 0 and no death in every run. Also (1 run each): a goal over a post in a pit 25 wide, the edge 11.5 off,
keeps the ladder (unreachable after 284 ticks); the pit without `beside` stays unreachable; a goal cell over a path
block arrives on it with no note, feet 0.06 under the cell's floor; a cobweb's cell ends next to it with the note; a
fence on a tower 3 high, the eye within 3.9 of the cell, arrives within reach with the note (4.15 from the cell).

**On bds-pve** (`test/e2e/nav-near.test.ts`, BDS 1.26.60, 2026-11-14, noon, no mobs, 10 runs a case, the PvE
layer's walk with `explain` and `beside` as `!goto` gives it; the default settings, and `allowBreak` on as live;
each site on a platform of stone 14 high so the pit fits; this PC, so the times are this host's):

| Case | Before | After |
|---|---|---|
| portal, default | unreachable `rule place`, 1 tick | next to it, 66 to 67 ticks (3.3 s), 1 plan, 1.3 to 1.45 from the cell, still 0 |
| portal, `allowBreak` on | unreachable `budget`, 773 to 777 ticks (38.6 to 38.9 s), still 717 to 720 | next to it, 66 to 67 ticks, the same |
| pit, default | unreachable `rule place`, 358 to 371 ticks, still 308 to 321 | `stopped short` 6.1, 152 to 165 ticks, still 102 to 115 (5.1 to 5.8 s), 9 plans |
| pit, `allowBreak` on | unreachable `rule place`, 626 to 669 ticks, still 580 to 623 (29 to 31 s) | `stopped short` 6.1, 380 to 382 ticks, still 334 to 336 (16.7 s), 9 plans |

Damage 0, no death and no portal travel in the 80 runs. The pit with `allowBreak` on is the slow one: the platform
is 14 blocks of stone, so every search that may dig is cut by its budget, and the cut rule runs the next levels'
searches, the last level's bigger and long dig searches and the open walk before it answers. In the closed loop the
same shape answers in 12 ticks: there the searches are not cut.

**The ladder's tests with `beside`** (`REACH_SIM_BESIDE=1`, every goto of the closed loop given `beside`): nav-r2,
nav-r3, nav-r4, nav-digway and nav-reach, 69 of 69 passed (this PC).

**R5's, R6's and R7's rows** (their tests with `R5_OUT`, `R6_OUT`, `R7_OUT`, the base tree and this one, this PC).
R5's 103 rows and R6's 396 have the same replies, notes, plans and ends; 27 and 70 rows differ in their ticks, all by
1 but one by 2. Two runs of the base tree differ the same way (21 and 69 rows by 1 tick, one by 3): the closed loop
waits on the worker's answers by the wall clock. R7's 398 rows: the same, plus four that moved by R8. With `beside`,
a goal inside natural stone (underground, and a boulder) with the default settings is still dug into, in 103 and 82
ticks with 5 and 4 plans where it took 322 and 302 ticks and 24 plans (the near end goes to the dig way's level at
once); and the fence on a tower 3 high, R7's "perch with nothing in reach", now arrives within reach with the note in
71 and 74 ticks where it was unreachable `rule place` after 319 and 344.

**The reach bench** (`--config live --place off --speed 1 --worlds 20 --jobs 4`, the Mac, 2026-11-14, alone on the
host; 2541 pairs; this tree without `--beside` stands for the base, since nothing of R8 runs without `beside`):

- Without `beside`: 2464 at the goal, 0 deaths, 0 stranded, max damage 8, 6 the oracle reaches and the walk did not
  (caves:2:12, pits:2:13, unknown:13:17, hills:16:1, caves:17:11, long:18:3; R7's run had 8).
- With `beside` (`--beside`, as `!goto` passes it): 2465 at the goal, 26 more arrived within reach with the note, 21
  stopped short, 0 deaths, 0 stranded, max damage 8, 3 the oracle reaches and the walk did not (caves:2:12 and
  caves:17:11 unreachable as before, hills:16:1 stopped short 7.8 from its goal: `no way nearer found within the
  searches' budget`). 47 pairs had a near end; from the last move to the answer 42 to 534 ticks, the median 374.
- One pair at the goal without `beside` was not with it: pits:3:9 (a 2 x 2 tower 12 high, which the oracle calls
  `rule place`). Its log has no near end: the body never stood within 8 of the goal, and its ladder is the one it had.
  Run alone on this PC, 3 times each way, it arrived 6 of 6 (2216 to 2218 ticks, 38 dug) with and without `beside`:
  among 4 jobs at once its searches, all cut by their budgets, come out differently.
- Two pairs arrived with `beside` and not without: unknown:13:17 and long:18:3 (the long pair that swaps with the
  host's load under the 500 ms corridor limit, as R6 and R7 found).

A first version (one search at the last level, or the long dig search, after any near end) lost pits:13:11 on the
bench (stopped short 6.1 under the goal on a 2 x 2 tower that the dig way's level climbs), which is why a search cut
by its budget keeps the levels.

**Gates** (2026-11-14): lint; the unit suite on the Mac three times (2 900 tests, 3 of 3 passed); on bds-pve
`nav-low` (24), `nav-perch` (16), `nav-hostile-fall` (4), `pve-m1` (4), `pve-creeper` (4), `pve-combat` (12) passed,
and `nav-low`'s `beside` cases again on the final tree.

**On the Realm** (2026-11-14, deployed; `!test goto <waypoint> from home 1`, six trips, no damage, no death):

- **The portal's cell.** The cell was decided before the first plan (`(portal) cannot be stood on (portal: a cell the
  walk never enters): the walk ends next to it`), walked to with 1 plan in 57 ticks, and answered `arrived at ...
  (...: stopped 1.42 blocks from it)` 2.8 s after the walk began. The trip took 31 s where it took 95 s (65 s of them
  searches from 1.1 blocks off, then `unreachable`).
- **The cell over the lone block in the pit.** Every search was cut by its budget there, so the slow rule ran: the
  next two levels' searches (the body went from 5.1 to 3.3 blocks off on the first), the bigger and the long dig
  search, the open walk, then the "why" searches (`place lifted: found, 61 expanded`). The answer came 19.5 s after
  the first near end, 15 s after the last move: `arrived at ... (the goal's cell ... (air, 3 over the floor) cannot be
  reached (the rest needs a block placed (a goto places no blocks)): stopped 3.35 blocks from it)`. It is an arrival
  with the note and not `stopped short` because the node nearest the cell has the eye within 3.9 of it. Before:
  44 s of searches from the pit's edge 6 blocks off, then `unreachable`.
- **The others as before.** R7's cell 2 over a floor ended under it with R7's note; two ordinary waypoints and a
  trip home arrived in their usual times; a waypoint in the End answered `is in the End, not in the overworld`.
- **The scoring.** The six runs were scored by their replies (`reply` `ok` five times, `fail` once, `replyDistance`
  set for the three noted arrivals). Replayed over the 207 goto runs recorded there before: 205 score as they did, and
  the two runs that ended `unreachable` 1.1 blocks from the portal go from arrived to `short`.

To see it on any world: `!goto` a portal block's cell, or a cell in the air over a single block that stands in a hole
too wide to jump. The log says `no way nearer from here (...), D blocks from the goal's cell` once for every search of
the near end, then `the answer now`.

## Following a path

Per tick, from `InputLoop.onBeforeStep` (the command applies to the same tick):

- **Legs**: the path is walked in legs that end before a node with an action (or at a door to close).
  The body stops on the leg's last node, the action runs, the next leg starts.
- **Aim** (pure pursuit): the farthest node up to 6 ahead that is reachable in a straight line on the
  same feet height (footprint half-width 0.31, sampled every 0.2 blocks, on cells standable at that
  height). Doorway cells are not standable for this check, so doors are approached head on.
- **Turn** towards the aim at most 30 degrees per tick; `forward` while the aim is within 50 degrees.
- **Jump** when on the ground, facing the step within 25 degrees and within 1.4 blocks of the next
  node (or pushing against it), and still below its feet height (a body that landed off-centre on the
  step walks on instead of jumping again).
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
| dig | `actions.dig(p)` per cell in the plan's break order (the higher cell first); cells already free are skipped; Track BC: the whole list is re-read after every dig (a cell a falling stack refilled under `allowGravityAbove` is dug again after `DIG_SETTLE_TICKS` 12, at most `DIG_REPEATS` 8 extra digs), and a dig node that also places (pillar under a lid) places next | every cell is free; a failure marks the cell not breakable and re-plans |
| dig-down (Track BC) | the dig action on the block under the feet; the follower then presses nothing until the body stands in the node (`downward` target: idle) | the body is on the ground in the cell below |
| sneak (Track BC) | no action: the follower holds sneak while the target is a `sneak` node (into, through and out of the low cells), so the body enters the gap already 1.49 high; sprint stays off for 10 ticks after | the next node is a plain walk |
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
| `correct_player_move_prediction` (if `replanOnCorrection`), `set_entity_motion`, a teleport | re-plan (`correction`) once on the ground; Track BE: while a leg is walked, first the path check (below): standing in a node of the leg, the leg restarts there (no re-plan) |
| Track BE: the body more than 3 blocks from the path, or more than 2 for over 20 ticks | re-plan (`off_path`), no failure |
| Track BE: the body stands in a node past the follower's aim | the leg restarts at that node (skip-ahead), no re-plan |
| Track BE: an action runs longer than its node's cost + 100 ticks | the action fails (`overrun`): failure + 1, blacklisted like a failed action, a dig cell not dug again this goto |
| `World.onBlockUpdate` within 1 block (x / z) and y - 1 .. y + 2 of a node not yet passed, whose movement signature (boxes, floor, liquid, danger, cost factor, roof, open ...) changed | invalidate, re-plan (`block`); updates that change nothing the planner reads (grass to dirt) only invalidate the cache |
| a section of a loaded column (re)placed by a chunk packet, or a column dropped (`ChunkStore.onSection` / `onColumnUnloaded`; a re-sent `level_chunk` replaces its column with a fresh unloaded one; Track BC) | once on the next tick, the grid's caches are dropped (`NavGrid.clear`): a chunk re-sent after a teleport or a server-side fill carries changes that never came as block updates, and the grid had answered from the old blocks (the nav-digmoves cave course found its shaft column "already free" that way); no re-plan by itself |
| the move under way (straight line from the last node passed to the aim) takes more than 2 x its estimate + 10 ticks | re-plan (`timeout`), failure + 1 |
| no progress (remaining path not 0.05 shorter) for 40 ticks | re-plan (`stuck`), failure + 1 |
| an action fails or times out (dig 600 ticks per block, use / place 100) | re-plan (`action`), failure + 1; the cell is not dug / pillared in / opened again during this goto; after 2 failed places the goto plans without pillaring |
| a failure while the body is not on a safe node (in water / lava, airborne, no standable node) | retreat first: steer to the last safe node (forward, jump in water or against a wall) for up to 60 ticks |
| no standable node under the body, or the best node is the start (Track BA: also a `no_progress` plan, no partial end 5+ blocks out) | wait 20 ticks, failure + 1 |
| the retry after a `no_progress` plan (all loaded) would start from the same node, by the same planner (worker / in-thread), with no block change the planner reads since (`worldGen`: block updates, re-sent sections) | `unreachable` at once, no search (2026-10-31: the same 2-second search ran 3 times per goto, every 8 s for 15 minutes). Not after the 40 ms in-thread stand-in while the worker starts (its retry runs in the worker), not for a `runAway` from a moving threat, and not once a plan with a path came back in between. Changes outside `worldGen` do not count: mob avoidance costs, a new tool or more throwaway blocks (the next goto plans with them) |
| 3 failures | `unreachable` |
| the main search says `none`, or a `block` goal is a cell nobody can stand in | `unreachable` at once |

**Partial-path end** (Track BA, ported from Baritone's `AbstractNodeCostSearch` /
`AStarPathFinder`, `nav/baritone/bestSoFar.ts`, LGPL-3.0). A search that stops at its budget (or
touched unloaded world) keeps 7 bests, best k scored `h + g / k + trap` for k in 1.5, 2, 2.5, 3, 4,
5, 10 (`h` the goal heuristic, `g` the path ticks, `trap` the irreversible-drop penalty; a best is
replaced only by a score lower by more than 0.01). The path ends at the first best (lowest k) more
than 5 blocks (straight line, y included) from the start; with none, the result is `partial`, the
start node alone, `reason: 'no_progress'`, which the navigator counts as a failed plan (the "best node
is the start" row above; the blacklist as before) instead of walking 1 to 4 blocks and re-planning.
While no best is 5+ blocks out (Baritone's `failing`), a search runs on past `maxNodes` up to 4 x it
(Baritone's failure / primary timeout, 2 000 / 500 ms); `maxMs` stays the hard cap. Before (the one
node with the lowest `h + trap`), the bot walked into the base of a U wall and every plan from there
ended where it stood; now the higher coefficients pick a node round the corner. The trade: k 1.5
prefers cheap progress, so a node-limited search past the mouth of a long open dead-end corridor
pointing at the goal can end at its far end (main's scoring had ended past it); the next plan, from
there, gets out: at 50 to 64 nodes the k 1.5 best of a 12-long dead end pointing at the goal is its
far end, walked to and back (+12 ticks, about 8 %), while at 16 / 32 nodes main's unreachable becomes
ok. `g` already includes the drop penalty, so `trap` counts once more on top of `g / k`. The bests
are updated at expansion (Baritone: at relax): a partial path can end one move short of Baritone's
(only closed nodes win), `failing` clears one expansion later, and a best always carries its final
`g`. The 4 x extension also changes non-partial outcomes: a search that used to stop `partial` at
`maxNodes` can now end `found`, or `none` (open set emptied), and `none` makes the navigator answer
`unreachable` at once instead of counting failures. Navigator effects: a `no_progress` result with
`unknown` and not `limited` takes the wait-for-chunks branch; a start-only worker interim is ignored
(the body stands until the final answer); a `maxMs`-cut search that only got within 5 blocks now
counts as a failure. Not taken from Baritone: its time budgets (ours are `maxNodes` / `maxMs`), the
static cut-off of the last 10 % of a partial path (`pathCutoffFactor`), the bests updated when a
neighbour is relaxed (ours: when a node is expanded), `MIN_IMPROVEMENT` for re-opening nodes (found
paths are unchanged).

**Off the path** (Track BE, ported from Baritone's `PathExecutor`, `nav/baritone/executor.ts`,
LGPL-3.0; `NavigatorOptions.offPath`, default on, `false` is main's behaviour). Per tick, before the
follower steers, and only while it walks (not during an action: dig, use, place; not while the body is
in the air: a jump, a fall, an irreversible drop, a knock; not in water, on a swim / climb / parkour /
pillar target, a parkour run-up, a glide):

- **Distance from the path**: to the polyline of node centres at feet height, from 8 nodes behind the
  last node passed to 16 past the aim (Baritone `closestPathPos`: to every block centre of the whole
  path). More than `MAX_MAX_DIST_FROM_PATH` (3) blocks: re-plan at once (`off_path`). More than
  `MAX_DIST_FROM_PATH` (2): "possibly off path", re-plan once that has held for more than 20 ticks
  (`offPathGraceTicks`; Baritone's `MAX_TICKS_AWAY` is 200: a body that is coming back is within 2
  blocks again in a few ticks, one the follower walks parallel to the path (see Known gaps, the aim
  runaway) never comes back, and the stuck detector is 40). Not a failure; a pending re-plan of
  another reason is kept.
- **Skip-ahead**: the body stands (cell, feet within 0.6, a walk / diag / jump / drop node) in a node
  past the follower's aim (within 64): the leg restarts there (Baritone's "Skipping forward", which
  starts at pathPosition + 3; our aim is already the farthest node the follower walks to).
- **The path check after an event**: a correction (with `replanOnCorrection`), a knock
  (`set_entity_motion`) or a teleport while a leg is walked on the ground no longer re-plans at once:
  from the next tick, once the body stands (in the air: up to 20 ticks; in water: at once), a body
  standing in a node of the leg behind the last node passed or past the aim restarts the leg there
  (Baritone: snap `pathPosition` back after a lag teleport, forward after a push), one between them
  walks on; a body in no node of the leg, or in water, re-plans (`correction`), as before. The check
  runs before the tick's re-plan, so that re-plan is not a tick late. A knock re-plans at once, as
  before, unless its estimated landing (flight x 0.91 per tick, gravity, then the ground slide, flat
  ground assumed) is within 1 block of the leg and not in a liquid. Events re-plan as before during an
  action, a retreat, a main search, a glide, in water, and on a swim / climb / parkour / pillar target
  or a parkour run-up (main re-plans there on the next tick).
- **Overrun**: an action (dig, use, place) failing once it has run longer than its node's planned cost
  + 100 ticks (Baritone: `ticksOnCurrent > cost + movementTimeoutTicks`; `overrun` option `{ factor 1,
  margin 100 }`): re-plan (`overrun`), failure + 1, the action cell blacklisted as a failed action is,
  and the next dig cell not dug again in this goto (as a failed dig). Checked only while no action call
  is pending (the Digger times out on its own estimate, 1.5 x) and not when the last dig just
  succeeded: in practice between two digs of one node. For n cells the dig node's cost is the sum of
  their break times + 60 n (`digPenalty`) + the walk, so the budget is that + 100. Use and place keep
  their 100-tick timeouts (always shorter). Walking moves keep the per-move timeout (2 x the estimate +
  10, `timeout`): shorter than Baritone's cost + 100 for every move up to 90 ticks.
- **Dig timeout**: the navigator's dig timeout (600 ticks per cell) now aborts the Digger's job
  (`NavigatorOptions.cancelDig`, BotSkills wires `Digger.cancel`); before, the abandoned job made the
  next dig answer `busy`.
- **Break times**: the planner's break times use the Digger's tool filter (`NavigatorOptions.toolOk`,
  BotSkills wires `Digger.toolOk`: Track S worn tools count as an empty hand), in-thread and in the
  worker (the navigator sends the worker the filtered hotbar), so a dig is priced with the tool the
  Digger will use.

Report: `offPath` (re-plans), `skips`, `snaps` (legs restarted after an event), `overruns`.

Not taken from Baritone: its per-tick cost re-check of the next 5 movements (`costVerificationLookahead`,
`maxCostIncrease`: ours re-plans on block updates near the path), the pause while the next segment's
search could backtrack (`shouldPause`), the sprint rules (ours are measured), the trim of walked path
history (`maxPathHistoryLength` 300 / `pathHistoryCutoffAmount` 50: our checks read a bounded window,
the path array of one goto is not trimmed).

The report (`skills.status().lastGoto`) has each plan (reason, tick, status, nodes, expanded, ms,
slices), segments, corrections, motions, stuck and move timeouts, failures, distance, sprint ticks,
`maxTickMs` (longest tick in the navigator, planning included), `planMs`, action counts, retreats and
ticks waited for unloaded chunks.

### A walk keeps to its way (Track W2 way, decision 0088)

Decision [0088](decisions/0088-a-walk-keeps-to-its-way.md); `nav/way.ts`, `Navigator.keepWay`, `onRejoinResult`,
`onKeepResult`. (Not the water dig-out, which is also called Track W2 above: this one is "W2 way".) A goto that knows a
whole way walks it to the end. It does not plan partial ways and change its mind. A re-plan from a new position does
not turn the body round onto another way unless that way is clearly shorter. A goto taken up again after the guard
goes on along the way it was on.

**Why.** On the Realm (2026-11-14 and 15, 17 walks from a flight's landing at a cave's mouth to five goals deep in a
cave under a mountain), the landing search's probe had found the whole walk, 76 to 166 blocks of path. The walk
planned its own, and three things went wrong:

- The end lines said 141 to 214 blocks for probed paths of 112 to 167.
- Twice the walk turned back to its landing.
- Once it wandered for 355 s where three repeats took 101 to 154 s.

The closed loop over a world-cache extract of the same cave (the reach bench's, `walk-way-bench.ts`, the live
settings and budgets) explains each of the three:

- **Farther is mostly another unit.** The goto's end line counts every tick's 3D motion: the stair steps up and down,
  the sway round the corners. The probe counts the polyline of its node centres. Offline, with nothing in the way, the
  walk's own path was 0.93 to 0.99 of the probe's, in the probe's unit. Its motion was 1.26 to 1.37 of it, which is the
  Realm's 1.25 to 1.28. The plan-by-plan line below now prints the blocks of each plan's path in the probe's unit.
- **The turn back and the wander come from hostiles round the way.** Their costs (`avoidance.ts`) pushed the walk's
  first full search past its budget (2.5 s). It ended partial, 14 nodes out. The plan-ahead from there had its smaller
  budget. It took the best partial end it had, 160 nodes down a side passage, and the next plan came back. With one
  zombie on the probed way at 0.3 and one at 0.6 of it, walking towards the body:
  - cave_8: 342 blocks of path for a probed 149, in every run;
  - cave_19: 314 for 134, in 2 runs of 10 (the search's budget decides);
  - 36 turns back in 12 of those 20 runs.

  The probe plans with no hostile costs, so it had the whole way.
- **The dive that timed out.** See the dive item under the rules below.

**The rules.**

- **A handed way** (`GotoOptions.way`): the flight's walk after a landing hands the goto the landing probe's path
  (docs/flight.md "The walk after a landing takes the probe's way").
  - When the body stands on one of its nodes, the goto walks it from that node with no search. On a node means the
    feet are within `WAY_ON_H` 1 by the plane (its cell, or the centre of the next) and `WAY_ON_V` 0.6 by height (its
    level, Track BE's skip-ahead number). Not a level off: a body 1 block over a node that is left by a drop of 3
    falls 4 and is hurt. With 1.1 here, a walk resumed beside its way on the cave took 1 HP in every run.
  - When the body is off the way but within `REJOIN_MAX` 8 blocks of it, a rejoin search runs in-thread. Its goal is
    any node of the way from the nearest one plus the distance, rounded up, to `WAY_AHEAD` 48 nodes past the last node
    passed. Its budget is `REJOIN_NODES` 6000 nodes and `REJOIN_MS` 120 ms. The way is walked on from the node it
    reaches.
  - Farther off, or when a node of the way can no longer be stood on (`wayBroken`: a block placed on it, a floor
    dug out), the goto plans afresh, as before.

  A handed way that is a partial path takes the walk's own plan from the way's end.
- **The search beside the way.** Once a handed or resumed way is taken at the start, the goto's ordinary search runs
  beside it, as the final answer runs beside a worker's interim answer.
  - Its plan replaces the way only when it is clearly shorter: shorter in blocks of path than the way's rest by
    `KEEP_MARGIN` 0.2 of it, and by at least `KEEP_MIN_BLOCKS` 8 blocks. It must also have no more actions (digs,
    opens) than the way.
  - When it is clearly shorter, it is spliced in where the two meet. If they do not meet, the goto re-plans from where
    the body is.
  - Why 20 %: the walk's own plans and the probe's differ by 3 to 8 % in blocks on the same ground. The probe plans
    with no surface preference and no long falls, and the walk's own plans change from search to search with their
    budget. 20 % is over twice that, so the two never take turns.
  - Why 8 blocks: on a short way, 20 % is a few blocks. The moves' own costs (a diagonal against two straights, a drop
    against a stair) make that either way.
- **Resumed.** An interrupted goto that was walking a kept way (handed or its own) remembers the rest of it for
  `RESUME_KEEP_MS` 180000 ms (3 minutes: a guard fight, a meal). The goto that `GotoProcess` asks again with `resume`
  after a pre-emption takes it as a handed way, for the same goal only. An arrival forgets it.
- **Dropped.** Any other re-plan drops the kept way and plans afresh, as before: a block changed on it, a move timed
  out, an action failed, the body stuck.
- **Its own way.** A goto's own plan that reaches the goal is kept too. After a correction or off_path it is walked on
  only when the body stands on one of its nodes, within `WAY_BACK` 4 nodes behind the last node passed to `WAY_AHEAD`
  48 ahead. Off it, the goto plans afresh, as before. A rejoin there makes a kink that the follower's pure pursuit cuts
  across, and that made a second off_path in the open (the nav-offpath shove case).
- **No corridor at the start under a handed way.** The coarse layer's corridor is asked only once the handed way is
  dropped. Its windows would cut the whole way into near goals.
- **One line a plan.** For a walk to a place (`block`, `xz`), every plan is one INFO line, for example
  `goto: plan (start, final) found, 104 nodes, 139.3 blocks, 47588 expanded, 1386 ms, ends ...`. The reason and the
  tag in brackets are one of `interim`, `final`, `ahead`, `rejoin`, `beside the way` or `the way`. The decisions are
  lines of their own:
  - `walking the handed way from node i of n`;
  - `rejoining it (nodes a to b of n)`;
  - `back onto its way at node j`;
  - `the fresh plan F blocks against the way's K ...: walking on along the way`;
  - `... clearly shorter, taken from there`;
  - `off its way by more than 8 blocks ... planning afresh`.
- **A drop beside lava.** The follower creeps off a 1-block drop with lava beside it, at 0.05 a tick, with forward
  presses spaced by the double-tap guard. That takes about 60 ticks, and the move timeout (2 x the estimate + 10) was
  34. The move timed out, and the retreat turned the body back onto the step it had left. `DROP_CREEP_TICKS` 30 is now
  added to the move's estimate when the follower will creep into it (`Follower.creepsInto`). That makes it 94 ticks
  for a drop of 12.
- **The dive off a rim.** A body on dry ground at a pool's rim, over a `dive` node, sneaked (the sink rule for a body
  more than `DIVE_SINK` above the node). A sneaking body never steps off an edge, so the move timed out three times
  (the Realm, 2026-11-14: `dive, est 8.0 ticks, timed out after 27 ticks`, from a spot the guard had left the body on).
  On dry ground the sink rule is skipped: the body walks off the rim and sinks once wet.

**Measured** (the closed loop over the cave's extract, this PC, 2026-11-15, 10 runs per goal and case, every run
arrived, no damage; blocks of path walked against the probe's, in the probe's unit, p50 / max):

| case | cave_17 | cave_16 | cave_19 | cave_8 | cave_9 | turns back |
|---|---|---|---|---|---|---|
| before, nothing in the way | 0.966 | 0.986 | 0.985 | 0.933 | 0.983 | 0 |
| before, two zombies on the way | 1.099 | 1.064 | 1.015 / 2.352 | 2.292 | 1.019 | 36 in 12 runs |
| after, the probe's way handed | 1.018 | 1.013 | 1.010 | 1.007 | 1.009 | 0 |
| after, two zombies on the way | 1.018 | 1.013 | 1.010 | 1.007 | 1.009 | 0 |
| after, no way handed (a plain `!goto`) | 0.966 | 0.986 | 0.985 | 0.933 | 0.983 | 0 |
| before, the walk interrupted and resumed | 0.979 | 0.985 | 0.985 | (not interrupted) | 0.984 | 0 |
| after, the walk interrupted and resumed | 1.031 | 1.012 | 1.010 | (not interrupted) | 0.991 | 0 |

The interrupted walk: a zombie 5 blocks beside the probed way at 0.3 of it. Once the body is within 8 blocks of it,
the goto is cancelled. The body walks to the zombie, stands 40 ticks, the zombie is gone, and the goto is asked again
with `resume`. On cave_8 no standable cell lies 5 off the way there, so that walk was not interrupted. After the
resume, the walk rejoined its way in 4 to 6 nodes (a search of 6 to 34 nodes, 0.6 to 7.5 ms on this PC). No damage. Before
`WAY_ON_V` was 0.6, the resumed walk took 1 HP in every run (the level-off case above).

- Seconds, before against after, nothing in the way:
  - cave_17: 30.3 against 31.0;
  - cave_16: 40.8 against 41.3;
  - cave_19: 48.1 against 51.5;
  - cave_8: 52.6 against 57.9;
  - cave_9: 57.6 against 62.3.

  The probe's way is a little slower. It takes no long falls: on cave_8 it is a stair of drops beside lava, against
  the walk's own fall. It was not clearly longer, so it was kept.
- With the zombies, before against after:
  - cave_8: 106 s against 57.9 s;
  - cave_19: 53.4 s (95.4 in the 2 runs that went down the side passage) against 51.0 s.
- Plans a walk, after: 2 or 3, which are the way, the search beside it, and on cave_9 a plan-ahead from the way's
  partial end. Before: 2 to 4, and 4 to 6 with the zombies.
- A plain `!goto` (no way handed) walks tick for tick as before.

On a server (`test/e2e/nav-way.test.ts`, the cave's extract rebuilt round the five walks, a box of 171 x 198 x 162,
this PC, 2026-11-15, 10 runs a goal and side, every run arrived, no damage, no turn back):

| side | cave_17 | cave_16 | cave_19 | cave_8 | cave_9 |
|---|---|---|---|---|---|
| before: blocks against the probe's / s | 0.966 / 28.3 | 0.986 / 40.6 | 0.988 / 47.0 | 0.941 / 51.3 | 0.991 / 56.7 |
| after: blocks against the probe's / s | 1.018 / 32.1 | 1.013 / 42.3 | 1.010 / 48.3 | 1.007 / 54.9 | 1.008 / 58.6 |

The probes found the same paths as offline (to 0.1 blocks), so the rebuilt cave is the extract's.

The same walks interrupted on the server (`NAV_WAY_GUARD=1`, 10 runs a goal and side), every run arrived, no damage,
no turn back:

- At 0.3 of the way the goto is cancelled, the body walks to a cell 5 off the way and stands 40 ticks, and the goto
  is asked again with `resume`. bds-cache is peaceful, so the guard's fight is stood in for. On cave_8 there is no
  such cell, so that walk was not interrupted.
- Before: 0.986 to 1.031 of the probe.
- After: 1.008 to 1.074. Every resumed walk took its way up again: it stood on the way, or rejoined it a few nodes on.
- After took 0 to 3.9 s longer than before. A fresh plan from the side cell is a little shorter than going back onto
  the way, but not by 20 %, so the way is kept.

On the test host under the live bot's CPU policy (`--as-live`, `--speed 1`, 2026-11-15, the same cases, 10 runs
each), the picture was the same:

- After: 1.007 to 1.031 of the probe's blocks, interrupted or not, with no turn back and no damage.
- Before, with the zombies, the walk went down the side passage on cave_19 in every run: 2.39 of the probe, with 30
  turns back in 10 runs. On cave_8 it took 0.98.
- The search beside the way took 0.46 to 2.0 s in the worker, while the body walked. That is what the walk's own
  first search cost before (0.5 to 2.0 s).
- A rejoin took 2 to 33 ms in-thread.
- 7 of 262 probes ran out of their budget in a job's first, cold run. Then no way is handed, and the walk plans as
  before.

The reach bench at the live settings (`--config live --place off --speed 1`, worlds 1 to 10 of every class, the test
host, 2026-11-15), main against this change, pair by pair:

- 1262 pairs each. 1260 had the same outcome and the same damage.
- Ticks over the 1221 pairs both arrived at: +0.54 %.
- caves:1:0 arrived with 1 HP of damage, against 0 on main. Main does the same on this PC in 2 of 3 reruns.
- lava:7:10 arrived, where main died. Main arrives on this PC in 2 of 2 reruns.
- Both are the wall-clock budgets' run-to-run spread, not this change.
- False unreachable: 2 against 3. Deaths: 0 against 1.
- One bench worker ran out of its 6 GB heap in both runs. On this PC main's worker reaches 6.1 GB on long:1 too, so
  it is the bench's and not this change's; no pair was lost to it.

The trade: a handed way is the probe's, and the probe plans with no hostile costs. The body walks it past a hostile
that the walk's own plan would have gone round. The guard (`mobReflex`) deals with a hostile that comes close, and the
resumed walk goes on along the way.

**On the Realm** (2026-11-15, deployed; 10 night trips to the five goals, the guard fighting on the way). Nine walks
were handed the probe's way (76 to 166 blocks; the tenth landing had no probe of its own cell and planned as before).
All arrived; none turned back to its landing and none wandered. Eight of the ten walks were interrupted by the guard
at least once: each went on along its way from the node the body stood on (`walking the handed way from node k`,
`walking the resumed way`), and once, 3.9 blocks off it, a rejoin of 8 nodes (3 ms) took the body back. The end lines' blocks, which count the body's motion, read 1.29 to 1.42 of the
probe's (1.26 to 1.37 is the unit alone; the rest is the fights). The trips took what they took before or less (76 to
120 s to four of the goals; 117 and 148 s to the fifth, the longer one with a landing moved for a creeper and a second
flight to another mouth). How to see it on any world: the log's `walk: from the landing cell along the landing
probe's way (N nodes, B blocks)`, one `goto: plan (...)` line a plan, and `walking the resumed way` after a fight.

## Long trips: the coarse layer (Track CB, decision 0066)

A goto whose goal is farther than `coarseMin` (96 blocks, straight line; 0 = off) first asks the coarse layer
([coarse.md](coarse.md), `bot/src/skills/coarse`) for a corridor: a search over the open space of every chunk
the bot has ever seen (the world cache, underground included) that finds the cave entrance 400 blocks back or
the way round a ravine, which no segment of the planner above can see. The navigator then plans towards the
corridor's waypoints a window at a time (`nav/corridor.ts`: the farthest within 32 blocks of corridor, as a
`near` goal; the goto's own goal once the rest is short), re-plans the corridor when chunks near it change or a
waypoint cannot be reached (its opening is marked failed for 30 minutes), and falls back to everything above
when there is no corridor. The report has `corridor` (requests, status, waypoints passed and failed).

## Compute

Wave 8 Track AB, [decisions/0023](decisions/0023-planner-worker.md). The question was whether the bot
uses the Mac's compute or is "rated to the Realm tick speed". Before: A* on the main thread, sliced
at 8 ms per 50 ms tick, a main plan (the body stands and waits) 40 ms / 20 000 nodes, a plan-ahead
100 ms / 20 000 nodes. Now the navigator plans in a `worker_threads` Worker with much bigger
budgets, and the main thread only forwards the world to it.

```
main thread                                         planner worker (nav/worker.ts, same file)
 ChunkStore events ── column loaded ──┐              MirrorWorld (worker-grid.ts)
                   ── section re-sent ┤  MirrorOps     loaded sections (layer 0 copies)
                   ── block set ──────┼─ batched ──▶   BlockInfo per state id (each once)
                   ── column unloaded ┤  per turn      cached column summaries (corridor)
 WorldCache ───── summaries (corridor)┘              NavGrid ─▶ PathSearch (same code)
 Navigator ── plan(start, goal, options, generation) ──▶ 25 ms slices, messages between slices
          ◀── interim (best partial after mainMs) ────── peek()
          ◀── result (PathResult) ────────────────────── step()
```

| Piece | What |
|---|---|
| `nav/worker-grid.ts` | `MirrorWorld`: applies `MirrorOp`s (world bounds, BlockInfos, columns, sections, unloads, block changes, cached summaries) and exposes a `TerrainSource` that answers like `worldSource(world)`: loaded columns from the section copies (same `Layer` class), unknown runtime ids as `unknown` solid blocks, unloaded columns from the cache stand-ins, `columnTop` the same way. |
| `nav/worker.ts` | `PlannerClient` (main thread): subscribes to the chunk store, copies layer 0 of each section of a column that finishes loading (palette, runtime ids, index array: copied, the main thread keeps its own), sends the BlockInfo of each state id the first time a palette or block change references it, batches ops per event-loop turn (`setImmediate`), sends the initial snapshot of the loaded columns 5 ms per 5 ms timer, and the world cache's summaries of the unloaded columns within 1 chunk of the lines from the start to the goal's points (radius 4 chunks for goals without a place) before a request (6 ms per tick, at most 10 ticks of waiting). `WorkerSearch`: the navigator's handle (`step()` like `PathSearch.step`, `takeInterim()`, `cancel()`). The worker side (`runPlannerWorker`): one search at a time in 25 ms slices, the interim answer once `interimMs` of search has passed. |
| `nav/navigator.ts` | `attachPlanner(world, { threads })`, `plannerThreads()` read every tick (the worker starts and stops with it), `newSearch` (worker when ready and the options cross threads, else `PathSearch` in-thread), `stepSearch` (interim, upgrade, stale check, fallback), `onUpgradeResult` (splice). |

**Budgets** (`workerBudgets`, `NavigatorOptions`): main plan 500 000 nodes / 2 000 ms, plan-ahead
60 000 nodes / 300 ms; `path.maxNodes` / `path.maxMs` override both kinds, as in-thread. The
in-thread fallback keeps the old budgets (`mainMs` 40, `segmentMs` 100, `segmentNodes` 20 000).

**The body never waits longer than before.** A main plan that is not done after `mainMs` (40 ms of
search) sends `PathSearch.peek()`, the best partial path so far; the navigator walks it (plan record
`interim`) while the search goes on. The final answer (`upgrade`) is spliced in at the first node of
the remaining interim path (from the last node passed, or the node of a running action) that it also
visits; without one, a `found` answer re-plans from where the body is (reason `upgrade`), a partial
one leaves the interim path (its end plans ahead as before). Plan-aheads have no interim: the body
keeps walking the current segment. Searches that finish within 40 ms have no interim answer at all.

**Stale answers.** Every block change whose movement signature differs gets a generation number
(`noteChange`); a worker answer requested before a change within the re-plan distance of its path
(1 block sideways, y - 1 .. y + 2) is dropped: a main plan re-plans (`block`), a plan-ahead restarts.

**Fallbacks.** In-thread planning while the worker is not ready (start-up: about 180 ms to the first
`ready` on bds-move; the initial snapshot; 1 s after a crash), for options the worker cannot rebuild
(a custom `path.breakTicks`; a `cellCost` that is not the survival kit's avoidance, whose function now
carries its sources and costs), for `navigator.plan()` and the other one-off planners (mining probe,
tests), and when the worker has not answered within the budget + 2 s. A crash is logged once (WARN),
the worker restarts after 1 s, at most 5 times. Break times: the hotbar is sent with each request and
`chooseTool` runs in the worker. The world cache records which cells the planner read from cached
columns (a column that loads later announces the cells that changed as block updates, so a running
goto re-plans): the client reads the cells around each worker path on the main thread for that.

**Setting**: `plannerThreads` (0..1, default 1; `!set plannerThreads 0` plans in-thread exactly as
before). Wired in `tasks/registry.ts` for the afk task; tests call `nav.attachPlanner(world)`. One
thread: the navigator runs one search at a time.

### Measured (bds-move, BDS 1.26.60.6, 2026-10-29)

Before (main's code, `test/e2e/nav-compute.test.ts` on the old navigator) and after
(`plannerThreads` 1 vs 0 on the same terrain, same run). "Max tick" is the goto report's `maxTickMs`
(the longest time one tick spent in the navigator, planning included); the gap between two physics
ticks stayed 62 to 76 ms in every run (Windows timer jitter at 50 ms).

| Walk | Before (main) | Worker (`plannerThreads` 1) | In-thread (`plannerThreads` 0) |
|---|---|---|---|
| house (nav-stairs layout: around a wall, 2 levels of stairs, a door) | ok, 1 plan, 620 nodes, 2.3 to 19.6 ms, 1 segment, 0 corrections, max tick 3.1 to 17.5 ms | ok, 1 plan (620 nodes, 23.6 ms in the worker over 2 ticks), 1 segment, 0 corrections, max tick 12.8 ms | ok, 1 plan, 6.6 ms, 1 segment, max tick 7.7 ms |
| 120 blocks of the cross-country course | ok, 1 plan, 2 138 nodes, 6.4 to 15 ms, max tick 7.7 to 8.9 ms | ok, 1 plan (13.2 ms), max tick 0.9 ms | ok, 1 plan (15.4 ms), max tick 9.0 ms |
| goal 120 blocks away behind a cup of walls (about 250 blocks around) | (not in main's run) | **ok** in 47.9 s, 262.5 blocks: 1 plan (interim after 40 ms: 60 nodes / 8 562 expanded, final: found, 245 nodes, 28 650 expanded, 116 ms), spliced in once, 0 partial segments, max tick 1.2 ms | **unreachable** after 13.7 s and 58.9 blocks: 5 plans, every one at its budget (40 ms / 8 463, then 20 000 nodes), max tick 8.9 ms |
| sealed cell 100 blocks away, allowPlace (pillar moves) | unreachable, 5 plans, 7 551 to 20 000 nodes, each at its budget, planner 228 to 260 ms in all, max tick 9.1 ms | unreachable, 5 plans of 345 584 / 60 000 / 430 623 / 240 467 / 286 327 nodes (2 000 ms each for the main plans), planner 8.2 s in all, **max tick 1.2 ms** | unreachable, 5 plans of 6 615 to 20 000 nodes, max tick 9.2 ms |

Before the change, the cache-gather forest walk (CLI, bds-cache, natural terrain, 97 blocks to a
remembered forest, an `any` goal over 25 logs): ok after 419 ticks, 98.3 blocks, 2 plans, 2
segments, 1 correction, max tick 13.7 ms.

Forwarding (the client's stats over a whole e2e run on the flat world, 4 worker starts): 4 761
columns, 5 847 block changes, 73 BlockInfos, 19.7 MB copied, 53.8 ms of main-thread time in all,
1.6 ms the longest single flush; worker ready 180 to 190 ms after start. Unit test (`nav-worker`):
20 random start / goal pairs on a generated hilly world gave the same status, cost and expanded
count in the worker thread as in-thread (20 / 20); 200 random cells per stage (loaded, after block
updates and a re-sent column, cached) had identical blocks, classes, `stand`, `standThrough`,
`crossing`, `skyTop` and `columnTop`.

## Goals

`Goal` (PLAN.md 4.3: block, near, xz) is what older callers switch over; `NavGoal` adds the task 7.10
goals, and `Navigator.goto` / `BotSkills.goto` / `plan` take any of them. A goal is a predicate on a
node (feet cell + feet height) and an estimate in blocks (`GoalTest.done` / `h`, nav/goals.ts).

| Goal | Done when | Heuristic |
|---|---|---|
| `block {p}` | the feet cell is p | `columnH`: octile to p's column, levels to p.y |
| `near {p, r}` | feet within r of p (3D) | octile - r |
| `xz {x, z}` | any cell of the column | octile |
| `any {goals}` | some member is done; `member()` says which (the first) | min over the members |
| `getToBlock {p, reach = 4.5, face = true}` | the feet cell is in one of the 8 columns around p with p at the feet or the head (feet cell y or y - 1), or right on top of p, or 2 below it; p within `reach` (eye to the closest point, plus the server's corner limit: `checkReach`, docs/digging.md); and when p has an exposed face at all (a neighbour that is not a full cube), one such face turned to the eye. From the 4 sides, on top or below, that face borders the cell the bot stands in; from a diagonal the eye sees two side faces, which walls or glass may cover. Track AN: `low` (default 1) lets a side cell's feet be up to `low` blocks below p (home logistics uses 3: chests on stacks and pillars) | `columnH`: octile - sqrt 2, levels to p.y - max(low, 2) .. p.y + 1 |
| `yLevel {y}` | the feet cell's y is y | difference in y |
| `runAway {from, r}` | at least r (horizontally, from the cell centre) from every threat; `from` is a point, points, or a function read at every plan | r - distance to the nearest threat |
| `surface` | sky above the head (`NavGrid.skyTop`, the sky-column cache) and the feet no more than a step (0.5625) below the local ground: the 25th percentile of the column tops in the 7 x 7 columns around, + 1. A 1 x 1 to 3 x 3 pit or a ravine floor is below it, the foot of a cliff or a tree is not | the rise to the local ground |

`twoBlocks` / `threeBlocks` (Track BD) use `columnH` too, the levels to their feet range (p.y - 1 / p.y - 2
.. p.y). **Levels** (`columnH`, 2026-10-31): the heuristic of a goal at a known height is max(octile,
levels) plus, beyond `FREE_LEVELS` (4), the levels priced like a staircase into the ground
(`levelWeights` from the search's costs: down `fall[1] + landing + underground` = 13 ticks, up `jump -
walk` = 5.4 ticks, over `walk`; Baritone's GoalBlock adds GoalYLevel's FALL_N_BLOCKS_COST / JUMP_ONE_BLOCK_COST
the same way). Within 4 levels the heuristic stays admissible (no move costs less than `walk` per level:
a 3-block drop walk + 9 + 2, a ladder 5, a jump 9), so the short-range choices stay optimal (the
staircase over a 3-block drop, the stairs over a pillar). Before, the column goals had no y part (octile
only): a body straight above a goal scored 0, every node around it worse, so a search cut short by its
budget had no partial end 5+ blocks out (`no_progress`) - the Realm miner stood over a coal ore 13 blocks
down, its 64-member composites failed 3 x 2 s every 8 s for 15 minutes; and `!goto mine` (298 -54 -93, a
hand-dug staircase 119 levels down whose entrance is 9 blocks from home) walked the surface to the column
over the goal. Measured on the Realm's world cache (.work, not in the repo), budget 350 ms: the composite
from 195 70 -28 found (20 k nodes; before: `no_progress`), `!goto mine` found down the staircase in 1 750
nodes (before: partial to 298 73 -93, the surface over the goal; 86 k nodes without digging, none in budget
with it). Callers without costs (goto.ts remaining distance, the blame of an `any` member) get unit weights.

`goto` with an `any` goal reports the member reached in `report.reached` (`{ index, goal }`, the index
into `goal.goals`). A `runAway` whose `from` is a function is checked again when the path ends: if the
threat has followed, the navigator plans on (until `timeoutTicks`). PvE flee (tasks/pve.ts, not
changed here) can use it instead of its "12 blocks away" point:

```ts
skills.goto({ type: 'runAway', from: () => (threat.alive ? entityFeet(threat) : undefined), r: 16 }, { timeoutTicks: 400, sprint: true });
```

`!top` (chat/commands-nav.ts) runs `{ type: 'surface' }` with `allowPlace` (pillars up with
throwaway blocks). Measured on bds-move (task 7.10 e2e, 2 runs each): `any` over 10 log columns
reached the nearest (member 0) in 38 ticks (one plan, 17 nodes expanded, 1.4 to 1.7 ms); getToBlock
next to a block with glass on its north, west and top: the north-east diagonal (sees east) in 34
ticks, reach 0.99; yLevel -57 up a staircase: the first step at -57, 77 ticks; runAway r 12: 0 ->
12.02 in 56 ticks (threat on the spot), 2 -> 11.96 in 50 ticks straight east (threat 2 west);
surface from a 4-deep 1 x 1 shaft: 3 blocks placed and a jump onto the rim, 60 to 72 ticks.

## Blacklist

`Navigator.blacklist` (nav/blacklist.ts, Baritone's blacklist): a key that failed `blacklistFailures`
(3) times is skipped for `blacklistTicks` (6000, 5 min of the navigator's ticks), then forgotten;
failures more than 6000 ticks apart never add up, and a success clears the count.

| Key | Counted when | Effect |
|---|---|---|
| `b:x,y,z` (block / near / getToBlock target), `xz:x,z`, `y:Y` | a goto with that goal ends `unreachable` or `timeout`; for an `any`: all its members when the last main search was exhaustive (`none`), else the member the body was heading for (lowest estimate) | the goal is refused at once (`blacklisted`), an `any` drops the member (listed in `report.skipped`) |
| `dig:x,y,z`, `place:x,y,z`, `use:x,y,z` | a dig / pillar place / door use at that cell fails or times out (every goto) | the planner never digs that cell (`noBreak`), pillars there or opens that door (`PathOptions.noAction`) |

Goals are counted and consulted only for `any` and `getToBlock` goals by default (targets of work:
logs, chests, ores), or with `{ blacklist: true }` in the goto options (`NavGotoOptions`); plain
block / near / xz gotos (home, shelter, `!goto`) never are, so a blocked home is never skipped.
`report.blacklisted` lists the keys a goto put on the list. The tree finder (`findTrees`:
`TreeOptions.skip`) starts no tree from a blacklisted log and drops a tree whose every log is
blacklisted; the feller skips blacklisted logs and counts one failure for a log no stand cell could
be reached for (or whose dig failed 3 times), so after 3 failed fells a gather stops walking back to
it. `!status` shows `blacklist <n>` (the afk task; its status JSON lists the entries). Measured on
bds-move: a log in a glass shell failed 3 gotos (63 to 70 ticks, 3.1 to 3.5 s each), was blacklisted
on the third, and the next `any` over it and a free log skipped it and reached the free one (52 ticks).

## Status, health and falls

`BotSkills.status()`: health and food, the last 20 health drops (`falling: true` with `fallDistance`
when the body landed from more than 3 blocks within the 20 ticks before), corrections, knockback
motions, teleports, inWater / inLava, the last goto. Track BI: `skills.falls.last` / `stats` for the
clutch (docs/movement.md "Falls and the water bucket clutch").

## Measured

### Track BC: the moves that dig (2026-10-30)

What Baritone's movements do and what we kept (`nav/baritone/moves.ts`; the rule set's own table is in
"Rules"):

| Movement | Baritone (`movements/*.java`) | Ours before Track BC | Kept, and why |
|---|---|---|---|
| `MovementTraverse` | break `to.above()` (falling stack counted) and `to`; walk cost x sprint multiplier when nothing is broken; x 5 when standing on a ladder; a bridge branch that places the missing floor (side place, else a sneak back-place) | `digThrough`: the same two cells, full-block floors, the same rule set | Baritone's break set and cost shape over our ticks; no bridge branch (pillar-up is our only placing move: a bridge needs the sneak back-place the follower has no input for); the ladder x 5 never arises (a climb node is not a dig start) |
| `MovementAscend` | break `dest`, `src.above(2)`, `dest.above()` (falling stack); refuse a FallingBlock at `src.above(3)` ("it would fall on us"); never from a bottom slab onto a full block; onto a bottom slab is a walk; `jumpPenalty` | the plain jump only (head room required) | Baritone's break set and the falling-block refusal (kept even with `allowGravityAbove`); the start and the target stand on full blocks (our measured slab / stairs walks, decision 0022, are the partial-floor rules); `jumpPenalty` is 0 in Baritone and not ported |
| `MovementDescend` | break `end.above(2)` (falling stack), `end.above()`, `end`; `canWalkOn` two below, else `dynamicFallCost` (falls of 3+ with breaks, into water, with a water bucket; never onto a bottom slab); refuse when breaking in front and a FallingBlock is over the column | the plain drop only | the one-block descend with Baritone's break set; our drop rules for everything longer (`MovementFall` not ported: no bucket, the irreversible-drop penalty as today); never into liquid (the rule set refuses liquid cells and cells beside one: stricter than Baritone's "fall into water") |
| `MovementDiagonal` | breaks nothing: edges round one blocked corner (cost x (sqrt 2 - 0.001)), refuses two; ascending / descending diagonals (`allowDiagonalAscend` / `Descend`) | both side cells standable at the same height | ours: the footprint line check (0.62 wide) would collide with a blocked corner, and the cardinal pair plus dig-through covers the route; no diagonal dig move |
| `MovementDownward` | `canWalkOn` two below; `FALL_N_BLOCKS_COST[1]` + the mining ticks; `allowDownward` setting | none (the miner's shaft only, `mine/tunnel.ts`) | ours (rule 6): the shaft rules (`shaftBlocker`), `allowPlace` with the throwaway blocks for the depth + 4, only towards a goal below; cost fall(1) + `digDown` + the mining ticks; `moves.digDownward` is the switch |
| `MovementPillar` | break `start.above(2)` (falling stack) with the FallingBlock-above refusal; never from a bottom slab onto a non-ladder, never a fence gate, ladders climbed instead, water columns swum; +0.1 on air | the plain pillar only (head room required) | Baritone's head-room break and refusal; full-block floors (the follower's PlaceSkill); doors and gates refused by the rule set; no ladder / water branches (climb nodes are Track AJ's) |
| `MovementFall` | the break column over the landing, the water bucket, sneak on magma | the drop rules (3 blocks, free column); Track BI: long drops with a damage budget or a water-bucket clutch | ours, not ported: Track BI wrote its own (measured Bedrock damage, the waterloggable table; "Long falls", decision 0049); no break column, no magma sneak |
| (no Baritone movement) sneak-through | a Java body does not fit under 1.5 blocks either; Baritone sneaks only on magma and for back-placing | a cell with a top slab at head height was BLOCKED | ours (owner, 2026-10-30): the `sneak` move above. Not taken: a descend into such a gap (a sneaking body stops at an edge, physics.ts `backOffFromEdge`; a standing body that falls in lands on the ceiling block), sneaking under a ceiling while digging (digs start from standing nodes only) |

Measured on bds-bari (BDS 1.26.60.6, 2026-10-30; `test/e2e/nav-digmoves.test.ts`, truth-built courses, the planner
worker attached as on the Realm; "before" is the same search with only dig-through, i.e. main's move set, in the
test process; "plan" is the navigator's worker plan). No navigator tick over 5 ms; corrections per run are in the
last column (0 everywhere except the cave's drop timing and the sneak exit before its fix).

| Course | Before (dig-through only) | After (Track BC) | Executed (runs 3, 4, 5) |
|---|---|---|---|
| tunnel: 12-long, 3-high dirt hill under a stone brick roof, corridor closed | found, 57 expanded, 8 ms, cost 800, 24 digs (the dig-through move: unchanged) | the same plan (238 expanded in the worker, 11 to 12 ms) | ok in 590 to 592 ticks, 24 digs, 0 corrections, max tick 1.2 to 3.9 ms |
| cave: start on a 12-high dirt mound, the goal in a 3 x 5 x 3 cave inside it at the ground, a lava pocket under the grass in front of the cave; cobblestone in the hotbar | no path (partial / no progress after 1.5 s and 260 000 to 300 000 expansions) | found, 15 nodes, 2 581 expanded, 29 to 46 ms in the worker: 11 dig-downs in a 1 x 1 shaft beside the cave (the shaft rules refuse the columns 1 to 2 blocks over the lava), then a step into the cave | ok in 291 to 367 ticks, 11 digs, min feet -60, lava untouched (6 of 6), health 20, max tick 0.9 to 1.3 ms; corrections: 0 in 4 of 5 runs, in the other one vertical correction of 0.739 per shaft block (the server breaks the block on its own timer and its body falls about 4 ticks before the client's `update_block` arrives; the body is idle, each re-plan found the same shaft, 367 ticks) |
| cliff: a stone brick step under a dirt lintel over the approach and the step | none (18 expanded) | found, 10 nodes, 22 expanded, 0.3 to 0.4 ms, cost 98: one jump with 2 head-room breaks | ok in 93 to 94 ticks, 2 digs (the lintel's 4 blocks otherwise intact), 0 corrections, max tick 0.3 to 1.0 ms |
| rock: a goal 8 blocks inside a 17 x 21 x 4 stone block, iron pickaxe | found, 10 600 expanded, 70 to 83 ms, cost 457: a straight 18-dig tunnel | found, 13 nodes, 11 200 expanded, 86 to 98 ms, cost 411: 3 ascends with breaks up the face, a plain jump onto the top, 4 descends with breaks down to the goal: 15 digs | ok in 288 to 289 ticks, 15 digs, 0 corrections, max tick 0.4 to 1.0 ms |
| gravel: a 2-high dirt barrier with gravel on top closing a corridor | none (30 expanded; `gravity_above`) | none by default; with `allowGravityAbove`: found, 18 nodes, 40 expanded, 0.3 ms, cost 130: an ascend onto the barrier digging the dirt and the gravel cell itself (cheaper than digging under the stack) | refused: unreachable in 2 ticks, 0 digs, the 3 gravel intact; allowed: ok in 149 to 150 ticks, 2 digs, 0 corrections |
| gravel, 2-high stack (tried once, not kept as a course) | | found: the dirt under the stack dug, the stack paid (`includeFalling`) | the two gravel fell and the lower one landed in the barrier (truth found it), but the world model never saw it (BDS sends no block update for a falling block that lands), so every re-plan walked into a block it believed was air: timeout after 2 504 ticks, 590 blocks, 0 digs beyond the first 2. The owner's rule (refused) stays the default; see Known gaps |
| sneak: a corridor with top slabs at head height over 7 cells (a 1.5-high gap) | (dig-through only, sneak on) found: the same 8 sneak nodes (no dig move is involved) | found, 17 nodes, 43 expanded, 0.3 to 0.6 ms, cost 152: 8 walks, 8 sneak moves | ok in 164 ticks, 118 sneak ticks, 16.0 blocks for 15.5 straight, 0 digs, the 21 slabs intact; run 4: 1 correction of 0.14 at the exit (sneak released while the trailing edge was still under the last slab: the follower now holds sneak until the footprint is clear); the smallest gap a sneaking body passes on BDS is the top slab's 1.5 (the 1.49 box) |
| in-thread fallback (the unit sim, 48 x 48 flat world, a goal inside a dirt block) | | the dig-heavy search needs 4 400 expansions, 27 to 38 ms: more than the 40 ms main-plan slice holds in one go; the worker's 2 s budget is the production path | |
### Track BE: off-path checks (2026-10-30)

Before: main (`offPath: false`); after: Track BE. Closed loops are the unit sim (`nav-offpath.test.ts`;
`InputLoop.nudge` moves the body without an event, as a push the model does not explain would).

| Test | Before | After |
|---|---|---|
| sim, a 30+-block lane, the body shoved 3.2 blocks sideways (no event) | walks on parallel to the path (the follower's aim runs ahead), 157 ticks, 0 re-plans | `off_path` re-plan 2 ticks after the shove, 158 ticks |
| sim, shoved 1.5 / 2.5 (back to 1 after 15 ticks) | no re-plan | no re-plan |
| sim, held 2.5 off for 40 ticks | no re-plan | `off_path` after the 20-tick grace |
| sim, zigzag corridor, pushed forward onto path node 25 (no event) | walks back towards the node it aimed at, `timeout` re-plan, 175 ticks | skip-ahead, 0 re-plans, 113 ticks |
| sim, zigzag, a teleport onto node 25 | `correction` re-plan, 115 ticks | snap (the leg restarts there), 0 re-plans, 115 ticks |
| sim, closed corridor, 2-cell dirt wall, each dig 100 ticks, overrun budget forced to 0.5 x cost | both cells dug | `overrun` when the first dig finishes, the second cell not dug again |
| sim, a dig that never finishes | the 1200-tick timeout (2 cells), the job left running | the same timeout, no overrun (pending), the Digger's job cancelled |
| sim, a knock (`set_entity_motion`) along the lane | `correction` re-plan, 150 ticks | lands on the leg: no re-plan, 150 ticks |
| sim, a knock sideways / during a parkour run-up / into a pool | re-plan at tick 31 / 16 / 31 | re-plan at tick 31 / 16 / 31 (sideways: then `off_path` once landed off that plan) |
| sim, 20 goals on the hilly world | 0 re-plans, 4999 ticks | 0 re-plans, 0 off-path, 11 skip-aheads, 4912 ticks |
| bds-move `nav-offpath`, truth tp 3 sideways off a 30-block lane (2 runs) | ok in 125 / 125 ticks, 1 `correction` re-plan | ok in 126 / 126 ticks, 1 `correction` re-plan (the tp is a teleport event; the body stands in no node of the leg) |
| bds-move `nav-offpath`, zigzag, truth tp forward onto path node 25 (2 runs) | ok in 104 / 104 ticks, 1 `correction` re-plan | ok in 106 / 104 ticks, 0 re-plans, 1 snap |
| bds-move regressions, once each: nav-knockback, nav-wall, nav-long, nav-hill, nav-stairs, nav-swim, nav-ladder, nav-parkour | (as documented above) | all green; no `off_path` / `overrun` plan; plans as before (wall: start + block; sealed goal unreachable after 96 ticks, 3 failures; long: 1 plan, 390 ticks; hill: 1 plan per leg; stairs, house, swim, ladder, parkour ticks identical to the documented ones) |

On BDS every displacement of the body arrives as an event (a correction, `set_entity_motion`, a
teleport), so the per-tick off-path re-plan is a safety net there (a push the movement model does not
explain while `replanOnCorrection` is off; a follower that drifts); what BDS shows is the snap: one
re-plan fewer, the same ticks (an in-thread re-plan of a 40-node path costs about a tick).

**Heuristic weight** (Baritone `costHeuristic`, measured only, nothing shipped;
`NAV_HEURISTIC_BENCH=1 pnpm exec vitest run --project unit test/unit/skills/nav-heuristic`). Baritone's
3.563 is ticks per block (GoalXZ: octile distance x costHeuristic, just under its sprint cost 3.564);
ours is octile x `costs.walk` (3.564 sprinting), so Baritone's default is our weight 1.0. Our heuristic
x 1.0 / 1.5 / 3.563 on 20 dig-heavy queries (a 9 x 9 x 6 stone block round a 1 x 2 pocket on the
hilly world, the start 10, 10 out, `allowBreak`, `digPenalty` 60; 4 to 8 digs per path):

| Weight | Nodes expanded (sum) | Plan time (sum) | Path cost vs weight 1 (mean) |
|---|---|---|---|
| 1.0 (ours, = Baritone 3.563 ticks per block) | 992 513 (100 %) | 10.0 s | 1.000 |
| 1.5 | 957 333 (96.5 %) | 9.4 s | 1.001 |
| 3.563 | 753 837 (76.0 %) | 6.9 s | 1.003 |

24 % fewer nodes at 3.563 x, short of the 40 % bar: not added as an option. A dug block costs its
break time + 60 ticks against 3.56 for a walked one, so a heuristic over walking distance hardly
steers a dig-heavy search (about 50 000 nodes for a goal 14 blocks away) whatever its weight.


### Track BA: partial-path selection (2026-10-30)

Before: main's scoring (the lowest `h + trap`); after: Baritone's coefficient bests with `no_progress`
and the 4 x node extension while failing. Closed loops are the unit sim (`nav-partial.test.ts`).

| Test | Before | After |
|---|---|---|
| bds-move, `nav-partial` (U wall 20 wide, 3 high, arms 10 long, open away from the start; goal 30 out; `path.maxNodes` 100), worker and in-thread | unreachable after 92 / 96 ticks, 10.8 blocks: the first plan ends at the wall's base, then 4 plans of 1 node (3 re-plans, 3 failures) | ok in 184 / 185 ticks, 38.7 blocks: partial (12 nodes), plan-ahead partial (17 nodes, 106 expanded), plan-ahead found; 0 re-plans, 0 stuck, 0 failures, 0 corrections |
| sim, the same U, goal 30 out / in its pocket / a cup (open towards the start), 100 / 200 / 200 nodes | unreachable (3 "no progress" failures) in each | ok in each, 0 failures |
| sim, a U 3 blocks ahead, 100 nodes | partial path to (2, 0) against the wall, then unreachable | first plan ends round the corner (8, 10); ok |
| sim, a 12-long dead-end corridor from the start, goal 30 out, 16 / 32 / 50 / 64 nodes | unreachable / unreachable / ok 147 ticks / ok 147 ticks | ok 159 ticks in each (the 50 / 64-node plans end at the corridor's far end, then get out) |
| navigator behaviour (not measured, by construction) | a node-limited plan that got only 1 to 4 blocks out was walked; a start-only interim was not walked | a `no_progress` result with `unknown` and not `limited` takes the wait-for-chunks branch; a start-only worker interim is ignored (the body stands until the final answer); a `maxMs`-cut search that only got within 5 blocks counts as a failure |
| unit, 1000 random paths, 128 x 128 hilly world (back to back, same machine) | p50 1.89, p95 8.13, p99 11.5, max 15.4 ms | p50 1.92, p95 8.15, p99 11.4, max 13.1 ms (identical expansions: 1828 mean) |

### v2 (bds-move, BDS 1.26.60.6, 2026-10-29)

| Test | Result |
|---|---|
| ticks per block, 50-block straight run, steady part (blocks 10 to 40) | walking 4.633 (table 4.633), sprinting 3.562 to 3.565 (table 3.564); whole runs incl. start and stop 4.72 and 3.84 |
| 6-step staircase | 9.0 ticks per step, landing to landing (table `jump` 9) |
| 6-step oak stairs (1.26.60 states) | up: 53 ticks, 4.60 ticks per step, 0 jumps, 0 corrections; down: 59 ticks, 0 jumps, 0 drops, 0 corrections (full blocks, same climb: 81 ticks, 9.00 per step, 6 jumps, 2 corrections); 3 stairs to a platform with allowPlace on or off: 49 ticks, nothing placed; the owner's house (around a 2-high wall, 2 levels over 4 cells of stairs / landing / stairs, a closed door around the corner, goal 4 past it), allowPlace on or off: 147 / 148 ticks, 1 door use, 0 places, 0 corrections (175 ticks and a move timeout before the follower's re-jump fix) |
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
| `test/unit/skills/nav-v2.test.ts` | closed loop, v2: tick costs, the cave hill and the pit (also with 12-node segments), irreversible drops, 290 blocks in many spliced segments without stopping, sliced searches, unloaded world, irrelevant block updates, move timeouts, a knock into a pool (re-planned from the water since Track AJ), dig-through (and its safety rules), pillar-up out of a pit and onto a plateau, doors and gates (opened, closed behind) with fake actions |
| `test/e2e/nav-flat`, `nav-hill`, `nav-long`, `nav-wall`, `nav-knockback` | v1 suites (tasks 3.3 to 3.6), still green on v2 |
| `test/e2e/nav-costs.test.ts` | ticks per block / step / drop vs the cost table |
| `test/unit/skills/stairs.test.ts` | stairs per direction, upside down, corners, the 1.26.60 runtime ids; slabs, carpets, farmland, dirt paths, snow layers; stairs walks and jumps in the planner; `locateNode` on fractional feet; closed-loop staircase up / down with 0 jumps; starts on a stairs low half / a slab; block goal in a stairs cell; the no-segment WARN line |
| `test/e2e/nav-stairs.test.ts` | 1.26.60 stairs resolved; 6-step oak staircase up and down with 0 jumps (vs full-block steps); 3 stairs to a platform with allowPlace off / on (nothing placed); stairs facing away; carpet / farmland / dirt path / snow / slab lane; starts on a stairs low half and on a slab |
| `test/e2e/nav-surface.test.ts` | cave hill (surface only), pit on the line (never entered) |
| `test/e2e/nav-cross.test.ts` | 200-block cross-country: 0 corrections, no tick over 100 ms |
| `test/e2e/nav-dig.test.ts` | dirt wall: walked around without `allowBreak`, dug with it |
| `test/e2e/nav-fence.test.ts` | fence line: never collided with |
| `test/e2e/nav-place.test.ts` | pillar-up (cliff, pit) and door / gate; skipped with a message until the navigator has `place` / `useBlock` actions |
| `test/unit/skills/nav-goals.test.ts` | task 7.10 goal predicates and heuristics; closed loop: any over 10 logs, getToBlock (visible face), yLevel, runAway (also from a moving threat), surface (shaft with pillaring, cave); the blacklist (counting, expiry, keys, a walled log skipped by the next any, blame of an any member, dig cells) |
| `test/unit/skills/tree-blacklist.test.ts` | the tree finder and the feller skip blacklisted logs; 3 failed fells blacklist an unreachable log |
| `test/unit/skills/nav-partial.test.ts` | Track BA: the ported bests (constants, scores, MIN_IMPROVEMENT, MIN_DIST_PATH), node-limited ends next to a U wall, in a dead-end corridor and on open ground, `no_progress`, closed loops round a U and a cup with 100 to 200-node budgets |
| `test/e2e/nav-partial.test.ts` | Track BA: a truth-built U wall with `path.maxNodes` 100: the first plan partial, the goal reached (worker and in-thread) |
| `test/unit/skills/nav-digmoves.test.ts` | Track BC: per dig move the break set and order, the cost against the rule set, the refusals (water beside, a gravity block above with and without `allowGravityAbove`, the protected area, a built block, the floor under the feet, a falling block over a head-room cell, the shaft rules: liquid / dripstone below, gravity over the head, the world floor, no floor below, the throwaway budget), the `moves` switches, the goal-below gate; sneak-through (a top-slab ceiling: 8 sneak nodes at `sneakWalk`, a carpet under it closes the lane, a goal and a start under the ceiling); closed loops with fake actions (dig-down x 2, a descend-dig into the shaft column then dig-downs, ascend with head-room breaks, descend with a break, pillar under a lid, the sneak passage with the 1.49 sneak box); a dig-heavy goto with the worker-sized budget keeps every tick under 100 ms |
| `test/e2e/nav-digmoves.test.ts` | Track BC, bds-bari, planner worker attached: a tunnel through a roofed dirt hill, a shaft down to a cave beside a lava pocket, a cliff under a lintel, a goal 8 blocks inside stone, a gravel-topped barrier (refused, then dug with `allowGravityAbove`), a 1.5-high passage under top slabs crossed sneaking; each with the "before" plan (dig-through only) |
| `test/unit/skills/nav-offpath.test.ts` | Track BE: the ported executor rules (constants, distance from the path, states, overrun, nodeAt / skipAhead); closed loops: a 3.2-block shove re-plans within 2 ticks, 1.5 and a 2.5 that comes back do not, a body held 2.5 off re-plans after the grace, a push forward along a zigzag skips ahead, a teleport onto a later node snaps (main re-plans), a teleport off the path re-plans, knocks on / off the leg, in a parkour run-up and into water (no later than main), an overrun between two digs, a dig timeout cancelling the digger, 20 hilly goals with no off-path re-plans |
| `test/unit/skills/nav-way.test.ts` | Track W2 way: the helpers (blocks, a node on the way and its window, the nearest node, a broken node, "clearly shorter", the found ways' lookup); closed loops through a wall with gaps: a handed way walked with no search and kept against a fresh plan that is not clearly shorter, replaced by one that is, not walked from a far start or with a node built over, rejoined after a teleport 4 to 6 off, the own way after a teleport planned afresh, beyond `REJOIN_MAX` planned afresh, a resume after a cancel (on or rejoined, through the same gap); the plan INFO line; the dive off a pool's rim (no sneak, in the water within 20 ticks) and in water (still sneaks); the creep into a drop beside lava; guards (the guide and the decision name the constants with their values, no place of the owner's world) |
| `test/e2e/nav-way.test.ts` (any server with the truth pack's `cave` command, `FLY_BDS_PORT` / `FLY_BDS_CONTAINER`) | Track W2 way: a private world-cache extract of a cave rebuilt (skipped without it), the landing probe from the cave's mouth, then the goto to each goal before (no kept way) and after (the probe's way handed), `NAV_WAY_GUARD=1` with the walk interrupted at 0.3 of the way and resumed; blocks walked against the probe, turns back, plans, seconds, damage |
| `test/unit/skills/nav-heuristic.test.ts` | Track BE: heuristic weights 1 / 1.5 / 3.563 on 20 dig-heavy queries (measurement; `NAV_HEURISTIC_BENCH=1`) |
| `test/e2e/nav-offpath.test.ts` | Track BE: truth tp 3 blocks sideways off a 30-block lane, and forward onto a later node of a zigzag, checks off (main) and on |
| `test/unit/skills/nav-worker.test.ts` | Track AB: the worker's mirror vs the main grid on 200 random cells (loaded, after block updates and a re-sent column, cached after an unload); 20 random start / goal pairs in a real worker thread vs in-thread (same status, cost, expansions); the navigator walking an interim answer and splicing in the final one; a crash logged once, its search failed, the worker restarted |
| `test/unit/skills/nav-worker.test.ts` | Track AB: the worker's mirror vs the main grid on 200 random cells (loaded, after block updates and a re-sent column, cached after an unload); 20 random start / goal pairs in a real worker thread vs in-thread (same status, cost, expansions); the navigator walking an interim answer and splicing in the final one; a crash logged once, its search failed, the worker restarted. Track BB: the rule strip (every helper rule compared between the mirror and the main grid). Track BC: 20 dig-heavy pairs (goals 3 blocks inside the stone, `allowBreak`, `allowPlace` / `throwaway` and `allowGravityAbove` varied): identical status, cost, expansions, path length and break sets |
| `test/unit/skills/nav-baritone-helper.test.ts` | Track BB: the shared rule set, one test per rule (see "Rules"), the planner's dig cost against `getMiningDurationTicks`, the grid's stand rules against `canWalkOn` / `canWalkThrough` |
| `test/e2e/nav-rules.test.ts` | Track BB, bds-bari: magma strip, berry bushes, ice over lava, gravel over a dig (and the control without it), soul sand, slabs and stairs (see "Rules") |
| `test/e2e/nav-compute.test.ts` | Track AB, worker vs in-thread on the same terrain: the house walk (1 segment, 0 corrections), 120 blocks of the cross-country course, 120 blocks through staggered walls (fewer plans, no partial segments with the worker), a sealed goal 100 blocks away with allowPlace (a 300 000+ node search, navigator tick under 20 ms) |
| `test/e2e/nav-goals.test.ts` | any over 10 logs, getToBlock, yLevel, runAway, surface from a 4-deep shaft, a log walled in glass blacklisted after 3 failures and skipped by the next any |
| `test/unit/skills/nav-variety.test.ts` | Track AJ: the measured water / climbing / sneak-edge physics; planner swims a river (never below the surface), swimming off, ladder up and down, vines, 1- and 2-block gaps (never over lava or a deep drop), ladder cells passable and scaffolding an obstacle; closed loops: river, ladder up and down, vine wall, both gaps, a 1-wide bridge (no fall) |
| `test/e2e/nav-swim.test.ts` | Track AJ: a 6-wide river (0 corrections, health 20), an 18-block lane (swim ticks per block), a 1-deep ditch |
| `test/unit/skills/nav-water.test.ts` | Track W1: the water rules (air budget, air clock, in water / head under water, dive nodes, a point under the surface), the sneak physics; the planner over every `truth:water` station (pool2 on the surface only, pool6 from its floor, the column, the waterfall, the lip refused and the step taken, the tunnel's sump and a 20-long one refused, a low-air start, `near` goals in and under water, never under a roof); closed loops over every station (air kept, 0 stuck) |
| `test/unit/skills/nav-worker.test.ts`, `coarse.test.ts`, `follow.test.ts` (Track W1 cases) | the worker plans under water as the thread does (dive nodes, the air budget); walk corridors through a flooded cave 3 and 2 high, not 1; treading water in follow (settled, close, the bob's hysteresis, out of water, the target swimming off) |
| `test/e2e/nav-water.test.ts` (bds-fly, `WATER_BDS_PORT` / `WATER_BDS_CONTAINER`) | Track W1: every station from its start, pool6 from its floor and to a point on its floor, a follow behind a second client moved through a pool; completion, ticks, air low-point, damage, corrections, the bot's water against the layout; Track W2: the dig-out pools with the inventory set per run (`lipDirt` by hand, `lipStone` by hand: trapped, with a wooden pickaxe: dug, `bank3` by hand, `lipBuilt` with an iron pickaxe: trapped), blocks broken |
| `test/unit/skills/nav-digout.test.ts` | Track W2: the step into a lip (from the surface only, its price), a stone lip by hand refused (no tool) and dug with a wooden pickaxe, a built rim, the protected area, the gravity rule (a sand lip dug, a 2-high sand bank refused), a near swim exit beats the dig and a far one does not, the stair up `bank3` without `allowBreak` (nothing dug off it, nothing dug from dry ground), the trapped report; closed loops (the dig's break conditions, the re-plan after the break, the stair, the trapped reason); guards (the guide and the decision name the constants with their values, the no-tool threshold between a wooden pickaxe and the hand on stone) |
| `test/e2e/nav-ladder.test.ts` | Track AJ: a 10-block ladder in a 1 x 1 shaft up and out, back down and out; a vine wall (climb ticks per block) |
| `test/e2e/nav-parkour.test.ts` | Track AJ: 1-block, 2-block and 2-block-1-lower gaps over a 4-deep pit with water, 20 crossings each (`PARKOUR_RUNS`); a 1-wide bridge with a turn, edge sneaking off / on (`BRIDGE_RUNS`) |
| `test/unit/skills/fall.test.ts` | Track BI: the measured fall damage model (heights, soft landings, enchantments), the waterloggable table and the clutch target, the live policy, long drops in the planner (a 12-block plateau: none without a policy, the drop with its cost, refused over the budget / with maxDrop 1 / health unknown, Feather Falling, the staircase preferred, hay without a budget, the clutch drop, refused onto a top slab / in the no-water area / over clutchMax), the note on a refused fall, closed loops (the drop walked, the note at health 12, the clutch with a fake server), the scan's planner cost on 300 random paths; review fixes: no plannable drop beyond the budget with a bucket (B1), the clutch pricing and its tie, a ladder column, `acceptsDrop`, the drop re-checked before the step off (health 20 -> 12 on the way: no drop, the note), `shouldClutch` (margin, kill, creative, base, fight), no clutch through ladders / cobwebs / with Slow Falling (B3), the guard bounded when the bucket never empties (H1), finish on an exception and on dispose |
| `test/e2e/fall-long.test.ts` | Track BI, bds-gaunt: a 12-block tower with no way down but the fall: walked and arrived (8 HP, the model's), and at health 12 unreachable with the note, twice each |
| `test/unit/skills/nav-trapdoor.test.ts` | Track BG: panels and `hatch` states; the planner down / up through a hatch for every facing and half (never out through the panel side), without `allowOpen`, open (no use), iron / `noAction` / `moves.trapdoor` false, the roof-layer hatch (down only), drops to a floor and into water, a panel in a doorway; closed loops with fake actions (open, closed behind, `closeTrapdoors` false) |
| `test/e2e/nav-hatch.test.ts` | Track BG2, bds-move: a farm-style hatch (walking-layer trapdoor, ladder to the floor layer, a 3-high room under it); clicks from the ladder while sneaking with an empty hand, a pickaxe, a sword, a block, a shulker box (raw: rejected with an item; UseSkill: opened); with a pickaxe, a block, a shulker box held: down and up twice each, both panel sides, opened and closed behind every time, no pillar or dig (allowPlace / allowBreak on) |
| `test/e2e/nav-trapdoor.test.ts` | Track BG, bds-move: truth-built shafts under a platform: closed hatch down and up (panel opposite the ladder and on its side), open top-half hatch down and up with no action, the roof-layer hatch (down, no plan up), a ladderless hatch over a pool (fall of 8); 0 corrections |

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
`MOVE_VERBOSE=1` (corrections, teleports, navigator decisions). Track BB: `nav-rules` runs on bds-bari
(`node scripts/bds.mjs --profile bari up`, then `pack`; `BARI_BDS_HOST` / `BARI_BDS_PORT` 19206 /
`BARI_BDS_CONTAINER`), and the other nav suites run there too with `MOVE_BDS_PORT=19206 MOVE_BDS_CONTAINER=bds-bari`.

## Known gaps

- Track BE: the follower's aim runs away on open straight runs: pure pursuit moves the aim up to 6
  nodes further every tick while the straight line stays clear, so it ratchets to the end of the run.
  A body shoved sideways less than 2 blocks walks parallel to the path and converges only at the next
  turn or the leg's end (2 to 3 blocks: the off-path grace re-plans). The fix (cap the aim distance by
  the lateral offset) is for a later track.
- Fences, panes and bars: known since the BDS palette registry (decision 0024); on 1.26.60 their arms
  come from the `minecraft:connection_*` states (Track AK, decision 0031; `TerrainClass.arms`), on
  minecraft-data states from the neighbours. Palette-only doors, trapdoors, gates, stairs and slabs
  take the state-dependent shape by name suffix (`shapes.ts` `partialBoxes`).
- The partial-blocks lane (snow, slab, then grass) gave 1 correction of 0.417 in 3 of 3 runs after
  stepping off the last slab (the server one tick of falling behind); a plain slab, two slabs and
  snow + slab walked off 3 times each gave 0. Not investigated further.
- No bridging (placing a block to cross a gap); pillar-up needs a full-block floor (Track O's PlaceSkill
  clicks the top of the block below the feet, which a slab floor in the feet cell has not; Baritone
  refuses pillaring from a bottom slab too). Track BC: dig-down, head-room breaks for a jump and descending
  by digging are moves now (see "Nodes and moves"); descending by digging more than one block at a time
  (Baritone's `dynamicFallCost`) and breaking the corner cells of a diagonal are not.
- The goal-below gate: digging down into open ground is planned only towards a goal below the node, so a
  same-level goal behind a built (undiggable) wall is unreachable by digging under the wall: a staircase
  under it would need the first dig into the open floor, which the gate refuses for a goal at the same
  height. Dig-through and the ascend / descend into rock stay available at every height.
- `allowGravityAbove` (Baritone's gravity rule) is planned and executed completely (the stack is paid, a
  refilled cell is dug again, a dug cell that is a block again in the model sends the follower back to
  digging), but BDS sends no block update when a falling block lands: measured on bds-bari with a 2-high
  gravel stack, the landed gravel was in the world (truth) and invisible to the model, and the goto looped
  on corrections against it. The option stays off (the owner's rule) until the world model learns landed
  falling blocks (the falling-block entity's removal, or a chunk re-read).
- The dig-down drop is server-timed: BDS breaks the block when its own break timer ends and the server
  body falls at once, while the local body stands until the `update_block` arrives (about 4 ticks on
  bds-bari under load): a vertical correction of 0.74 per shaft block in 1 of 5 runs of the cave course,
  0 in the others. Harmless (the body is idle in the shaft, the re-plan is the same shaft) but each one
  re-plans; predicting the break locally (the Digger's expected tick) would remove it.
- Dig-heavy searches cost about 10 to 20 us per expansion (each node asks the rule set for up to 4
  directions x 3 cells, cached per search) against about 1 us for a walk, and A* expands every node cheaper
  than the dig route (the open ground around it): a goal inside rock 8 blocks away takes 4 000 to 45 000
  expansions (30 to 850 ms) on the test worlds. The planner worker's 2 s budget holds them; the in-thread
  fallback's 40 ms main plan does not (its partial path walks towards the rock and the plan-ahead takes
  over).
- Swimming, ladders, vines, parkour and edge sneaking: see "Movement variety" (limits there); no
  scaffolding. Under water and up water: see "Water (Track W1)" (limits there: no flow push model, no
  sprint-swimming, bubble columns refused); out over a lip or a taller bank by digging only ("Digging out of
  water (Track W2)": no dig from under water, no placed step).
- Trapdoors (Track BG): a hatch in the roof layer whose ladder ends under it is down only: on BDS an open
  trapdoor is not climbable, so nobody climbs past it from the ladder top (measured; Track BG2: holding jump and
  forward from the top rung the feet peak at 0.55 below the exit floor, every facing and half). The owner's farm
  is not this layout (Track BG2, world cache): its hatch is in the walking layer over a ladder that reaches the
  floor layer. Horizontally a trapdoor is only a wall or a passable open panel (`crossing`); a closed
  trapdoor standing in a corridor is not toggled to walk through. The tight-gap alignment pulses need a free
  floor around 0.2 blocks behind the approach; approaching a tight hatch along its tight axis is not planned
  differently (the follower turns and aligns first).
- Climbing the cave hill's four 1-block terraces in a row (jumping while pushed against each step,
  then accelerating on top) gave one correction of 0.418 (client ahead) in 2 of 4 runs, right after
  the last landing. The follower never sprint-jumps there (checked in the sim); likely a sprint-start
  rule after horizontal collisions in the movement model (input/sprint.ts). Not investigated further.
- Soul sand, honey, slime and ice are only penalised by the planner; the physics models ice / slime
  friction but not the soul sand / honey speed factor. Track BB measured it on bds-bari (nav-rules): a
  3-long soul sand floor is walked (85 ticks for the corridor against 74 on grass) with 2 corrections of
  0.63 to 0.71 blocks, the server behind the local body (the input loop walks soul sand at full speed).
  Honey stays a floor (Baritone refuses it; ours is penalised x5 and not modelled by the physics either).
  A body standing on a block that is no floor to the planner (magma without the sneak setting, a hazard)
  has no start node (`locateNode` finds none; the goto ends with no standable node): pre-existing for
  magma and the other hazards, and the reason honey was kept a floor.
