# Room in the inventory (Track V1)

The bot keeps 4 inventory slots free when it is idle, by the cheapest step that loses nothing of worth, in the order a
player takes them. At home the unload does it; away from home a merge, the junk, the rockets' own box and a carried box
do it. Decision record: [decisions/0090-room-in-the-inventory.md](decisions/0090-room-in-the-inventory.md).

Why: a full inventory picks nothing up. The ore a dig breaks, the loot of a fight, the shulker box of a refill or of a
stash step lie on the ground and are lost. The owner's live bot sat at 36 of 36 for hours with a netherite kit, seven
stacks of loose rockets beside its fireworks box, five empty shulker boxes and seven kinds of food; a new bot fills the
same 36 slots with stone and mob drops in an hour of mining.

## Files

| File | What |
|---|---|
| `bot/src/skills/inventory/room.ts` | `planRoom` (pure), `roomSlotsOf`, `stackKey`, `roomAskLine`, `ROOM_FLOOR` 4, `ROOM_TARGET` 6, `ROCKETS_LOOSE` 128, `STONE_LIKE`, `KEEP_LOOSE`, `ROOM_COMPACT` |
| `bot/src/tasks/process/room.ts` | `RoomChore`: the idle chore that runs the plan one step at a time |
| `bot/src/tasks/process/unload.ts` | `unloadWanted`: the home chore's trigger, the free slots counted; `HomeChore.unloadDue`; `sparesWanted`, `sparesKeptLine`, the `spares` job |
| `bot/src/skills/home/unloader.ts` | `unloadableStacks` also counts the spare empty boxes and the free slots; `planUnload(..., { spares })`, `spareChestState` |
| `bot/src/skills/home/logistics.ts` | `HomeLogistics.returnSpares` (the spares job's trips), `spareChest` |
| `bot/src/skills/supply/supply.ts` | `Supply.putInto`: a carried box placed, the stacks put in, the box picked up again |
| `bot/src/skills/survival/index.ts` | `SurvivalKit.merge`; the kit registers its `exchange` |
| `bot/src/skills/container/exchange.ts` | the exchange by inventory model, `RateLimit` (once a minute a key) |
| `bot/src/skills/place/place.ts`, `bot/src/skills/farm/click.ts` | `hotbarRoom(..., exchange)`, the fetch into a full inventory |
| `bot/src/chat/commands-home.ts` | the wiring (what the chore reads and the skills it drives) |
| `bot/src/skills/inventory/thrown.ts` | `ThrownItems` (the bot's own throws by entity id, `thrownFor`), `throwDirection`, `throwAway` (a drop stays dropped) |
| `bot/src/skills/test/inv.ts`, `bot/src/chat/commands-test.ts` | Track T3: `!test inv` (`keptReason`, `isKeptFood`, `snapshotInv`, `presetStacks`, `planPreset`, `planRestore`, `protectedSlots`, `InvTest`: `restore`'s wait, `tick`, `restoreFirst`, `waiting`; `INV_SAVE_LIMIT_MS`, `RESTORE_WAIT_MS`) |
| `bot/src/skills/supply/boxes.ts`, `bot/src/skills/supply/supply.ts` | Track T3 follow-up 2: `BoxOps.takeBack`, `Supply.unbox` (the restore takes a preset's boxed items back out; `boxedExcess` in inv.ts says what) |
| `bot/src/skills/test/guard.ts` | Track T3 follow-up: `SaveGuard`, `heldBySave`: what the home chore, the logistics, the stash step and the food chore ask while a save waits |

## Why a slot stays taken

| Reason | Late game (the live bot) | Early game (stone tools, an hour of mining) | What a player does | Slots |
|---|---|---|---|---|
| Gear | the worn set; pick, shovel, sword, axe; the elytra; a bow and 15 arrows | stone tools | keeps the gear; the bow goes into a chest | 7 (5 kept) |
| The flight kit | 422 loose rockets beside a fireworks box of 165 | - | keeps a trip's worth loose, the rest in the rockets' box | 8 (3 kept) |
| Spare boxes | 5 empty shulker boxes | - | keeps one, the rest go back to the chest of spares | 5 (1 kept) |
| Food | 7 kinds, 88 items beside 40 carrots and potatoes | bread | keeps it (the bot keeps 64 of food and 32 of each seed it replants) | 7 to 9 |
| The throwaway reserve | 16 cobblestone | 16 of the throwaway blocks | keeps a stack to pillar and bridge | 1 |
| Mob drops and odds | bone, redstone, stick, seeds, a grass block | rotten flesh, string, bones, arrows, flint | drops the junk, stores the rest | 5 to 6 |
| Split stacks | a fight's sweep: the same food or drop in two slots | the same block in two slots | merges them | 1 to 3 |
| Filler | - | 10 stacks of cobblestone, deepslate, dirt, andesite, diorite, granite, tuff, gravel | drops the filler beyond a stack or two, or stores it | 15 to 20 |

Why five empty boxes are carried (from the code; the live log can say which applied, e.g. `out of the box in slot` or
`flight kit: refill`):

- a fireworks box emptied by refills is no longer the fireworks box (that is the box that holds rockets and nothing
  else), so it becomes a spare and the kit uses the next rockets-only box;
- the Supply empties carried boxes for food, torches, rockets for a flight with none loose, and a build's blocks, and
  keeps the empty box;
- `!bring` loads whole boxes, later used up;
- an unload or a fill step interrupted with its box carried.

Only the unload sends spares back to the chest of spares (it keeps one for the stash step). With 6 stacks to unload,
under its bar of 8, and the empty boxes counting for nothing, it never ran: the live bot kept all five.

Loose rockets beyond a trip are not unloadable: the flight kit keeps every loose rocket (it is a keep item of every drop,
stash and unload). The room plan moves the ones beyond two stacks into the fireworks box instead.

## The floor

`ROOM_FLOOR` 4 free slots, and once a pass starts it plans on until `ROOM_TARGET` 6 are free (the next pickup then does
not start it again). Four, because:

- a box step (the stash's, the Supply's, the flight kit's refill) needs one slot for the box coming back and one for
  what lies there and is picked up with it (the Supply keeps two free for that: `ENSURE_MIN_FREE`);
- a fight's sweep and a dig's drop each bring a new kind;
- the stash step starts a job's clean-up below 2 free (`MIN_FREE_SLOTS`), so the floor sits above it.

## The steps

`planRoom(slots, options)`: nothing with 4 or more free; else these steps in this order until 6 are free. The chore
runs the first step, reads the inventory again and plans again.

| Step | Where | What | Never |
|---|---|---|---|
| merge | anywhere | split stacks of one item (the same name, metadata and wire NBT: a crafted rocket of another flight or an enchanted book stays apart) into one, the main inventory's stack onto the hotbar's; only when it frees a slot | a shulker box, an item that does not stack, the junk the next step drops |
| junk | away from the home chests | the keeper's junk list (rotten flesh, poisonous potatoes, string, spider eyes; the setting the keeper drops at 36 of 36), dropped below the floor instead of at 36 | anything the keeper never drops (gear, armour, food, logs, torches, bones, gunpowder, the flight kit) |
| rockets | anywhere | loose rockets beyond `ROCKETS_LOOSE` 128 (two stacks; a trip burns about 20 to 40) into the fireworks box, whole stacks, the main inventory's first; the hotbar's stack and the fullest stay loose | a box with no room; with no fireworks box the rockets stay loose |
| box | away from the home chests, below the floor only, `stashShulker` on | what the unload would put away (its plan with no chest: not the gear, the food and seed reserves, the throwaway reserve, the milk reserve (Track K1), the flight kit, the boxes) into a carried box with room: a `bot_loot` box, then a box this chore filled earlier in the session, then an empty unnamed box; things of value before filler | the fireworks box, a box the bot cannot read, a box owed to a chest, a box holding anything else (the owner's box of sand stays a box of sand); torches, buckets, bone meal, the crafting table, ender pearls (`KEEP_LOOSE`: a skill takes them loose) |
| compact | away from the home chests, a crafting table within reach | redstone, lapis and emeralds into their blocks (9 -> 1) when that frees a slot (`compactRunner`, the crafter's) | anything else (iron and gold are crafted from, coal burns); at home the unload compacts (`compactOnUnload`) |
| stone | away from the home chests, `dropStone` above 0 | of each stone-like kind (cobblestone, cobbled deepslate, dirt, coarse dirt, grass block, podzol, gravel, sand, red sand, andesite, diorite, granite, tuff, calcite, stone, deepslate, netherrack, blackstone, basalt, dripstone, mud) `dropStone` (64) kept, the rest dropped, the main inventory's smallest stacks first | what a `!get` of the last hour was getting (`!get stone` keeps its cobblestone); flint, clay, ores |

At home with chests (a home set, at least one container read, `autoUnload` on) the chore merges and moves rockets only:
the unload stores the rest, and the home chore unloads below the floor too.

The box step uses the Supply's box routine (`Supply.putInto`, under the logistics' serial lock): the box goes into the
hotbar (the kit's exchange with a full inventory), is set down on a free cell next to the bot, filled, broken and picked
up again. Not on a cell that would lose its drop (a ledge), with water or lava beside it or over the lid, or with sand or
gravel over the lid (the flight kit's `unsafeBoxCell`). A box not picked up again is fetched by the next job, as every
Supply box.

The chore remembers the boxes it filled by what they hold (`boxPrint`) and fills one of them before an empty one, so
the loot of a session goes into one box rather than one box a pass.

Track V1c: an empty box with a custom name other than `keepBoxName` (`labelled`: the owner's `owner_stuff`) is never a
loot box; a name says someone means it for something. And every move onto a partial stack (the deposits into a box or
chest, the takes out of one, the refill from the fireworks box) needs the same wire NBT as the stack it tops up
(`container/chest.ts stacksOnto`, the merge step's `stackKey`): the server refuses to merge rockets of another flight,
enchanted books, named items or potions (error 55), so such a stack goes into an empty slot instead, and a box of
partial Flight 1 stacks with no empty slot is full for Flight 2 rockets. The refill counts no room on a loose stack its
box's rockets do not merge onto, so the box's own slot still stays free for it.

A box in the main inventory with the hotbar full (the usual state of a full inventory) is brought in by the survival
kit (`SurvivalKit.hotbarWhy`: an empty hotbar slot, else the least useful hotbar stack exchanged with it by the kit's
`exchange`, each stack's wire item kept); when it does not come in, the step says why (`the box is not in the hotbar:
the survival kit stayed busy ...`, `... the swap ... failed (...)`) instead of the bare line the Realm showed. A box
just set down that gets no `container_open` is clicked once more, and the log names the block over its lid.

The cell over the lid (`container/stash.ts lidOpen`, every box cell: the room chore, the Supply, the stash step, the
flight kit's open-air and cave refills), measured on BDS 1.26.60 (`test/e2e/box-lid.test.ts`): a box opens under air,
short grass, a fern, a flower, a vine or a cobweb, and stays shut under anything with a collision box however thin (a
carpet, a slab, glass, leaves, stone). The rule is the box cell's own (air or a replaceable plant, no collision box, no
liquid) and never a snow layer or fire; a shaft's carved cell digs such a lid first.

## The home chore

`unloadWanted(load)`: the home chore unloads when idle at home with more than 8 stacks of unloadable items or a full
shulker box (as before), and now also with fewer than 4 free slots and anything to unload: a stack, or a spare empty
box (the unload keeps one for the stash step and sends the rest to the chest of spares). With 4 or more free, or nothing
to unload, the old bars alone. The room chore waits while an unload runs or is due (`HomeChore.unloadDue`).

### Spare boxes go back on their own

The first deploy showed the gap: at home the live bot's room pass moved 320 rockets into the fireworks box (0 -> 5 free)
and then kept its five empty boxes, because with 5 free and 6 stacks neither unload bar was met. Now, with nothing to
unload, the home chore runs a small `spares` job whenever it is idle at home with `autoUnload` on, whatever the free
slots:

- what goes: the empty unnamed boxes carried beyond the stash step's one (none is held back when a `bot_loot` box
  serves the stash step), the same count the unload sends back (`load().spares`);
- where: the chest of spares only, a read chest (not a box block) that holds an empty shulker box or is labelled
  boxes, box, shulkers or spares, with a free slot (`spareChestState`; the one with the most empty boxes first);
- nothing else moves: not the loot, not a box that holds anything, not the fireworks box, not a box it cannot read
  (`planUnload(..., { spares: true })`, `HomeLogistics.returnSpares`);
- a job that moved no box or left one (the memory said room a chest no longer has) waits 10 minutes
  (`SPARES_BACKOFF_MS`);
- with no chest of spares, or only full ones, the boxes stay and the chore says so once, in the log and in chat:
  `home chore: I keep 4 spare shulker boxes: I know no chest of spares at home (a chest holding an empty shulker box,
  or one labelled boxes or shulkers; then !chests scan)` (or `... the chest of spares at home is full`). It says it
  again only after a chest of spares with room was known in between.

The log line is `unload (spare boxes): unloaded: 4 green_shulker_box -> chest 1 2 3; kept 1 green_shulker_box`. The
room chore waits for the job (`unloadDue`). A full unload (the bars above) still sends spares back as before, and with no
chest of spares it still puts them into the emptiest chest, which then is one.

## When

The chore (`room`, auto, priority 30 like the other chores) wants control only when all of these hold:

- no user process (running, paused or held) and no `!test` series;
- nothing else in control for 3 s (`ROOM_SETTLE_MS`: a flight, a fight and its sweep, a flee, the night shelter, the
  home return, a home job all keep it off, and the sweep after a fight picks up first);
- the inventory unchanged for 3 s (a pile of drops being picked up, items being given: the pass plans on what is
  there once it stops);
- the survival kit, the stash step and the home logistics idle, no skill running (a command's `!drop` or `!place`), no
  hostile within 12 blocks (`ROOM_MOB_RANGE`);
- at home, no unload running or due;
- fewer than 4 slots free and a step to take.

A command pre-empts a pass at once (priority 40 over 30): the step's skill is cancelled and the rest waits for the next
quiet. A step kind that failed (no cell for the box, a refused drop) is not planned for 5 minutes
(`ROOM_STEP_BACKOFF_MS`); a pass that freed nothing waits 2 minutes (`ROOM_RETRY_MS`).

## What the owner sees

- The log: one `inventory: ...` line a step (`inventory: merged 7 cooked_beef (slot 28 -> 5)`, `inventory: 294
  firework_rocket into the fireworks box`, `inventory: boxed 19 bone, 17 redstone into the shulker box in slot 18`,
  `inventory: dropped 448 cobblestone (dropStone 64)`) and one a pass (`inventory: 0 -> 8 slots free in 14.2 s: ...`).
- Chat: one line a pass that boxed loot or dropped stone, at most every 10 minutes (`ROOM_SAY_MS`). Merges, the junk
  and the rockets are not said.
- With the room short and no step left, one line asks, at most once an hour for the same reason (`ROOM_ASK_MS`):
  `inventory: 2 slots free and nothing I may drop or box; I know no chest at home: a chest within 16 blocks of it (then
  !chests scan) would let me unload; or give me an empty shulker box`. With chests known it says `I unload when I am
  home (!unload there)` away from home, and at home (the chests full, or nothing left they take) `the chests at home
  take none of what is left (!unload says what stays)`.

The bot does not craft and place a chest of its own when it has a home and no chest: it cannot tell a build or a path
from open ground, and it asks instead.

## A full inventory and the hotbar

The place skill's `selectItem` and the farm's click bring an item from the main inventory into a full hotbar by parking
the hotbar's least useful item (no durability first, the selected slot last, never one the job wants) in a free main
slot. With 36 of 36 there is none: both failed with `move_failed` and said nothing, so a build block or the bone meal in
the main inventory was never used. Now, with no free main slot, the wanted item and that hotbar item change places in
one swap request (the survival kit's `exchange`, registered under the inventory model in `container/exchange.ts`, the one
the hotbar puller has used since Track T2 follow-up 2):

    place: cobblestone moved from slot 20 to 8 (bone exchanged into 20: the inventory is full)

With no exchange (no survival kit), or a refused move, the reason goes to the log once a minute per item and reason:

    place: no hotbar slot for cobblestone (slot 20): the inventory is full (36 of 36) and no exchange is wired

## A drop stays dropped

Bedrock hands an item to a player whose box (grown by about 1 block sideways) touches it once its pickup delay (about
2 s) has run out; the bot cannot refuse it. A stack dropped at the feet of a bot that stands still comes back, and a
collect walks to anything in reach. On the Realm the stone step dropped 434 cobblestone three times in 12 s. Two rules
(`bot/src/skills/inventory/thrown.ts`, ADR 0090 decision 13):

- **The collector skips the bot's own throws.** The keeper announces every drop request before it goes out
  (`ThrownItems.expect`); an item actor of that item that spawns at the body (within 1.5 blocks sideways, from 0.5
  below to 2.5 above the feet) within 2 s is the throw, and every collect (a fight's sweep, a job's, a box pickup)
  skips its runtime id for 5 minutes, an item's despawn time. A zombie's rotten flesh beside the bot's own is a new
  entity and is picked up.
- **The body walks away** (the junk and stone steps, `throwAway`): it faces a direction with no block within 3 cells at
  the feet and the head (the throw does not bounce back off a wall; nothing unloaded), the opposite one free too if it
  can, looks a little above the horizon, drops, and walks at least 4 blocks from any of its stacks that landed within 3.
  One log line says it (measured): `inventory: threw 434 cobblestone: 7 items seen thrown, walked out of reach: ok`.

The keeper's own junk drop at 36 of 36 runs during jobs too and does not move the body; the collector rule holds there.

Measured on bds-home (`test-inv` e2e, the early preset away from home, 2026-11-16, one run each): the stone step
dropped 434 cobblestone once (7 stacks seen thrown, the walk out of reach ok); 60 s idle after it: no drop again, 10 free
before and after, 64 cobblestone carried, the 7 stacks still on the ground. Then a zombie summoned beside the bot and
killed by the guard: its collect `gained {"rotten_flesh":2}`, the 7 stacks left lying, no drop again. On main's code the
same run: the idle part held too (BDS did not hand the stacks back to a bot standing still; on the Realm it did), but
the fight's collect took back all 434 cobblestone (`gained {"cobblestone":434,"string":2,"rotten_flesh":5}`) and the
room chore dropped twice more.

The box step's check that the right box was placed counts the boxes carried by what they are (name, custom name,
contents), wherever they lie: an exchange that gives the fireworks box the plain box's old slot, a resync or a keeper
move between the place and the check no longer reads as a wrong box (ADR 0090 decision 14). The `test-inv` e2e case
with the Realm's hotbar (tools in every slot but the fireworks box's) brings the plain box in by exchanging it with the
fireworks box and fills it (`2 -> 21 slots free`, the fireworks box's 165 rockets kept). That case passed on main's code
too: BDS did not reproduce the Realm's false verdict, which the unit test reproduces by another box moving during the
place.

## Settings

| Key | Default | What |
|---|---|---|
| `dropStone` | 64 | the stone step: of each stone-like block this many are kept, the rest dropped, idle away from the home chests with fewer than 4 free and nothing cheaper left; never what a `!get` of the last hour got; 0 = never |
| `stashShulker` | on | (existing) off: no carried box is set down for loot |
| `autoUnload` | on | (existing) the home chore, now also below 4 free slots |

Not known to the bot, and left: items the owner gave a moment ago. The bot cannot tell a gift from a pickup; the steps
drop only the keeper's junk and, with `dropStone` above 0, stone beyond that many of a kind.

## Measured

On bds-home (flat, peaceful, the truth pack; the inventory set slot by slot under a held user process, then the hold
released and the chore left alone), 2026-11-15, on a PC:

| Case | n | Before (main 058ae4b6, the same cases, 1 run each) | With Track V1 |
|---|---|---|---|
| The live inventory idle away from home: 36 of 36 (the netherite kit, 422 loose rockets in 7 stacks beside a fireworks box of 165, 5 empty boxes, 7 kinds of food, three split stacks) | 5 | 0 free after 45 s, no line in the log: nothing merges, the rockets stay loose | 0 -> 8 free in every run, the pass 4.0 to 5.1 s (7.3 to 8.4 s after the release, the 3 s quiet included): 3 merges and 294 rockets into the fireworks box (128 loose, 459 in the box); nothing dropped, every item counted loose and boxed |
| Early game away from home: stone tools, torches, bread, coal, raw iron and copper, flint, logs, lapis, 498 cobblestone in 9 stacks, deepslate, dirt, gravel, andesite, diorite, granite, tuff, rotten flesh, string | 5 | 2 free after 45 s: the keeper dropped the rotten flesh and string at 36 of 36 (`keeper: stocked 0, dropped 7`) and nothing more; the next two new kinds fill it again | from 0 to 2 free (the keeper's drop) to 10 in 5.0 to 5.2 s (the pass 1.6 to 1.7 s): a merge of 20 cobblestone and 434 cobblestone dropped (64 kept); then 8 more stacks of cobblestone given: 2 -> 10 free in 1.3 to 1.4 s, 512 dropped; no tool, food, ore, coal, torch, log, flint, bone or lapis lost |
| The place skill and the farm click with 36 of 36, the item in the main inventory (the hotbar 9 kinds no job wants, the main inventory dirt) | 5 a skill, before and after | main's code: `move_failed`, nothing in the log (not run on main; this track's code with the exchange taken away: `move_failed` and `no hotbar slot for cobblestone (slot 20): the inventory is full (36 of 36) and no exchange is wired`, in runs 1, 3 and 5: once a minute) | placed and clicked in 5 of 5 each: `cobblestone moved from slot 20 to 8 (bone exchanged into 20: the inventory is full)`, `stone_hoe moved from slot 20 to 7 (brick exchanged into 20: ...)`; nothing lost (one cobblestone placed) |
| The live inventory at home with chests and a chest of spares | 5 | 7 unloadable stacks, under the bar of 8, and no full box: no unload in 60 s, 0 free | the slot trigger in 5 of 5: 10 stacks into 2 containers and 4 spare boxes back to the chest of spares (one kept), 0 -> 11 free in 9 to 10 s; the kit, the rockets, the food and the reserves stay, every item counted in the chests |
| The same at home after the room pass (the live bot after the first deploy): 5 free, 7 unloadable stacks, no full box, 5 empty boxes; spares job (decision 11) | 5, before and after | main e372ee3d, 5 runs: nothing in 60 s, 5 free, the 5 boxes carried, no unload or room line | the spares job in 5 of 5: 4 boxes into the chest of spares (one kept for the stash step), 5 -> 9 free in 7 to 8 s (the trip 1.5 to 1.9 s); nothing else left the inventory or reached a chest, no unload and no room pass |
| The same with no chest of spares (no chest holds an empty box, none is labelled for boxes) | 1 | - | the boxes stay (nothing moved in 15 s more) and one line in chat and the log: `home chore: I keep 4 spare shulker boxes: I know no chest of spares at home (...)` |

The first three cases run with every item counted: what left the inventory is in the fireworks box, in a carried box
or, for junk and stone only, on the ground.

## Test presets on a server with cheats (Track T3)

The cases above were set up by the truth pack, which only a test server has. On any world with cheats on where the bot
is an operator (a backup of the Realm, a test server), the bot can set its own inventory by slash commands:
`!test inv <preset>` (owner only, `testMode` on, the op check of `!test`; `bot/src/skills/test/inv.ts`).

| Command | What |
|---|---|
| `!test inv full` | every free slot: food, drops and odds in partial stacks, then full stacks of stone-like blocks: 36 of 36 |
| `!test inv early` | stone tools, torches, bread, a crafting table, coal, raw iron and copper, flint, bones, logs, lapis, rotten flesh, string and 19 stacks of cobblestone, cobbled deepslate, dirt, gravel, andesite, diorite, granite, tuff (36 stacks; the first ones if fewer slots are free) |
| `!test inv split` | the same kinds in split stacks (the merge step) |
| `!test inv rockets` | 422 loose rockets in 7 stacks beside the fireworks box, the other slots full stacks the chore neither drops nor merges; without a fireworks box the reply says the rockets stay loose |
| `!test inv fullbar` | the hotbar nine kinds no job asks for, the main inventory full stacks with 32 cobblestone among them only: the place and farm exchange at 36 of 36 |
| `!test inv status` | what the room chore did since: its passes and their `inventory: ...` steps, the free slots, the counts changed |
| `!test inv restore [sweep]` | the saved inventory back; `sweep` first removes the items on the ground within 8 blocks (`/kill @e[type=item,r=8]`: the stone and junk the chore dropped, and anything else lying there) |

How it goes:

1. Refused while a trip, a flight, a fight, a test series, another process in control (a room pass: try again in a
   moment) or a skill runs, and while an earlier save waits for its restore. The first reply comes before the command
   returns (the panel's command box shows only what is said meanwhile), and every refusal is one INFO line with its
   reason (`test inv: refused: ...`).
2. The save: every slot with its NBT, the boxes' contents and the worn pieces, in memory and in `<tests dir>/inv-saved.json`
   (a restart keeps it; the restore removes it).
3. The server's count of every item it will clear (`/clear @s <item> -1 0` counts without clearing) must match the
   inventory model, else nothing is cleared. A name the server does not know stays in place.
4. The reply says what stays in place before anything is cleared:
   `test inv early: saved; 23 slots cleared and given back exactly by !test inv restore, 5 stay in place (...); the
   food stays (3 stacks); ...`. The food the bot eats (not rotten flesh and the other bad kinds) is not cleared: it
   stays in its slot and the restore puts its saved count back, so a preset never takes the food below what the bot
   carried (see "While a save waits" for why).
5. One `/replaceitem` a slot (`keep` into an empty one, so a pickup meanwhile is not overwritten), under a do-nothing
   user process (taken before the save, released after the last command) so no chore moves items meanwhile; the
   commands paced under the harness's 60 a minute (a preset is about 8 counts and 30 slots in 5 to 9 s; a restore within
   the same minute waits up to 45 s for the limit). The log has a
   `test inv <preset>: before: ...` and an `after: ...` line with the free slots and every count.
6. Then the room chore acts on its own as it would (3 s of quiet, fewer than 4 free).

### What the commands can give back

Measured on BDS 1.26.60 (bds-home), by the bot's own `command_request`:

| Item | A command gives it back? | So |
|---|---|---|
| a plain item (no NBT): food, blocks, drops | yes: name, count, metadata as the data value (a potion's kind) | cleared and restored |
| a firework rocket of duration 1 | yes: `/replaceitem` gives `Fireworks {Flight 1, no explosions}` | cleared and restored |
| a crafted rocket of duration 2 or 3, one with explosions | no | stays in place |
| durability (a tool, armour, the elytra) | yes: the data value is the `Damage` | stays in place anyway: gear, the elytra and the owner's tools are never cleared |
| enchantments | no (`/enchant` works on the held item only, up to the enchantment's level) | stays in place |
| a custom name, any other NBT (maps, books, banners) | no | stays in place |
| a shulker box | an empty unnamed one only, never its contents | every box stays in place |
| the worn pieces, the offhand | (not touched) | never touched |

The restore:

- a slot that held a restorable stack or nothing gets it back by `/replaceitem` (or `air`);
- a slot holding a kept item now (the hotbar puller moved the sword there) is never overwritten: its saved stack comes
  by `/give`. Each kept item of the save claims one slot (by name and NBT without the wear: a new tool has no NBT, the
  same tool after one dig has `{Damage: 1}`), its own with the same wear first, then any slot worn as much or more, so
  the preset's new stone pickaxe goes and the owner's worn one stays; gear of a kind no preset gives, boxes, elytras,
  enchanted or named items that were not in the save stay too: a restore only ever overwrites restorable stacks and
  the presets' own stone tools. The `/give` commands run after every `/replaceitem` (Track V1c: `/give` takes the first
  empty slot, and a later `/replaceitem ... air` could clear it; the rockets preset's box came back into a lower slot
  its own moves had freed, so the stack saved there was given and then lost). Such a restore holds the same stacks
  with the box and that stack in each other's slots;
- the slots to empty go before the saved stacks (Track T3 follow-up): with the food in place a preset's stacks can sit
  beside the slot a saved partial stack goes back to, and on bds-farm (2026-11-16) 3 of 8 `full` runs ended with 48 of
  the preset's cobblestone moved onto the owner's restored 16 between two commands; with the empties first no saved
  partial stack ever sits beside a preset's stack of its own item;
- `sweep` is left out (and said) while a kept item of the save is not carried: it may lie on the ground;
- what the room chore put into a box of the save is taken back out (Track T3 follow-up 2). A command can neither give
  nor clear a box's contents, and on the Realm (2026-11-16) the preset's boxed items (798 cobblestone, 82 coal, 74 raw
  copper, 46 raw iron and more in the bot's bot_loot boxes) stayed after the restore, and the next unload at home put
  55 stacks of them into 23 of the owner's containers. So after the commands the restore places each box that gained
  items where the room chore places it (`BoxOps.takeBack`, the Supply's box ops under the logistics' lock), takes out
  exactly what the box gained since the save, by item name (`boxedExcess`: an item the box held as much of before is
  never touched), the box's last slots first (a deposit fills the free slots after the box's own stacks), breaks it,
  picks it up, and a second plan puts every slot as saved (the items taken out go by `/replaceitem`: nothing is
  dropped). Up to 3 rounds when the inventory has no room for all of it at once. Said:
  `took back out of the boxes andesite 128, ... ; still in the boxes coal 20 (no free cell for the box next to the bot)`
  when something stayed. The box comes back into the first free slot, not always its own (on bds-farm, 2026-11-16: a
  bot_loot box of 12 bone took 14 kinds of the `full` preset, 829 items, and held 12 bone again after a 48 s restore,
  in slot 30 instead of 12). A box's items of the same name but other NBT (crafted rockets beside the preset's) are
  told apart only by that order. Kept items moved or gone and changed worn pieces are said too;
- one line before and after in the log; a refused command stops it and keeps the save.

### While a save waits

A preset fills the inventory with made-up items. Until the restore they must not leave the bot for the owner's chests,
and the bot must stay as safe as it was. On the Realm (2026-11-16) a series ran `fullbar`, which cleared the food and
gave none: 19 s later the food chore started (nothing to eat), the bot walked home for food, and the home chore
unloaded 55 stacks of the preset (coal, glass, logs, planks, raw metals, leather, wheat, paper) into 23 of the owner's
containers. Eight `!test inv restore` in 11 minutes were refused (another process in control), and neither the panel
nor the log showed it. The rules since (one module the movers ask, `bot/src/skills/test/guard.ts`):

| What | While a save waits | Why |
|---|---|---|
| the home chore's unload, spares and tidy jobs, the unload after a `!get` | held until the restore (no job starts; the scans still run, they move nothing) | the incident; held, not restored first: every preset leaves fewer than 4 free, the unload's own trigger, so restoring first would end every preset at home within a second |
| `!unload` | refused: `unload: not now: a !test inv full save from 09:30:31 UTC waits for its restore (!test inv restore first)` | the same items |
| the logistics' deposits (unload, tidy, spares, whoever starts them) | end at once, `held: ...`, nothing walked or moved | a second lock behind the first: no caller is missed |
| the stash step (a `!mine`, `!quarry`, `!gather`, `!get` filling up) | held: the job ends `inventory full` | its chest step puts the job's stacks into the owner's chest |
| the food chore | the restore runs first, on its own, then the chore goes on as before | it hunts away from the spot and walks home; the saved inventory has the food. Food is never held: when no restore can run (testMode off, not an operator, one failed in the last minute) the chore goes as before |
| the guard, the flee, the reflex, the eater, the night shelter | never held | a fight is never held |
| the room chore | runs (at home too: it no longer waits for an unload that will not come) | that is what a preset tests |

A walk home after a full quarry still goes (it keeps the bot out of the pit): nothing is unloaded there until the
restore.

**The food stays.** The presets leave the food the bot eats in place (above), so the food chore has no reason to
start in the first place; gear (the weapon and the armour) stayed in place already.

**A restore during a fight waits.** `!test inv restore` while the guard fights (or the flee, the night shelter, a room
pass) says `test inv restore: waiting for the fight to end (at most 3 min), then the restore` at once and runs when the
guard hands back; after 3 minutes (`RESTORE_WAIT_MS`: long enough for a fight with a few mobs, short enough that the
owner hears back) it says `... still after 3 min; the save is kept`. A chore below the owner's commands (the food
chore, the home return) is no reason to wait: the restore's hold takes control from it. A series, a flight or the
owner's own command still refuses it.

**The time limit.** A save waits at most 10 minutes (`INV_SAVE_LIMIT_MS`; a fill takes 5 to 9 s, a room pass 2 to 9 s,
and the Realm series waited 25 s before its restore), then the bot restores it on its own and says so in chat:
`test inv: restoring the saved inventory on my own (the save waited 10 min, the limit is 10 min)`. A save from before
a restart counts from its own time. With testMode off nothing is sent: the log says once that the save waits and the
unload with it. `!test inv status` says when: `restored on my own in 7 min`.

### Testing V1 on a world with cheats

    !set testMode on
    !test inv full        (away from home: the stone step; at home the unload waits for the restore)
    !test inv status      (a few seconds later: `room chore 1 pass (0 -> 6 in ... s): ...`)
    !test inv restore sweep

`early` and `split` show the junk, the merges and the stone step, `rockets` the fireworks box, `fullbar` the exchange
(a job right after it that needs an item from the main inventory, such as a build of cobblestone: the log line
`cobblestone moved from slot 20 to 8 (... exchanged ...)`).

## Tests

```sh
pnpm --filter bot exec vitest run --project unit inventory-room room-chore fetch-full place-skill home-logistics home-unloader
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e home-room --silent=false   # bds-home; ROOM_RUNS (default 5)
pnpm --filter bot exec vitest run --project unit test-inv test-commands
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e test-inv --silent=false    # bds-home; T3_OUT=<file> for the notes
```

- `inventory-room`: the plan over made-up slots: the live inventory (36 of 36 with three split stacks; without them,
  33), an early-game inventory, every rule on its own (keys, boxes, junk, stone, compaction, the home case), the lines,
  the home chore's trigger.
- `room-chore`: the chore against fakes: the quiet, one step at a time, the log and chat lines, a pre-emption, the box
  it filled taking the next loot, the backoffs, the ask line.
- `fetch-full` and `place-skill`: the farm click and the place skill with 36 of 36, before (no exchange) and after.
- `home-unloader` and `home-logistics` (the spares job): the plan moves only the spare boxes and only into a chest of
  spares; the chore runs it at 5 free, backs off after one that moved none, keeps the boxes and says so once with no
  chest of spares.
- `home-room` (e2e, bds-home, the inventories set slot by slot by truth): the live inventory away from home; the early
  game away from home, then stacks of cobblestone given until 2 are free; the place and click faults before and after;
  the live inventory at home with chests and a chest of spares; the same at home with 5 free (the spare boxes go back,
  nothing else moves); at home with no chest of spares (the boxes stay, one line).
- `test-inv` (unit): what stays in place, the presets, the preset and restore plans, the runner against a fake server
  (the order of the reply and the first clear, a count the server disagrees on, a refused command, a pickup meanwhile,
  the owner's tool swapped with the preset's, the status line's bytes); "While a save waits": no preset takes the food
  below what was carried (each preset, food in the hotbar too) and the restore is exact after the bot ate, refusals
  said at once and logged, a restore that waits out a fight and one whose wait runs out, the time limit (and a save
  from a file), `restoreFirst` for the food chore, the held lines once a save; the boxed items taken back out (only
  what each box gained) and the line when they cannot be. `supply-recovery`: `takeBack` takes only what is asked, the
  box's last slots first, and picks the box up again. `home-logistics`, `stash`, `food` and
  `test-commands`: the home chore, the deposits, the stash step and the food chore under a waiting save, and the
  guard on the afk registry.
- `test-inv` (e2e, bds-home, by the bot's own commands): each preset on an owner's inventory (worn netherite, an
  enchanted sword, a pickaxe, the elytra, a fireworks box, a named box, loose rockets, food): the kept slots and the
  preset's stacks by the server's own inventory read, a room pass (fullbar: the place skill's exchange), the status,
  the restore with every slot and count as before; a refusal while a user process runs and a second preset refused
  (each one INFO line). Then: the food chore asking to run while a save waits (the food cleared by a command: the
  restore goes first, on its own, the food is back, no hunt), a restore during a fight (two zombies summoned at
  difficulty easy: it waits, then runs), the time limit (shortened to 20 s), an unload due at home (the chests
  unchanged for 25 s, `!unload` refused), a carried bot_loot box holding 12 bone under the `full` preset with
  `dropStone 0` (the room pass boxes the preset's items into it; after the restore it holds 12 bone again and every
  carried count is as saved). Every preset case checks the boxes hold what they held;
  and (follow-up 3) the Realm's hotbar (the box exchanged with the fireworks box, `T3_PRESETS=v1d` runs only those
  cases) and the early preset's drop left lying 60 s idle and through a fight's collect.
- `thrown`, `collect` (the bot's own throws), `survival` (every drop announced) and `supply` (the box census): a drop
  stays dropped, and the box is followed through an exchange.
