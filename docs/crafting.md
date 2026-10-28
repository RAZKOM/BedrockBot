# Crafting and compaction: `!craft`, `!compact`, the compaction step of `!unload` (wave 11, Track AW)

The owner's words (2026-10-30): "if a chest has iron blocks and iron ore, and it's full and trying to
drop off more iron ore, then it should craft them into blocks to make it fit." So: crafting as a
skill, and compaction (9 raw iron -> 1 raw iron block, 9 ingots -> 1 block, the same for copper,
gold, diamond, emerald, coal, redstone, lapis, netherite) as its first use, called by the unload plan
when a chest cannot take the bot's load. Nothing here gives an advantage over other players: the bot
crafts through the normal screens exactly as a vanilla client does (the inventory's 2 x 2 grid, a
crafting table's 3 x 3), one `item_stack_request` at a time. Decision record:
[decisions/0045-crafting-and-compaction.md](decisions/0045-crafting-and-compaction.md).

Everything below was measured on **BDS 1.26.60.6** (`bds-craft`, udp/19208, flat, peaceful, operator)
with bedrock-protocol `c9e1fbf2` / minecraft-data 3.117.0 + the 1.26.60 patch on 2026-10-30, with a
`PacketRecorder` on a probe stack (the recordings are not committed; the request shapes below are
what the probe sent and the unit tests pin).

## Files

| Path | What |
|---|---|
| `bot/src/skills/craft/recipes.ts` | `RecipeIndex` (the server's `crafting_data` by output name; shaped and shapeless grid recipes only), `needsTable`, `gridSlots`, `TAGS`, `planCraft` / `canCraft` (the recipe, the crafts possible, the shortfall, the batch size), `usablePool` (the keep rules and the reserve) |
| `bot/src/skills/craft/crafter.ts` | `Crafter.craft(item, n, cancelled)`: the screen, the grid fill, the craft request, the output, the give-back, the table (found, placed, dug and picked up); `CraftRequests` (own request ids from -400001); `craftLine` |
| `bot/src/skills/craft/compact.ts` | `COMPACT` (the 9 -> 1 table), `compactPlan`, `compactAll` (`!compact`), `compactForUnload` + `fullAfter` (the unload hook), `installCompactPlanner`, `compactLine` |
| `bot/src/chat/commands-craft.ts` | `!craft`, `!compact`, `CraftProcess` (user, priority 40), `neverConsume`, `compactRunnerFor` (the runner the unload job calls for `plan.compact`), `craftControlOf(task)` |
| `bot/src/skills/home/unloader.ts` | Track AW hooks: `UnloadPlan.compact` (kind, count) filled by `compactPlanner` (set by `installCompactPlanner`), and `compactRunner` / `setCompactRunner` (the unload job runs the steps through it, under its serial lock); both reset when the task stops |
| `bot/src/config/settings.ts` | `craftReserve` (text: `iron_ingot 9, diamond 4` / `none`), `compactOnUnload` (boolean, on) |
| `bot/src/nl/plan.ts`, `prompt.ts` | the `craft` step (`{"command":"craft","item":"iron_block","count":4}`), one example |
| `bot/src/tasks/registry.ts` | one import, one registration line (after the home logistics: the unload wrapper needs it) |
| `packs/truth/src/craft.ts` | `truth:kit` (clear + give several items in one request), `truth:craftinv` (counts without the namespace), `truth:table x y z [remove]` |
| `bot/test/unit/skills/craft-recipes.test.ts`, `craft-crafter.test.ts`, `bot/test/unit/chat/craft-commands.test.ts`, `bot/test/unit/fixtures/crafting-data-1.26.60.json` | unit tests on a recorded recipe fixture and a small BDS-like fake server |
| `bot/test/e2e/craft-basic.test.ts`, `craft-compact.test.ts`, `craft-truth.ts` | e2e on bds-craft |
| `docker/compose.craft.yml`, `scripts/bds.mjs` (`craft` profile), `bot/scripts/e2e-profile.ts` (`CRAFT_BDS_*`) | the server |

## Commands (owner only, afk task with walking)

| Command | Tier | Reply |
|---|---|---|
| `!craft <item> [n]` (also `!craft 32 oak_planks`) | more (work) | `crafting 4 iron_block (36 iron_ingot, crafting table)`, then `crafted 4 iron_block (36 iron_ingot used) in 0.7 s; crafting table placed and picked up`. Fewer possible: `crafting 1 iron_block (9 iron_ingot, crafting table; 891 iron_ingot short for 100)` and the end line repeats the shortfall. Refusals: `craft: no diamond for diamond_block (need 9, have 0)`, `craft: no recipe for elytra I can use (crafting table and inventory recipes only)`, `craft: busy crafting already (!stop ends it)`, `craft: no recipes yet (the server sends them at join)`; a run that made nothing: `craft: made no iron_block (no_table)` |
| `!compact [kind]` | more (work) | `compacting 45 raw_iron -> 5 raw_iron_block, 9 iron_ingot -> 1 iron_block`, then `compacted 45 raw_iron into 5 raw_iron_block; 9 iron_ingot into 1 iron_block`; `kind` picks one (`!compact iron` matches raw_iron and iron_ingot, `!compact coal_block` coal); nothing: `compact: nothing to compact (9 or more of raw_iron, raw_copper, raw_gold, iron_ingot, gold_ingot, copper_ingot, ...)` |
| `!unload` (Track AG) | front | with `compactOnUnload` on and Track AV's unload job calling the runner: `compacted 27 raw_iron into 3 raw_iron_block` before the usual `unloaded: 3 raw_iron_block -> chest 12355 -60 13248` when the plan's chest for a compactable kind cannot take the load |

Both commands are user processes (priority 40): `!stop` ends them between batches; a pre-emption
(flee, guard, night) pauses them and the job runs again for what is still missing (`craft 4
iron_block (1 done) (paused)` in `!status`).

### Settings (`!set`)

| Setting | Default | Meaning |
|---|---|---|
| `craftReserve` | `none` | `item n[, item n]`: never consume below this many of an item (`!set craftReserve iron_ingot 9, diamond 4`). Tools, armour, food, totems, shulker boxes, ender chests (everything `!drop items` keeps) and the flight kit are never consumed anyway |
| `compactOnUnload` | on | `!unload` and the autoUnload chore compact a kind first when its chest would end with no free slot or part of it has no chest at all |

## Packets (BDS 1.26.60.6, recorded on bds-craft)

### The recipe list at join

`crafting_data` arrives once after `start_game` (about 0.9 s after the spawn on a local server):
1219 shaped, 2068 shapeless, 14 multi, 1456 shulker-box, 12 + 1 smithing recipes, `clear_recipes:
true`. Every grid recipe has `block: 'crafting_table'` (2674 of them; the others: `furnace` 134,
`blast_furnace` 62, `smoker` 9, `campfire` / `soul_campfire` 9 each, `stonecutter` 354,
`cartography_table` 2, `deprecated` 34). The grid size, not the block, decides between the inventory
screen and a table: a shaped recipe with `width <= 2 && height <= 2` (or a shapeless one with at
most 4 inputs) works in the inventory. `network_id` is what a craft request names (1..4770, distinct).

| Recipe (`recipe_id`) | `network_id` | Shape | Input | Output |
|---|---|---|---|---|
| `minecraft:iron_block` | 4250 | shaped 3 x 3 | 9 x name `minecraft:iron_ingot` (metadata 32767 = any) | `iron_block` x1 (network id 42, block runtime id -939070369) |
| `minecraft:raw_iron_block` | 4403 | shaped 3 x 3 | 9 x `minecraft:raw_iron` | `raw_iron_block` x1 |
| `minecraft:oak_planks` (+ `_from_stripped`, `_from_wood`, `_from_stripped_wood`) | 3587 (3588, 3945, 3944) | shaped 1 x 1 | 1 x `oak_log` (stripped log, wood, stripped wood) | `oak_planks` x4 |
| `minecraft:stick` | 4453 | shaped 1 x 2, priority -1 | 2 x item_tag `minecraft:planks` | `stick` x4 (per-wood recipes 4738 / 4642 / 4739 and a bamboo one exist too) |
| `minecraft:torch` | 3318 | shaped 1 x 2 | item_tag `minecraft:coals` over `minecraft:stick` | `torch` x4 (`Torch_recipeId` 4770 names coal, `Torch_charcoal_recipeId` 4769 charcoal) |
| `minecraft:WorkBench_recipeId` (+ `_from_oak`, per wood) | 4090 (3256, ...) | shaped 2 x 2 | 4 x item_tag `minecraft:planks` | `crafting_table` x1 |
| `minecraft:coal_block` | 4075 | shaped 3 x 3 | 9 x `minecraft:coal:0` (the aux value in the name, metadata 0) | `coal_block` x1 |

Ingredient shapes as bedrock-protocol decodes them: `{ type: 'valid', descriptor_type: 'name', name:
'minecraft:iron_ingot', metadata: 32767, count: 1 }`, `{ type: 'valid', descriptor_type: 'item_tag',
tag: 'minecraft:planks', metadata: 32767, count: 1 }`, `{ type: 'invalid', metadata: 32767, count: 0 }`
for an empty cell of a shaped pattern (row-major). Every recipe also carries `unlocking_requirement`;
the server did not enforce it (an iron block was crafted on a fresh player). Tags grid recipes use:
`planks`, `logs`, `coals`, `wooden_slabs`, `stone_crafting_materials`, `stone_tool_materials`, `wool`,
`soul_fire_base_blocks`, `egg`, `metal_nuggets`, `mushrooms_for_stew` (recipes.ts `TAGS` resolves them
against item names).

### The screens

| Grid | Open | Server | Grid slots (`crafting_input`) |
|---|---|---|---|
| 2 x 2 | `interact { action_id: 'open_inventory', target_entity_id: own, has_position: false }` | `container_open { window_id: 2, window_type: 'inventory', coordinates: feet, runtime_entity_id: -1 }` | 28 29 / 30 31 |
| 3 x 3 | the chest click (`inventory_transaction` item_use / click_block on the table, docs/wood.md) | `container_open { window_id: 2, window_type: 'workbench', coordinates: the table }`; no `inventory_content` follows for the window | 32 33 34 / 35 36 37 / 38 39 40 |
| close | `container_close { window_id, window_type, server: false }` | `container_close { window_id, window_type: 'none', server: false }` | **items left in the grid are destroyed** (no item entity, nothing back in the inventory: the vanilla client moves them back itself), so the crafter empties the grid before every close |
| drop | `{ type_id: 'drop', legacy_type_id: 3, count, source: { container_id: 'crafting_input', slot, stack_id }, randomly: false }` | ok, the grid slot at count 0, an item entity at the feet (truth:items) | the last resort of the give-back when the inventory has no room: a player would do the same |

### The requests

A shaped recipe's pattern sits at the grid's top-left (sticks: slots 28 and 30 in the inventory, 32
and 35 in a table). A batch is two requests:

```js
// 1. the fill: one `place` per grid cell, several in one request are fine (count = crafts in this batch)
{ requests: [{ request_id: -400001, actions: [
  { type_id: 'place', legacy_type_id: 1, count: 8,
    source: { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 21 },          // or 'inventory' for 9..35
    destination: { slot_type: { container_id: 'crafting_input' }, slot: 28, stack_id: 0 } },
], custom_names: [], cause: 'chat_public' }] }
// -> item_stack_response { status: 'ok', containers: [{ hotbar: [{ slot: 0, count: 0 }] }, { crafting_input: [{ slot: 28, count: 8, item_stack_id: 22 }] }] }

// 2. the craft: craft_recipe (times), one consume per cell, the output placed from the created-output slot
{ requests: [{ request_id: -400003, actions: [
  { type_id: 'craft_recipe', legacy_type_id: 12, recipe_network_id: 3587, times_crafted: 8 },
  { type_id: 'consume', legacy_type_id: 5, count: 8, source: { slot_type: { container_id: 'crafting_input' }, slot: 28, stack_id: 22 } },
  { type_id: 'place', legacy_type_id: 1, count: 32,
    source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: -400003 },   // the request's own id
    destination: { slot_type: { container_id: 'inventory' }, slot: 9, stack_id: 0 } },
], custom_names: [], cause: 'chat_public' }] }
// -> item_stack_response { status: 'ok', containers: [{ crafting_input: [{ slot: 28, count: 0 }] }, { hotbar|inventory: [{ slot: 9, count: 32, item_stack_id: 23 }] }] }
```

No `inventory_slot` / `inventory_content` follows a crafting response: the response is the
confirmation, and it carries counts and stack ids only, so the crafter predicts the output item into
the destination slot (and the grid items into the window) before sending, as the furnace code does.
`times_crafted` is a byte; the output must fit one stack and each cell one stack, so a batch makes at
most `floor(64 / output count)` crafts (16 for planks, 64 for blocks). `creative_output` is
minecraft-data's name for ContainerSlotType 60 (the "created output" container); its slot is always 50.

**The wire type of the craft action.** Every action has two header bytes: minecraft-data's `type_id`
(a varint from its mapping) and `legacy_type_id` (a byte). For `place` / `consume` both are the same
number and nothing shows. For crafting they differ: BDS 1.26's `ItemStackRequestActionType` has the
two bundle actions (`PlaceInItemContainer` 7, `TakeFromItemContainer` 8) that minecraft-data 3.117.0's
mapping lacks, so from `lab_table_combine` on the names are two off: `craft_recipe` is 10 in the
mapping and 12 on the server. What works is **`type_id: 'craft_recipe'` (10) with `legacy_type_id: 12`**
(`crafter.ts` `CRAFT_RECIPE_WIRE_TYPE`). Measured on the way there:

| Sent | Server |
|---|---|
| `craft_recipe` 10 / legacy 10, or `craft_creative` (12) / legacy 12 | `packet_violation_warning { violation_type: 'malformed', severity: 'terminating', packet_id: 147, reason: 'wrong const value for member "Action type"' }` and the connection is closed 0.5 s later (no `disconnect` packet) |
| `craft_recipe_auto` 11 / legacy 11 with an `ingredients` list (the recipe-book path) | the same violation: minecraft-data's `RecipeIngredient2` / auto shape is not what this server reads; not used |
| `craft_recipe` 10 / legacy 12, alone | `status: 17` (the craft without the result transfer) |
| the craft with a grid that does not match the recipe (two planks side by side for the 1 x 2 stick recipe; or the fill and the craft in ONE request) | `status: 35` (the grid is checked before a fill in the same request lands) |
| `consume` alone | `status: 3` |
| `take` from `creative_output` without a craft | `status: 49` |
| a `place` or `drop` from a grid slot with `stack_id: 0` (the stack id unknown) | `status: 49`: a grid item can only be moved or dropped with the stack id the fill's response gave |
| a player-inventory move without the screen (earlier tracks) | `status: 49` / `50` |

Item stack requests are atomic: a refused request moves nothing (the model's prediction is rolled
back whole). Moving a grid item back into the inventory is a plain `place` from `crafting_input` to a
player slot (ok, the player slot's new count and stack id in the response).

### Timing (bds-craft, local)

| What | Measured |
|---|---|
| one request (fill or craft) -> response | about 3 ticks, 130 to 150 ms |
| a 2 x 2 batch (fill + craft): 8 logs -> 32 planks, 4 + 4 planks -> 16 sticks | 0.4 s crafting, 0.8 s from the command to the end line (screen open and close included) |
| a 3 x 3 batch with a table already standing: 27 raw iron -> 3 blocks | 0.5 s crafting |
| `!craft iron_block 4` with the table carried | 0.7 s crafting; 6.6 s from the command: placing the table (4 ticks), the dig of a crafting table with the bare hand (about 3.8 s), the pick-up |
| `!compact` 45 raw iron with the table carried | 5.6 to 5.7 s from the command |
| the unload with the compaction step (27 raw iron, a table standing) | 1.5 s from `!unload` to `unloaded:` |
| 64 iron blocks (576 ingots, 9 stacks) | one batch: the fill is 9 `place` actions of 64 in one request (a cell takes a stack), then the craft; the same 2 requests as one block |

## The recipe index and the plan

`RecipeIndex` keeps the shaped and shapeless recipes with `block: 'crafting_table'` by their first
output's name (item names from the registry's `item_registry`); furnace, smoker, campfire, stonecutter,
smithing and brewing recipes are not crafting (docs/food.md owns the furnace). `planCraft(item, n,
inventory)` builds one plan per recipe of the item against the **usable pool** (every carried item
minus the kept ones and the `craftReserve` counts), assigns each cell a concrete item (a tag takes
the most plentiful match), and picks the recipe with the most crafts possible now, then the one that
fits the inventory grid, then the lower priority number, then fewer inputs. The plan says `crafts`
(capped at the crafts wanted: `ceil(n / output count)`), `batchMax`, the `perCraft` consumption and
the `shortfall` (the limiting ingredient: have, need). `canCraft` wraps it: `no_recipe`, `missing`
(with the shortfall), or ok.

## The crafter

1. Plan; nothing possible -> `missing` with the shortfall, no packet. A recipe whose ingredient the
   bot keeps (a golden apple's gold, a tool) answers `missing` too: kept items are not in the pool.
2. A 3 x 3 recipe needs a table: one within reach of the eye (4.5) with a clear line from the eye to
   its nearest face (a 0.2-block ray, no solid block on the way) is used as it stands; a table in the
   13 x 6 x 13 scan box but out of reach or behind a wall is walked to (`goto getToBlock`, reach 3)
   and checked again; else the carried `crafting_table` is placed on a free cell next to the feet
   (the stash step's `boxSpots`: empty, empty above, a full block below that is not a container and
   not a built block) with `PlaceSkill.place(p, { face: 'up', item: 'crafting_table' })`; none
   carried but planks: a table is crafted first (a 2 x 2 recipe, in the inventory screen); else
   `no_table`.
3. Open the screen (above), then batch by batch while something is wanted and possible: replan on the
   live inventory; **choose the output slot first** (a matching stack with room, else an empty slot,
   counting the slots the fill empties; none -> `inventory_full` before anything moves); fill the grid
   by the recipe's pattern cells (holes stay empty: a chest fills 32..35 and 37..40, never 36; the
   largest stack of each item first; a cell that needs more than one source stack is filled over
   several requests); craft. A refused craft gives the grid back and is retried once; a second
   refusal ends the craft (`request_failed`, the status in the reply). The response's counts correct
   the predicted slots; the destination's growth is checked against the expected output (a warning
   when the model disagrees). `cancelled()` (`!stop`, a pre-emption) is read between batches.
4. Always: the grid is given back and the screen closed. The give-back plans its destinations with
   their counts (cells of one item merge where they fit, nothing is sent to a slot that would
   overflow); a refused give-back is retried cell by cell; a cell with no room, or one still refused,
   is **dropped** from the grid (`drop`, an item entity at the feet, `dropped 5 raw_iron (no room)` in
   the reply) rather than lost at close; a cell the server refuses to move or drop is taken as empty
   on the server (a stale prediction). A table the bot placed is dug (`Digger`, the best hotbar tool)
   and picked up (the drop usually lands at the feet; else `collect` within 3 blocks); the reply says
   `crafting table placed and picked up`, or `crafting table left at x y z` when the pick-up failed.
   The bot never digs a table it did not place, and only the cell it placed it in, after checking the
   block is still a crafting table.
5. Tables left standing (a dig refused or pre-empted) stay in the Crafter's `pendingTables` (task
   state, `!status` says `1 left standing`): the next craft picks them up first when within reach,
   and a pending table found as the nearest table counts as `placed: true` (picked up after use).

