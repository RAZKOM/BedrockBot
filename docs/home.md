# Home logistics: chest memory, `!unload`, spare shulker boxes (wave 9, Track AG)

The owner's idea: "it would be cool for it to auto know the chests at home within a radius so maybe
it goes in and finds items in chests, and then makes a decision of where to unload its stuff. If it
finds a chest of like empty shulkers it can also use those in case a chest fills up of regular item
stacks". The bot now finds the containers around home, remembers what they hold, decides where each
stack it carries goes, and fills spare shulker boxes when the chests are full.
Decision record: [decisions/0028-home-logistics.md](decisions/0028-home-logistics.md).
Track AN (the follow-up, [decisions/0035-home-walking-distance.md](decisions/0035-home-walking-distance.md)):
containers by walking distance, an unreachable memory, a read cap per scan ("Walking distance" below).
Track AS (wave 10, [decisions/0040-bring.md](decisions/0040-bring.md)): `!bring` takes stored items out
of the chests and carries them to the owner ("Bring" below).
Track AV (wave 11, [decisions/0044-boxing.md](decisions/0044-boxing.md)): boxing a full chest's stacks into
spare shulker boxes at `!unload`, the owner's `bot_loot` boxes, `!boxes`, packing priority in the stash step
("Boxing at the chests" below).

## Files

