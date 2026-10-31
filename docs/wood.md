# Wood gathering: trees, collect, chests, GatherWood (`bot/src/skills/{tree,collect,container}`, `bot/src/tasks/gatherWood.ts`)

PLAN.md Phase 4 tasks 4.3 to 4.6 (Track H). Everything below was measured on **BDS 1.26.60.6**
(container `bds-wood`, udp/19150, RakNet, offline, flat world, peaceful, survival,
`server-authoritative-block-breaking` on, pick-range scalar 1.5, TICK_DISTANCE 10) with
bedrock-protocol `c9e1fbf2` / minecraft-data 3.117.0 + the 1.26.60 patch on 2026-10-29. Digging
itself (break times, reach, `abort_break`) is in [digging.md](digging.md); movement in
[movement.md](movement.md) and [pathfinding.md](pathfinding.md).

```ts
const world = new World(conn);
const loop = new InputLoop(conn, { world: flatWorld() });
const hotbar = new Hotbar(conn, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
const containers = new Containers(conn, world.inventory);
const skills = new BotSkills({ loop, world, hotbar, containers, source: conn });
loop.start();
await conn.connect(target);

const tree = skills.treeAt({ x: 10, y: -58, z: 4 });           // from any log
const r = await skills.fellTree(tree!);                           // bottom up, re-paths when out of reach
const c = await skills.collect(8, 400, { origin: tree!.base });  // walk over the drops
const trees = skills.findTrees(48);                               // closest first
const o = await skills.open({ x: 0, y: -60, z: 0 });              // chest next to the bot
if (o.ok) {
  await skills.deposit(o.view, (i) => i.name.endsWith('_log'));
  await skills.closeContainer(o.view);
}
```

CLI (unattended):

```sh
cd bot
node src/index.ts --task gather --port 19150 --target-logs 64 --chest 0,-60,0 --exit-when-done
node src/index.ts --task gather --port 19150 --chest 0,-60,0      # then in chat: !gather 64, !gather stop, !status
```

| Option | Default | Meaning |
|---|---|---|
| `--target-logs <n>` | none (wait for `!gather N`) | start at once: n logs into the chest |
| `--chest <x,y,z>` | none | chest block; `!gather N x y z` overrides it. Without a chest the task stops once it carries n logs |
| `--search-radius <n>` | 48 | tree search radius around the chest (else around the start position) |
| `--exit-when-done` | off | disconnect and exit 0 when the target is reached, 1 when the task fails |
| `--allow-dig <names>` | none | blocks besides logs the feller may dig (comma list, e.g. `oak_leaves`) |

Config file: `tasks.gather.{targetLogs, chest ([x,y,z] or "x,y,z"), searchRadius, exitWhenDone, allowDig}`.
Common options (`--respawn-delay`, `--owner`, ...) as in docs/runbook.md. Default username `WoodBot`.

Chat: `!gather <n> [x y z]` starts (or restarts) gathering; `!gather stop`; `!gather` prints the
gather status; `!status` carries `task gather, state <s>, logs <deposited>/<target>, carried <n>,
trees <n>, corrections <n>, deaths <n>`.

## Files

| File | What |
|---|---|
| `bot/src/skills/tree/tree.ts` | `detectTree`, `treesFrom`, `remainingLogs`, `logKind`, `isLog`, `isLeaves` (pure, over a block lookup) |
| `bot/src/skills/tree/feller.ts` | `fellTree` (bottom-up felling with re-pathing and pillar-up), `standSpots`, `pillarSpots`, `planColumn` |
| `bot/src/skills/place/scaffold.ts` | `ScaffoldRecord` (cells placed as scaffold), `pillarStep`, `clearScaffold` (dig it again), `dropUnder` |
| `bot/src/skills/collect/collect.ts` | `collectItems` (walk over item entities, inventory-full detection, the `hard` walk that may dig and place) |
| `bot/src/skills/container/chest.ts` | `ChestSkill` (open / deposit / close), `clickBlockTransaction`, `maxStackOf` |
| `bot/src/world/containers.ts` | `Containers`: container_open / container_close, item_stack_request with prediction, item_stack_response |
| `bot/src/world/inventory.ts` | raw wire `ItemV4` per slot (`rawItem`), `setItem`, `removeWindow`, `freeSlots`, `room` (additions) |
| `bot/src/skills/index.ts` | `BotSkills`: the skills above behind one facade, serialised (see below); `attach()` for Hotbar / Containers |
| `bot/src/tasks/gatherWood.ts` | `GatherWoodTask` (state machine) and `gatherTask` (CLI TaskDefinition) |
| `bot/src/chat/commands.ts` | `registerGatherCommands` (`!gather`) |
| `packs/truth/src/wood.ts`, `woodShapes.ts` | `truth:container`, `truth:tree`, `truth:find`; `treeShape` |