### No answer from the server

A request without an `item_stack_response` within 60 ticks is a timeout; the crafter keeps its
prediction, waits up to 100 more ticks for the late response (applied to the model when it comes:
`status: 'late'` in the result) and ends the craft with `request_failed`. The grid is then given back
from the model's view: when the server never saw the fill, the give-back is refused (nothing was
there) and the model is corrected; when the server did the move, the give-back is refused too (the
grid stack ids are only in the lost response: `stack_id: 0` answers 49), so the items are lost at
close exactly as a vanilla client's are on a disconnect; the model is told so. A lost craft response
(the server crafted, the client did not hear) leaves the output in the inventory and an empty grid;
the give-back's refusal tells the model so. On a disconnect the screen is gone with
the connection: the server destroys the grid items of a player who leaves with a filled grid (the
vanilla client has the same exposure); the next spawn's `inventory_content` resyncs the model.

Hotbar slots the responses changed get `Hotbar.noteRaw` (the wire item rebuilt from the model), so
the next `mob_equipment` / click carries the right item.

## Compaction

| Item (9) | Block (1) |
|---|---|
| `raw_iron`, `raw_copper`, `raw_gold` | `raw_iron_block`, `raw_copper_block`, `raw_gold_block` |
| `iron_ingot`, `gold_ingot`, `copper_ingot`, `netherite_ingot` | `iron_block`, `gold_block`, `copper_block`, `netherite_block` |
| `diamond`, `emerald`, `coal`, `redstone`, `lapis_lazuli` | `diamond_block`, `emerald_block`, `coal_block`, `redstone_block`, `lapis_block` |

