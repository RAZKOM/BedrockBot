# `!get` and the stash step (wave 8, Track AD)

`!get <item> [n]` is the one front door for work: the bot decides by itself whether the item is
gathered (trees), mined (ores and plain blocks), hunted (food mobs, spiders) or farmed (crops), and
runs the matching process. When the inventory fills during mining, gathering or hunting, the
**stash step** makes room (a chest, a carried shulker box, dropping junk) and the job goes on.
Decision record: [decisions/0025-get-front-door-and-stash.md](decisions/0025-get-front-door-and-stash.md).

## Files

| Path | What |
|---|---|
| `bot/src/skills/items/catalog.ts` | the catalog: item words -> strategy, item, target block / crop / mob, default count, the command it runs |
| `bot/src/chat/commands-get.ts` | `!get`, `GetController` (dispatch, `!get stop`, `!get status`, the farm round check), builds and registers the `Stash` |
| `bot/src/skills/container/stash.ts` | `Stash` (the step), `boxSpots`, `withSlotType`, `setStash` / `stashFor` |
| `bot/src/tasks/process/mine.ts` | `MineProcess.tick()`: the stash step while mining (Track AD lines) |
| `bot/src/tasks/process/food.ts` | `FoodJob.run`: the stash step before a hunt (Track AD lines) |
| `bot/src/tasks/gatherWood.ts` | `GatherWoodTask.stash` and the call where the inventory is full (Track AD lines) |
| `bot/src/config/settings.ts` | `stashChest` (text: `x y z` / `none`), `stashShulker` (on) |
| `packs/truth/src/get.ts` | `truth:stuff`, `truth:getinv`, `truth:boxitems` |
| `bot/test/unit/get-catalog.test.ts`, `get-processes.test.ts`, `skills/stash.test.ts` | unit tests on fakes |
| `bot/test/e2e/get-front.test.ts`, `get-stash.test.ts`, `get-truth.ts` | e2e on bds-get |
| `docker/compose.get.yml` | `bds-get`, udp/19194, flat, peaceful |

## Commands (owner only, afk task with walking)

| Command | Reply |
|---|---|
| `!get <item> [n]` / `!get [n] <item>` | `getting 20 oak_log: gathering wood`, then the replies of the command it runs (`gathering 20 logs (no chest: keeping them)`, `gather done: 24/20 logs`) |
| `!get coal 4` | `getting 4 coal: mining coal_ore`, `mining 4 coal_ore/deepslate_coal_ore`, `mine coal_ore: 4/4 done` |
| `!get wheat` | `getting wheat: farming wheat (one round of the field)`, `farming r=8 around ...`, then `get wheat: 81 wheat harvested (81 crops in all), the field is done` (the round check is unit-tested on fakes; no e2e yet) |
| `!get bread` | `get: I do not know how to get bread; I can get: wood, ores (coal, iron, gold, copper, diamond, redstone, lapis, emerald), stone, dirt, sand, gravel, flint, clay, food (beef, pork, mutton, chicken), string, crops (wheat, carrots, potatoes, beetroot)` |
| `!get stop` | `stopped mine coal_ore 2/4 (dig, 0 skipped)`: the job `!get` started (else any running gather / mine / food / farm); `get: nothing to stop` |
| `!get status` | `get: 4 coal via !mine coal_ore 4: mine coal_ore 2/4 (dig, 0 skipped); stash: 1 attempts (1 ok, 0 full), last: shulker box at ...: moved 1728 cobblestone in 27 requests (28 on the shared Containers), picked up again, box full`; `get: idle` |

`!get` replies first, then runs the command as a copy of the owner's line through the chat's own
handler (like a `!do` plan step), so `!stop`, `!pause`, `!status` and the command's own replies work
as for the command typed by hand. The old commands (`!gather`, `!mine`, `!food`, `!farm`) stay.
Counts above the command's own maximum are cut to it (2304 logs, 256 blocks, 64 food).

## Catalog

| Item words (also with `minecraft:`, plural) | Strategy | Runs | Item / note |
|---|---|---|---|
| wood, log(s), tree(s), timber | gather | `!gather n` | logs; any log kind counts |
| oak, oak_log, oak_wood, birch, spruce, jungle, acacia, dark_oak, mangrove, cherry, pale_oak (and `_log`, `_wood`) | gather | `!gather n` | `<kind>_log`; the gather task fells any tree, so other kinds count too |
| coal, coal_ore, deepslate_coal_ore | mine | `!mine coal_ore n` | coal |
| iron, raw_iron, iron_ore, iron_ingot | mine | `!mine iron_ore n` | raw_iron |
| gold, raw_gold, gold_ore | mine | `!mine gold_ore n` | raw_gold |
| copper, raw_copper, copper_ore | mine | `!mine copper_ore n` | raw_copper |
| diamond(s), diamond_ore | mine | `!mine diamond_ore n` | diamond |
| redstone, redstone_dust, redstone_ore | mine | `!mine redstone_ore n` | redstone |
| lapis, lapis_lazuli, lapis_ore | mine | `!mine lapis_ore n` | lapis_lazuli |
| emerald(s), emerald_ore | mine | `!mine emerald_ore n` | emerald |
| quartz, nether_quartz_ore | mine | `!mine quartz_ore n` | quartz |
| stone, cobble, cobblestone | mine | `!mine stone n` | cobblestone |
| dirt, sand, red_sand, gravel, clay, andesite, diorite, granite, tuff, calcite, netherrack, obsidian, deepslate | mine | `!mine <block> n` | the block (clay: clay_ball, deepslate: cobbled_deepslate) |
| flint | mine | `!mine gravel n` | flint drops from about 1 in 10 gravel: counting gravel dug |
| food, meat, beef, steak, pork(chop), mutton, chicken, rabbit | hunt | `!food n` | any food mob counts (`!food` has no kind filter) |
| string, cobweb | hunt | `!kill spider n` | counting spiders killed |
| wheat, seeds, wheat_seeds, carrot(s), potato(es), beetroot(s), beetroot_seeds | farm | `!farm` | one round of the field (until nothing is left to do), or until n of that crop were harvested |
| anything else | unknown | - | the reply lists the categories |