## Skill serialisation

Every public `BotSkills` call (`goto`, `dig`, `lookAt`, `collect`, `fellTree`, `open`, `deposit`,
`closeContainer`) first cancels the running one, synchronously (the navigator, the digger and the
look controller all finish their promise inside `cancel`), and then starts. So goto and dig never
steer yaw/pitch at the same time. `collect` and `fellTree` are compound: they call the navigator and
the digger directly, one at a time, and check a cancel epoch between steps; `cancel()` or any new
public call ends them with `interrupted`. `status().running` names the skill that runs. `dig()`
returns the full `DigResult` (`DigOptions` / `DigResult` are exported from `skills/index.ts` and
`skills/types.ts`, as Track G asked).

## Tree model (4.3)

- **Detection** from any log: flood fill over logs of the **same kind** (`oak_log` -> oak; stripped
  logs never count), 26-connected (branches touching only by an edge or corner belong to the tree),
  at most 160 logs (a 2 x 2 trunk 30 high and its branches; 96 before 2026-10-30) and 8 blocks
  horizontally from the start log. Not a tree (2026-10-30 review): more than 8 columns in the lowest 3 layers (a log
  wall), or a built block (planks, glass, doors, slabs, stairs, fences, torches ... `isBuiltBlock`) touching a
  log on any side but the floor under the base. It is a tree when at least 3 leaves
  are within 2 blocks of its logs and its lowest logs stand on soil (dirt, grass, podzol, mud ...);
  a log column on planks or without leaves is refused (`minLeaves: 0`, `requireSoil: false` relax
  that). Two trunks side by side are one tree; canopies that touch do not join trees.
- **Felling order**: by y, then by distance from the trunk axis (mean x/z of the lowest layer).
- **Reach**: the feller digs a log when it is within `DEFAULT_REACH` (5, eye to the closest point of
  the block) and the server's corner limit (digging.md). Standing next to a trunk, the eye is at
  feet + 1.62 and the highest log within reach is the one at feet + 6 (distance 4.40); feet + 7
  (5.40) is out. So trees up to 7 logs are felled from the ground.
- **Re-path** when the next log is out of reach: every standable cell (NavGrid.stand) within 4
  blocks horizontally and 6 below / 1 above the log from which it is in reach (reach - 0.25 margin)
  is scored by `-3 x (remaining logs in reach) + distance to the trunk + 0.3 x distance to the bot
  + 0.5 x height difference`; the bot walks to the best (up to 4 tries). A log no cell reaches is
  skipped and reported in `left` (`{ ok: false, reason: 'logs_left' }`), unless a pillar reaches it.
- **Pillar-up** (2026-10-30, decision 0051): see below. Without throwaway blocks a log no stand cell
  reaches is skipped as before (unit test: a 9-high trunk ends with 7 broken, 2 left, and the log
  line says `no throwaway blocks for a pillar`).
- **Only logs are dug** besides the pillar's way: `fellTree` refuses any other block unless
  `allowDig(name)` says yes (`--allow-dig`). Leaves are dug only where they are in the pillar's column
  (the head room of the next jump), its own scaffold blocks only when it digs them down.

## Pillar-up (decision 0051)

The owner (2026-10-30): "When gathering items, why is it not building like temporary pillars it then
destroys? [...] with wood it kind of gets stuck on tall trees. It does end up leaving floating tree
parts". When no stand cell reaches the next log and the bot carries scaffold blocks, the feller builds a
temporary pillar. Scaffold blocks are the throwaway kinds carried (`DEFAULT_THROWAWAY`: cobblestone,
dirt, cobbled deepslate, netherrack, stone ...) that the hotbar's tools or the hand **harvest**, fastest to
dig first (`BotSkills.scaffoldItems`): without a pickaxe dirt, never cobblestone (the first e2e run dug
cobblestone by hand: 200 ticks a block, and no drop). No harvestable kind carried: no pillar at all.

