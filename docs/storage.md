# Storage as a database

The control panel ([panel.md](panel.md)) has a third view beside the map ([map.md](map.md)) and the
cards: **Storage**. It answers "what do I have and where is it" from what the bot already knows, with
no new scanning. That means every container in the chest memory (all dimensions, the shulker boxes
inside them included) plus what the bot carries (its shulker boxes included). Search as you type,
see the totals by category, see what is stale, and bring things with one confirmed `!bring`.
Decision: [decisions/0065](decisions/0065-storage-database.md).

Home logistics ([home.md](home.md)) fill the chest memory: the unloader, `!chests scan`, and every
container the bot opens. `!stock` answers in chat from the same counting (below), so the chat and the
panel never disagree.

## The index

`bot/src/skills/home/storage.ts` (`buildStorageIndex`, `StorageIndex`) is pure: the same input gives
the same answer, with no bot state and no I/O. Its input:

- the chest memory per dimension (`ChestMemory.byDimension()`: dims 0, 1 and 2, plus any other that
  was loaded);
- what the bot carries (inventory slots 0 to 35). A carried shulker box adds its contents, read from
  the wire item's NBT, the same reading the inventory card uses;
- home (taken as the overworld: the home point has no dimension) and the bot's position and dimension;
- now, and the stale age (`STALE_MS`, 24 h).

What it answers:

| Question | Method | Notes |
|---|---|---|
| totals per item | `items` | `total = loose + boxed + carried`; `places` = containers holding some |
| where an item is | `where(name)` | the bot first (it is at hand), then containers by count, nearest home first on a tie; each place has `count`, `loose`, `boxed` (inside its full shulker boxes), `readAt`, `distHome`, `distBot` (same dimension only, else null), `unreachable` |
| totals per category | `categories()` | the unloader's categories (`categories.ts`), biggest first |
| containers by fullness | `byFullness()` | slots used / size, read containers only |
| freshness | `freshness` | `known`, `read`, `never` (found but never opened), `stale` (read over 24 h ago), `unreachable`, oldest / newest read, per dimension |
| one container | `container(dim, pos)` | with its record (slots, boxes, per-box contents) |

The second half of a double chest is never a container of its own (`partnerKeys`). The record that
names a partner counts, and the partner does not.

**Shared with `!stock`.** `skills/home/stock.ts` holds the counting: `partnerKeys`, `itemQuery`,
`itemMatches`, `stockRecords`, `stockTotals` and `stockHits`. `memory.ts` `stockLine` only words the
reply, and the index counts loose plus boxed the same way. The unit test "agrees with !stock" checks
that the totals are equal. `!stock`'s replies and its tests did not change.

## Search

`bot/src/skills/home/search.ts` (`searchStorage`) takes a query the way the owner would type it:

- item names (`diamond`, `iron_ingot`, `minecraft:coal`);
- readable names (`iron ingot`), and the game's own display names from the item registry
  (minecraft-data `bedrock_1.26.51`, the same data as `maxStackOf`): `steak` finds `cooked_beef`;
- plurals: `diamonds`, `torches`, `berries`;
- common words, through groups (below) and a small alias table (below).

Ranking, then by how many the bot has:

| Score | Rule | Example |
|---|---|---|
| 100 | the exact item (any singular form) | `diamonds` -> diamond |
| 90 | an alias member, in the alias order | `iron` -> iron_ingot, raw_iron, ... |
| 80 | a group member | `ores`, `logs`, `food`, `tools`, `armour`, `shulker` |
| 60 | the name starts with the query | `diam` -> diamond |
| 50 | every word is a word of the name or of its display name | `iron` -> iron_sword |
| 35 | every word starts a word of the name | `pick` -> diamond_pickaxe |
| 20 | the query is inside the name | `ak_lo` -> stripped_oak_log |