| Path | What |
|---|---|
| `bot/src/skills/home/discovery.ts` | `findContainers` (World.find over loaded columns plus the world cache's marks), `chestNeighbours` (double chest halves), `visitOrder` |
| `bot/src/skills/home/unloader.ts` | `planUnload`: the decision table, pure; `unloadableStacks` (the chore's trigger) |
| `bot/src/skills/home/categories.ts` | item categories and label matching (`ores`, `wood`, `food`, `blocks`, `junk`, `tools`) |
| `bot/src/skills/home/memory.ts` | snapshot -> record, records -> unloader targets, the `!chests` / `!stock` lines |
| `bot/src/skills/home/logistics.ts` | `HomeLogistics`: the scan and unload jobs (walk, open, snapshot, deposit, spare boxes), serialised; Track AS: `withdraw` (walk, open, take, refresh) |
| `bot/src/skills/home/reach.ts` | Track AN: `chestGoal` (the walk to a container), `probePath` (a bounded, sliced probe plan), `verdict` (path length against `homeChestWalk`), `pathBlocks` |
| `bot/src/world/cache/chests.ts` | `ChestMemory`: the per-server chest memory, a sidecar of the world cache (`chests.json`); Track AS: `inBoxes` (what the full shulker boxes hold) |
| `bot/src/skills/home/bring.ts` | Track AS: `resolveBringItem` (the word -> item names), `planBring` (carried first, nearest chest, boxes last), `stockOf`, `parseBringArgs`, `itemsText` |
| `bot/src/tasks/process/bring.ts` | Track AS: `BringProcess` (user: the withdrawal, then the delivery) |
| `bot/src/chat/commands-bring.ts` | Track AS: `!bring`, `BringController`, the delivery walk (come's logic), the `!get` stock hint |
| `bot/src/tasks/process/unload.ts` | `HomeJobProcess` (user: `!unload`, `!chests scan`), `HomeChore` (auto, PRIORITY.chore) |
| `bot/src/chat/commands-home.ts` | `!unload`, `!stock`, `!chests`; wiring of the chore, the block-update trigger, the `!get` hook |
| `bot/src/skills/container/chest.ts` | slot type per block kind, `snapshot` / `snapshotOf`, `depositSlots`, `take`, the shulker box names and NBT readers (moved here from stash.ts) |
| `bot/src/world/containers.ts` | `setSlotType` / `slotTypeOf`: the item_stack_request slot type per open window; a whole stack moved into an empty slot keeps its wire item (NBT) |
| `bot/src/config/settings.ts` | `homeChestRadius` (number, 16, 2..48), `homeChestWalk` (Track AN: path blocks, 32, 0..256; 0 = radius only), `autoUnload` (boolean, on), `getSuggestsBring` (Track AS: boolean, on), `keepBoxName` (Track AV: text, `bot_loot`; 1..32 characters) |
| `bot/src/skills/nav/goals.ts` | Track AN: `getToBlock` option `low` (a side cell's feet up to `low` blocks below the block; default 1) |
| `packs/truth/src/home.ts` | `truth:chestput` (fill a container block); reading one is `truth:container` |
| `bot/test/unit/skills/home-*.test.ts`, `bot/test/unit/cache/chests.test.ts`, `bot/test/unit/chat/home-commands.test.ts` | unit tests on fakes |
| `bot/test/unit/skills/home-bring.test.ts`, `bot/test/unit/chat/bring-commands.test.ts` | Track AS: unit tests on fakes |
| `bot/test/e2e/home-chests.test.ts`, `home-shulker.test.ts`, `home-reach.test.ts` (Track AN), `home-bring.test.ts` (Track AS), `home-truth.ts` | e2e on bds-home |
| `bot/src/skills/home/boxing.ts` | Track AV: named boxes (`isKeptBox`, `keepBoxName`), carried boxes and spares, `placesExactly`, the `!boxes` line, the `kept 4 bot_loot boxes` line |
| `bot/src/world/inventory.ts` | Track AV: `itemDisplayName(raw)`: an item's custom name from the wire item's NBT |
| `bot/src/skills/home/unloader.ts` | Track AV: `UnloadStep` (`box`, `compact`), `planBoxSteps`, `emptyNamed`, `blocked` |
| `bot/src/skills/container/stash.ts` | Track AV: the named box first, packing priority (`DROP_FIRST`, `packClass`, `packOrder`), the re-pack |
| `bot/test/unit/skills/home-boxing.test.ts`, `stash-packing.test.ts`, `bot/test/e2e/home-boxing.test.ts` | Track AV: unit tests on fakes, the e2e on bds-home |
| `docker/compose.home.yml` | `bds-home`, udp/19196, flat, peaceful |

## Commands (owner only, afk task with walking)

| Command | Reply |
|---|---|
| `!unload [all]` | `unloading 8 stacks into 5 known containers`, then `unloaded: 176 cobblestone -> double chest -3 -60 -1, 32 dirt -> barrel 0 -60 -4, 128 coal -> chest 3 -60 -2, 128 oak_log -> chest 3 -60 2 (wood); kept 16 cobblestone, 1 iron_pickaxe, 5 bread`; with full chests `unloaded: 1904 cobblestone -> shulker box (into chest -3 -60 3); 2 shulker boxes filled and stored; kept ...`; `unload: no home set (!home set)`, `unload: I know no chest near home yet (!chests scan)`; `left 5 dirt (no room)` when nothing had room |
| `!stock [item]` | `iron_ingot: 128 in chest 100 63 -48 (ores), 64 in barrel 90 63 -48 (192 in all)`; `!stock shulker`: `shulker_box: 3 in chest 1 2 3 (3 empty)`; no item: the totals; `stock: no diamond in the 5 containers I know` |
| `!chests` | `chests: 6 remembered (3 reachable, 3 unreachable: !chests unreachable): 6 chests \| chest 3 -60 2: 26/27 free, 5 coal (0 min ago) \| ...`; the counts by kind with their labels (`3 chests (ores, wood), 1 barrel, 1 double chest`), then each reachable container, nearest first (chat cuts at 256 characters) |
| `!chests scan` | `chests: reading the containers within 16 blocks of home (walks of up to 64 blocks)`, then `chests: 181 within 16 blocks, 140 reachable within 32 path blocks, read 64 (76 pending), 41 unreachable, in 95 s` (blocks found: a double chest is two; `2 read less than 10 min ago`, `1 forgotten`, `could not open 1 2 3 (open: timeout)` when so; with `homeChestWalk 0` no `reachable` part). Probes the unreachable ones again |
| `!chests unreachable` | Track AN: `chests: 3 unreachable: chest -6 -60 5: no path within 4000 nodes (0 min ago) \| chest 12 -60 0: path 38 blocks (0 min ago) \| ...`, nearest first, at most 3 messages (the last ends `... and 12 more (!chests clear forgets them, !chests scan tries again)`); `chests: none unreachable` |
| `!chests clear` | `chests: forgot 181 containers (41 unreachable); I read them again the next time I stand near home (or !chests scan)` |
| `!chests label x y z <text>` / `none` | `chests: chest 3 -60 2 (wood) labelled`; up to 32 characters |
| `!boxes` | Track AV: `boxes: 4 spare (1 carried, 3 in chest 1 2 3); carrying 2 bot_loot boxes (1 empty, 1 holding 1728 sand)`; `boxes: no spare empty box known (carried or in the chests I know); no bot_loot box carried` |
| `!bring <item> [n] [to <player>\|home]` | Track AS: `bringing 64 torches to Steve (from 2 chests)`, then `brought 64 torches (from 2 chests)` ("Bring" below) |

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
- What: every container not read in the last 10 minutes (and not remembered as unreachable) is probed
  (Track AN, below); the reachable ones are visited in nearest-neighbour order, at most 64 per scan:
  walk (`chestGoal`), open, snapshot, close. A container that does not open is reported and not
  retried for 2 minutes by the chore; one whose block is no container any more is forgotten.

## Walking distance (Track AN)

The owner's Realm: 181 containers within `homeChestRadius` 16 of home, and every one above floor
level ended `goto: unreachable` after 3 plans; the owner asked "instead of radius can it be like
walking distance? like pathfind distance to said chests? or a toggleable thing?". Now:

- **Candidates**: the radius stays the cheap filter (`homeChestRadius`, 16, up to 48).
- **Probe plans first** (no walking): every candidate gets a bounded plan (reach.ts `probePath`:
  4 000 nodes / 300 ms of search, in 8 ms slices with a yield to the event loop between them, on the
  main thread like the miner's probes, never digging or pillaring) from home, or from the bot when it
  stands within 8 blocks of home. The path's length (sum of the steps, blocks) is the container's
  walking distance. A container is **unreachable** when the probe finds no path (`no path`, `no path
  within 4000 nodes`, `no path in the loaded world`) or a path longer than `homeChestWalk` (`path 38
  blocks`; default 64 (a multi-floor house: the owner's upper-floor chests are 40 to 45 path blocks from a basement home), `0` = no probes: radius only, as before Track AN).
- **Unreachable memory**: the record keeps `unreachable` (the reason) and `unreachableAt` in
  `chests.json`; scans skip it for an hour, `!chests scan` probes it again at once, a read clears it,
  `!chests clear` forgets it with the rest. A walk that fails during a scan (`goto: ...`) marks it too.
  Unreachable containers are never unload targets; `!stock` still counts what they held when read.
- **Read cap**: the reachable ones are sorted by path length; the nearest 64 are read
  (nearest-neighbour between them), the rest is `pending`: the chore reads them at the next idle
  moment at home (64 at a time), also after a `!chests scan`.
- **The goal** (`chestGoal`): `getToBlock` with reach 4, `face: false` (main's rule for container
  goals: a chest inside a stack or a wall of chests has no face turned to a stand cell) and `low: 3`
  (new option: from a side column the feet may be up to 3 blocks below the container, so a chest on a
  3-high stack or a pillar is read from the floor; reach still decides). The probe uses the same goal
  as the walk, so "reachable" means the walk's goal can be reached.

Probe cost, measured on bds-home (home-reach e2e, flat world, final code): 6 candidates in 46 to 58
ms of wall clock, **7.7 to 9.7 ms per candidate** (4 runs, 2 on the final code) (the 2 walled-in ones run to the 4 000-node budget, the
4 others finish in a few hundred nodes); unit test on a generated world: the same layout gives the
same verdicts. The owner's 181 candidates therefore cost about 2 s of probing (at most 181 x 300 ms
if every one hit the time budget), instead of 181 walks.
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
there too, or with `all` are emptied, one after the other (the box is placed, its items taken into the
inventory but for the slot the box needs back, then it is broken and picked up; what was taken is
unloaded before the next box, and a box that did not fit at once is emptied again after that). The
fireworks box is never emptied.

Track AV, before the rules: the plan's `box` steps (and Track AW's `compact` steps) run first; rule 1
counts the items inside a chest's full boxes too, and the kinds with a home (rule 1) claim their room
before the others' label / emptiest rules ("Boxing at the chests" below).

| # | Rule (Track AV rows) | When |
|---|---|---|
| 0a | compact (Track AW's hook) | `plan.compact` not empty and a runner installed (`setCompactRunner`): run once before the chest trips |
| 0b | box | the chests holding the item (loose or boxed) cannot take what the bot carries of it, and a spare empty box is known (carried first, else the chest nearest to the target holding empty boxes) |
| - | blocked `no_spare` | the same, but no spare known: the item goes by rules 2 / 3, or is left (`left 192 cobblestone (no room; chest 1 2 3 is full and no spare shulker box is known)`) |
| - | blocked `boxes_full` | the target chest holds no loose stack of it and has no free slot for a box (a chest full of full boxes): `left ... (no room; chest 1 2 3 is full of boxes)` |

### Spare shulker boxes

When unloadable items are left and every container is full: the nearest container holding an empty
shulker box (`boxes.empty` in the memory) is opened, one empty box is taken (into a free hotbar slot;
with a full hotbar an unloadable hotbar stack is moved to the main inventory first, while the window
is open), the box is placed on a free cell next to the bot (Track AD's `boxSpots`), opened (slot type
`shulker`), filled with the overflow, closed, broken and picked up, and the full box goes back into
the box chest (the slot it came from is kept for it in the plan), else into the emptiest container
with a free slot. Up to 3 boxes per run.

## Boxing at the chests (wave 11, Track AV)

The owner: "If a chest is full of empty shulkers, it can also find that chest, and load in items from a
full chest into the shulker, break the shulker, and put it back in the chest ... all of the 8640 sand won't
fit in one chest that is already partially full of sand, so if it sees empty shulkers it can just use one."
Decision record: [decisions/0044-boxing.md](decisions/0044-boxing.md).

### Named boxes (`bot_loot`)

- **What**: a shulker box whose custom name is the setting `keepBoxName` (text, default `bot_loot`; case,
  colour codes such as `§6` and surrounding spaces ignored). The name comes from the item NBT
  (`world/inventory.ts itemDisplayName`), verified on BDS 1.26.60 (bds-home, a box named by
  `truth:nameinv`): an unnamed box has `extra.has_nbt: 0`; a named empty one
  `extra.nbt.nbt.value = {display: {type: 'compound', value: {Name: {type: 'string', value: 'bot_loot'}}}}`;
  a named full one has `Items` and `display` side by side (naming keeps the contents; a named box placed,
  filled, broken and picked up keeps its name).
- **Rules**: never unloaded as an item, never put into a chest, never used for boxing, never a spare, never
  dropped by `!drop all` / `!drop items` (`dropped 193 items of 2 kinds; kept 2 bot_loot boxes`; the drop
  skips those slots, so an unnamed box of the same colour still goes), nor by an explicit
  `!drop undyed_shulker_box` (`dropped 1 undyed_shulker_box; kept 2 bot_loot boxes`: `!drop bot_loot [n]` drops
  them, `!drop slot <0..35>` one slot whatever it holds, which is what the panel's Drop button sends), nor by `!drop flightkit` (only the fireworks box's own slot goes); the stash step fills it before any
  unnamed box, the emptiest named box first: the place skill takes the first hotbar box of a colour, so a
  chosen box in the main inventory is moved into the hotbar first (`SurvivalKit.hotbar`; before that fix
  a full `bot_loot` box in the hotbar was refilled over and over while eight empty ones of the same colour
  waited, and the job stopped `inventory still full`); `!unload` empties it into the inventory (placed, opened, emptied, broken, picked up; between
  deposit passes when the inventory has no room yet) and unloads its items like loose stacks; the box stays
  carried (`kept 2 bot_loot boxes`). A box not picked up again (`unload: emptying a box: the box was not picked
  up again (left at x y z)`; the collect tries radius 4, 6 and 10) no longer ends the job with its items in the
  inventory: one more deposit pass unloads them, no further box is emptied in that run (2026-10-31 Realm: the
  items were pulled into the inventory and left there), then the bot walks back to the box and picks it up
  (`unload: the box left at x y z: picked up on the second try`). Emptying a box leaves two inventory slots
  free, the box's own and one for whatever else lies there and is picked up with it (with one, the pickup
  once found the inventory full). With a named box carried no unnamed box is held back for the stash step.
  The fireworks box (Track AU) is checked first and keeps its own rule.
- A box whose wire item is unknown (no raw item for its slot, e.g. after a refused request rolled the slot
  back): its name and contents are unknown, so it is kept (`unknown_box`), never a spare, never stored or
  taken as one, until the server sends the slot again.
- In a chest a named box counts neither as an empty nor as a full box (`boxes.empty` / `full` leave it out;
  `inBoxes` counts what it holds), so it is never taken as a spare.

### The box step

1. **The spare**: a carried unnamed empty box (not the stash step's), else one taken out of the chest the
   plan names (into a free hotbar slot; with a full hotbar a movable hotbar stack goes to the main
   inventory first, while the window is open).
2. **Rounds** (at most 4): walk to the target chest, take its loose stacks of the item (fullest first, as
   many as the box's free slots and the inventory's free slots allow), move the box into the hotbar while
   the window is open if the place skill would pick another box, close; place the box next to the bot
   (`placesExactly`: the selected hotbar box; another box placed is picked up again and the step fails),
   fill it with the item's stacks (fullest first, the throwaway reserve held back; planned again after each
   pass, up to 3, because the survival keeper may move a stack meanwhile), break it, pick it up. Another
   round only when the inventory's room limited the take.
3. **Store**: the full box goes into the target chest (the freed slots); the memory is refreshed from the
   window: the box with its contents (`inBoxes`), the loose stacks reduced.
4. Then the deposits plan again from the fresh memory: the bot's stacks of that item go into that chest.

The bot's own produce is boxed too when the chest has fewer free slots than the bot carries and no loose
stack (a chest of boxes with one free slot: 27 stacks of produce in one box). Never boxed: mixed kinds,
kept items (food, tools, armour, totems, rockets), unstackable items, the reserve. At most 4 box steps a run
(`MAX_BOX_STEPS`); a failed step (`skip`) plans that kind without boxing for the rest of the run.

### The `compact` hook (Track AW)

Crafting an item into its block form (iron ingots into iron blocks) to make room is Track AW's. The contract:

- **Plan**: `UnloadPlan.compact?` (`{kind, count}[]`, `count` = items), filled by Track AW's
  `compactPlanner(slots, plan, chests)` (`setCompactPlanner`) at the end of `planUnload`. The planner is
  called on every plan (`HomeLogistics.plan()`, the chore's load check, each deposit round): it must be pure
  and cheap.
- **Run**: Track AW's `compactRunner(list, cancelled)` (`setCompactRunner`, unloader.ts). `HomeLogistics.unload`
  calls it once, under its serial lock, before the chest trips (after `all` emptied the full boxes) when a
  runner is installed and the list is not empty; without a runner it is skipped silently. The runner must
  not call back into HomeLogistics (the job holds its serial lock: a nested job would wait forever). Its
  fragment goes into the `!unload` reply after the deposits (`unloaded: ...; compacted 27 raw_iron into 3
  raw_iron_block; ...`); a runner that throws gives `compact failed: <message>` and the unload goes on. The
  logistics crafts nothing itself.

### Packing priority in the stash step

The owner: "If he has 5 shulkers and I ask for 27*64*5 sand, but he starts filling some of the shulkers
with just stuff, will it put them back down and prioritize the sand when it realizes it doesn't have enough
space?"

| Order | What | Rule |
|---|---|---|
| 1 | junk that is no building block (`DROP_FIRST`: rotten flesh, poisonous potatoes, string, spider eyes, snowballs, kelp, seagrass, vines; bones, seeds, flint, feathers and arrows are not in it: bone meal, replanting, crafting) | dropped before a box is filled (a `drop` step), never boxed (unless the job is getting it) |
| 2 | the job's produce (`StashJob.wanted`) | boxed first |
| 3 | other items of value | boxed next |
| 4 | filler blocks (the rest of `STASH_JUNK`: cobblestone, dirt, sand, gravel, stone kinds, ...) | boxed last, only when no produce waits |
| re-pack | a box (named or not) holding stash junk the job does not want while produce waits | the junk taken out stack by stack into a free inventory slot, the produce deposited into each freed slot, the junk dropped right after the box is picked up again; once per box (afterwards it holds no junk, and the order above never boxes junk while produce waits). Needs a second free inventory slot besides the box's: with the inventory completely full there is no re-pack (the keeper's own full-inventory drops raced the takes) |

Reply / log: `re-packed 1 box: dropped 1280 junk, boxed 20 stacks of sand` (also in the stash step line).
Filler is boxed last rather than dropped first: the get-stash regression (coal wanted, 34 stacks of
cobblestone) still boxes 27 stacks of cobblestone.

### Measured (e2e on bds-home, 2026-10-30, home-boxing 6/6 green in two gate runs, 137 to 147 s per run)

| What | Result |
|---|---|
| (a) a full chest of cobblestone (27 stacks), 10 stacks carried, spares 4 blocks away: the box step (take the spare, take 25 stacks, place, fill 27, break, pick up, store) | 12.5 to 14.5 s, **1 round** (25 stacks out: the inventory's 25 free slots plus 2 own stacks fill the box); the whole `!unload` 14.3 to 16.4 s, 62 requests (66 shared), 5 chest trips |
| (b) 17 stacks of sand in the chest (10 free), 20 stacks + a bot_loot box of 27 stacks carried | 2 box steps of 10.0 to 11.6 s and 14.1 to 14.4 s, 1 round each (13 and 6 stacks out of the chest); the whole `!unload` (with emptying the named box) 36.7 to 38.7 s, 116 requests, 8 chest trips; the chest then holds 2 boxes (1728 each) + 10 stacks |
| (d) the stash step into the named box (27 stacks of cobblestone) | 3.8 s |
| (f) re-pack: 20 stacks of rotten flesh out, 20 stacks of sand in | 10.4 to 13.5 s for the stash step, 40 requests (20 takes, 20 deposits) |
| (e) a full chest, no spare | 0.2 to 0.3 s (no walk), the reply names what is left and why |
| before the fill was planned again per pass | 1 of 3 runs needed a second round: the survival keeper moved a stack during the fill (26 of 27 stacks went in) |

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

## Bring (wave 10, Track AS)

The owner: "maybe like a retrieve command for bringing items to the player instead of unloading at
home. or some way to differentiate between getting already gotten items or getting new resources and
either taking them to the player or home." Decision record:
[decisions/0040-bring.md](decisions/0040-bring.md).

| | `!get <item> [n]` | `!bring <item> [n] [to <player>\|home]` |
|---|---|---|
| what | makes new items: gathers, mines, hunts, farms | takes items already stored in the chests at home |
| source | the world | the chest memory (`!stock`), loose stacks first, full shulker boxes as the last source |
| ends | where the job ends; at home `!unload` (or the `autoUnload` chore) puts it away | at the player (within 2 blocks), or home with `home`, from the console, or when the player is not online |
| chests | never takes from a chest (the stash step only deposits) | only takes |
| hint | `getting 16 iron: the chests hold 128 (!bring iron 16 fetches it); mining iron_ore anyway` when the chests hold n (`getSuggestsBring`, on) | `bring: no torch in the 5 containers I know (!stock torch; !get torch makes new ones)` |

### Planning (`skills/home/bring.ts`, pure)

1. **The word**: the item names the chest memory or the inventory knows that match it first
   (`torches` -> torch, `shulker` / `box` -> any shulker box), then the `!get` catalog's
   (`iron` -> iron_ingot, then raw_iron; `wood` -> every log the memory knows; `diamonds` -> diamond).
   Loose stacks of the first name are taken first. n defaults to one stack (16 ender pearls, 1 box).
2. **Carried first**: what the bot carries of those names counts; only the rest comes from chests.
3. **Nearest chest first, by the memory's counts** (read, reachable containers within
   `homeChestRadius`; never the other half of a double chest), straight-line distance from the bot.
4. **Shulker boxes only when the loose stacks are not enough**: a full box holding the item is taken
   whole (the memory knows what full boxes hold: `inBoxes` on the chest record, from the boxes' NBT
   `Items` at every read); both replies say `the only source: a full shulker box out of chest ...`.
   `!bring shulker` takes empty boxes before full ones.
5. **Short**: what the chests do not hold is said at the start (`only 8 known: 12 short`) and at the
   end (`12 short: the chests hold no more`); the bot brings what there is.

### The withdrawal (`HomeLogistics.withdraw`)

Plan, walk to the plan's first chest (the scan's stand cell, `face: false`, the same reach rules as a
scan), open it, take the item's stacks with `chest.take` (or whole boxes), refresh that chest's record
from the window, close, plan again. A chest that held less than remembered gives what it has and the
refreshed memory sends the next round to the next chest; a chest that gives nothing is not tried again
in this job. The memory follows every take at once: counts go down, an emptied chest loses the item, a
box taken out leaves the box counts and `inBoxes`; `!stock` shows it right away and the next scan
refreshes it anyway.

### The delivery

`!come`'s walk: the tracked player (the follower's `come`, within 2 blocks), else the locator bar's
position (up to 4 legs, then the tracked player), trip readiness first (a long trip with food or
health below 14 eats and puts armour on). `home` (or the console, or a player who is not online):
a walk to within 2 blocks of the home point, and the reply says why (`Steve is not online, so I took
them home`). The items stay in the bot's inventory (`!drop torch 64` hands them over).

`BringProcess` (tasks/process/bring.ts) is a user process (priority 40) with two phases; a
pre-emption (flee, guard, night, a newer command, `!pause`) cancels the running step and the phase
runs again on resume: the withdrawal takes only what is still missing (carried counts), the walk
starts again from where the bot stands. `!bring stop` / `!stop` end it.

### Replies

| Command | Reply |
|---|---|
| `!bring torch 64 to Steve` | `bringing 64 torches to Steve (from 2 chests)`, then `brought 64 torches (from 2 chests)` |
| `!bring iron 20` (8 in stock) | `bringing 20 iron to Steve (from 1 chest, only 8 known: 12 short)`, `brought 8 iron_ingots (from 1 chest; 12 short: the chests hold no more)` |
| `!bring diamond 2` (only in a box) | `bringing 2 diamonds to Steve (from 1 chest, a full shulker box comes along: the only source)`, `brought 1 shulker box holding 2 diamonds (from 1 chest; the only source: a full shulker box out of chest 0 -60 -4)` |
| `!bring coal home` | `bringing 64 coal to home (from 1 chest)`, `brought 64 coal home (from 1 chest)` |
| `!bring torch` (none) | `bring: no torch in the 5 containers I know (!stock torch; !get torch makes new ones)`; no chest read: `bring: I know no chest near home yet (!chests scan)` |
| `!bring status` / `stop` | `bring: bring 64 torch to Steve: walking to Steve, 12 blocks left (running)`, `bring: idle (last: brought ...)`; `stopped bring ...`, `bring: nothing to stop` |
| failures | `bring: carrying 64 torches but could not get to Steve: not_found`; `bring: found no torch: the chests held less than remembered (!chests scan reads them again; ...)` |

NL (`!do`): the `bring` step (`{"command":"bring","item":"torch","count":64,"to":"home"?}`): "bring me
64 torches", "fetch some coal from home", "bring the diamonds to me" map to it; "get me coal" stays
`get`. The prompt's step lines say the difference, so the answer step can explain it.

### Measured (e2e on bds-home, 2026-10-30, two runs, 6/6 green each, 89 s per run)

| What | Result |
|---|---|
| 64 torches: 40 + 30 in two chests 10 blocks apart, to a player 30 blocks away | 13.6 / 13.7 s from the command; 1.92 blocks from the player; truth: 64 torches carried, 6 left (memory and truth) |
| 3 stacks of cobblestone (2 + 1) from the same two chests to the same player | 13.6 / 13.7 s; 1.92 blocks from the player; truth 192 cobblestone |
| iron 20 with 8 iron ingots in one chest | 7.4 / 7.5 s; 8 brought, 12 short said twice |
| diamond 2, only in a shulker box | 7.5 s; the box (NBT 2 diamonds) carried, the chest's record without boxes |
| coal home, the bot 20 blocks east | 5.5 / 5.6 s; 1.95 blocks from home, 64 coal |

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
- `home-reach` (Track AN): 2 floor chests (one with 5 coal), a chest on a 3-high stone pillar, 2 chests
  walled in (3 x 3 x 3 stone), 1 chest 12 blocks away in a walled room whose door is on the far side;
  `!chests scan`: `chests: 6 within 16 blocks, 3 reachable within 32 path blocks, read 3, 3 unreachable,
  in 4.9 to 5.1 s` (walled: `no path within 4000 nodes`, far: `path 38 blocks`), `!chests unreachable`
  lists the 3, `!chests` counts them apart; `!set homeChestWalk 0` + `!chests scan`: the far chest is read,
  the walled ones fail their walks (`goto: unreachable`): `read 1, 2 unreachable, 3 read less than 10 min
  ago, in 48 to 52 s`. Final code: 2 runs of all three files in parallel, 8/8 green each (141 to 147 s); 2 earlier
  runs (before `face: false`) green too.
- `home-shulker`: the same home, every container filled with stone (truth:chestput), 30 stacks of
  cobblestone: 2 boxes filled and stored, 16 cobblestone kept, no box left in the world, the box
  chest's boxes hold 1728 and 176 cobblestone and one stays empty.
- `home-boxing` (Track AV): (a) a chest of 27 stacks of cobblestone + a chest of 3 empty boxes, 10 stacks
  carried, `throwawayMin 0`: `!unload` boxes 27 stacks there (box from the box chest), the chest holds 1
  box (1728) + 10 stacks, the bot no cobblestone, memory and `!stock` (`cobblestone: 2368 in chest ...
  (1728 in boxes)`) agree with truth; (b) 2 `bot_loot` boxes (one holding 27 stacks of sand), 20 stacks of
  sand, the sand chest with 17 stacks (10 free), 3 spares: 2 box steps, all 64 stacks in the sand chest
  (2 boxes + 10 loose), both named boxes carried and empty, `kept 2 bot_loot boxes`; (c) `!drop all` keeps
  the 2 named boxes, drops an unnamed one; (d) the stash step fills the named box (hotbar slot 2), not the
  unnamed one in slot 1; (e) a full chest, no spare: `left 192 cobblestone (no room; chest ... is full and
  no spare shulker box is known)`; (f) a named box holding 20 stacks of rotten flesh + 7 of sand, the
  inventory full of sand (1 slot free): re-packed, the box holds 27 stacks of sand, the flesh is dropped.
- `home-bring` (Track AS): 4 chests by truth (A: 40 torches + 2 stacks of cobblestone, B 10 blocks from
  A: 30 torches + 1 stack, C: 8 iron ingots + 64 coal, D: a shulker box holding 2 diamonds, filled by
  truth as a block, broken and stored by the bot), a second connection 30 blocks east, `!chests scan`
  first: `!bring torch 64 to <player>` (64 carried, within 2 blocks of the player, 6 left in memory and
  truth, `!stock torch`), 3 stacks of cobblestone (measured), `!bring iron 20` (12 short, 8 brought),
  `!bring diamond 2` (the box comes along; D's record without boxes), `!get coal 4` (the hint line, then
  `!get stop`), `!bring coal home` from 20 blocks away (within 2 blocks of home).

### Truth commands (`packs/truth/src/home.ts`)

| Request | Answer |
|---|---|
| `chestput x y z typeId amount [stacks\|all]` | `{typeId, size, slots, free}`: `stacks` stacks of `amount` into the first free slots of the block's inventory |
| `namebox x y z slot\|boxes name` | Track AV: `{typeId, named}`: the custom name (ItemStack.nameTag) of the item in that slot of the container, or of every shulker box in it; the item keeps its data (a box its contents) |
| `nameinv playerName slot\|boxes name` | Track AV: the same in a player's inventory |
| `boxmix x y z typeId amount stacks [typeId amount stacks]...` | Track AV: an undyed shulker box dropped as an item at x y z holding those stacks in that order (placed, filled a tick later, destroyed; like fly.ts `boxdrop` with mixed contents) |

## Open points

- Track AV: re-pack junk: dropped at the box cell, the bot walked back over it and picked up 448 to 512 of
  1280 rotten flesh again in 2 of 3 runs. Now the bot walks back to the job's spot first, looks up and away
  from the box cell, then drops it: 1280 of 1280 on the floor in the review rerun. A job that later walks
  over the spot may still pick some up (the keeper drops it again when the inventory fills).
- Track AV: `!unload` empties a named box only when the inventory has 2 free slots; a run that starts with
  a full inventory deposits first and empties the box in the next pass (up to 6 passes).
- Track AV: the `!unload` reply lists every deposit; past 256 characters (the chat limit) it becomes `unloaded: 14 stacks
  into 3 containers`.

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