Defaults: 16 logs, 8 ore or blocks, 6 food, one round of a field. Plain blocks are mined like ores:
with `mineSeenOnly` off (the default) the nearest one the bot knows, tunnelling to it under the
mining safety rules (docs/mining.md).

## Stash

Called where the inventory fills, with fewer than 2 free inventory slots:

| Where | When |
|---|---|
| mine process | every tick in control (also right at the start), not while collecting a drop: the task pauses for the step and resumes after it |
| food job (`!food`, `!get beef`, the food chore) | before the hunt starts or resumes |
| gather task (`!gather`, `!get wood`, afk task only) | at the full-inventory check, when no logs wait for the job's own chest trip |

Steps, in order, until 2 slots are free:

1. **Chest**: the `stashChest` setting (`!set stashChest 10 -60 3`), else the job's own chest (a
   gather `!gather N x y z`): walk there (`near`, 2 blocks), open, deposit, close.
2. **Shulker box** (`stashShulker` on, a box carried; with several, the one with the most free slots by its NBT `Items`, a box with all 27 used is skipped): place it on a free cell next to the bot
   (empty, empty above for the lid, a full solid top below that is not a container, not reaching
   into the body; nearest of 12 cells first, up to 3 tries), open, deposit (slots addressed as
   `shulker`), close, break it (the Digger's best tool; a shulker box drops itself with its contents
   with any tool), pick it up (collect radius 4, then 6). A failed open or deposit still breaks and
   picks it up again.
3. **Drop junk**: junk only (`STASH_JUNK` in stash.ts: the survival keeper's junk such as rotten flesh and string, plus filler
   blocks: cobblestone, dirt, gravel, sand, stone, deepslate, tuff, seeds, leaves, ...), never the job's produce, ore, ingots or gems;
   throwaway blocks keep 16 for pillaring. Through the survival kit's `drop(name, n)`.
4. **Give up**: still fewer than 2 free: `ifFull` answers false, the stash says `stash: inventory full
   (...)` and the job ends: `mine coal_ore: failed after 2/4 (inventory full)`, `gather failed: ...
   (inventory full)`, a food job with reason `inventory_full`.

Deposited: every stack `keepOnDropItems` does not keep (the job's produce and junk); tools, weapons,
armour, real food, totems, shulker boxes and ender chests stay. After a chest or box step the bot
walks back to the block it stood on. A guard fight, a flight, the night shelter or a new command
(any control change of the process manager) cancels a running step; the job checks again once it has
control back. Every attempt is logged (`stash (mine): 0 -> 27 slots free in 4.0 s: shulker box at
29825 -60 30080: moved 1728 cobblestone in 27 requests (28 on the shared Containers), picked up
again, box full`) and kept in `Stash.attempts` (last 50); `!get status` shows the last one.
`requests` are the step's own item_stack_request round trips (one per stack moved); `shared` counts
every request on the task's one Containers while the step ran (the keeper restocking the hotbar with
cobblestone added one in every run).

### Packet facts (BDS 1.26.60.6, verified on bds-get)