An answer lists at most 12 items (`more` counts the rest), each with at most 8 places (`morePlaces`).
When the query names one real item exactly and none is known, `none` names it, and the page says
"no emerald in the 4 containers I know (!get emerald makes new ones)". A query that names a group also
returns the group's total and number of kinds.

### Groups

Groups come from metadata wherever it exists: the unloader's categories, the survival tables
(durability, armour slots) and name patterns over the item registry. The table is generated from
`STORAGE_GROUPS`. The guard test compares it with this file and fails until it matches (it prints the
table to paste). "registry items" is how many items of the registry each group matches.

<!-- storage:groups -->
| group | words | from | members | registry items |
|---|---|---|---|---|
| `ores` | `ore` `ores` `mineral` `minerals` `metal` `metals` `gem` `gems` `ingot` `ingots` | categories | ores, raw metals, ingots, gems, coal, redstone, lapis, quartz and their blocks (the unloader's `ores` category) | 50 |
| `wood` | `wood` `woods` `timber` `lumber` | categories | logs, wood, planks, stems, hyphae, saplings, sticks (the `wood` category) | 69 |
| `logs` | `log` `logs` `stem` `stems` | name pattern | every `_log` and `_stem`, stripped ones too | 25 |
| `planks` | `plank` `planks` `board` `boards` | name pattern | every `_planks` | 12 |
| `food` | `food` `foods` `meat` `crop` `crops` | categories | real food, crops, seeds, eggs (the `food` category: the eater's food table) | 39 |
| `blocks` | `block` `blocks` `building` | categories | stone-like and building blocks (the `blocks` category) | 116 |
| `tools` | `tool` `tools` `weapon` `weapons` `gear` | survival tables | anything with durability that is not armour (the survival kit's durability table) | 42 |
| `armour` | `armour` `armor` `armours` `armors` | survival tables | helmets, chestplates, leggings, boots, the elytra (the armour table) | 25 |
| `shulker` | `shulker` `shulkers` `box` `boxes` | shulker names | every shulker box colour | 18 |
| `junk` | `junk` `trash` `drops` | categories | what the stash step drops (the `junk` category) | 26 |
| `wool` | `wool` `wools` | name pattern | every `_wool` | 16 |
<!-- /storage:groups -->

### Aliases

Aliases are for words that have no metadata behind them: the word maps to the items it means, most
likely first. Every name must be a real item, and the guard test checks that. The table is generated
from `STORAGE_ALIASES`.

<!-- storage:aliases -->
| word | items, most likely first |
|---|---|
| `iron` | `iron_ingot`, `raw_iron`, `iron_block`, `iron_nugget`, `raw_iron_block` |
| `gold` | `gold_ingot`, `raw_gold`, `gold_block`, `gold_nugget`, `raw_gold_block` |
| `copper` | `copper_ingot`, `raw_copper`, `copper_block`, `raw_copper_block` |
| `netherite` | `netherite_ingot`, `netherite_scrap`, `ancient_debris`, `netherite_block` |
| `coal` | `coal`, `charcoal`, `coal_block` |
| `lapis` | `lapis_lazuli`, `lapis_block` |
| `redstone` | `redstone`, `redstone_block` |
| `quartz` | `quartz`, `quartz_block` |
| `stone` | `cobblestone`, `stone`, `cobbled_deepslate`, `deepslate`, `smooth_stone` |
| `cobble` | `cobblestone`, `cobbled_deepslate` |
| `seeds` | `wheat_seeds`, `beetroot_seeds`, `pumpkin_seeds`, `melon_seeds` |
| `pearl` | `ender_pearl` |
| `pearls` | `ender_pearl` |
| `rocket` | `firework_rocket` |
| `rockets` | `firework_rocket` |
| `fireworks` | `firework_rocket` |
| `steak` | `cooked_beef` |
<!-- /storage:aliases -->

## Wire

`bot/src/health/panel/storage.ts` (`StorageLive`) owns the storage wire. Every route sits behind the
panel token like the rest of `/api/`. Other methods get 405.

| Request | Answer |
|---|---|
| `GET /api/storage` | `StorageOverview`: the summary (below), every category with all its items, every read container by fullness, the never-opened ones |
| `GET /api/storage/search?q=diamonds` | `StorageSearchAnswer`: `searchStorage`'s answer plus `recent[item]`, its last 5 deposits and withdrawals; `q` is cut to 64 characters |
| `GET /api/storage/container?x=&y=&z=&dim=0` | `StorageContainerAnswer`: one container as remembered (counts by item, inside boxes, per box, the partner); 400 for a non-integer, 404 when none is remembered there |

**Topic `storage`** (state, on `/api/stream`). The value is `StorageSummary`:

- `rev`, `staleMs`;
- `me`: who a panel command runs as (the first owner name, else null for the console);
- `containers`: the freshness counts plus slots used / size;
- `totals`;
- each category with its top 4;
- the 5 fullest containers;
- the 8 newest changes.

The topic refreshes 400 ms after a change (`REFRESH_MS`), so a burst of changes is one delta. A change
is any of:

- the chest memory changing: `ChestMemory.onChange`, on every `set` and every real `delete`, in any
  dimension;
- the bot's inventory changing (window 0);
- a `container.deposit` / `container.withdraw` event arriving.

The topic is also sampled every 5 s while a stream listens, because the stale count moves with time
alone. A rebuilt chest memory, such as the world cache opening late, is followed: the watch
re-subscribes when the memory or the inventory changes identity.

**Recent changes.** These come from the event store ([events.md](events.md)): `container.deposit` and
`container.withdraw`. The newest 200 are read once at start (`events.query`) and then followed live
(`events.subscribe`). The view is read-only: the event store already records every deposit and
withdrawal the bot makes, so nothing new is written.

## The view

`client/storage.ts`, phone first (360 px up):

- **Search** on top. Results come as you type (200 ms after the last key). Each result shows:
  - the item's icon (when the server has icons) and its total, with how many are carried;
  - every place with its count, flagged "in a shulker box", "read 3 min ago", "12 blocks from home"
    and any unreachable reason;
  - the item's last deposits and withdrawals;
  - **Bring...**, and **Map** on each container line.
- **Containers**: known, read, never opened, stale, unreachable, slots used, carried. When any are
  never opened or stale, **Read them now (`!chests scan`)** appears, with a confirm.
- **Totals by category**: a button per category that searches its group.
- **Recently changed**: the newest deposits and withdrawals.

Switching views works as for the map: one switch (`client/views.ts`). Every element with
`data-goview` switches, and the choice is kept in `localStorage` `bbpanel-view`. The `<head>` script
applies it before the first paint. Buttons: **Storage** in the cards' header and in the map's
controls; **Map** and **Cards** in the storage header. The view joins the `storage` topic the first
time it shows. Without a stream it fetches `GET /api/storage` every 10 s while it shows.

## Actions

Every action that changes anything is one chat command through `POST /api/cmd`, like every panel
action. The page shows the exact command, one tap on **Send** posts it, and the reply shows under it.
The table is generated from `STORAGE_ACTIONS` (`client/storedefs.ts`), and the guard test checks that
every command is registered.

<!-- storage:actions -->
| action | button | command | what it does |
|---|---|---|---|
| `bring` | Bring | `!bring` | the bot takes n of the item out of the chests (its planner picks them: nearest first, loose before boxes) and brings it to the player the panel runs as |
| `bring-home` | Bring home | `!bring` | the same, but the bot carries it to the home point |
| `scan` | Read them now | `!chests scan` | walks to every container within homeChestRadius of home not read in the last 10 minutes (the never-opened and stale ones included) and looks inside |
| `map` | Show on map | none (local) | local: switches to the map, centres it on the container and highlights it |
<!-- /storage:actions -->

**Bring...** (`client/bring.ts`) is one picker shared by the storage view and the map's chest sheet.

- **How many**: quick picks 1, 16, 64, a stack (when the stack size is not one of those) and all (up
  to 2 304, the `!bring` limit), or any number.
- **Where to**: "to <player>" or home. The command is `!bring <item> <n>` or `!bring <item> <n> home`.
- **Who "me" is**: panel commands run as the first owner name (`chat.owners.names[0]`, the summary's
  `me`). The picker says "to <name>", and the items go to that player when online, else home. With no
  owner configured the panel runs as the console, which has no position, so the picker says "to me
  (home)".
- **The source**: `!bring` takes from the chests its own planner picks (nearest first, loose stacks
  before boxes), not from a chosen chest. The picker says so. Choosing the source chest is a
  follow-up (below).
- Send is off while the bot is not spawned, like every action.

**Show on map** switches to the map, turns follow off, centres on the container and zooms in to at
least 6 px per block. It draws a ring for 12 s (`HIGHLIGHT_MS`). A container in another dimension
gives a toast, because the map shows the bot's dimension.

**The map's chest sheet**: a tap next to a remembered chest with contents adds **Bring...**. It opens
the picker with what that chest holds (from `/api/marks`), and its note names the chest.

## Files

| File | What |
|---|---|
| `skills/home/stock.ts` | the counting shared by `!stock` and the index |
| `skills/home/storage.ts` | the index (`buildStorageIndex`, `StorageIndex`, `STALE_MS`, `storageKey`) |
| `skills/home/search.ts` | the search (`searchStorage`, `scoreItem`, `parseQuery`), `STORAGE_GROUPS`, `STORAGE_ALIASES`, the item registry, the generated tables |
| `world/cache/chests.ts` | the hook: `ChestMemory.onChange`, `ChestMemory.byDimension` (both optional on `ChestMemoryStore`) |
| `health/panel/storage.ts` | `StorageLive`: the routes, the `storage` topic, the recent changes, `carriedOf`, `changeOf` |
| `health/panel/index.ts` | wires `StorageLive` (memory: the running home control's, else the world cache's; home; bot; `runAs`) |
| `health/panel/client/storage.ts`, `bring.ts`, `storedefs.ts`, `views.ts` | the view, the Bring picker, the actions as data, the view switch |
| `health/panel/page.ts` | `storageScreenHtml`, `bringSheetHtml`, the CSS, `VIEW_BOOT` with three views |
| `health/panel/budgets.ts` | `storage`, `storageDelta`, `storageSearch`, `storageFetch` |

## Recipes

### Add a search group

1. Add an entry to `STORAGE_GROUPS` in `skills/home/search.ts`: an `id`, the `words` that name it
   (singular and plural, lower case, not already a group word or an alias), the `doc` line, the
   `source`, and `match(name)`. Prefer metadata (a category, a survival table, a name pattern) to a
   list.
2. Run `pnpm --filter bot exec vitest run --project unit test/unit/health/storage-guards.test.ts`. It
   fails and prints the new groups table; paste it between the `storage:groups` markers above.
3. The guard also checks that the group matches at least one registry item and that its words are
   unique. Add a line to the search test in `test/unit/skills/home-storage.test.ts` if the group
   should find something specific.

A word with no metadata behind it goes in `STORAGE_ALIASES` instead: word to items, most likely first,
every name a real item. Then paste the aliases table the same way.

### Add a storage action

1. Add it to `STORAGE_ACTIONS` in `client/storedefs.ts`, with its chat command words (or `''` for a
   local action) and its `doc`. Build the command with a pure helper in the same file, such as
   `bringCommand`.
2. Wire the button in `client/storage.ts` (or `bring.ts`). It must show the exact command first and
   send only on **Send**, through `page.send(cmd, true)`.
3. Run the guard test and paste the actions table between the `storage:actions` markers. The guard
   checks that the command is registered (a subcommand must be in that command's help) and that this
   file names it.
4. Add a page test in `test/unit/health/panel-storage-page.test.ts`: the command shown, nothing posted
   before Send, the reply shown.

## Reviewer checklist

- [ ] Counting changes go in `stock.ts`, so `!stock` and the index stay equal; `!stock`'s replies and
      tests do not change.
- [ ] The index stays pure (no bot state, no I/O) and reads only what the bot already knows: no new
      scanning, no container opened by the panel.
- [ ] A new group or alias is in the generated tables here, resolves to real items, and does not
      reuse a word.
- [ ] A new action is in `STORAGE_ACTIONS` and in the table here, sends one registered chat command
      through `POST /api/cmd`, and shows the exact command before Send.
- [ ] `!bring`'s planner is unchanged; the view never claims to choose the source chest.
- [ ] Budgets (`storage`, `storageDelta`, `storageSearch`, `storageFetch`, and `html` / `modules` for
      the page) hold in `panel-storage.test.ts` and `panel-budgets.test.ts`. A raise comes with the
      reason in `budgets.ts` and [panel.md](panel.md) "Budgets".
- [ ] Browser modules import only `./x.ts` and `../shared.ts`; `shared.ts` gets only `export type` and
      constants.
- [ ] A new `!set` setting is in `SETTING_GROUPS` (`chat/help.ts`).

## Tests

- Unit:
  - `test/unit/skills/home-storage.test.ts`: the index (totals, carried boxes, where, freshness,
    partners, categories, fullness, agreement with `!stock`), the search (plurals, the brief's
    words, ranking, none, limits, display names) and the chest memory hooks;
  - `test/unit/health/panel-storage.test.ts`: the routes over HTTP, the topic's snapshot and deltas
    after a memory, inventory or event change, a burst as one refresh, the stored events read at
    start, a replaced memory followed, and the budgets on a 512-container worst case;
  - `test/unit/health/panel-storage-page.test.ts`: the view on the fake DOM (the switch, the topic,
    search as you type, Bring with the exact command, Show on map, the scan's confirm, the poll
    without a stream, the map chest's Bring...);
  - `test/unit/health/storage-guards.test.ts`: commands registered, the Bring commands parse as
    `!bring` arguments, the three tables equal the registries, groups and aliases resolve.
- E2E `test/e2e/panel-storage.test.ts` on bds-home: the truth pack fills two chests (one with a
  shulker box of diamonds) and the bot reads them. Then it checks:
  - search "diamonds" finds both places with the right counts (the box flagged), and the totals
    match;
  - a bot deposit shows on the stream and in "recently changed";
  - Bring 2 from the view's command delivers;
  - `!stock` replies unchanged.

## Measured

Unit worst case: 512 containers, every slot a different registry item, a box in each
(`PANEL_MEASURE=1 pnpm --filter bot exec vitest run --project unit test/unit/health/panel-storage.test.ts --silent=false`).

| Piece | Budget | Worst case | Live (bds-home, 2 chests) |
|---|---|---|---|
| `storage` snapshot | 8 000 | 2 785 | 793 |
| `storage` delta after a deposit | 3 000 | 1 807 | 284 and 448 |
| a search answer | 32 000 | 23 103 (`o`: 12 items, 8 places each) | 637 (`diamonds`) |
| `GET /api/storage` | 160 000 | 120 457 | 1 037 |

Live, from [panel.md](panel.md) "Measured (decision 0065)":

- `!chests scan` to both chests indexed: 4.3 s;
- `!unload` to the deposit on the topic: 0.9 s;
- `!bring diamond 2` to the player: 4.5 to 4.7 s.

## Follow-ups

- **Bring from a chosen chest.** `!bring` picks its own source. A `from x y z` argument for `!bring`
  (a planner change) would let the map's chest sheet and the view's container lines take from that
  container.
- The job queue (panel step 4) and the timeline and notifications (step 5) are out of scope here.
- Home has no dimension, so it is taken as the overworld. A home in the nether would show distances
  only from the bot.
