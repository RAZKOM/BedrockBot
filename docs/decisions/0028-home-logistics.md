# 0028: Home logistics: chest memory, a decision table for unloading, spare shulker boxes

Date: 2026-10-29. Status: accepted (PLAN.md Phase 7 wave 9, Track AG).
Server: BDS 1.26.60.6 (`bds-home`, flat, peaceful). Details and numbers: [../home.md](../home.md).

## Context

The owner asked for the bot to "auto know the chests at home within a radius", look inside them,
"make a decision of where to unload its stuff", and use "a chest of like empty shulkers ... in case a
chest fills up of regular item stacks". Until now a job's produce went to one configured chest
(`--chest`, `stashChest`) or stayed in the inventory; the bot had no idea what any chest held. Track AD
(0025) left two open points this track depends on: the item_stack_request slot type per window
(shulker boxes `shulker`, barrels probably `barrel`), and the shulker box names being added to the
chest skill at load time from stash.ts.

## Decisions

1. **A chest memory, persisted beside the world cache.** One record per container block (chest,
   trapped chest, barrel, shulker box) within `homeChestRadius` (16) of home: position, kind, owner
   label, size, free slots, contents by name, room on partial stacks, empty / full shulker boxes, double
   chest partner, read time. It is a sidecar of the world cache directory (`chests.json` per dimension,
   flushed with the cache, like Track AF's herd marks), so it survives restarts and never mixes
   servers; without a cache it lives in memory. Every container the bot opens for any home job
   refreshes its record.

2. **Discovery from the world model plus the cache's marks.** Loaded columns are searched block by
   block, unloaded ones through the cache's marks; shulker boxes became marks (one line in
   `isInteresting`). Scans run on `!chests scan`, once per session when the bot first stands within 8
   blocks of home, and for a container that appears within the radius (a block update); a disappeared
   one is forgotten without a walk. Containers read in the last 10 minutes are not opened again. A
   window of 54 slots is a double chest: one record, the other half its `partner`.

3. **A pure decision table.** `planUnload` maps the inventory and the memory to (slot, count, chest)
   moves: (1) a chest that holds the item (most first), (2) a chest whose label names the item's
   category or the item, (3) the emptiest unlabelled chest; full chests are skipped, stacks split as
   chests fill. Never unloaded: what `!drop items` keeps (food, tools, armour, totems, ender chests),
   16 throwaway blocks, one empty shulker box. The executor walks to the nearest chest with moves,
   opens it, plans again with what it really holds, deposits, and repeats, so a stale memory costs one
   wasted trip, not a wrong deposit.

4. **Spare shulker boxes from the box chest.** When items are left and every chest is full, the bot
   takes an empty box from the chest holding the most boxes, places it next to itself (Track AD's
   `boxSpots`), fills it, breaks it, picks it up and stores the full box back (the slot it came from is
   reserved for it in the plan). `!unload all` empties full boxes it carries first.

5. **Slot types per window, set by the opener.** Every container opens as window_type `container`,
   but the request's `container_id` depends on the block: chests `container`, barrels `barrel`
   (verified: `container` is refused with status 50), shulker boxes `shulker`. `Containers.setSlotType`
   keeps it per open window and the chest skill sets it from the block it clicked; the stash step's
   switch of the Containers' private option is gone, and the shulker box names live in the chest skill.

6. **Model fixes found on the way.** A whole stack moved into an empty slot keeps its wire item (the
   NBT that says a shulker box is full), an ok response keeps it too, a refused request no longer
   undoes a slot the server rewrote meanwhile, and an ok response refills a slot it filled that
   another request's rollback emptied: the e2e caught the survival keeper's hotbar restock racing the
   box take and pickup and wiping a full box (or the kept cobblestone) from the model.

7. **Processes: a user job and a chore.** `!unload` and `!chests scan` are user processes (40); the
   automatic scans and unloads are one auto process at chore priority (30), only with no user process
   and the bot within 8 blocks of home. `autoUnload` (default on) unloads above 8 stacks of unloadable
   items or with a full box; a `!get` job that ends at home is followed by an unload whose line goes to
   chat. Both run on one `HomeLogistics` that serialises jobs.

## Consequences

- The owner can label chests (`!chests label x y z ores`) and ask `!stock coal` without the bot
  walking anywhere; the answers are as fresh as the last visit (shown as minutes in `!chests`).
- With `autoUnload` on, a bot that comes home loaded empties itself into the chests by itself; on the
  Realm the first scan of a session walks to every container near home once.
- Two chests set by commands do not pair in Bedrock; the e2e builds its double chest with the bot.
- Open: an ender chest step, a box pre-empted while placed stays standing (and is then read as a
  container at home), and with `all` the placer may pick a same-coloured empty box from the hotbar
  instead of the full one in the main inventory.