Not sand, cobblestone, wheat, melon slices, snowballs or anything that does not come back as the
same item (netherite scrap has no block). `compactPlan(kind, inventory)` = `floor(usable / 9)`
blocks; `compactAll` lists every kind carried in nines (`!compact`).

### The unload integration

`planUnload` (skills/home/unloader.ts) now carries `compact?: { kind, count }[]`, filled by the
planner `installCompactPlanner` sets: for every compactable kind the bot carries nine or more of,
compact when some of it **overflows** (no chest has room) or when **its target chest ends with no
free slot** after the plan's moves (`fullAfter` replays the plan's slot arithmetic per chest). The
owner's case: a chest of 26 stacks of raw iron with one free slot, 27 raw iron carried -> the 27 fill
the last slot -> compact first -> 3 blocks go into that slot instead (8 slots saved per 9 stacks).
A chest with room left (or fewer than 9 of the kind) compacts nothing; `compactOnUnload off` turns
the step off.

The runner: `commands-craft.ts` installs `setCompactRunner(fn)` (unloader.ts) with `fn(steps,
cancelled)` crafting each `{ kind, count }` (`floor(count / 9)` blocks of the kind's block: a table
within reach, else the carried one placed and picked up) and answering the reply fragment
`compacted 54 raw_iron into 6 raw_iron_block` (undefined when nothing was compacted). Track AV's
unload job (logistics.ts `doUnload`, under its serial lock) calls `compactRunner?.(plan.compact,
cancelled)` before its moves when the plan carries the step and the runner is installed, says the
fragment, then unloads as before (`unloaded: 6 raw_iron_block -> chest ...`). Both hooks
(`compactPlanner`, `compactRunner`) are reset in the task's stop override. The craft-compact e2e
drives the runner directly (the planner's step, the runner's craft, then `!unload` moves the blocks)
until AV's call lands.

