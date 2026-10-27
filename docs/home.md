# Home logistics: chest memory, `!unload`, spare shulker boxes (wave 9, Track AG)

The owner's idea: "it would be cool for it to auto know the chests at home within a radius so maybe
it goes in and finds items in chests, and then makes a decision of where to unload its stuff. If it
finds a chest of like empty shulkers it can also use those in case a chest fills up of regular item
stacks". The bot now finds the containers around home, remembers what they hold, decides where each
stack it carries goes, and fills spare shulker boxes when the chests are full.
Decision record: [decisions/0028-home-logistics.md](decisions/0028-home-logistics.md).

## Files

| Path | What |
|---|---|
| `bot/src/skills/home/discovery.ts` | `findContainers` (World.find over loaded columns plus the world cache's marks), `chestNeighbours` (double chest halves), `visitOrder` |
| `bot/src/skills/home/unloader.ts` | `planUnload`: the decision table, pure; `unloadableStacks` (the chore's trigger) |
| `bot/src/skills/home/categories.ts` | item categories and label matching (`ores`, `wood`, `food`, `blocks`, `junk`, `tools`) |
| `bot/src/skills/home/memory.ts` | snapshot -> record, records -> unloader targets, the `!chests` / `!stock` lines |
| `bot/src/skills/home/logistics.ts` | `HomeLogistics`: the scan and unload jobs (walk, open, snapshot, deposit, spare boxes), serialised |
| `bot/src/world/cache/chests.ts` | `ChestMemory`: the per-server chest memory, a sidecar of the world cache (`chests.json`) |
| `bot/src/tasks/process/unload.ts` | `HomeJobProcess` (user: `!unload`, `!chests scan`), `HomeChore` (auto, PRIORITY.chore) |
| `bot/src/chat/commands-home.ts` | `!unload`, `!stock`, `!chests`; wiring of the chore, the block-update trigger, the `!get` hook |
| `bot/src/skills/container/chest.ts` | slot type per block kind, `snapshot` / `snapshotOf`, `depositSlots`, `take`, the shulker box names and NBT readers (moved here from stash.ts) |
| `bot/src/world/containers.ts` | `setSlotType` / `slotTypeOf`: the item_stack_request slot type per open window; a whole stack moved into an empty slot keeps its wire item (NBT) |
| `bot/src/config/settings.ts` | `homeChestRadius` (number, 16, 2..48), `autoUnload` (boolean, on) |
| `packs/truth/src/home.ts` | `truth:chestput` (fill a container block); reading one is `truth:container` |
| `bot/test/unit/skills/home-*.test.ts`, `bot/test/unit/cache/chests.test.ts`, `bot/test/unit/chat/home-commands.test.ts` | unit tests on fakes |
| `bot/test/e2e/home-chests.test.ts`, `home-shulker.test.ts`, `home-truth.ts` | e2e on bds-home |
| `docker/compose.home.yml` | `bds-home`, udp/19196, flat, peaceful |

## Commands (owner only, afk task with walking)

| Command | Reply |
|---|---|
| `!unload [all]` | `unloading 8 stacks into 5 known containers`, then `unloaded: 176 cobblestone -> double chest -3 -60 -1, 32 dirt -> barrel 0 -60 -4, 128 coal -> chest 3 -60 -2, 128 oak_log -> chest 3 -60 2 (wood); kept 16 cobblestone, 1 iron_pickaxe, 5 bread`; with full chests `unloaded: 1904 cobblestone -> shulker box (into chest -3 -60 3); 2 shulker boxes filled and stored; kept ...`; `unload: no home set (!home set)`, `unload: I know no chest near home yet (!chests scan)`; `left 5 dirt (no room)` when nothing had room |
| `!stock [item]` | `iron_ingot: 128 in chest 100 63 -48 (ores), 64 in barrel 90 63 -48 (192 in all)`; `!stock shulker`: `shulker_box: 3 in chest 1 2 3 (3 empty)`; no item: the totals; `stock: no diamond in the 5 containers I know` |
| `!chests` | `chests: 5 remembered: chest 3 -60 2 (wood): 26/27 free, 32 oak_log (0 min ago) \| double chest -3 -60 -1: 54/54 free, empty (0 min ago) \| ...` |
| `!chests scan` | `chests: reading the containers within 16 blocks of home`, then `chests: read 5 of 6 containers within the radius in 6.0 s` (blocks found: a double chest is two; `2 read less than 10 min ago`, `1 forgotten`, `could not open 1 2 3 (open: timeout)` when so) |
| `!chests label x y z <text>` / `none` | `chests: chest 3 -60 2 (wood) labelled`; up to 32 characters |

`!unload` and `!chests scan` are user processes (priority 40): `!stop` ends them, flee / guard /
night pre-empt them and the job runs again from a fresh plan when it resumes. `all` empties the full
shulker boxes carried first (placed, opened, emptied into the inventory, broken, picked up) and then
unloads their items like the rest.

## Discovery

- Where: every chest, trapped chest, barrel and shulker box block within `homeChestRadius` (default
  16, a sphere around the home block's centre). Loaded columns are searched block by block
  (World.find without a class: ~110 k blocks for r = 16, done only when a scan runs); unloaded columns
  through the world cache's marks (chests, trapped chests and barrels were marks already; shulker
  boxes are marks since this track, `isInteresting` in world/cache/classes.ts).
- When: `!chests scan`; automatically (the chore) once per session when the bot first stands within 8
  blocks of home with no user process; and when a container block appears within the radius (a
  block update: read that one) or disappears (forgotten at once, no walk). The bot's own box placing
  and breaking during a job is ignored.
- What: every container not read in the last 10 minutes is visited in nearest-neighbour order: walk
  (`near`, 2 blocks), open, snapshot, close. A container that does not open is reported and not
  retried for 2 minutes by the chore; one whose block is no container any more is forgotten.
- Double chests: the window has 54 slots (`inventory_content`). The open half becomes the record
  (`double: true`, size 54), its single same-kind horizontal neighbour the `partner`, which is never a
  container of its own (not read, not a target, left out of `!chests` and `!stock`).

## Decision table (`planUnload`)

For every stack, the first rule with a container that has room wins; a stack is split when the
container fills (free slots and partial stacks are simulated as the plan goes):

| # | Rule | Order among candidates |
|---|---|---|
| 1 | same: the container already holds this item | most of the item first |
| 2 | label: its label names the item's category, or the item itself (`coal`, `oak_log`) | most free slots first |
| 3 | emptiest: an unlabelled container | most free slots first |
| - | overflow: no container has room | spare shulker box (below) |

Ties go to the container nearest the bot. A container with no free slot and no partial stack of the
item is skipped; a labelled container that does not match is used only by rule 1. Categories
(`categories.ts`): ores (ores, raw metals, ingots, gems, coal, redstone, lapis, quartz, their blocks),
wood (logs, wood, planks, stems, saplings, sticks), food (real food, crops, seeds, eggs), blocks
(stone-like and building blocks), junk (the stash step's junk list), tools (anything with durability,
armour), misc. Label words: `ores` / `ore` / `metals` / `minerals` / `ingots` / `gems` / the metal
names; `wood` / `logs` / `planks` / `timber`; `food` / `meat` / `crops` / `farm`; `blocks` / `stone`
/ `cobble` / `building` / `dirt`; `junk` / `trash` / `misc` / `drops`; `tools` / `gear` / `weapons` /
`armour`.

Never unloaded: food, tools, weapons, armour (anything with durability), totems, ender chests (the
list `!drop items` keeps), the throwaway reserve (16 blocks of cobblestone, dirt, cobbled deepslate
and netherrack in all, cobblestone first, held back from the last slots of a kind) and one empty
shulker box (the stash step's). Further empty boxes go to the box chest (the container holding the
most shulker boxes; a placed shulker box never takes a box); full boxes (NBT `Items` not empty) go
there too, or with `all` are emptied first.

### Spare shulker boxes

When unloadable items are left and every container is full: the nearest container holding an empty
shulker box (`boxes.empty` in the memory) is opened, one empty box is taken (into a free hotbar slot;
with a full hotbar an unloadable hotbar stack is moved to the main inventory first, while the window
is open), the box is placed on a free cell next to the bot (Track AD's `boxSpots`), opened (slot type
`shulker`), filled with the overflow, closed, broken and picked up, and the full box goes back into
the box chest (the slot it came from is kept for it in the plan), else into the emptiest container
with a free slot. Up to 3 boxes per run.

### Memory file (`<cache dir>[/dim<n>]/chests.json`)

```json
{"version":1,"chests":[{"x":3,"y":-60,"z":-2,"kind":"chest","label":"ores","size":27,"free":25,"stacks":2,
 "contents":{"coal":20,"iron_ingot":10},"room":{"coal":44,"iron_ingot":54},"boxes":{"empty":0,"full":0},
 "double":false,"readAt":1793300000000},
 {"x":-3,"y":-60,"z":-1,"kind":"chest","size":54,"free":54,"stacks":0,"contents":{},"room":{},
 "boxes":{"empty":0,"full":0},"double":true,"partner":{"x":-3,"y":-60,"z":0},"readAt":1793300000000}]}
```

One file per dimension beside the cache's regions (like `herds.json`), written with the cache's
flush (every 30 s and at exit, temp file + rename), read lazily; at most 512 records per dimension
(the oldest reads go first). A record with `readAt` 0 was found but not opened yet. Without a world
cache (`BEDROCKBOT_CACHE=0`, tests) the memory lives in memory only. Every chest trip of a job writes
the container's fresh snapshot.

### Processes

| Process | Kind, priority | Wants control |
|---|---|---|
| `unload`, `chests` (`HomeJobProcess`) | user, 40 | until the job ends |
| `home-chore` (`HomeChore`) | auto, 30 (chore) | within 8 blocks of home (4 vertical) and no user process: the session scan, appeared containers; with `autoUnload` on and at least one read container: more than 8 stacks of unloadable items or any full shulker box (an unload that left items or failed waits 5 minutes), or a `!get` job that just ended at home (anything unloadable; the line `unloaded: ...` goes to chat after the job's reply) |

Both jobs run one after the other on one `HomeLogistics` (a pre-empted job finishes its current step
before the next starts). All container traffic goes through the task's one Containers: `requests` in
the report are the job's own item_stack_requests (one per (stack, destination slot)), `shared`
counts every request on the Containers while the job ran (the keeper restocking the hotbar, the
placer fetching the box into the hotbar).

## Slot types (BDS 1.26.60.6, verified on bds-home)

| Container | `container_open` | item_stack_request `container_id` |
|---|---|---|
| chest, trapped chest | window_type `container`, 27 slots | `container` (ContainerSlotType 7) |
| double chest (two chests placed by a player facing the same way) | window_type `container`, 54 slots, `coordinates` = the half clicked | `container` |
| barrel | window_type `container`, 27 slots | `barrel` (58); `container` is refused with `item_stack_response { status: 50 }` |
| shulker box (Track AD) | window_type `container`, 27 slots | `shulker` (30); `container` and `shulker_box` are refused (status 50) |

The chest skill now sets the slot type per window on the shared Containers when it opens a container
(`slotTypeForBlock`), so nothing switches the Containers' option any more. Two chests set next to each
other with `/setblock` (truth:set) do not pair (27 slots each); two placed by the bot from the same
side do (both `minecraft:cardinal_direction` east, 54 slots), so the e2e places its double chest with
the bot. A barrel opened right after it was closed missed one click in a probe (`container_open`
timeout); the visit clicks once more after a timeout.

## Measured (e2e on bds-home, 2026-10-29)

Final code: two gate runs of `home-chests` + `home-shulker` (5/5 green each, 75.4 s per run with
both files in parallel) and six runs of `home-shulker` alone (6/6); figures below span those and the
earlier runs of the same scenarios:

| What | Result |
|---|---|
| `!chests scan`, 5 containers (6 blocks) within 7 blocks | read in 5.9 to 6.1 s; memory equals truth:container for every container (counts, free slots, size) |
| `!unload`, 8 stacks into 4 containers (coal, logs, double chest, barrel) | 5.4 to 5.6 s, 4 chest trips, 12 requests (12 on the shared Containers) |
| autoUnload chore, 10 stacks after a 12-block `!goto` home | the unload itself 2.2 to 2.9 s (17 to 18 requests); done 5.8 to 6.9 s after the `!goto` |
| spare boxes: 30 stacks, every container full, 3 empty boxes in the box chest | 1904 cobblestone into 2 boxes (1728 + 176) in 14.1 to 16.4 s, 7 chest trips, 34 requests (37 to 39 shared: the survival keeper restocking the hotbar and the placer fetching the box); both boxes back in the box chest (NBT `Items` read from the chest window's inventory_content), 16 cobblestone kept (truth and model agree) |

## Tests

```sh
pnpm --filter bot exec vitest run --project unit home- cache/chests       # unit, fakes only
node scripts/bds.mjs --profile home up && node scripts/bds.mjs --profile home pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e home- --silent=false   # ~75 s
```

Env: `HOME_BDS_HOST` (127.0.0.1), `HOME_BDS_PORT` (19196), `HOME_BDS_CONTAINER` (bds-home),
`HOME_VERBOSE=1`. Every run uses its own random 256-block cell from x, z = -30720, settings and
waypoints in memory, no world cache directory; the containers are emptied and the area cleared at
the end.

- `home-chests`: a home of 4 chests (coal + iron, oak logs, an empty double chest placed by the bot,
  3 empty shulker boxes) and a barrel with 5 dirt; `!chests scan` (memory = truth for all 5, the
  double chest one record of 54 slots), `!chests label ... wood`, `!chests`, `!stock coal`,
  `!stock shulker`; `!unload` with 2 stacks of coal, 2 of oak logs, 3 of cobblestone, 32 dirt, bread
  and an iron pickaxe (coal to the coal, logs to the wood chest, cobblestone to the double chest,
  dirt to the barrel through `barrel` slots, bread / pickaxe / 16 cobblestone kept, 12 requests);
  `autoUnload`: 10 stacks, `!goto` home, the chore unloads them.
- `home-shulker`: the same home, every container filled with stone (truth:chestput), 30 stacks of
  cobblestone: 2 boxes filled and stored, 16 cobblestone kept, no box left in the world, the box
  chest's boxes hold 1728 and 176 cobblestone and one stays empty.

### Truth commands (`packs/truth/src/home.ts`)

| Request | Answer |
|---|---|
| `chestput x y z typeId amount [stacks\|all]` | `{typeId, size, slots, free}`: `stacks` stacks of `amount` into the first free slots of the block's inventory |

## Open points

- The placer picks the first hotbar box of the wanted name: with `all` and a full box that is not in
  the hotbar while an empty box of the same colour is, the empty one may be placed (it is then just
  picked up again; the full box stays carried).
- A pre-emption while a spare box stands placed leaves it there; it then counts as a container at
  home (it holds the items) and the next scan reads it.
- No ender chest support (the slot type is unverified).

## Model fixes (world/containers.ts)

Found by the e2e while the survival keeper restocked the hotbar during a box pickup:

- A whole stack moved into an empty slot keeps its wire item, and an ok response keeps it too: a
  stored full box is counted as full in the snapshot right away (before, the chest's record said
  "empty" until the next visit).
- A refused or timed-out request restores only the slots the server has not rewritten since the
  prediction, and an ok response refills a slot it filled that another request's rollback emptied
  meanwhile (the item kind from its own prediction). Before, the survival keeper's hotbar restock
  (16 cobblestone from slot 31 to slot 1) racing the box take and pickup left the model wrong: once
  the picked-up full box vanished from the model ("not picked up again"), once the 16 kept
  cobblestone did (`item_stack_response ...: 16 items in unknown slot 0:1`), 3 of about 12 runs. With
  both fixes the keeper still collides (status 49 / 50, `bad_destination`) in about half the runs and
  the model stays right. The box is now taken into the last free hotbar slot (the keeper restocks
  the first ones), and a box is filled in up to 3 planning passes (a stack the keeper moved meanwhile
  is found again).