| What | Seen |
|---|---|
| Placing `undyed_shulker_box` on a full block (`place`, face up) | `update_block` 4 ticks after the call (2 after the click); world model `undyed_shulker_box`, boxes `[[0,0,0,1,1,1]]`, hardness 2 |
| Opening it (the chest skill's click) | `container_open { window_type: 'container', coordinates, runtime_entity_id: -1 }`, then `inventory_content` with 27 slots |
| `item_stack_request` `place` into its slot 0 with `container_id: 'container'` | refused: `item_stack_response { status: 50 }` (also `'shulker_box'`) |
| the same with `container_id: 'shulker'` (ContainerSlotType 30) | ok; the response names the container `shulker` |
| Breaking it with a stone pickaxe | 15 ticks (Digger table), drops one `undyed_shulker_box` item entity |
| Picking it up | the inventory slot's item carries NBT `Items` (one compound per stack: `Name`, `Count`, `Slot`, `Block`); placed again, the block holds the same stacks (truth:container) |
| Script API 2.10.0 on the box item | no `minecraft:inventory` component (truth:getinv lists no contents): the contents cannot be read by the truth pack from the item |

## Measured (e2e on bds-get, 2026-10-29)

Three runs of `get-front` + `get-stash` (5/5 green each, 129 to 134 s per run):

| What | Result |
|---|---|
| `!get 20 oak_log`, 4 oak trees of 6 logs, iron axe | `gather done: 24/20 logs` (the last tree is finished) in 26.9 to 29.2 s from the command |
| `!get coal 4`, 4 coal ore 3 blocks under the floor, 2 blocks away, stone pickaxe | `mine coal_ore: 4/4 done` in 18.2 to 20.7 s; 5 blocks dug on the way (sight line + tunnel), 4 coal |
| stash, shulker box (0 slots free, 34 stacks of cobblestone) | 0 -> 27 slots free in 4.1 to 6.3 s: place (4 ticks), open, 27 item_stack_requests (28 on the shared Containers: the keeper restocked the hotbar once), close, break (15 ticks, stone pickaxe), pick up, walk back; the job then finished 4/4, 23.8 to 26.3 s from the command in all |
| stash, `stashChest` 10 blocks away | 0 -> 27 slots free in 6.8 to 6.9 s (4.5 to 4.6 s for walk + deposit, the rest walking back); 27 requests (28 shared); job 4/4 in 26.4 to 26.7 s |
| contents after the box came back | NBT `Items` 1728 cobblestone; placed again: 1728 cobblestone (truth:container) |

## Tests

```sh
pnpm --filter bot exec vitest run --project unit get-catalog get-processes stash       # unit, fakes only
node scripts/bds.mjs --profile get up && node scripts/bds.mjs --profile get pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e get- --silent=false          # ~2.5 min
```

Env: `GET_BDS_HOST` (127.0.0.1), `GET_BDS_PORT` (19194), `GET_BDS_CONTAINER` (bds-get),
`GET_VERBOSE=1` (the bot's log). Every run uses its own random 256-block cell from x, z = 28672,
random truth request ids; the area is cleared and drops removed at the end.

- `get-front`: an oak stand of 4 persistent trees, `!get 20 oak_log` (the reply names the gather
  process, `gather done: 24/20 logs`, truth counts >= 20 oak logs); 4 coal ore 3 blocks under the
  floor (stone around), `!get coal 4` (`mine coal_ore: 4/4 done`, 4 coal, the ores gone); `!get bread`
  (the unknown reply, no process started).
- `get-stash`: inventory full (stone pickaxe, a shulker box, 34 stacks of cobblestone, 0 free),
  `!get coal 4`: the stash step places, fills (27 stacks, 27 requests), breaks and picks up the box,
  the job finishes 4/4; the box item's NBT holds 1728 cobblestone and the box placed again holds 1728
  cobblestone (truth:container), no box or drop left; then `!set stashChest <chest 10 blocks away>`
  and the same: 27 stacks in the chest (truth:container), the box stays in the inventory, empty.

### Truth commands (`packs/truth/src/get.ts`)

| Request | Answer |
|---|---|
| `stuff playerName typeId stacks` | `{name, typeId, stacks, slots}`: full stacks into the first free slots in one request |
| `getinv playerName` | like `inv`, plus the contents of items that carry an inventory component (bundles; not shulker boxes in 2.10.0) |
| `boxitems x y z r` | item entities within r, with nested contents when readable |

## Home logistics (wave 9, Track AG)

What a job brings back now has a place to go: the bot remembers the containers within
`homeChestRadius` of home and what they hold, and `!unload` (or the `autoUnload` chore) puts each
stack with the same item, in a chest labelled for it, or in the emptiest chest, filling a spare
shulker box from the box chest when every chest is full (docs/home.md). A `!get` job that ends
within 8 blocks of home is followed by such an unload, and its line `unloaded: 64 coal -> chest
100 63 -48, ...` comes after the job's own reply. The stash step itself is unchanged; its shulker
box names, the NBT reader and the `shulker` slot type moved to the chest skill
(`skills/container/chest.ts`), which now sets the slot type per window on the shared Containers
(`shulker` for shulker boxes, `barrel` for barrels, verified; `container` for chests), so the stash
no longer switches the Containers' private option.

## Open points

- ~~`world/containers.ts` should know the slot type per window~~ done in wave 9 (Track AG):
  `Containers.setSlotType`, set by the chest skill when it opens a container; shulker boxes are in
  `CONTAINER_BLOCKS` from the start.
- No ender chest step yet (same click and window; the slot type is unverified).
- The food job checks for room only before a hunt; a long hunt that fills the inventory picks
  nothing more up until the next job. Farming keeps its own chest trips (no stash call).
- `!get oak_log` counts any log kind (the gather task has no species filter); `!get beef` hunts any
  food mob.
- The miner refuses to dig a sight line under its own feet; the stash walks back to the block the
  job had the bot on, which avoids that after a box pickup, but a miner that ends up standing on the
  line by itself still skips the ore (Track Z's `mineOne`).