## What the panel can offer next (docs/panel.md)

A `Craft...` entry on an inventory cell: `RecipeIndex.byOutput` lists what the item makes (and
`canCraft` what the bot can make now, with the shortfall), the entry sends `!craft <item> <n>` through
`POST /api/cmd` like every other action; a `Compact` quick button sends `!compact`. No new API.

## Truth commands

| Command | Reply |
|---|---|
| `kit playerName [typeId:count ...]` | `{name, given: {typeId: count}}`: clears the inventory and the worn armour, then gives each item (several stacks when needed) |
| `craftinv playerName` | `{name, counts: {typeId: n}, stacks, free}` (names without the namespace) |
| `table x y z [remove]` | `{x, y, z, typeId}`: a crafting table at the block (or air) |

## Tests

```sh
pnpm --filter bot exec vitest run --project unit craft-                                   # recipes, compaction, the crafter on a fake server, the commands
node scripts/bds.mjs --profile craft up && node scripts/bds.mjs --profile craft pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e craft- --silent=false           # ~1.5 min
```

Env: `CRAFT_BDS_HOST` (127.0.0.1), `CRAFT_BDS_PORT` (19208), `CRAFT_BDS_CONTAINER` (bds-craft),
`CRAFT_VERBOSE=1`. Every run uses its own random 128-block cell from x, z = 12288.

