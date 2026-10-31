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
blocks (1.5 high) are obstacles, never floors. Costs are ticks (`DEFAULT_COSTS`):

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
| sneak (`sneak`; ours, Track BC, owner: "sneaking makes you fit through smaller gaps") | 4 cardinal, same level | into, through and out of a cell the body only fits sneaking (`moves.ts sneakFits`): the feet cell passable over a full floor, the head cell blocked only by boxes whose underside is at least `sneakHeight` 1.49 above the feet (a top slab: 1.5; a top trapdoor: 1.81; a bottom slab or a carpet under a top slab: no); a standing body (1.8) is BLOCKED there, so these are sneak nodes: only sneak moves leave them (no jumps, drops, diagonals or digs); the follower holds sneak for the whole move; `moves.sneak` switches it off | `sneakWalk` 15.44 (`walk` / `sneakScale` 0.3; Baritone's SNEAK_ONE_BLOCK_COST is 15.385) |
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
hazards are never entered; water only by the swim moves, on its surface (Track AJ). Heuristic: `walk` x octile distance, plus for
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

Owner: "When it gets stuck on top of a mountain it determines its end goal unreachable. This is kind of
silly considering it can fall and survive, or water bucket clutch." The drop move stops at `maxDrop`
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
within 16 blocks (`blocked`); harmless landings stay allowed. A long drop is a `drop` node; the follower
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

**Planner (`nav/astar.ts`).** Swim and climb nodes are flagged; a goal is never reached in them. Swim
nodes are always surface cells: the planner never plans underwater travel (air is not modelled).
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

Limits: no underwater travel (no air model), no swimming in flowing water (no flow push model), no
sprint-swimming; no scaffolding; no ladder-to-ladder side steps, no jump off a ladder; parkour only
cardinal, 1 or 2 blocks, the same height or 1 lower, and only over water or at most a 3-block drop;
no jump up across a gap. Twisting / weeping / cave vines climb in the physics but have no e2e course.

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
| `test/e2e/nav-ladder.test.ts` | Track AJ: a 10-block ladder in a 1 x 1 shaft up and out, back down and out; a vine wall (climb ticks per block) |
| `test/e2e/nav-parkour.test.ts` | Track AJ: 1-block, 2-block and 2-block-1-lower gaps over a 4-deep pit with water, 20 crossings each (`PARKOUR_RUNS`); a 1-wide bridge with a turn, edge sneaking off / on (`BRIDGE_RUNS`) |
| `test/unit/skills/fall.test.ts` | Track BI: the measured fall damage model (heights, soft landings, enchantments), the waterloggable table and the clutch target, the live policy, long drops in the planner (a 12-block plateau: none without a policy, the drop with its cost, refused over the budget / with maxDrop 1 / health unknown, Feather Falling, the staircase preferred, hay without a budget, the clutch drop, refused onto a top slab / in the no-water area / over clutchMax), the note on a refused fall, closed loops (the drop walked, the note at health 12, the clutch with a fake server), the scan's planner cost on 300 random paths; review fixes: no plannable drop beyond the budget with a bucket (B1), the clutch pricing and its tie, a ladder column, `acceptsDrop`, the drop re-checked before the step off (health 20 -> 12 on the way: no drop, the note), `shouldClutch` (margin, kill, creative, base, fight), no clutch through ladders / cobwebs / with Slow Falling (B3), the guard bounded when the bucket never empties (H1), finish on an exception and on dispose |
| `test/e2e/fall-long.test.ts` | Track BI, bds-gaunt: a 12-block tower with no way down but the fall: walked and arrived (8 HP, the model's), and at health 12 unreachable with the note, twice each |
| `test/unit/skills/nav-trapdoor.test.ts` | Track BG: panels and `hatch` states; the planner down / up through a hatch for every facing and half (never out through the panel side), without `allowOpen`, open (no use), iron / `noAction` / `moves.trapdoor` false, the roof-layer hatch (down only), drops to a floor and into water, a panel in a doorway; closed loops with fake actions (open, closed behind, `closeTrapdoors` false) |
| `test/e2e/nav-hatch-realm.test.ts` | Track BG2, bds-move: the owner's farm hatch rebuilt from the Realm's world cache (walking-layer trapdoor, ladder to the floor layer, a 3-high room under it); clicks from the ladder while sneaking with an empty hand, a pickaxe, a sword, a block, a shulker box (raw: rejected with an item; UseSkill: opened); with a pickaxe, a block, a shulker box held: down and up twice each, both panel sides, opened and closed behind every time, no pillar or dig (allowPlace / allowBreak on) |
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
  scaffolding, no underwater travel, no swimming in flowing water.
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