1. **Column** (`pillarSpots`): every column within 2 blocks of the log (the trunk column itself once its
   lower logs are gone). Its foot is the first cell under the log's height that is not passable (air,
   leaves and the tree's own logs are passable) and must be standable with the feet and head cells free.
   `planColumn` finds the lowest top feet height from which the log is in reach (reach 4.75 less 0.35 for
   the sneaking eye, and the server corner limit) and checks every cell from the foot to 2 above the top
   (the jump's head room): passable, none inside the protected area. Score: blocks + 0.5 x leaves - 2 x
   logs reachable from the top + 0.1 x walk. At most `maxScaffold` (40) blocks and `scaffoldBudget()`:
   the scaffold kinds carried; the keeper's reserve (`throwawayMin`, 16) is lent only while no scaffold
   block was ever left behind (`ScaffoldRecord.lost`); after one was, the pillar never dips into it.
2. **Climb**: no pillar is started or grown with a hostile mob within 12 blocks (`hostile_near`). Walk to
   the foot (`goto block`, no digging), then per block: dig the head room (2 and 3 above the feet: leaves,
   or a log of the tree, which counts as felled), `PlaceSkill.place(feet cell)` (jump, place under the
   feet, land), record the cell (`ScaffoldRecord`, with the block placed), hold sneak. A click the server
   confirms late (the placer's 20-tick timeout under lag, or an interrupted click) is re-checked for 40
   ticks and recorded when the block shows up (`recordPlaced`): the dig-down never meets an unrecorded
   block in mid-air.
3. **Fell from the pillar**, sneaking (knockback or a correction does not push it off the 1 x 1 top): the
   loop digs every log in reach; when the next log is above, the pillar grows in the same column (2 tries
   per log); when it is not reachable from this column the bot comes down first and the loop starts over
   from the ground. It never walks off the pillar. A hostile within 12 blocks: it comes down at once and
   the fell ends with `hostile_near` (gather does not count that against the tree). It stops on the last
   block (1 above the ground, a harmless fall): a mob hitting it at the foot spoils every dig there
   (e2e: 3 timeouts in a row from the knockback), so that block stays pending until the next fell, a
   cancel or a goto without a hostile near digs it. Dirt that grass grew over still counts as its own
   (`sameScaffold`). A dig spoiled by a hit is tried again (3 times) before a block is given up. Once a pillar was
   needed, the whole fell is capped at 1200 + 60 x logs ticks (`maxTicks`, `time_cap`; it comes down first).
4. **Come down** (`clearScaffold`, also at the end). First, a log drop that bounced onto the canopy
   (resting on leaves, out of reach of any later walk) gets the leaf under it dug from the pillar so it
   falls (at most 6 leaves; e2e: 1 of 20 spruce logs stayed on the leaves for 90 s before this). Then,
   standing on a recorded cell, sneaking, dig the block
   under the feet and drop one block (no fall damage), down to the ground. The drop of each block falls
   with the bot and is picked up on the way. Only recorded cells that still hold the block placed there
   are dug; a recorded cell holding anything else is never touched.

**The pending scaffold outlives the job** (review 2026-10-30, B1): the record is `BotSkills.scaffold`,
not the fell's. A fell pre-empted on top of its pillar (the guard, `!stop`, `!come`, eating, night, a
death pause) leaves its cells there, and:

- a cancel, and any new skill but the feller (goto, collect, ...), starts the dig-down at once
  (`descendFirst`); a goto or collect waits for it, then walks. A newer call does not stop the dig-down
  (stopAll leaves its digger alone), so a guard chasing a mob first comes down, sneaking, block by block,
  instead of fighting from a 12-high 1 x 1 column;
- the next fell digs any pending scaffold first; a column the bot is no longer on (it fell off, died and
  respawned) is walked onto when it can be, else the bot pillars up beside it with harvestable blocks and
  strips the old column from the top down on the way down.

Protected area: nothing is placed and no leaves are dug within `protectRadius` of home (the navigator's
break rules' distance test, `BotSkills.inProtectedArea`). A log only a pillar would reach there is
skipped with `no pillar: inside the protected area (no scaffold in the base)` in the log; logs the
ground reaches are felled as before. `FellResult` adds `pillars`, `scaffoldPlaced`, `scaffoldRemoved`,
`scaffoldLeft` (with why), `leavesDug`.

### Temporary scaffold in general (`skills/place/scaffold.ts`)

`ScaffoldRecord` holds the cells placed only to reach something; `clearScaffold` digs them: down the
column the bot stands on, stripping every other recorded column in reach from its top down to the feet
level on the way (a dig-down that would make the bot fall more than 3 blocks is refused: that block
stays); else it walks onto the top of a column (no digging or placing on the way) and digs it down; else
it digs the topmost cell of a column from the side, only while standing on natural ground (not scaffold)
no higher than that cell; else it pillars up beside the column (once) and strips it on the way down.
Anything else stays and is logged as `scaffold: leaving x,y,z (...)`, and counts in `lost`. A dig
interrupted by another skill is tried again (only dispose or death stop the dig-down).

Collect's second approach to an item goes onto the item's floor only (`near`): the first one's `getToBlock`
member can already be met where the bot stands, beside the cell but outside the server's pickup box for an
item lying at a cell corner (wood-fell e2e 2026-10-30, twice: two goto's of 0 blocks, then a log given up).

### Pickups that may dig and place (`collect` with `hard`)

An item the plain walk reports `unreachable` (a drop on a ledge, in a hole, caught on leaves) may get a
walk (`BotSkills.scaffoldGoto`) onto the item's own floor (`near`, not the plain walk's `getToBlock` beside
and 2 below it, which once ended on a 2-block pillar out of pickup reach of an item at a cell corner) with
`allowBreak` and `allowPlace`, under the navigator's rules
(protected area, built blocks, `digPenalty`). On such a walk the navigator digs **natural terrain only**
(`isNaturalTerrain`: stone kinds, dirt, sand, gravel, ores, leaves, snow ...; never logs, cobblestone,
planks, glass or anything built: the dig action refuses and the planner routes around), and places
only harvestable scaffold kinds. Bounds: `hardBlocks` (8) blocks dug + placed (`block_budget` beyond);
per walk min(`hardTicks` 300, max(120, the collect's timeout)) ticks; per collect call at most `hardWalks`
(2) walks within about the caller's own timeout; one walk per item actor across collects (the sweeps run
before every target). Only the job's main items get one: logs for wood (gather's collect and sweep), the
ore drops for the miner, food for the hunter; never saplings, sticks, apples or seeds (`isMinorDrop`).
The blocks the walk placed (also those confirmed late: the walk waits for the re-checks) go into
`BotSkills.scaffold` and are dug again after the pickup. `CollectResult` adds `hardWalks`,
`scaffoldPlaced`, `scaffoldLeft`.

- **Not trees** (`looksBuilt`, 2026-10-31 Realm: a log cabin next to leaves was felled as a 57-log spruce): a bottom
  layer wider than 2 x 2, a layer with more than 9 logs, mostly sideways logs, or a built block (planks, glass,
  stairs, slabs, fences, torches, lanterns ...), a stripped log or a door / chest touching a log; and no tree with
  a log inside `protectRadius` of home is ever listed (`findTrees`).

Test trees (`packs/truth/src/woodShapes.ts`, placed by `truth:tree`): a log column 4..6 high, leaves
radius 2 without corners at top - 1 and top, a plus shape at top + 1 and top + 2. The lowest leaves
are at y + h - 2, so the cells next to the trunk are free up to y + 1 and the drops are reachable.

## Collect (4.4)

`collect(radius, timeoutTicks, { origin, filter, near, attemptsPerItem })`: repeatedly picks the
nearest item entity (EntityTracker, `minecraft:item`) within `radius` of the origin that fits into
the inventory (`Inventory.room(name, maxStack)`), walks to it with `goto({ type: 'near', p, r: 0.8 })`
and waits up to 10 ticks for the server's `take_item_entity`. Items it could not reach or that were
not picked up after 2 approaches are skipped (an unreachable one is retried once after 10 ticks:
drops on top of leaves fall when the leaves decay). Two timing rules came from failed e2e runs:

- **Grace period** (`graceTicks`, 10): the drop of the block broken last arrives as
  `add_item_entity` a moment after the `update_block` that ends `dig()`. A `collect` started right
  after felling saw no item and returned at once; the bot walked off and one log stayed at the
  trunk (2 of the first 2 full-suite runs: 23 of 24 logs). `collect` now reports "nothing to
  collect" only after 10 ticks.
- **Falling drops** (`settleMs` 250, `maxSettleTicks` 60): an item whose position changed within
  the last 250 ms is still falling (from a log higher up); planning a path to its mid-air position
  fails as unreachable, so collect waits for it to land. Result: `{ ok, reason?, gained (inventory delta by
name), pickedUp, skipped, ticks, corrections }`; `reason` is `inventory_full` when only items that
do not fit are left, `timeout`, or `interrupted`.

Measured: logs broken next to the bot are picked up without walking (the server hands a drop to a
player within about 1.3 blocks, about 10 ticks after `add_item_entity`); logs from higher up fall
down the empty trunk column and are picked up the same way, so `collect` after a tree usually walks
only for drops that bounced away (0 to 92 ticks per tree in the fell test) and for saplings from leaf
decay. Picked-up items arrive as `inventory_slot` / `inventory_content` / clientbound
`inventory_transaction` for window 0; `truth:inv` agreed with the model in every run.

## Chest (4.5): packet shapes that work on BDS 1.26.60.6

Open (client -> server), `inventory_transaction`:

```js
{ transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use', actions: [],
  transaction_data: { action_type: 'click_block', trigger_type: 'player_input',
    block_position: { x, y, z }, face,                       // the face seen from the eye (faceToward)
    hotbar_slot: selected, hand: 'main_hand',
    held_item: <the held slot's ItemV4 exactly as the server sent it, or the empty item>,
    player_pos: <eye position, feet + 1.62>,
    click_pos: <centre of that face, block-relative, e.g. {x:0, y:0.5, z:0.5} for west>,
    block_runtime_id: <the chest's network runtime id from the chunk store>,
    client_prediction: 'success', client_cooldown_state: 'off' } } }
```

The bot looks at the chest first (2 ticks) and must be within about 4.5 blocks (eye to the closest
point; the server rejects far clicks silently). bedrock-protocol writes one extra byte after
`legacy_request_id` for the optional `legacy_transactions`; the server's own clientbound
`inventory_transaction` carries that byte too (fixtures), so the shape is symmetric and correct.

Server answers (about 200 ms after the click, including the 2 look ticks):

```js
container_open   { window_id: 2, window_type: 'container', coordinates: { x, y, z }, runtime_entity_id: -1n }
inventory_content { window_id: 2, input: [27 x ItemV4], container: {...}, storage_item: {...} }   // sent twice
```

Move a stack (client -> server), `item_stack_request`, one request per move, awaited one by one:

```js
{ requests: [{ request_id: -1,                // negative odd, counting down: -1, -3, -5 ...
  actions: [{ type_id: 'place', legacy_type_id: 1, count: 10,
    source:      { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 1 },      // 'inventory' for slots 9..35
    destination: { slot_type: { container_id: 'container' }, slot: 0, stack_id: 0 } }],  // 0 = empty slot, else its stack id
  custom_names: [], cause: 'chat_public' }] }
```

`legacy_type_id` must be set (the serializer writes an `undefined` u8 otherwise and BDS drops the
request: no response, the first probe timed out). Stack ids are the server's stack network ids
(`stack_id` of the ItemV4 in inventory_content / inventory_slot / inventory_transaction).

Answer, `item_stack_response`:

```js
{ responses: [{ status: 'ok', request_id: -1, containers: [
  { slot_type: { container_id: 'hotbar' },    slots: [{ slot: 0, hotbar_slot: 0, count: 0, custom_name: '', filtered_custom_name: '', durability_correction: 0 }] },
  { slot_type: { container_id: 'container' }, slots: [{ slot: 0, hotbar_slot: 0, count: 10, item_stack_id: 6, ... }] } ] }] }
```

followed by an `inventory_slot` for the chest window. The model applies the move at once
(prediction), then takes counts and new stack ids from the response; on `status: 'error'` or no
answer within 3 s it rolls the prediction back. Partial stacks of the same item are filled first
(stack size from minecraft-data), then empty slots; `container_full` when neither is left.

Close: client `container_close { window_id: 2, window_type: 'container', server: false }`; the
server answers `container_close { window_id: 2, window_type: 'none', server: false }`.

## GatherWood (4.6)

State machine (`GatherWoodTask.state`): `find` -> `fell` -> `collect` -> (`to_chest` -> `deposit`)
-> `find` ... -> `done` | `failed` | `stopped`; `waiting` while the bot cannot act (not spawned,
loop not ready, dead) and `dead` while paused by a death.

- **find**: `findTrees(searchRadius, origin = chest)` (World.find over the `log` class index, then
  `detectTree` per candidate), nearest to the bot first; a tree that failed twice is skipped.
  5 rounds without any tree (100 ticks apart) -> `failed`.
- **fell** (walks to the tree itself), then **collect** (radius 8 around the base, 300 ticks).
- **deposit** when the logs carried reach what is still missing, or when fewer than 2 inventory
  slots are free: goto `near` the chest (r 2), open, deposit every `*_log` stack, close. Logs of
  any kind count; saplings, apples and sticks are picked up but never counted or deposited.
- **death**: tasks/respawn.ts (Track I) presses respawn; on its `death` event the task pauses
  (skills cancelled), its after-respawn hook waits for the chunks and resumes from `find`. Items
  dropped at the death are not fetched back explicitly (collect may pick them up later if they lie
  near a tree). The respawn point must be near the forest (`/spawnpoint`), otherwise there are no
  trees within the search radius and the task fails after 5 rounds.

## Measured

bds-wood, BDS 1.26.60.6, 2026-10-29. Bare hands throughout (no axe: 60 ticks per oak log), so the
times are an upper bound; an axe would cut the digging time by 2x (wooden) to 7.5x (diamond).

**4.6, `wood-gather` (CLI, `--target-logs 64`, 24 trees / 115..126 logs, chest in the middle):**

| Run | Time to 64 logs in the chest | logs/h (to 64) | Deposited at the end | Trees | Trips | Corrections | Deaths | Failures |
|---|---|---|---|---|---|---|---|---|
| first full run | 304.6 s | 756 | 67 | 14 | 1 | 1 | 0 | 0 |
| suite run A1 | 288.7 s | 798 | 67 | 13 | 1 | 1 | 0 | 0 |
| suite run A2 | 267.9 s | 860 | 65 | 13 | 1 | 0 | 0 | 0 |
| final run 1 | 268.3 s | 859 | 67 | 14 | 1 | 0 | 0 | 0 |
| final run 2 | 336.4 s | 685 | 68 | 14 | 1 | 1 | 0 | 0 |

All well under the 15 min limit (worst 5.6 min); the CLI exited 0 every time. Logs/h as the task
reports it over its whole run: 738 to 915. One trip each time: the bot carries all the logs (64 fit
in one slot) and deposits once. A short run (`WOOD_GATHER_TARGET=16`): 65.9 s. The truth check after
each run found no tree that lost its base log but kept logs above it.

**4.3 / 4.4, `wood-fell` (5 oak trees, 24 logs):** 24/24 logs broken in 89 to 120 s every run, 0
corrections while felling (1 correction per test, at the teleport into the area), 0 dig
failures, one re-path per tree (walking to it; a tree next to the previous one needed none), no log
left from base to base + 5 (truth:find). The first two full-suite runs failed the 4.4 count by one
(23 of 24 logs in the inventory; see "Grace period" above); after the fix 5 of 5 runs had
inventory = truth:inv = logs broken = 24.

**4.5, `wood-chest`:** open in 200 to 231 ms (two of them are the look ticks), one
`item_stack_request` per stack, 0 errors, 10/10 logs in the chest per truth:container, from the
hotbar and from main-inventory slots (onto the existing stack), every run.

**Death (`wood-death`, target 15):** killed while carrying 3 to 6 logs, respawned 2.1 s later next
to the chest, resumed 0.5 s after that, done in 76 to 92 s with 15 to 17 logs deposited; in two of
four runs the logs dropped at the death were picked up again by a later collect.

## Tests

| Test | What |
|---|---|
| `bot/test/unit/skills/tree.test.ts` | detection from every log, branches, touching trees, kinds, refusals (bare column, not on soil, too big), order, `treesFrom` |
| `bot/test/unit/skills/tree-feller.test.ts` | closed loop (FakeConnection + InputLoop + BotSkills + a stand-in server that breaks a block 3 ticks after start_break): bottom-up order, re-path, 9-high trunk leaves 2, cancel, a new skill cancels the running one, `standSpots` |
| `bot/test/unit/skills/collect.test.ts` | nearest first, inventory full, partial stacks, unreachable, never picked up, filter, cancel, timeout |
| `bot/test/unit/skills/tree-pillar.test.ts` | pillar-up on fakes: a 20-high spruce and a 2 x 2 jungle 25 high felled, every scaffold block dug again, only its own blocks dug, falls of 1; no throwaway blocks = as before; protected area; `planColumn` / `pillarSpots`; `clearScaffold` (a replaced block left alone, a drop of 5 refused, a column walked onto from a ledge); collect's `hard` walk. Review fixes: a fell cancelled 10 up leaves its cells pending in the shared record and the next fell digs them down first (B1); a pillar the bot is not on is climbed beside and stripped top down (B1); a late-confirmed placement is recorded (B2); scaffold kinds only harvestable, the reserve lent only until a block was lost (H1, BotSkills); hostile near: no pillar, comes down sneaking (H2); a fall of 4 refused, 3 allowed (L1); minor drops and the sweep's hard filter (M1); at most 2 hard walks per collect (M2); natural terrain only (M3); log walls and logs touching built blocks (M4) |
| `bot/test/unit/skills/container.test.ts` | window tracking, the exact request shape, prediction / reconciliation / rollback / timeout, serialisation round trip with the 1.26.60 protocol, `ChestSkill` open / deposit / close / container_full / refusals |
| `bot/test/unit/skills/gather.test.ts` | state machine with fake skills: one trip, inventory full, failing trees, no chest, death pause/resume, stop/waiting; `!gather` parsing |
| `packs/truth/test/unit/wood-shapes.test.ts` | `treeShape` |
| `bot/test/e2e/wood-fell.test.ts` | 4.3 + 4.4 on `fell-forest` (5 oak trees) |
| `bot/test/e2e/wood-chest.test.ts` | 4.5 on `chest-room` |
| `bot/test/e2e/wood-gather.test.ts` | 4.6 from the CLI on `gather-forest` (24 trees, about 120 logs) |
| `bot/test/e2e/wood-death.test.ts` | the CLI bot is killed while carrying logs and still delivers 15 logs |
| `bot/test/e2e/wood-pillar.test.ts` | pillar-up: a 20-high spruce and a 2 x 2 jungle 22 high felled with no log and no cobblestone left, back on the ground, no damage; a log on a 4-high ledge picked up with the `hard` walk and its scaffold dug again; a husk summoned while the bot is 10 up: it comes down, the pillar is gone, a second fell finishes the tree; a goto pre-empting the fell 8 up: dug down first, then walked, no damage |

Server and pack:

```sh
node scripts/bds.mjs --profile wood up      # docker compose -f docker/compose.wood.yml up -d, wait for "Server started."
node scripts/bds.mjs --profile wood pack    # deploy the truth pack into docker/data/wood, restart
cd bot
BDS_E2E=1 pnpm exec vitest run --project e2e wood          # all wood-* e2e files (about 10 min)
BDS_E2E=1 WOOD_GATHER_TARGET=16 pnpm exec vitest run --project e2e wood-gather   # a short gather run
```

Env: `WOOD_BDS_HOST`, `WOOD_BDS_PORT` (19150), `WOOD_BDS_CONTAINER` (`bds-wood`), `WOOD_VERBOSE=1`
(skill logs and the CLI's log), `WOOD_GATHER_TARGET` (default 64); version and transport from
`bot/test/e2e/env.ts`. Every run builds its layouts in its own random 128-block cell from
x, z = 2048 (`WoodArea`) and uses run-unique truth ids (`DigTruth`), so concurrent runs do not
collide.