- `craft-basic`: 8 oak logs -> `!craft oak_planks 32` -> 32 planks, `!craft stick 16` -> 16 sticks and
  24 planks (truth); 36 ingots + a carried table -> `!craft iron_block 4` -> 4 blocks, the table back in
  the inventory and none standing within 3 blocks (truth); `!craft iron_block 100` with 9 ingots -> the
  start line names the 891 short and 1 block is made; a diamond pickaxe -> `!craft diamond_block`
  refused; `!craft elytra` no recipe; the usage line.
- `craft-compact`: 45 raw iron + a carried table -> `!compact` -> 5 raw iron blocks; home set, a chest
  with 26 stacks of raw iron (1 free slot) and a table standing 2 blocks away, 27 raw iron carried ->
  `!chests clear`, `!chests scan`; `planUnload` carries `compact: [{ raw_iron, 27 }]`; the installed
  `compactRunner` answers `compacted 27 raw_iron into 3 raw_iron_block` (truth: 3 blocks, 0 raw iron);
  `!unload` -> `unloaded: 3 raw_iron_block -> chest ...`, inventory empty, the chest holds 1664 raw
  iron + 3 blocks, the standing table stays; a chest with room -> no step, 18 raw iron unloaded as they
  are; `compactOnUnload off` -> no step, 27 raw iron into the last slot.
