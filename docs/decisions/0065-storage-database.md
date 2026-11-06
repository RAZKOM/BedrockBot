# 0065: Storage as a database: one pure index over what the bot knows, a ranked search, a pushed summary, actions as visible commands

Date: 2026-11-06. Status: accepted (web panel programme, step 3, Track P3). It builds on
[0026](0026-lan-control-panel.md), [0059](0059-event-store.md), [0061](0061-panel-push-and-modules.md)
and [0062](0062-map-screen.md). Details are in [../storage.md](../storage.md) (index, search, groups and
aliases, wire, view, actions, recipes, checklist), [../panel.md](../panel.md) and
[../home.md](../home.md).

## Context

The bot already remembers every container it has opened. The chest memory keeps one file per
dimension, with the contents, the full shulker boxes inside and when each was read. It also knows what
it carries, its shulker boxes included. That knowledge only reached the owner through `!stock <item>`
(one item, chat-sized) and the panel's chest list (a table of counts). Neither answers "where are my
diamonds", "how much iron do I have in all" or "what is stale". Neither can start a delivery from the
answer either.

Step 3 of the programme asked for these:

- **One index** over every container, every dimension and the carried items, with freshness.
- **A search** that understands what the owner types (plurals, common words, groups) and ranks.
- **An API and a pushed topic.**
- **A view beside Map and Cards**, phone first.
- **Actions** that cannot surprise the owner: bring n to me or home, show on the map, and a Bring entry
  in the map's chest sheet.
- **Recent changes** from the event store.

`!stock` had to keep its replies.

## Decision

### 1. One pure index next to the chest memory's readers

`skills/home/storage.ts` builds the index from the memory per dimension, the carried stacks, home, the
bot and now. It has no bot state and no I/O, so it is tested without a bot. It lives in `skills/home`
because both the chat command and the panel read it, and `skills/` never imports the panel.

The counting `!stock` did (partners left out, loose plus boxed, the query matching) moved to
`skills/home/stock.ts`. `stockLine` now only words the reply, and the index counts the same way, so the
chat and the panel cannot disagree. A unit test pins it. The split also breaks what would have been an
import cycle: memory, storage, categories, stash, boxing, memory.

A container is **never opened** when it was found but not read, and **stale** when read over 24 h ago.
Both are counted apart, so the view can offer `!chests scan`. Distances are only given within the same
dimension. Home has no dimension and is taken as the overworld.

### 2. A ranked search with groups from metadata and a small guarded alias table

A query is parsed into words, the name and its singular forms. It is scored in order: exact item,
alias member, group member, prefix, words of the name or of the game's display name (minecraft-data's
item registry, so `steak` finds `cooked_beef`), typing prefixes, substring. Ties go to what the bot has
most of.

Groups come from metadata wherever it exists: the unloader's categories, the survival durability and
armour tables, name patterns over the registry, the shulker names. A word with no metadata goes in a
small alias table. Both are listed in docs/storage.md as tables generated from the registries. A guard
fails until the doc matches, every group matches real items, every alias names real items, and no word
is used twice.

There are no Bedrock item tags in minecraft-data, and no new dependency was wanted. Hand-written lists
are kept to the alias table.

### 3. One owner for the wire; a summary topic, the details fetched

`health/panel/storage.ts` (`StorageLive`) owns `GET /api/storage`, `/api/storage/search` and
`/api/storage/container`, and the `storage` state topic.

The topic carries a bounded summary:

- counts, freshness and slots;
- each category's top 4;
- the 5 fullest containers;
- the 8 newest changes;
- `me`, who panel commands run as.

Its size does not grow with the number of containers: 2.8 KB on a 512-container worst case. A deposit
is a delta of about 1.8 KB.

The search and the full overview are fetched. A search answer depends on the query, and the overview
grows with the memory (120 KB at 512 containers). Neither belongs on a stream every page receives.

The topic changes on three things:

- `ChestMemory.onChange`: one small optional hook on the memory, called on `set` and on a real
  `delete`;
- the inventory's window-0 changes;
- container events.

It refreshes 400 ms after a change, so an unload run is one delta, not one per chest. The memory can be
replaced (the world cache opening late), so the watch re-subscribes when its identity changes.

### 4. Recent changes are the event store's container events, read-only

Every deposit and withdrawal the bot makes is already a `container.*` event
([0059](0059-event-store.md)). The newest 200 are read at start and then followed live. Nothing new is
recorded and nothing is written.

### 5. The third view, the same switch

`client/views.ts` becomes the one view switch. Any element with `data-goview` switches, the choice is
kept in `bbpanel-view`, and the `<head>` script applies it before the first paint (now with three
values). The map's own switch moved there. A view's module hears every switch, and the storage view
joins its topic the first time it shows, like the map.

### 6. Actions are visible chat commands; `!bring` picks its own source

Each action is one chat command (`STORAGE_ACTIONS` in `client/storedefs.ts`) posted through
`POST /api/cmd` after the exact command is shown and Send is tapped:

- Bring: `!bring <item> <n> [home]`;
- Read them now: `!chests scan`.

Show on map is local. One Bring picker serves the view and the map's chest sheet. A guard checks that
every command is registered and that the built commands parse as `!bring` arguments.

"To me" means the player panel commands run as: the first owner name, else the console, which sends
the items home. The picker names that target.

`!bring` chooses where to take from with its own planner, and this step does not change the planner.
The picker says so instead of pretending to take from the tapped chest. A `from x y z` argument is a
follow-up.

## Consequences

- One more topic, three routes, four browser modules and two markup blocks. The page budgets were
  raised with the reasons written in `budgets.ts` and [../panel.md](../panel.md) "Budgets":
  - `html` from 120 000 to 128 000 (121.6 KB measured);
  - `modules` from 170 000 to 200 000 (184 KB raw, 61 KB gzip).
- `ChestMemoryStore` gains two optional methods (`onChange`, `byDimension`). Other stores keep working:
  without them the index reads `all()` for the bot's dimension, and nothing is pushed on a memory
  change.
- `!stock` and the bring and unload planners behave exactly as before.
- Out of scope: the job queue (step 4), the timeline and notifications (step 5), and choosing the source
  of a bring.