- Unit: the index on a recorded fixture (37 shaped + 6 shapeless recipes of interest), grid rules,
  tags, plans, keep rules and the reserve; the compaction table and the unload hook (planUnload's
  `compact` field, the runner); the crafter against a fake server that enforces the measured rules
  (the wire type 12, the output stack id = the request id, 35 for a wrong grid or pattern, a `drop`
  from the grid, grid items destroyed on close, atomic requests): request shapes, shaped recipes with
  a hole (chest, furnace), batching, model = server and nothing destroyed after every run, a craft
  refused with 17 / 3 / 49 / 35 (retried once), a refused fill, a fill or craft without an answer
  (late and never), a refused give-back (cell by cell, then dropped), a full inventory (nothing moves)
  and a stack the fill empties, the table placed / opened / dug / left and retried, a table behind a
  wall (walked to), cancel; the commands, the process (pause, resume, stop), the settings, the NL step.

## Open points

- `craft_recipe_auto` (the recipe book's one-request craft) cannot be sent with minecraft-data
  3.117.0's definition (the server calls it malformed); the manual grid path costs one extra request
  per batch and is what the vanilla UI does anyway. The mapping fix (two bundle actions at 7 / 8,
  everything after shifted) belongs in `patches/minecraft-data@3.117.0.patch` (the TODO at
  `CRAFT_RECIPE_WIRE_TYPE`); with it the constant and `type_id: 'craft_recipe'` agree and the auto
  path / `craft_results_deprecated` become sendable.
- The `compact` step is executed by Track AV's unload job through `compactRunner`; until that call
  lands, `!unload` moves items without compacting (the planner still marks the step).
- The compaction decision reads the chest memory; a chest emptied since its last read (within the 10
  minute freshness window) still counts as full until `!chests clear` or the next read, so the bot
  may compact when it did not need to (harmless: storage blocks) or skip a compaction for a chest
  filled since (the unload then reports the overflow as before).
- The table is placed on a cell next to the feet whose support is not a built block, so on a
  fully built floor (planks, stone bricks) with no table within reach the 3 x 3 craft answers
  `no_table`; the home usually has a table standing.
- Recipes whose ingredients carry an aux value in the name (`minecraft:coal:0`) are matched by name
  only (charcoal has its own recipe id); shulker-box dye recipes, smithing (netherite upgrades) and
  the furnace (docs/food.md) are not crafting here.
- Not measured on a Realm: the request round trip there is the RakNet latency plus the tick; the
  shapes do not change.
