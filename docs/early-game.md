# The early game: day one from an empty inventory (Track E1), the iron age (Track E2), the shaft, the furnace wait and a bed (Track E3), wear and setbacks (Track E4), a farm (Track E6), other ground (Track E5), dusk and the shell's blocks (Track E7), the early leftovers (Track E10), the way home and the morning after (Track E9)

What the bot does on a fresh survival world when it starts with nothing, the commands an owner types for the first
day, the iron age after the stone kit (a furnace, smelting, cooked food, iron tools and armour), and what is still
missing before it can live through the first nights on its own. Decision records:
[decisions/0098-day-one-from-nothing.md](decisions/0098-day-one-from-nothing.md),
[decisions/0099-iron-age.md](decisions/0099-iron-age.md),
[decisions/0100-shaft-furnace-bed.md](decisions/0100-shaft-furnace-bed.md),
[decisions/0101-wear-and-setbacks.md](decisions/0101-wear-and-setbacks.md) (the job through wear and setbacks, Track E4),
[decisions/0102-starter-farm.md](decisions/0102-starter-farm.md) (a starter farm, the farm chore and bread, Track E6),
[decisions/0103-early-chain-other-ground.md](decisions/0103-early-chain-other-ground.md) (the chain on other ground, Track E5),
[decisions/0104-dusk-shell-blocks-creeper-end-line.md](decisions/0104-dusk-shell-blocks-creeper-end-line.md) (a job at dusk, the shell's blocks, the end line, Track E7),
[decisions/0111-way-home-and-morning.md](decisions/0111-way-home-and-morning.md) (the way home from the mine, the morning after a night, Track E9),
[decisions/0112-early-leftovers.md](decisions/0112-early-leftovers.md) (the shell's open sides, the cook's fuel, sheep for the bed, a step lost to flights, Track E10).

Measured on BDS 1.26.60.6 (itzg/minecraft-bedrock-server 2026.10.2), a default-generated world (a forest with stone
under it near spawn), difficulty normal, the daylight cycle and mob spawning on, the bot alone with an owner in
spectator mode far away. Each run starts on a freshly generated copy of the same world. The e2e cases run on a flat,
peaceful test server with the truth pack.

## Files

| Path | What |
|---|---|
| `bot/src/skills/craft/chain.ts` | `planChain(index, targets, slots, opts)`: the crafts that make the targets from what is carried (planks, sticks, a crafting table first), and the raw materials still missing; `chainText`, `carried` |
| `bot/src/skills/craft/table-spot.ts` | `tableSpots`: where a crafting table may be set down next to the feet (a cover such as leaf litter is cleared first); `clearableCover` |
| `bot/src/skills/items/obtain.ts` | `nextAction(index, targets, slots, opts)`: the next command towards a set of targets (gather, mine, hunt, food, craft) or why there is none; `EARLY_KIT`, `minedBlockFor`, `pickaxeFor`, `canHarvestWith`, `foodCarried`, `itemAlias` |
| `bot/src/chat/commands-kit.ts` | `ObtainController`: the obtain job behind `!get <craftable>` and `!get kit`; `registerKitCommands` (after `!get` and the crafter) |
| `bot/src/tasks/night-shell.ts` | `NightShell` (`nightShell`): walled in at an open shelter after dusk, a side dug open at dawn; `roofOver`, `shellExit` |
| `bot/src/tasks/night.ts` | `NightSafety.shell`: the hooks (inside after dusk; before the walk home at dawn) |
| `bot/src/chat/commands-craft.ts`, `bot/src/skills/craft/crafter.ts` | `!craft` runs a chain in its process; the table spot rule |
| `bot/test/unit/skills/craft-chain.test.ts`, `obtain.test.ts`, `table-spot.test.ts`, `bot/test/unit/chat/kit-commands.test.ts`, `bot/test/unit/tasks/night-shell.test.ts`, `bot/test/unit/fixtures/crafting-data-early-1.26.60.json` | unit tests on the server's own early-game recipes (89 grid recipes recorded from BDS 1.26.60.6) |
| `bot/test/e2e/dayone-craft.test.ts`, `dayone-get.test.ts`, `dayone-shell.test.ts` | e2e cases (below) |
| `bot/src/skills/food/smelt.ts` | Track E2: what a furnace makes of what (`SMELTS`, `PLANNED_SMELTS`), which block takes what (`cookerTakes`), `smeltTicksOf`, `fuelItems`, `smeltableCounts` |
| `bot/src/skills/food/furnace.ts` | `placeFurnace`: a furnace set down where the cooker looks (by home, or next to the bot); `furnacesCarried`, `furnaceReasonText` |
| `bot/src/skills/food/cook.ts` | the cooker: `inputs`, `limit` and the block kind for a smelt (the window, fuel and output as for food) |
| `bot/src/tasks/process/smelt.ts`, `bot/src/chat/commands-smelt.ts` | `SmeltJob`, `SmeltProcess`; `!furnace`, `!smelt`, the cook step's furnace (`cookFurnace`) |
| `bot/src/skills/items/obtain.ts`, `bot/src/chat/commands-kit.ts` | Track E2: the smelt, furnace and cook steps, the fuel rule, `IRON_KIT`, soft targets, worn counted |
| `bot/src/skills/craft/table-spot.ts` | Track E2: a wall cell dug out when no cell is free (`dig`), `canHarvestCarried` |
| `bot/src/skills/mine/miner.ts` | Track E2: after a timeout the closest ore's touching vein is skipped with it |
| `bot/test/unit/skills/smelt.test.ts`, `obtain-iron.test.ts`, `bot/test/unit/fixtures/crafting-data-iron-1.26.60.json`, `bot/test/e2e/iron-smelt.test.ts`, `iron-get.test.ts` | Track E2 tests (99 grid recipes recorded from BDS 1.26.60.6: the early ones, iron tools, armour, the bucket, the shield, shears) |
| `bot/src/skills/combat/combat.ts`, `bot/src/skills/combat/reflex.ts`, `bot/src/tasks/pve.ts` | Track E3: the blade strike (`PveRules.bladeStrike`; docs/pve.md "The blade strike") |
| `bot/src/tasks/smelt-shell.ts`, `bot/src/tasks/process/smelt.ts` | Track E3: `SmeltShell` (`smeltShell`), `smeltOutlastsDay`, `shellStandCell`, `smeltShellBrace` |
| `bot/src/tasks/night.ts` | Track E3: `NightSafety.wantsControl` keeps control while the night shell is still shut after dawn |
| `bot/src/skills/survival/bed-place.ts` | Track E3: `placeBed`, `bedSpots`, `sheepForBed`, `bedsCarried` |
| `bot/src/tasks/process/bed.ts`, `bot/src/chat/commands-bed.ts` | Track E3: `BedJob`, `BedProcess`; `!bed [status]`, `bedControlOf` |
| `bot/src/skills/food/finder.ts`, `hunter.ts`, `bot/src/tasks/process/food.ts`, `bot/src/chat/commands-food.ts` | Track E3: the hunt's `keep` (the bed's sheep) |
| `bot/src/skills/items/obtain.ts`, `bot/src/chat/commands-kit.ts` | Track E3: the `bed` step, the iron kit's bed (`last`), `noDyeRecipe`, the herd walk for a hunt, a soft hunt capped |
| `bot/test/unit/skills/blade-strike.test.ts`, `bed-place.test.ts`, `bot/test/unit/tasks/smelt-shell.test.ts`, `bot/test/e2e/early-shaft.test.ts`, `early-smelt.test.ts`, `early-bed.test.ts` | Track E3 tests |

| `bot/src/skills/items/wear.ts` | Track E4: `usableSlots` (the inventory without the tools the worn-tool rule refuses), `wornTools`, `replacedBy`, `toolKind` |
| `bot/src/skills/items/placed.ts` | Track E4: `PlacedBlocks`, `placedOf(task)`: the furnaces the bot set down (`FURNACE_RECALL` 64) |
| `bot/src/skills/items/death-return.ts` | Track E4: `deathReturnPlan` (whether and how long to walk back to a death spot), `stacksRecovered` |
| `bot/src/tasks/process/recover.ts` | Track E4: `RecoverProcess` (`recover`: the walk back and the pick-up), `WorkProcess` (the job's `tables` sweep) |
| `bot/src/chat/commands-kit.ts` | Track E4: the worn-tool stop in a mine step, the held tables and their sweep, the death handling (`afterDeath`, `deathReturn`), the end line's notes |
| `bot/src/skills/craft/crafter.ts` | Track E4: `holdTables`, `ownTables`, `sweepTables`, the wider pick-up of a dug table's drop |
| `bot/src/chat/commands-smelt.ts`, `bot/src/tasks/process/smelt.ts`, `bot/src/skills/food/cook.ts` | Track E4: placed furnaces recorded and offered, the smelt opening its own furnace first (`prefer`), `SmeltControl.held` / `collect` |
| `bot/test/unit/skills/obtain-wear.test.ts`, `bot/test/unit/chat/kit-setbacks.test.ts`, `bot/test/unit/tasks/recover-process.test.ts`, `bot/test/e2e/early-wear.test.ts` | Track E4 tests (and new cases in `craft-crafter.test.ts`, `smelt.test.ts`, `test-recovery.test.ts`) |
| `bot/src/skills/farm/plot.ts`, `setup.ts`, `bot/src/tasks/process/farm-new.ts`, `bot/src/chat/commands-farm-new.ts` | Track E6: `!farm new` (the plot, its work), the farm chore (`farmFood`), bread ([farming.md](farming.md) "A starter farm") |
| `bot/test/unit/skills/farm-new.test.ts`, `bot/test/e2e/early-farm.test.ts`, `bot/test/e2e/fresh-days.test.ts` | Track E6 tests; `fresh-days` is the harness for the days left alone below (skipped unless `FRESH_DAYS=1`) |
| `bot/src/skills/mine/branch.ts`, `bot/src/chat/commands-explore.ts` | Track E5: branch mining walks out of the base first (`leaveBase`, `baseExits`, `BASE_EXIT_MARGIN`; `BranchHost.protectedArea`) |
| `bot/src/skills/mine/miner.ts` | Track E5: the rescan log says why each known ore was not taken (`goneWhy`) |
| `bot/src/skills/craft/chain.ts` | Track E5: a tag cell tries the kinds a recipe makes from what is carried (`tagCandidates`) |
| `bot/src/chat/commands-kit.ts` | Track E5: `coalNearOutsideBase` (the fuel rule's coal outside the base) |
| `bot/src/skills/items/obtain.ts` | Track E5: `gatherCommand` (`!gather` asked for the total) |
| `bot/src/skills/craft/crafter.ts` | Track E5: `ownTableInReach` (the job's own table used with no clear line) |
| `bot/test/unit/skills/branch.test.ts`, `craft-chain.test.ts`, `craft-crafter.test.ts`, `obtain-gather.test.ts`, `bot/test/unit/chat/kit-coal.test.ts`, `bot/test/e2e/early-base.test.ts` | Track E5 tests |
| `bot/src/chat/kit-night.ts` | Track E7: the job at dusk: `shelterPlan`, `herePlan` (where the night is spent), `DUSK_STOPS`, `beforeDusk`, `stepProgress`, the ports `ObtainNight`, `ObtainBlocks` |
| `bot/src/chat/commands-kit.ts` | Track E7: `duskDue`, `nightPause`, `refillDue`, `refill` in the obtain job; the wiring (`jobDusk`, `shellBlocks`, the blocks chore, the kept end line) |
| `bot/src/tasks/night-shell.ts`, `bot/src/tasks/night.ts` | Track E7: `enclosedSpot` (a roofed spot the body can walk to), `shellStepOut` (out of a shell over a hole); `NightSafety.retryNow` |
| `bot/src/skills/survival/shell-blocks.ts`, `bot/src/tasks/shell-refill.ts` | Track E7: the shell's blocks: `refillCell`, `refillCells`, `refillBlocks`, `shellShort`; `refillDeps` (the base, the shelter's ground, the walk out), the `blocks` process, `BlocksChore` (`blockschore`) |
| `bot/src/chat/chat.ts` | Track E7: `Chat.sayKept` (a line kept past the rate limit) |
| `bot/test/unit/chat/kit-dusk.test.ts`, `bot/test/unit/tasks/kit-night.test.ts`, `shell-blocks.test.ts`, `night-shell.test.ts`, `bot/test/unit/chat.test.ts`, `bot/test/e2e/early-dusk.test.ts`, `early-blocks.test.ts` | Track E7 tests |
| `bot/src/skills/survival/seal.ts`, `bot/src/skills/place/place.ts` | Track E10: `faceSupports` (a support or a brace before a cell with no face), `openCellsText`; `clickableBlock`, `clickableName` |
| `bot/src/skills/food/cook.ts` | Track E10: `planFuel` (one kind that covers the batch), the second fuelling (`COOK_REFUELS`) |
| `bot/src/chat/kit-search.ts`, `bot/src/chat/kit-flights.ts`, `bot/src/chat/commands-kit.ts` | Track E10: the hunt's search walk (`huntLegs`, `standAt`, `ObtainController.search`); the flights in a step (`StepFlights`); the ports `preempt`, `seen`, `position`, `standY` |
| `bot/src/chat/commands-get.ts` | Track E10: `!get status` names the obtain job's end line |
| `bot/test/unit/skills/seal-faces.test.ts`, `food.test.ts`, `bot/test/unit/chat/kit-search.test.ts`, `kit-flights.test.ts`, `bot/test/e2e/early-leftovers.test.ts` | Track E10 tests |
| `bot/src/skills/nav/navigator.ts`, `bot/src/skills/nav/digway.ts` | Track E9: a walk whose body is shut in digs out (`digOutShutIn`, `DIG_OUT_MAX_BLOCKS`; [pathfinding.md](pathfinding.md) "Shut in") |
| `bot/src/skills/nav/reach.ts`, `bot/src/skills/food/furnace.ts`, `bot/src/skills/survival/bed-place.ts`, `bot/src/tasks/night.ts` | Track E9: a refused walk says why (`walkFailWords`; the furnace step, the bed step and the night rule ask the navigator) |
| `bot/src/tasks/pve.ts` (`workThreat`), `bot/src/tasks/creeper-rise.ts`, `bot/test/e2e/early-mine.test.ts` | Track E12: the mine's dangers (`workGuard` on by default, `creeperRise` off; [pve.md](pve.md)) and their scenes |
| `bot/src/chat/kit-morning.ts` | Track E9: the morning rule: `morningBlock`, `nearestHolding`, `censusText`, `MORNING_SUN`, `MORNING_NEAR`, `MORNING_MAX` |
| `bot/src/chat/commands-kit.ts`, `bot/src/tasks/night.ts` | Track E9: the job's wait for the morning (`jobMorning`), `NightSafety.hold` (the dawn waits in the shelter; `HELD_DAWN_MS`), `ObtainController.nightPaused`; the job's craft tried again (`OBTAIN_CRAFT_RETRIES`), its wait for health (`OBTAIN_HEAL_HEALTH`, `OBTAIN_HEAL_MS`, `OBTAIN_HEAL_WAITS`), the step limit (`OBTAIN_MAX_STEPS` 40) |
| `bot/test/unit/skills/nav-shut-in.test.ts`, `bot/test/unit/chat/kit-morning.test.ts`, `kit-dusk.test.ts`, `bot/test/unit/tasks/night-shell.test.ts`, `bot/test/e2e/early-home.test.ts` | Track E9 tests |

## Day one as an owner types it

An empty bot, the owner's commands in the order a player would ask, each read before the next. Before this track
(times from the command to the reply that ends it):

| Command | Time | What it said |
|---|---|---|
| `!inv` | 1.8 s | `inv 0/36 ... items none` |
| `!get crafting_table` | 1.8 s | `get: I do not know how to get crafting_table; I can get: wood, ores (...), stone, ...` |
| `!get wood 8` | 45 s | `gather done: 12/8 logs` (two trees by hand) |
| `!craft crafting_table` | 1.8 s | `craft: no oak_planks for crafting_table (need 4, have 0)` |
| `!craft oak_planks 12`, `!craft crafting_table` | 2.3 s each | crafted |
| `!craft wooden_pickaxe` | 1.8 s | `craft: no stick for wooden_pickaxe (need 2, have 0)` |
| `!craft stick 4` | 2.3 s | crafted |
| `!craft wooden_pickaxe` | (no end line) | `crafting 1 wooden_pickaxe (...)`, then `craft: made no wooden_pickaxe (no_table)`: no cell round the feet took the table (leaf litter round it, leaves over it); the end line was lost to the reply limit |
| `!get stone 16` | 1.8 s | `mine stone: stopped at 0/16, no tool in the inventory harvests stone` |
| `!craft stone_pickaxe` | 1.8 s | `craft: no stone_tool_materials for stone_pickaxe (need 3, have 0)` (a recipe tag) |
| `!get food` | 47 to 83 s | `food: 6/6 items from 1 cow, 1 pig, 1 sheep; cook: no furnace or smoker within 32 blocks; the raw food is kept` |
| `!craft furnace` | 1.8 s | `craft: no stone_crafting_materials for furnace (need 8, have 0)` |
| `!home set`, `!shelter set` | 1.8 s | `home set to ...`, `shelter set to ...` (where the bot stands) |
| `!kill sheep 3` | 1.8 s | `kill sheep: 0/3, no more within 32 blocks` (the food hunt had taken them) |
| `!craft white_bed` | 1.8 s | `craft: no recipe for white_bed ...` (the item is `bed` on Bedrock) |

At the end of the day: logs, planks, sticks, a crafting table, raw meat; no pickaxe, no sword. The night after (the bot
left alone at the shelter on open grass): skeletons shot it from beyond reach while zombies closed in; it fled, came
back to the shelter, was shot again (health 3 at one point), and died to an arrow two thirds through the night. It
ended the night alive after the respawn, 138 blocks from home, fleeing.

After this track, the same day:

| Command | Time | What it says |
|---|---|---|
| `!get kit` | 124 to 213 s (13 runs) | `getting the kit (crafting_table, stone_sword, stone_pickaxe, stone_axe, 16 cobblestone, 6 food): first !gather 4`, each step's own replies, then `get kit: done in 124 s, 7 steps (gather 4, craft wooden_pickaxe 1, mine stone 24, craft stone_sword 1, craft stone_pickaxe 1, craft stone_axe 1, food 5)` |
| `!get stone_pickaxe` | 43 s (test patch) | `getting stone_pickaxe: first !gather 3`, then `get stone_pickaxe: done in 43 s, 4 steps (gather 3, craft wooden_pickaxe 1, mine stone 3, craft stone_pickaxe 1)` |
| `!craft wooden_pickaxe` with 6 logs | 7.7 s | `crafting 1 wooden_pickaxe (first 12 oak_planks, 1 crafting_table, 4 stick, crafting table)`, `crafted 1 wooden_pickaxe (3 oak_planks, 2 stick used) in 1.2 s; crafting table placed and picked up; first crafted 12 oak_planks, 1 crafting_table, 4 stick` |
| `!craft stone_pickaxe` with planks only | at once | `craft: no cobblestone for stone_pickaxe (3 cobblestone missing; it would craft 1 crafting_table, 4 stick first; !get stone_pickaxe gets it all)` |
| `!craft wooden_pickaxe` on leaf litter | 5.7 s | crafted; the table on a litter cell cleared first, picked up after |
| `!get iron_pickaxe` | at once | `get iron_pickaxe: no way to get iron_pickaxe yet: it needs iron_ingot, which is not gathered, mined, hunted or crafted from those` |

## Craft chains

`!craft <item> [n]` with too little of an ingredient that a recipe makes from what is carried crafts that first, in the
same process (one `!stop` ends it all). The rules (`planChain`):

- What is carried is used first; only the shortfall is crafted, and a step's surplus (12 planks from 3 logs) stays for
  the next.
- A recipe never consumes its own output or an item on the way to it (no loops), depth 5 at most.
- A 3 x 3 recipe with no table carried or standing near adds one crafting table (4 planks), counted once for the chain
  and not consumed: the crafter places it and picks it up.
- A tag cell (any planks, a stone tool material) tries the kinds carried, most first, then the kinds a recipe makes
  from something carried (spruce planks with spruce logs carried; Track E5), then a default (`oak_planks`,
  `cobblestone`), then the rest the server knows, six kinds at most. Kinds are not mixed in one cell's count.
- What no recipe makes from what can be had is missing and named as the item (`cobblestone`, never the tag
  `stone_tool_materials`). With `raw` given (the obtain job), a recipe that would need something that cannot be
  gathered, mined or hunted is not chosen: `iron_pickaxe` is missing `iron_ingot`, not the iron block an ingot unpacks
  from.
- Tools, armour, food and the flight kit are never ingredients (as before: `neverConsume`); `craftReserve` holds.

The refusal says what would be crafted first and, when the obtain job could get the rest, `!get <item> gets it all`.

## The crafting table spot

The crafter used to set its table down where a shulker box could go: an empty cell with air over it (the box's lid).
A bot that had just felled trees stood among leaf litter with leaves over it, and no cell passed. A table has no lid.
The rule now (`tableSpots`):

- the 12 cells round the feet at the feet's height (the four sides, the corners, two out), free ones first, nearest first;
- the cell empty (air or a replaceable plant), or a cover a hand clears at once (leaf litter, petals, a flower, a tuft,
  a sapling, a mushroom; never leaves, liquids, containers or anything a click opens), which is dug first;
- a full solid top under it, not a built block and not a container; not in the body;
- Track E2: when no cell passes (a one-wide tunnel whose open cell a furnace took), a wall cell is dug out: one of the
  four sides at the feet's height, a natural block a carried tool harvests, not built, with a full top under it, no
  falling block or liquid over it, and no liquid or unloaded cell next to it or under it.

Measured on a flat server, litter in every cell round the feet and leaves over them: before `craft: made no
wooden_pickaxe (no_table)` at once; after, crafted in 5.7 s, the table picked up again.

## From nothing: `!get <craftable>` and `!get kit`

An item the `!get` catalog does not know but a recipe makes starts an obtain job. `!get kit` (also `kit early`) asks
for the early kit: a crafting table, a stone sword, pickaxe and axe, 16 cobblestone kept (the night shell's 10 cells,
pillars) and 6 food. The job is a loop (`nextAction`, then the command, then again):

1. Every target carried: done. Food counts any item the bot eats that is not a bad or emergency food.
2. Everything can be crafted from what is carried: `!craft <first short target> <n>` (its chain is crafted with it).
3. Else the raw materials missing: logs (any kind) by `!gather <n>`, cobblestone and the catalog's mined items by
   `!mine <block> <n>`, wool by `!kill sheep <n>`. A block no carried tool harvests (stone with a bare hand) gets its
   pickaxe first: the pickaxe joins the targets ahead of the rest, so the logs for both come in one trip (stone needs a
   wooden pickaxe, iron ore a stone one; Track E2: the iron pickaxe through smelted ingots, "The iron age"). Logs first, then a target the
   inventory can make now (the pickaxe), then mining, then hunting.
4. Food last: `!food <n>`. With some food carried, a food step that gets nothing (no animals left near) ends the job as
   done with the count (`food 4 of 6`).

Each command runs as the owner's own line (the replies, `!stop`, `!status` work as typed by hand). The job waits for
the process it started (at most 10 minutes a step, 40 steps: 24 until Track E9), then re-plans from the inventory. It ends:

- done: `get kit: done in 124 s, 7 steps (gather 4, ...)`;
- a step that got nothing: `get bed: stopped after 30 s, 2 steps: !kill sheep 3 got nothing (kill sheep: 0/3, no more within 32 blocks)`;
- `!get stop`: `stopped get kit after 2 steps (at !mine stone 24)` (its process is stopped too);
- an owner command that moves the bot or starts other work (`!goto`, `!come`, `!stop`, `!mine`, ...): `get kit: stopped by !goto after ...`;
- nothing to do: `get stone_sword: already carried`, or the reason there is no way (`no recipe for ...`, `no way to get
  iron_pickaxe yet: it needs iron_ingot, ...`).

`<colour>_bed` names the bed item (`!get white_bed`, `!craft white_bed`): three wool of one colour and three planks,
at a table.

On the fresh world, 13 kit runs from an empty inventory, each from a new copy of the world: all done, in 124 to 213 s
(7 to 9 steps); one log trip each (4 logs asked, 5 or 6 felled), `mine stone 24` 49 to 58 s, each stone tool 3.3 to
8.4 s (the table placed and picked up each time), the food hunt 20 to 90 s. A first kit without the cobblestone and
with food as a hard target ended `stopped ...: !food 2 got nothing` with 4 of 6 food and no animal left within 48: food
became the soft target. In some runs the dug table's drop was not picked up before the next step planned, so the job
crafted a second table (and mined 3 more stone for the sticks' planks); both were picked up two steps later.

## The first night

The night rule walks the bot to its shelter at dusk and holds it there. A shelter an owner sets with `!shelter set` is
a point; on open ground it is no shelter. Measured: `!get kit`, then `!home set` and `!shelter set` where the kit
ended (the forest's edge, open grass or a clearing), the clock to 11000, the bot alone until 500 the next morning, no
armour, a stone sword. Monsters within 16: the server's own count every 10 s by night (samples with one / samples,
most at once), where it was taken.

| Run | Shell | Monsters within 16 | Deaths | Damage | End |
|---|---|---|---|---|---|
| owner, no kit (no tools, raw food) | none | - | 1 (arrow) | 45 in 11 hits, health 3 before the death | alive, 145 from home, fleeing |
| kit 1 | off | - | 1 (arrow) | 34 in 9 | alive, 66 from home (the food chore) |
| kit 2 | off | - | 1 (arrow) | 45 in 11 | alive, 119 from home, fleeing |
| kit 3 | off | 13 / 57, 5 | 3 (a witch's potions) | 106 in 59 | health 5, 24 from home, fleeing |
| kit 4 | on, not built (leaves over the head: the first rule took them for a roof) | - | 0 | 4, after dawn | home |
| kit 5 | on, 9 blocks | - | 0 | 0 | home |
| kit 6 | on, 10 | 40 / 56, 6 | 0 | 0 by night; 19 after it opened at 23000 (a skeleton at the open side, 20 to 6) | 24 from home (a hunt) |
| kit 7 | on, 10 | 7 / 55, 3 | 0 | 0 | home |
| kit 8 | on, 10, the dawn wait | 9 / 56, 2 | 0 | 0 | home |
| kit 9 | on, 2 placed, 5 cells open (leaf litter, before the cover rule) | 33 / 56, 5 | 1 (arrow) | 51 in 17 | health 8, 13 from home, fleeing |
| kit 10 | on, 5 placed, 3 open (leaf litter) | 56 / 56, 6 | 0 | 0 | shut at the end (4 hostiles at dawn) |
| kit 11 | on, 10, the cover rule | 32 / 55, 3 | 0 | 0 | shut at the end (1 hostile at dawn) |
| kit 12 | on, a leaf litter cell dug, 7 placed | 44 / 56, 9 | 0 | 12 in 6: a spider's bites through the shell, 20 to 9 | home |
| kit 13 | on, 9 | 13 / 56, 2 | 0 | 0 | home |

Off (and the owner's day without a kit): a death in each of the 4 nights. With the shell closed: 7 nights, no death,
no damage by night in 6 of them with up to 6 monsters within 16; in the 7th (9 within 16 at once) a spider bit the bot
6 times from outside the shell, which walls the four sides and the roof, not the corners. The shells that stayed open
came from two cases this track then added rules for: leaves over the head (kit 4: the canopy rule) and leaf litter in
the cells (kits 9 and 10: the cover rule); the dawn wait came from kit 6.

### The night shell (`nightShell`, off by default)

With `!set nightShell on`, once the night rule has the bot inside its shelter after dusk:

- under the open sky only: nothing but air, or a tree's leaves and logs, in the 24 cells over the head (an unknown cell
  counts as a roof); a shelter under a roof is a real one and is left as it is (`night shell: a roof over the shelter
  (oak_planks at y 70): not walling in`, once a night);
- with throwaway blocks for every open cell (cobblestone first, then dirt and the other kinds Track M1's shell uses);
  short, it says so once a night and stands in the open;
- it places Track M1's shell (`skills/survival/seal.ts`): the four cells round the feet, the four round the head, the
  cell over the head (with a support for it first on open ground): 10 blocks; a solid cell is left as it is; never the
  dig-in;
- a cover in one of those cells (leaf litter, a flower, a tuft: the table spot's `clearableCover`) is dug first: it
  takes no block and gives the cell over it no face (measured on the fresh world: a shelter on leaf litter, 2 placed,
  5 cells open, the bot shot dead that night; on the test server with litter round the feet, 0 placed and 10 open in
  3 of 3 before, walled in with 10 after the 4 litter cells were dug);
- at most two tries a night (a cell a mob stands in);
- at dawn, before the walk home, it digs one side open: the feet and head cells of the side farthest from the
  hostiles, only cells it placed itself (a wall that was there is never dug). The rest stands; the next night it places
  that side again (2 blocks) and its own roof does not count as a roof. A new shelter forgets the old shell;
- (Track E7) standing in a hole, no side opens at the feet (every side's feet cell is a wall that was there): the
  way out is a step up through a side. The shell digs that side's head cell, its own roof over the head and its block
  over the side's head cell, where they stand: the shell's own blocks only (`shellStepOut`). Measured on a fresh
  world before this: a shelter in a one-deep hole inside the base, one head cell opened, and the bot stood under its
  own roof with no step out (`no move from the start`); the job that had waited there stopped 2 s after dawn;
- with a hostile within 16 at dawn it stays shut, checked each second, until none is or 90 s (1800 ticks: the clock
  near 800, the sun up and the undead burning) have passed; the walk home waits with it (`night shell: 1 hostile(s)
  within 16 at dawn: shut for up to 90 s`, then `clear after 7 s: opening`).

The canopy rule came from a run on the fresh world: the kit's shelter stood under an oak, leaves 2 over the head, and
the first rule (nothing solid over the head) took the leaves for a roof and built nothing.

Measured on a flat test server, 4 runs: walled in 2.4 to 4.4 s after the clock went to dusk (10 blocks, 6 of 16
cobblestone left), out and home 4.0 to 4.9 s after the clock went to dawn (2 of 2 cells dug, 8 left standing); under
a leaf canopy 3 over the head walled in with 9 (the leaves hold the roof, no support); under planks nothing placed
(`a roof over the shelter (oak_planks ...)`); off, nothing placed after 8 s inside.

## The iron age (Track E2)

From the stone kit, one command gets iron tools, a shield, a bucket and the armour the ore allows: `!get kit iron`. Its
parts are commands of their own.

| Command | What it does |
|---|---|
| `!furnace` | sets a furnace down where the cooker looks; crafts one from 8 cobblestone first when none is carried (its table chained); one standing there already: nothing placed |
| `!furnace status` | the furnaces the cooker would use |
| `!smelt [item] [n]` | walks to that furnace (setting one down first when none stands there), puts the input and the fuel in, waits, takes the output; `!smelt` alone smelts everything smeltable carried; the item is the metal (`iron`), the raw item, the ore, the ingot, `sand` or `cobblestone` |
| `!get furnace` | an obtain job: crafted if needed, then set down |
| `!get iron_ingot [n]` | an obtain job: raw iron mined, the furnace, the fuel, the smelt (also `gold_ingot`, `copper_ingot`, `glass`); `!get iron` still mines raw iron |
| `!get iron_pickaxe`, `bucket`, `shield`, `iron_sword`, `iron_helmet`, ... | an obtain job through the ingots; a pickaxe tier needs the one below |
| `!get kit iron` (`iron kit`) | an iron pickaxe, an iron sword, a shield, a bucket; the four armour pieces as soft targets; 16 cobblestone kept; 6 food |

### The furnace and where it stands

The cooker looks for a furnace within 16 of home, or of the bot when no home is set. `placeFurnace` puts one there:
with a home the bot walks within 3 of the home point and sets it down next to its feet, without one next to where it
stands. The cell is the crafting table's (a free cell round the feet, a cover cleared first, a wall cell dug last; see
"The crafting table spot"). A furnace that stands there is used; a second is never placed. A furnace set down stays:
near home it is the home's furnace from then on.

### Smelting: the bot waits by the furnace

A furnace smelts an item in 200 ticks (10 s); a smoker takes food only and a blast furnace ores only. `!smelt` keeps the
window open for the whole smelt and takes the output when the input is used up: 33 raw iron is 5.5 minutes standing
there. The other way (put the input in, walk off to the next step, come back) needs a second trip and a furnace nobody
else uses in between; it is not built. A flee or a guard fight closes the window; the furnace smelts on, and when the
smelt resumes the bot goes back to that furnace first, even with nothing left to put in, waits out what is still in it
and takes the output.

Fuel goes in for the items in the input: coal 8 items, planks and logs 1.5 (the cooker's rule). Charcoal is not made:
a log is 8 items as charcoal but 10 s in the furnace first; as 4 planks it is 6 items at once.

### The obtain job smelts

A smelted target adds these steps to the job, after everything is mined:

1. The raw input of every target, mined in one `!mine` step (33 iron ore for the iron kit; a stone pickaxe first).
2. The furnace: crafted (`!craft furnace`, 8 cobblestone), then set down (`!furnace`).
3. The fuel, the cheapest that is near, for the smelt and the raw food carried together:
   - what the later crafts leave of the fuel carried now (planks a craft would make from a log are not counted: the
     furnace may burn that log first);
   - else coal when a coal ore is known within 24 blocks and a carried pickaxe harvests it (`!mine coal_ore n`, one
     coal 8 items; the kit's pickaxes can wear out on the iron);
   - else planks from the logs left (`!craft oak_planks n`);
   - else logs (`!gather n`).
4. `!smelt raw_iron n`, then the crafts. Once a furnace stands, raw food carried is cooked (`!cook`) before the food
   is counted.

The armour pieces are soft targets: when the mine step comes back short, each piece the iron carried no longer covers
(the tools, the shield and the bucket first, then the boots, then the rest) is dropped, and the end line names them and
the step that fell short. A mine step that reaches the 10-minute step limit while soft targets are asked ends with what
it got instead of stopping the job.

```
get kit iron: done in 274 s, 14 steps; short: iron_chestplate, iron_leggings, iron_helmet (!mine iron_ore 33 got 13); steps: mine iron_ore 33, ...
```

The food stays soft in the iron kit with none carried: the bot eats the stone kit's food during the mine and the
smelt (a quarter of an hour), and a hunt that then finds nothing ends the job done with `food 0 of 6: !food 6 got
nothing (...)` instead of stopping it (before, on the fresh world, every iron item made and worn: `get kit iron:
stopped after 857 s, 14 steps: !food 6 got nothing (food: 0/6 items, nothing left to hunt within 48 blocks)`). The
stone kit keeps E1's rule (no food at all is a stop).

Worn items count as carried, for the targets and for a step's gain: the armour pass puts a crafted piece on and the
shield goes to the offhand right after its craft. Before, on the fresh world, the shield's craft was read as getting
nothing and the job stopped: `get kit iron: stopped after 580 s, 8 steps: !craft shield 1 got nothing`. After, the
same case in e2e ends done (272 to 274 s, the boots worn, the shield in the offhand).

`cookFurnace` (on, the food group): `!cook`, and the food hunt when the bot is within 64 of home or has no home, set a
furnace down when raw food waits and none stands near; one carried, or crafted from 8 cobblestone (the hunt keeps the
16 the night shell needs; `!cook` uses any). Off: as before, the raw food is kept.

### Fixes found on the way

- **`!craft furnace` with no table.** A 3 x 3 recipe with all its materials but no table carried or near ended
  `craft: made no furnace (no_table)`; the chain now crafts the table first (`!craft` and the job alike).
- **The smelt burned the logs the crafts needed.** The fuel rule counted the planks a log would make; the furnace
  burned the log and the next craft's `!gather 1` found no tree. It now counts only what is carried, and the planner
  crafts the planks before the smelt.
- **No cell for the table in a tunnel.** After the furnace took the one open cell of a one-wide tunnel, the table had
  none: `craft: no free cell next to the bot for a crafting table`, then `get kit iron: stopped after 774 s, 9 steps:
  !craft iron_pickaxe 1 got nothing`. `tableSpots` now digs a wall cell when no cell is free or clearable: one of the
  four sides, a natural block a carried tool harvests (stone, dirt, deepslate, ...), never a built one, with a full top
  under it, no falling block or liquid over it and no liquid or unloaded cell next to it. In e2e (a one-wide stone
  tunnel, the furnace in its open cell) `!craft iron_pickaxe` dug a side cell and crafted in 5.6 to 6.3 s.
- **A whole vein lost to timeouts.** A goto that times out with no segment blacklists the closest ore; on the fresh
  world the next 3 ores of the same vein timed out the same way, 8 of the step's 10 minutes, and the step ended with
  13 of 33. The miner now skips the ores touching a timed-out one (the same block, Chebyshev distance 1) for the rest
  of the run (`mine: 3 iron_ore touching x y z skipped for this run with it`). In runs 4 to 10 no goto timed out
  that way, so the rule did not fire; the after is the unit test and the mine e2e passing as before.
- **A flee during the smelt lost it.** On the fresh world a creeper and a skeleton took the bot from 20 to 6 by the
  furnace; the flee closed the window 78 s into the smelt of 33, all of them in the furnace and none taken out; the
  smelt resumed with nothing carried and ended `smelted nothing`, the job `stopped after 450 s, 5 steps: !smelt
  raw_iron 33 got nothing`. The smelt now goes back to its furnace (above).
- **Coal with no pickaxe.** The stone and wooden pickaxes wore out on the iron and the first coal; the fuel rule still
  asked for coal, and the job stopped: `get kit iron: stopped after 249 s, 7 steps: !mine coal_ore 2 got nothing (mine
  coal_ore: stopped at 0/2, no tool in the inventory harvests coal_ore)`. Coal is now the fuel only while a carried
  pickaxe harvests it; else the logs (unit-tested; not seen again on the fresh world).

### Measured on a fresh world

A fresh default world from one seed at normal difficulty (BDS 1.26.60.6), a new copy each run; an empty bot and the
owner's two commands, `!get kit` then `!get kit iron`; no home set, so the furnace stood where the bot smelted.

`!get kit` (the stone kit, E1's): 10 of 10 done, 123 to 189 s, 7 to 9 steps.

`!get kit iron`, from the stone kit, 10 runs (runs 1 to 3 before the fixes above; runs 4 to 10 with all but the
last two):

| Run | End | Time | Steps | Worn | Deaths |
|---|---|---|---|---|---|
| 1 | stopped: `!craft shield 1 got nothing` (the shield in the offhand not counted; fixed) | 580 s | 8 | none | 0 |
| 2 | stopped: `!craft iron_pickaxe 1 got nothing` (no table cell in the tunnel; the mine step lost 8 minutes to one vein; both fixed) | 774 s | 9 | none | 0 |
| 3 | stopped: `!smelt raw_iron 33 got nothing` (a flee at the furnace; fixed) | 450 s | 5 | none | 0 |
| 4 | done, everything, 7 raw food cooked | 838 s | 16 | all four, the shield | 0 |
| 5 | every iron item made and worn; stopped: `!food 6 got nothing` with none carried (the food rule above, after this run) | 857 s | 14 | all four, the shield | 0 |
| 6 | done, everything | 1046 s | 18 | all four, the shield | 0 |
| 7 | done; `short: iron_helmet (!mine iron_ore 33 got 30)` (the stone pickaxe wore out); `food 5 of 6` | 712 s | 15 | three, the shield | 0 |
| 8 | stopped: `!mine coal_ore 2 got nothing` (both pickaxes worn out; the coal rule above, after this run) | 249 s | 7 | none | 0 |
| 9 | stopped: `!smelt raw_iron 33 got nothing (smelt: interrupted)`: died at the furnace at dusk, 3 minutes into the smelt (two skeleton arrows, a witch's poison, a creeper; the flee ran, poisoned at 1 health) | 579 s | 5 | none | 1 |
| 10 | stopped: `!mine iron_ore 33 got nothing`: died in the mine step by day at 15 of 33, pillaring up a one-wide shaft with a zombie hitting from its top (20 to 0 in 6 s, no flee) | 206 s | 1 | none | 1 |

Of runs 4 to 10, 3 ended done (4, 6, 7) and 4 made every hard target (with run 5); runs 5 and 8 stopped where the
last two rules now go on (unit-tested, not rerun on the fresh world). Deaths: 2 in 10 runs, both in the iron kit's own
steps, the bot standing in one place (at the furnace, in a shaft).

Each step, over runs 4 to 10 where it ran:

| Step | Runs | Time | Result |
|---|---|---|---|
| `!mine iron_ore 33` | 7 | 207 to 411 s | 33 of 33 in 5; 30 (the pickaxe wore out) in 1; a death at 15 in 1 |
| `!craft furnace 1` (the table chained) | 6 | 2.8 to 3.4 s | crafted; a second furnace in run 8 (6.4 s) after the bot had walked off from the first, no home set |
| `!mine stone 3` to `7` (the kit keeps 16 cobblestone) | 2 | 21 to 22 s | done |
| `!furnace` | 6 | 1.3 s | placed next to the bot |
| `!mine coal_ore 4` or `5` | 6 | 17 to 50 s | done in 5; 3 of 5 in 1 (the pickaxes wore out) |
| `!smelt raw_iron 33` | 3 | 331.5 to 331.7 s | 33 ingots, 5 coal; 28 in 281.6 s (run 7); a death 186 s in (run 9) |
| `!craft iron_pickaxe`, `iron_sword`, `shield`, `bucket`, the armour | 4 | 2.8 to 6.9 s each | crafted; the armour worn and the shield moved to the offhand right after |
| `!cook` (after `!mine coal_ore 1` in 2 runs) | 3 | 13 to 73 s | 1 to 7 items cooked |
| `!food` | 4 | 6 to 110 s | 0 to 15 items (the kit's food was eaten during the mine and the smelt) |

What the time goes to: the mine step (3.5 to 7 minutes for 33 ore, found by the scan and tunnelled to) and the smelt
(5.5 minutes for 33, standing at the furnace); a craft is 3 to 7 s, the furnace 1.3 s to set down. The world starts at
sunrise and the stone kit and the mine step take about 10 minutes, so the smelt fell at dusk or by night in every run:
in run 3 a creeper and a skeleton took the bot to 6 health at the furnace, in run 9 it died there.

## A mob at the top of a shaft (Track E3)

A walk that has to go up where there is no step pillars: it jumps and places a block under its feet, the block item
in the hand. In a one-wide shaft (the mine step's own, or any hole) a mob that comes down from the top stands on the
bot's head, out of the flight's reach. The reflex (docs/pve.md "The reflex") struck it, but with what the hand held:
a block or the fist takes 0.9 from a zombie's 20, so the zombie lives through 20 strikes and more. On a fresh world
this was a death by day: 20 to 0 in 6 s, 14 strikes with the cobblestone, no way out.

The rule (`PveRules.bladeStrike`, on): a reflex strike made with a block, a digging tool between digs or nothing in
the hand is made with the best sword or axe in the hotbar, and the hand goes back for the job's next action (the
details in docs/pve.md "The blade strike"). A stone sword takes a zombie in 3 or 4 strikes. The other ways (stop
climbing, a block over the head) are not built: they change every pillar the walk makes; the strike changes only what
a strike already made hits with.

On the replica (a one-wide shaft 10 high, a zombie 6 over the bot's feet once they are 2 up, the stone kit, guard off),
5 runs a side, 0 deaths either way:

| Walls | Rule | Reached the top | Damage a run | Strikes |
|---|---|---|---|---|
| stone (the walk can dig round) | off | 5 of 5, 16.6 to 17.0 s | 0, 6, 3, 0, 0 | 9 to 11 |
| stone | on | 5 of 5, 16.7 to 18.1 s | 0 | 3 to 4 |
| obsidian (only up) | off | 0 of 5 in 60 s | 9, 3, 0, 0, 0 | 21 to 40 |
| obsidian | on | 5 of 5, 7.2 to 8.3 s | 0 | 3 to 4 |

The flat case does not kill the bot with the rule off (on the fresh world the hits kept the body in the air and the
walk stood still); the gauntlet's live-kit rows (a sword held) are unchanged, 15 runs a side (docs/pve.md).

## The furnace wait (Track E3)

A furnace smelts an item in 10 s and the bot waits by it with the window open ("The iron age"). A smelt of 33 is 5.5
minutes; started late in the day it runs into the night, and the bot stands in the open the whole time. Two ways out:

- **Leave.** With a home or a shelter set, the night rule takes the bot there at dusk (docs/survival.md); the furnace
  smelts on without it, and the smelt resumes after: the bot walks back to that furnace, waits out what is left in it
  and takes the output. No new code: this is the night rule and the smelt's resume (ADR 0099). With neither set there
  is nowhere to go.
- **Wait inside a shell (`smeltShell`, off by default).** With no home or shelter within 16 of the furnace, a smelt
  that will not end before dusk (200 ticks an item plus 400, against the ticks left before 12000) or one started by
  night waits walled in: the bot steps onto a cell next to the furnace (a side at its height with feet and head free
  and a full top under it), builds Track M1's shell round itself (the furnace is one wall, so its window still opens),
  smelts, then digs one side it placed open: at once by day, at dawn by night (with a hostile within 16 then, after up
  to 1800 ticks, as the night shell). The cell over the furnace has no face to place against but the furnace's top,
  and a click there opens the furnace: a brace goes on its diagonal first, against the head-ring block (without it, 6
  placed and that cell, the roof's support and the roof open). 10 blocks; a pause (a flee, the night rule) leaves the
  shell standing for the resume. It builds and digs, so it ships off.

The case (`test/e2e/early-smelt.test.ts`, the flat test world at normal difficulty, the daylight cycle on): a furnace
next to the bot, 8 raw iron, 1 coal, 32 cobblestone, a stone sword, bread; `!smelt` at 21000 (100 s before dawn),
two zombies and a skeleton summoned 9 to 11 blocks off 3 s later. For the leave way the shelter and home are 10 blocks
from the furnace with the night shell on, `!smelt` at 11500 (the furnace loaded by day), the clock moved to 21000 once
the bot is walled in at the shelter, then the same mobs. 5 runs each:

| Way | Deaths | Damage a run | Lowest health | Ingots | Seconds |
|---|---|---|---|---|---|
| none (the bot waits by the furnace in the open) | 2 | 35, 23, 29, 24, 27 (arrows) | 0, 2, 1, 4, 0 | 5, 8, 8, 8, 1 | 38 to 107 (the runs that died ended there) |
| the smelt shell (`smeltShell` on) | 0 | 0 | 20 | 8 each | 120 to 163 (out at dawn, 3 runs waited for a mob to go) |
| leave (the night rule to the shelter, the night shell on there; after the fix below) | 0 | 0 | 20 | 8 each (taken at the furnace after dawn) | 153 to 189 (2 runs waited 30 and 36 s at dawn for a mob to go) |

In the open the flight started at least twice in every run and all the damage was the skeleton's arrows; walled in,
nothing reached the bot.

A fault found on the way and fixed: at dawn the night process let go of the bot while the night shell was still shut
(its dawn wait with a mob near, then the dig open), so the smelt resumed and planned its walk from inside the shell:
`cook: furnace ... unreachable`, the job ended with the ingots in the furnace. The night process now keeps control
while its shell is shut (NightSafety.wantsControl); the smelt resumes once the side is dug open.

## A bed (Track E3)

The night process sleeps in a bed within 8 of the shelter or home (or at the `bed` waypoint), from 12542 to 23459,
and a bed skips the night when everyone online sleeps (docs/survival.md). Nothing set one down before, and the food
hunt took the sheep.

| Command | What it does |
|---|---|
| `!bed` | sets the bed carried down where the night rule finds it: by home (the bot walks within 3 of it first), else by the shelter, else where it stands (and sets the `bed` waypoint there unless one is set); by day it clicks it once so the respawn point moves there; one standing there already: nothing placed |
| `!bed status` | the beds where it sleeps and the beds carried |
| `!get bed` | an obtain job: 3 wool of one colour from sheep (`!kill sheep 3`), planks, the craft, then `!bed` |
| `!get kit iron` | now ends with a soft `bed` step, planned once the iron, the armour and the food are met or dropped (made and set down when the sheep are there; else `short: bed`) |

Rules, for any world:

- **The spot.** Two cells side by side next to the feet (the foot 1 or 2 out, the head one further, on one of the four
  sides), both free or holding a cover the hand clears (leaf litter, grass, flowers), a full top under both, a free
  cell over both, not water or lava. The bot faces from the foot to the head and clicks the top of the block under
  the foot.
- **The spawn point.** A click on a bed by day is refused (`tile.bed.noSleep`) and the server moves the spawn point to
  it anyway; `!bed` makes that click right after placing.
- **The wool.** A sheep killed drops 1 wool of its colour; a bed takes 3 of one colour. With fewer sheep than that
  within 32 the job walks to the nearest flock it remembers (the food hunt's herd memory, up to 200 away; two walks at
  most), then hunts again.
- **The food hunt leaves them.** With no bed where the night rule looks and none carried, the food hunt leaves 3 wild
  sheep less the wool already carried (of the colour with most), on top of `foodLeave`.
- **No shears.** A shear gives 1 to 3 wool and keeps the sheep, but shears are 2 iron the iron kit puts in armour.

On a fresh world (seed 7, the stone kit first, `!home set` where the kit ended, then `!get bed`, then two nights,
the clock set to 12000 each, the bot alone):

| Run | `!get bed` | Steps | Night 1 | Night 2 | Deaths |
|---|---|---|---|---|---|
| before the herd walk | stopped: `!kill sheep 3 got nothing (... no more within 32 blocks)` | 1 | awake 601 s, lowest 9 | awake 607 s, lowest 3, died (an arrow) | 1 |
| 1 | done in 146 s | 8 (two herd walks) | asleep after 48 s (woken twice by a skeleton, a flee between), skipped at 104 s, lowest 5 | asleep after 30 s, skipped at 34 s, lowest 13 | 0 |
| 2 | done in 108 s | 6 (one herd walk) | asleep after 28 s, skipped at 36 s, lowest 20 | asleep after 28 s, skipped at 34 s, lowest 20 | 0 |
| 3 | done in 83 s | 4 | asleep after 28 s, skipped at 38 s, lowest 20 | asleep after 28 s, skipped at 36 s, lowest 20 | 0 |
| 4 (after the planning fix below; one night) | done in 54 s | 8 (two herd walks) | asleep after 28 s, skipped at 34 s, lowest 20 | - | 0 |

A night without a bed, the same world (the first row and one more run with no bed): 3 nights, 2 deaths (arrows),
lowest health 3 to 9; with the bed, 7 nights, 0 deaths, every night skipped, asleep as soon as the window opened (28
s after 12000) unless a mob was near. The food hunt of the stone kit took no sheep in these runs; the wool was short
because none stood within 32.

**The planning fix.** In runs 1 to 3 the job stood still 17 to 20 s before each step while the wool was missing, and
in the iron kit's e2e 15 to 53 s before each of its last three steps (the kit 347 s against 271 without the bed): the
server's full recipe set re-dyes every wool colour and every bed from the others, and the chain planner tried them all
for every plan, with the event loop blocked. The job never dyes now: a recipe with a dye in it is left out of its plans
(`noDyeRecipe`). After it `!get bed` took 54 s with two herd walks, and the iron kit's e2e 284 s (the bed's own steps
11 s), with no gap between steps. `!craft` alone still plans with every recipe.

## Wear and setbacks (Track E4)

The obtain job of Tracks E1 and E2 ended short or stopped on things that were not the world's: a pickaxe worn out in
the mine step, a second table or furnace crafted where one stood, a death in any step. Decision record:
[decisions/0101-wear-and-setbacks.md](decisions/0101-wear-and-setbacks.md).

### Worn tools

The worn-tool rule (`toolWearLimit`, default 10 uses left; a Mending item at `mendAt` is set aside the same way) is
what the digger and the miner use to pick a tool, but two gaps let a worn tool through. The digger takes the selected
slot when every tool is refused, so a worn pickaxe already in hand digs on. The miner's composite mode (the default)
checks the pickaxe only when no candidate is left. So a mine step ran its pickaxe to the end: in e2e a stone pickaxe
with 13 uses left mined 5 iron ore and ended with 8 left. The planner counted that pickaxe as carried and never
replaced it.

Now:

- **The plan leaves worn tools out.** `nextAction` plans on the inventory without the items the rule refuses
  (`skills/items/wear.ts` `usableSlots`). A pickaxe under the limit is not a pickaxe for the plan, so the planner's
  own pickaxe rule crafts the cheapest one that harvests the block (3 of the kit's cobblestone and 2 sticks for a
  stone one) before the step that needs it. A worn tool is never an ingredient. It stays carried.
- **The job ends a mine step at the limit.** While a mine step runs, the job compares the usable pickaxes with those
  at the start of the step. Once none harvests the step's block any more, it stops the step, and the next plan
  replaces the pickaxe and mines the rest. The job does this, not the miner, so plain `!mine` is unchanged.
- **A step cut short that way caps nothing.** A short mine step drops the soft targets (the iron kit's armour) the
  material no longer covers. It does not when the step ended on wear. A worn-out step that got nothing does not end the
  job either.
- The end line says it: `replaced the stone_pickaxe (worn)`.

### The job's tables and furnaces

- **The table stands between the job's crafts.** While a job runs, the crafter keeps the table it sets down standing
  (`holdTables`) and walks back to one within 16. The plan counts the table as carried, so the kit's own table target
  crafts no second one. Before a step that walks off (gather, mine, hunt, food) and when the job ends, the job walks
  to the tables it left within 24 and picks them up (`picked up the crafting table`). Within 16 of home a table stays,
  as the home's own. A table whose drop did not come into the inventory is looked for again, wider and for longer (6
  blocks and 200 ticks, after 3 and 100). A job stopped by the owner leaves its table, as before.
- **The furnaces the bot sets down are remembered** (`skills/items/placed.ts`), per task, for a run. The smelt offers
  one that still stands within 64 of the bot, together with the cooker's own within 16, and opens it first. With no
  home set, the walk to the coal used to cost a second furnace. The end line says `used the furnace at x y z again`.
  `!furnace`, `!cook` and the cooker's own set-down (`cookFurnace`) still look within 16 only. When the memory was
  first shared with them, `!cook` saw a furnace 40 off, set none down, then found none within its 16 (`cook: no
  furnace or smoker within 16 blocks of home`).

### A death in a job (`deathReturn`, off by default)

A death stops the step's process. The job keeps its state (targets, steps, notes) and the inventory as it was just
before the death.

- **Off:** the job ends `stopped by a death (cause) after T, N steps (at !step)`, names the furnace that holds a
  stopped smelt, and points at the setting.
- **On:** the job holds the afk task's walk home after the respawn (`respawnClaimed`). Once the respawn has settled,
  it walks back by the normal nav as the `recover` user process (the flee, a guard fight and the night process
  pre-empt it) only when all of these hold:
  - the death spot is known and not in the void;
  - the cause is not lava, fire or the void (the drops burn or fall);
  - it is day, with 1 200 ticks of daylight left;
  - the spot is within 160 blocks of where the bot respawned;
  - the walk, at 3 blocks a second, ends before the drops despawn 5 minutes after the death;
  - fewer than 2 returns in this job.

  It picks the drops up within 8 of the spot (20 s at most). If a smelt was stopped, it then goes back to that
  furnace, waits out what is inside and takes the output, putting nothing more in. The job goes on from the
  inventory: `recovered G of O stacks in S s (lost ...); smelted ...; going on with the job`. When it does not go,
  the end line says why (`not going back: it is night or near dusk ...`) and the walk home is made.

### Fixes found on the way

With the table held, the iron kit ran faster (180 s against 274 s in Track E2's e2e), and two races showed up in its
gate case (`iron-get.test.ts` `kit`).

- **Fuel into a burning furnace.** `!cook` opened the furnace 1.3 s after the smelt there, while it still burned,
  and the fuel move was refused (`cook: place 3 oak_planks 9 -> furnace_fuel 1: 50`). The job stopped: `!cook got
  nothing (cook: request failed ...)`. The cooker now tries a refused fuel move once more, 10 ticks later, planned
  again from what the slot holds then. That retry did not end the flake (the kit case failed 5 of 15 runs after
  it): the smelt leaves a plank in the fuel slot, the beef going in lights the furnace, which takes that plank as
  the fuel move naming it goes out, and the refusal put the plank back in the model, so the retry was refused too.
  Since Track C2 the fuel goes in before the input and a refusal keeps the server's slot (docs/food.md "Fuel before
  the input"): 0 of 20 runs failed, 0 fuel moves refused.
- **A table click lost to the offhand move.** Four crafts in 5 s at the held table. The armour pass moved the new
  shield to the offhand at the moment of the fourth click, which went unanswered: `craft: made no bucket
  (open_failed)`. The crafter now clicks a table that still stands once more before it gives up.

### Measured (e2e, before and after)

On the flat, peaceful test server with the truth pack, one bot, no home set, the clock frozen at noon (the night
case sets it to midnight before the death). The "before" is the same cases on the code before this track. There
were 3 runs a side, all with the same outcome; the after side was run 6 more times on the final code (the times below cover all 9).

| Case | Before | After |
|---|---|---|
| `wear`: a stone pickaxe with 13 uses left, 5 iron ore, `!get iron_helmet` | done in 76 to 78 s, 5 steps; the pickaxe mined all 5 and ended with 8 uses left (under the limit of 10); nothing replaced | done in 80 to 82 s, 7 steps: `mine iron_ore 5` (ended at the limit after 3, the worn one at 10 left), `craft stone_pickaxe 1`, `mine iron_ore 2` or `3`, ...; `replaced the stone_pickaxe (worn)` |
| `worn`: the same pickaxe with 6 uses left, 3 iron ore, `!get iron_pickaxe` | `stopped after 1 s, 1 step: !mine iron_ore 3 got nothing (... no tool in the inventory harvests iron_ore)` | done in 55 to 57 s, 4 steps: `craft stone_pickaxe 1, mine iron_ore 3, smelt raw_iron 3, craft iron_pickaxe 1` |
| `furnace`: 3 iron ore, a coal ore 23 blocks off, a stone pickaxe and 16 cobblestone, `!get iron_pickaxe` | done in 67 to 70 s, 8 steps, **2 furnaces crafted** (16 cobblestone): the one by the ore was over 16 off when the smelt planned | done in 63 to 68 s, 6 steps, **1 furnace**, `used the furnace at x y z again`; 8 cobblestone left |
| `death`: killed 8 s into `!smelt raw_iron 3` by day, the respawn point 30 blocks off, `deathReturn` on | `stopped after 11 s, 1 step: !smelt raw_iron 3 got nothing (smelt: interrupted)`; nothing carried, the drops left lying, the iron in the furnace | `died ...; walking back 30 blocks ...`, `recovered 5 of 5 stacks in 21 s; smelted 3 iron_ingot in the furnace at ... (7 to 10 s); going on with the job`; done in 38 to 39 s with the iron pickaxe |
| `night`: the same death at midnight | as `death` | `stopped by a death (generic) after 11 s, 1 step (at !smelt raw_iron 3): not going back: it is night or near dusk ...; the furnace at x y z holds the smelt` |

No second crafting table was crafted in any of these runs, before or after (the job carried a table). Before, every
craft set the table down and picked it up again (`crafting table placed and picked up`). After, the table stood
between the crafts (`crafting table kept at x y z for the next craft`) and was picked up at the end; none was left
standing.

## A farm (Track E6)

`!farm` worked a field that existed; nothing made one, and the food chore could only hunt. `!farm new [n]` now
makes a plot, and the farm chore (`farmFood`, off) harvests it and bakes bread before the hunt runs. The command and
its rules: [farming.md](farming.md) "A starter farm". Decision record:
[decisions/0102-starter-farm.md](decisions/0102-starter-farm.md).

### Left alone, before

On a fresh normal survival world (seed 7, reset per trial), the bot was given the iron kit (the state `!get kit
iron` ends in, 6 cooked beef), home was set where it stood and `!bed` set a bed down. Then it was left alone, one
process a game day, with Hunger II on it all the time (so a day eats about what three days would). The night process
slept through each night. With no farm the commands said:

| Command | Reply |
|---|---|
| `!farm status` | `farm: idle, 0 harvested, 0 planted, 0 bone meal, 0 trips, 0 rounds (no farm process)` |
| `!get bread` | `get bread: no way to get bread yet: it needs wheat, which is not gathered, mined, hunted or crafted from those` |
| `!get wheat`, `!farm` | one round of a field that is not there: `farm: done, nothing left to harvest or plant` |

3 game days, the hunt only (food points carried at the start and end of each day, the food chore's hunts and kills):

| Trial | Day 1 | Day 2 | Day 3 | Deaths | Lowest hunger |
|---|---|---|---|---|---|
| b1 | 48 -> 24, no hunt | 24 -> 10, 1 hunt, 3 kills | 10 -> 15, 2 hunts, 9 kills | 0 | 15 |
| b3 | 48 -> 24, no hunt | 24 -> 11, 1 hunt, 2 kills | 11 -> 13, 2 hunts, 7 kills | 0 | 16 |

No hunger deaths and no other deaths, and the lowest health was 19. Near a fresh spawn the animals are enough for
three days, so food was not short. The cost was the herd: 12 and 9 animals killed near home, with nothing growing
back, and the hunt walks further each time. (b1 ran on the tree before this track. b3 ran on this track's tree with
`farmFood` off. A third trial was cut on day 2 and is not counted.)

### Setting up on the fresh world

`!farm new` right after the setup above, the same world each time:

| Run | Time | Site | Seeds | Tilled, planted | Water | Fence |
|---|---|---|---|---|---|---|
| f1 (before the fixes below) | 289 s | 60 from home (8 raw copper blocks in a vein 21 to 35 under home made the base "not the bot's own") | 18 from 166 grass | `92 of 80 tilled` (bare dry farmland turned back to dirt and was tilled again), 18 planted | dry: no still water within 48 | none: the oak fence's log trip brought birch, `!gather 8 got nothing` |
| f2 | 310 s | 25 from home | 29 from 180 grass | 29, 29 | dry: none within 96 | none: 12 birch and 5 oak logs, too few of one kind for 35 posts |
| f3 | 315 s | 25 from home | 21 from 176 grass | 21, 21 | dry: none within 96 | none: the same |
| f4 (the fence fix; the kit's bucket full) | 321 s | 25 from home | 21 from 169 grass | 80 (moist farmland stays), 21 | poured | 33 of 35 posts and the gate: the second try `1 fence_gate, 18 oak_fence, 15 birch_fence` |
| f5 (the same) | 270 s | 20 from home | 14 from 207 grass | 14, 14 | dry: the one dig of the middle timed out, `not poured (occupied)` (now tried 3 times) | 30 of 39 and the gate (`1 fence_gate, 30 oak_fence`) |
| f6 (the dig fix; the bucket full) | 321 s | 25 from home | 21 from 164 grass | 79, 21 | poured, but the end line said `water dry`: the place read `rejected` and the water showed a second later (now looked at again for 2 s) | 33 of 35 and the gate (`1 fence_gate, 18 oak_fence, 15 birch_fence`) |

The hoe (a stone one) took 35 to 50 s each time, most of it a log trip for the sticks (the iron kit carries no wood).
The seed step took 150 s, its cap: 1 seed in 8 grass, 14 to 29 seeds for the 80 cells. On this world there is no
still water within 96 blocks of the plot, so every plot with the kit's empty bucket was dry. f4 to f6 were given
the bucket full (as if filled on an earlier trip) to measure a watered plot. The site differs between runs because
home does: the trial sets home where the bot stands after it joins.

### 3 days with the farm, dry

f2 and f3 then ran the three days with `farmFood` on:

| Trial | Day 1 | Day 2 | Day 3 | The crops at the end (stages 0 to 7) |
|---|---|---|---|---|
| f2 | 48 -> 32 | 32 -> 8 | 8 -> 12, 2 hunts, 6 kills | 29: none ripe, the highest at stage 4 |
| f3 | 48 -> 32 | 32 -> 8 | 8 -> 13, 2 hunts, 5 kills | 21: none ripe, one at stage 6 |

(Day 1 was shorter here: the setup used part of it. A hunt started at the end of day 2 was cut by the day's end and
done on day 3.) No deaths. A dry plot did not feed the bot in three days: after three days most of its wheat was at
stage 0 to 2 of 7. Wheat grows a stage on a random tick, with a chance that moist farmland about triples. The farm chore saw the crops
(`0 of 29 ripe (food short: any start a harvest)`) and left the food to the hunt, as it should.

### 6 days with the farm, watered

f4 and f6 ran six days each on their watered plots, `farmFood` on (food points at the start and end of each day; the
hunts; the farm chore's runs, crops harvested and loaves):

| Trial | Day 1 | Day 2 | Day 3 | Day 4 | Day 5 | Day 6 |
|---|---|---|---|---|---|---|
| f4 (one ripe crop started a run when food was short) | 52 -> 36 | 36 -> 12 | 12 -> 17, 2 hunts; none ripe | 17 -> 8, 1 hunt; 3 runs, 3 harvested, 1 loaf | 8 -> 8, 2 hunts; 2 runs, 3 harvested, 1 loaf | 8 -> 17, 2 hunts; 2 runs, 5 harvested, 1 loaf |
| f6 (from day 3: a loaf's worth starts it) | 48 -> 32 | 32 -> 8 | 8 -> 10, 2 hunts; 1 ripe at the end | 10 -> 12, 2 hunts; 2 ripe, no run | 12 -> 12, 2 hunts; 1 run, 6 harvested, 2 loaves | 12 -> 8, 3 hunts; 2 ripe, no run |

No deaths, lowest hunger 16, lowest health 20. The first ripe wheat came on day 3 (f6) or day 4 (f4): after three
days f4's 21 crops stood at stages `[1, 6, 2, 2, 3, 6, 1, 0]` (stage 0 to 7) and after six f6's at
`[1, 1, 1, 2, 4, 5, 5, 2]`. On BDS the night is slept through, so the crops grow by day only, about 10 minutes of
game time a day; a watered plot gave about one loaf a day from day 4. The hunt still fed the bot: 1 to 3 hunts a
day on both sides of the farm, as without one. The seeds from each harvest go back in, so the field grows (f4: 21
crops to 29 in six days).

With one ripe crop enough while food was short, f4 walked out 7 times in days 4 to 6 for 11 wheat (1 or 2 a run,
`done, 1 harvested, 1 wheat and the bread baked (0 loaves so far)`), and while one crop stood ripe the food chore
waited for it. A run now starts while food is short only when the ripe crops and the wheat carried make a loaf (3),
and the hunt goes first until then: f6's days 4 to 6 had 1 run, 6 harvested, 2 loaves (`8 food points carried (<
10), 5 crops ripe`).

## A farm: water and seeds (Track E8)

The plots above were dry whenever the kit's bucket was empty. The rules that fixed it and the seed rules:
[farming.md](farming.md) "Water for the plot" and "Seeds". Decision record:
[decisions/0105-starter-farm-water-seeds.md](decisions/0105-starter-farm-water-seeds.md).

### Setting up, before and after

One normal world, a fresh copy per run, the world spawn moved so that the nearest surface water lies at different
distances from it (the bot joins near the spawn and sets home where it stands, so the plot and its water vary a
little within a spawn). The iron kit with its empty bucket, home set, a bed, then `!farm new` (9 x 9). Three runs a
side a spawn; the distance in the first column is from the spawn to the nearest grassy chunk's water, as surveyed.

| Spawn | Before (the rules of Track E6) | After |
|---|---|---|
| water 36 off (the sea; a cave pool under the plot) | 3 of 3 dry, `no still water within 96`; 393 to 431 s; 19 to 25 planted | 3 of 3 wet, `filled 17 off`; 373 to 459 s; 25 to 28 planted |
| water 145 off (a plateau at 85 over caves) | 3 of 3 dry: once the bucket filled in a cave 45 under the plot, the bot was left 88 off the middle (3 digs `out of reach`, `not poured (occupied)`); twice `no still water within 96`; 543 to 732 s; 14 to 20 planted | 3 of 3 wet, `filled 161 off`: the first run tried 8 cave pools at 19 to 59 that counted as open (24 cells of air over them) and took 886 s (`seen before, walked 1008 looking`); with the plot-height rule 473 and 499 s; 21 to 27 planted |
| water 125 off (a plot pushed 77 out by a ruin's blocks) | 2 of 3 wet from a pool in a cave pocket 25 off under 15 blocks of rock (one run's pour then failed `occupied`: dry); 561 to 703 s; 17 to 22 planted | 3 of 3 wet, `filled 83 off` at the sea (the cave pocket is left out); 689 to 695 s; 11 to 21 planted |
| water 182 off (a mountain) | 1 of 3 had a site: dry, `no still water within 96`, 2 planted (11 plants within 24), 440 s; 2 of 3 `no 9x9 site ... within 24 of home` | 0 of 2 had a site (the site rules are unchanged) |

No world surveyed had grassy ground farther than about 200 from surface water within 1 400 of its spawn, so the far
cases come from a flat test world (e2e early-farm-water): a pond 236 off found by the search walk in 122 s, none
within 256 left dry in 157 s with `none seen within 256, walked 529 looking`.

The water step now costs 1 to 3 minutes where the water is near or seen, and the plot is wet. Seeds stayed the
limit: 11 to 28 of 80 cells planted at the set-up on either side (146 to 216 plants broken in the 150 s).

### 6 days with the water fetched

The first spawn above, the bucket filled by the bot (`filled 17 off`), `farmFood` on, one process a game day as in
"6 days with the farm, watered" (whose f4 and f6, given a full bucket and with no seed top-up, are the before side).
Crops on the plot at the end of days 1, 3 and 6 (of 80 cells), and the farm chore's harvests and loaves on days 4 to
6:

| Trial | Planted at set-up | Day 1 | Day 3 | Day 6 | Days 4 to 6 | Hunts a day | Deaths, lowest hunger |
|---|---|---|---|---|---|---|---|
| f4 (before) | 21 | 21 | 21 | 29 | 7 runs, 11 harvested, 3 loaves | 0 to 2 | 0, 16 |
| f6 (before) | 21 | 21 | 21 | 21 | 1 run, 6 harvested, 2 loaves | 0 to 3 | 0, 16 |
| d1 | 26 | 32 | 50 | 80 | 7 runs, 23 harvested, 5 loaves | 0 to 2 | 0, 14 |
| d2 | 21 | 23 | 50 | 80 | 4 runs, 10 harvested, 3 loaves | 0 to 2 | 0, 13 |

The seed top-up ran once a game day (each day's process is a fresh start, so the 10-minute spacing never bound):
36 to 114 plants broken in its 54 to 65 s for 2 to 13 seeds, and the harvests' seeds went back in, so every cell was
planted by day 6 against 21 to 29 before. The first ripe wheat still came on day 3, and bread stayed about a loaf
a day on days 4 to 6 (3 and 5 loaves): the crops planted late were still at stages 0 to 3 on day 6 (`[22, 13, 8, 10,
7, 13, 5, 2]` and `[6, 12, 10, 15, 14, 9, 9, 5]`). The hunt still ran most days. `farmFood` stays off: the farm does
not yet feed the bot in its first week, and the field it leaves on day 6 feeds it from then on.

## Other ground (Track E5)

Decision record: [decisions/0103-early-chain-other-ground.md](decisions/0103-early-chain-other-ground.md). Tracks E1
to E4 were measured on one forest. Track E5 ran the whole chain on five other kinds of fresh world: plains, a desert
(sand to the horizon, the nearest tree 50 blocks off), a snowy spruce taiga (snow layers, powder snow), mountains
(spawn on a slope at 64 to 147 high) and a river bank (water on three sides). Each run: a freshly generated world,
difficulty normal, an empty bot, the owner's commands in order (`!get kit`, `!home set` and `!shelter set` where the
kit ended, `!get kit iron`, `!get bed`), then two nights alone (the clock run to 12000 and the bot left until 500 of
the next day): the first with `nightShell` off, the second with it on. Two runs a world.

### Rules for any world

- **The base round home is never dug, and a step that needs the ground plans outside it.** An owner sets home where
  the kit ended, so the iron kit's mine step starts inside `protectRadius` (48). Branch mining walks out of the base
  first (docs/mining.md "Branch mining", the start row) and digs away from home; the fuel rule counts a coal ore only
  outside the base (with home set and the bot by the furnace, that is no coal within 24: planks or logs burn instead).
- **Any wood.** A planks (or other tag) cell tries the kinds a recipe makes from what is carried before the default
  oak: spruce logs make spruce planks ("Craft chains").
- **`!gather N` is a total.** With no chest the gather ends once N logs are carried, so the job asks for the logs it
  carries plus the ones it needs (`gather 4` with 2 carried gets 2). The job's step list shows that total.
- **The job's own table is used where it stands.** A table the crafter set down itself within reach is used again
  even when the straight line from the eye to its nearest face crosses a block (a table in a notch of a pit: the click
  that opened it when it was set down needs no line). Other tables still need the line.

### Measured on five worlds (the chain, n2 a world)

The fixes below went in while the runs went on: plains 1 and desert 1 had none of them; snowy 1 had F1; river 1 and
mountain 1 F1 and F2; plains 2, desert 2, snowy 2 and mountain 2 F1 to F3; river 2 all five. The table gives each
step's end, deaths with the step, and the nights.

| World, run | `!get kit` | `!get kit iron` | `!get bed` | night, shell off | night, shell on |
|---|---|---|---|---|---|
| plains 1 | done 161 s | died (arrow) at dusk, 492 s, in the mine step: 0 of 33, the staircase in the base | stopped 538 s: no sheep within 32 after 2 herd walks | 2 deaths (arrows) | 1 death; 2 cells open over the staircase hole |
| plains 2 | done 141 s | died (arrow) by day, 290 s, mining in a cave 124 from home (a zombie, a skeleton, a creeper) | died (arrow) at dusk hunting sheep | 0 | 0; no blocks (lost at the deaths) |
| desert 1 | done 167 s | no end in 30 minutes: two mine steps of 10 minutes, 0 of 33 and 0 of 9 (313 ores refused in the base), then fleeing | stopped 778 s: no sheep within 32 | 1 death (arrow) | 0; 4 cells open over the staircase hole |
| desert 2 | done 144 s | died to a creeper by day, 175 s, in the mine step (struck at it in reach, from 18 health) | died of a fall at 2 health fleeing a skeleton, by day | 2 deaths (a witch, an arrow) | 1 death (arrow); no blocks |
| snowy 1 | stopped 161 s: `!gather 4 got nothing (gather done: 6/4 logs)` (spruce) | the same, at once | the same, at once | 3 deaths (zombies; no weapon) | 2 deaths (arrows); no blocks |
| snowy 2 | died (arrow) by day at the food step, 402 s | the gather step's 10 minutes: paused by flee after flee (skeletons under the spruce) | the same | 0 | 1 death (arrow); the roof cell open (8 blocks placed, none left) |
| mountain 1 | done 232 s | 33 iron in 153 s, the furnace by home, then `!mine coal_ore 4` stopped at health 0.7 (skeletons and creepers in a cave by day); all the coal near was in the base (816 refused) | done 601 s (the kit's hunt had brought the wool) | slept in the bed (night skipped) | walled in, 0 |
| mountain 2 | stopped 96 s: `!craft stone_pickaxe 1 got nothing (no_table)` | the pickaxe crafted, 15 of 33 until it wore out, then `!gather 1 got nothing (gather done: 2/1 logs)` | stopped: no sheep within 32 | 0 (underground at the mine: the shelter unreachable) | 0 (the same) |
| river 1 | done 205 s | 33 iron, the furnace by home, 5 coal; died (arrow) at the furnace 287 s into the smelt of 33, at nightfall | died (arrow) at night | 0 (lowest 0.1) | 2 deaths (arrows); no blocks |
| river 2 | done 215 s | the coal step stopped at health 5 by day | died (arrow) at dusk hunting sheep | 0 | 0; no blocks |

In all: the stone kit done in 7 of 10 (141 to 232 s); the iron kit done in none (4 ended by a death, 2 by low health
in the coal step, 2 by a time limit, 2 by the faults fixed below); a bed in 1 of 10 (no sheep within 32 in 3, a death
in 4). Of 25 deaths, 10 came in the steps (4 by day: mining in caves twice, the food step under spruce, a fall while
fleeing; 6 at dusk or night, all arrows) and 15 in the nights alone, 8 with the shell off, 7 with it on. The
shell closed fully in 1 night of 10: no blocks left in 5 (every block is lost at a death), cells over a hole in 2
(the staircase that dug the base), the roof short of blocks in 1, the bot away from the shelter in 1.

### The fixes, before and after

Each measured on the world that showed it, a fresh copy per run, before on the code before this track:

| Fault | Case | Before | After |
|---|---|---|---|
| The staircase dug the base and the ore it opened was refused (F1) | plains, the stone kit given, home where a kit run ended, noon held, `!mine iron_ore 33` | 3 of 3: 0 of 33 at 660 s (no end), 69 blocks dug in the base, 306 ores refused | 3 of 3: 33 of 33 in 309 to 325 s, 0 dug in the base (walked out 51 from home first) |
| the same | plains, home at the spawn | 3 of 3 dug 48 blocks of the base; 33 of 33 in 385 and 422 s, 29 of 33 in 496 s (the pickaxe wore out) | 3 of 3: 33 of 33 in 218 to 259 s, 0 dug in the base |
| Spruce logs carried, no planks found (F2) | snowy, `!get kit` from nothing | 3 of 3 stopped in 133 to 191 s: `!gather 4 got nothing (gather done: 5/4, 9/4, 6/4 logs)` | 3 of 3 done in 316 to 517 s (spruce planks) |
| Coal in the base planned as fuel (F3) | mountains, the stone kit, 9 raw iron and 2 oak logs given, home where a kit run ended, `!get iron_ingot 9` | 3 of 3 done in 366 to 368 s, 7 steps: coal refused in the base, 1 coal found past it, the smelt timed out at 8, 9 more ore mined and 16 ingots made | 3 of 3 done in 95 to 96 s, 4 steps: 8 planks from the logs burned |
| The job's own table refused behind a block (F4) | mountains, `!get kit` from nothing | 1 of 3 stopped at 98 s `!craft stone_pickaxe 1 got nothing (no_table)` (and the chain's mountain 2) | 0 of 6 no_table: 4 done in 179 to 250 s, 2 stopped on food (no animal within 48); the own table used with no line in 1 (`craft: our table at ... has no clear line to its face: used as it stands`) |
| `!gather N` taken as more (F5) | mountains, 2 oak logs and a table carried, `!get chest 2` | 3 of 3 stopped at 1 s: `!gather 2 got nothing (gather done: 2/2 logs)` | 3 of 3 done in 27 to 30 s (`gather 4`, `craft chest 2`) |

e2e (`early-base.test.ts`, a flat test server, before once on the code before, after 3 of 3): the staircase with home
where the bot stands (`protectRadius 8`) dug 18 of 18 blocks in the base, after 0 of 18 and the walk-out line; 6 spruce
logs and `!get wooden_pickaxe` `stopped after 1 s: !gather 3 got nothing (gather done: 6/3 logs)`, after done in 3 s
with spruce planks; coal ore inside the base and `!get iron_ingot 3` `!mine coal_ore 1 got nothing`, after done in 37 to
38 s on planks; 2 logs carried and `!get chest 2` stopped at 1 s, after done in 27 s; the kit in a one-wide pit two
deep set 2 tables and stopped `!craft stone_axe 1 got nothing (no_table)`, after done in 9 to 10 s with 1 table.

## Dusk, the shell's blocks, the end line (Track E7)

Decision record: [decisions/0104-dusk-shell-blocks-creeper-end-line.md](decisions/0104-dusk-shell-blocks-creeper-end-line.md).
Track E5's five worlds lost 19 of 25 bots to arrows: 6 in a job's step that ran into the evening, the rest in the
nights, where the night shell had no blocks in 5 of 10. This track makes a job wait out the night, keeps the shell's
blocks, and keeps a job's end line when the chat rate limit is full. The creeper that killed one bot in a mine step
is in [pve.md](pve.md) "A creeper in reach" (measured; the rule built for it ships off).

### Dusk (`jobDusk`, on)

Before, a `!get` job knew nothing of the night. With a shelter set, the night rule took the bot there at dusk and held
it, the job's step paused under it; the step's 10 minutes ran on and the job ended in the night. With no shelter the
job worked through the night on the surface. Now:

- **The step ends at the night rule's dusk** (time of day 12000). While a step that walks or waits runs (a mine, a
  gather, a hunt, the food step, a smelt, a cook, a walk to a herd), the job ends it at dusk. A craft, the furnace
  step and the bed step are short and run on; the pause comes before the next step.
- **The job keeps its state** (targets, steps, notes, what fell short) and says where the night is spent:
  `get kit iron: paused for the night at step 6 (mine iron_ore 33: 15 of 33), at the shelter 10 64 3; resuming at
  dawn`. `!get status` says `paused for the night`.
- **It waits** until the night is over and the night process has let go of the bot (asleep in a bed: the night is
  skipped; walled in: the shell's dawn wait).
- **At dawn it goes on by itself**: `get kit iron: dawn: going on (paused at !mine iron_ore 33)`. A smelt ended at
  dusk left its input in the furnace, which smelted on; the job takes the output first (`...; smelted 8 iron_ingot in
  the furnace at x y z`). Then it plans again from what is carried. The end line carries `paused for 1 night`.
- A step ended at dusk caps nothing and is no dead end. A job started by night runs on and pauses at the next dusk.
  A death or the owner's `!get stop` ends the wait as it ends a step.

**Where the night is spent**, in this order:

1. a bed where the night rule sleeps (`autoSleep` on);
2. the shelter, or home when no shelter is set (the night rule's shelter is set to home for the night and put back
   at dawn). With `nightShell` on the bot walls in there as an idle bot does;
3. with neither set: the nearest enclosed spot the bot can walk to (`in the roofed spot at x y z`): a full floor, a
   roof that is no tree within 6 over the head, and at most 2 of the 8 cells round the feet and the head open (a
   tunnel's end, a niche). It is looked for by a flood over cells a body stands in, 12 blocks round the feet and 8
   up and down, so a pocket behind rock is never chosen;
4. else where it stands, when the night shell will wall in there (`nightShell` on, its 10 blocks carried, the open
   sky over it: `walled in where it stands (x y z)`);
5. else nowhere: the job works on tonight as it did before and says so at its end (`worked through a night (nowhere
   to shelter)`). Standing still all night in the open, or in a cave, is no safer than working.

When the night rule gives the walk to its shelter up (3 tries), the place is chosen once more from where the bot
stands (3 to 5 above); with nowhere there either, the pause ends and the job goes on (`the shelter is out of reach
and no roofed spot is near: going on tonight`).

The step the job ends cancels the walk the night rule began in the same second. Measured on the test server before
the fix: `night: shelter unreachable (interrupted), attempt 1/3; staying put, retry in 60 s`, and the bot stood in the
open for that minute. That try no longer counts (`NightSafety.retryNow`): the walk starts again at once.

`jobDusk` is on by default: with a shelter, a home or a bed the body does at night what the night rule did with it
before (the walk there, the hold), and with none of them and no shell the job runs on as before. What it changes for
a bot with a base: a `!get` job at dusk walks home (with only home set, it worked on before) and goes on the next
morning instead of ending in the night. It does not keep arrows off a bot at an open shelter: that is the night
shell's part (`nightShell`, off) with its blocks (below).

### The shell's blocks (`shellBlocks`, off)

The night shell places 10 throwaway blocks on open ground (its 9 cells and the roof's support) and stands in the
open with fewer. A death drops them all. With `!set shellBlocks on` the bot keeps 10 (cobblestone, dirt and the
other kinds the shell places):

- **Where they come from.** The ground near the bot, within 10 blocks, nearest first: dirt kinds by hand (grass,
  dirt, podzol: a dirt block each), natural stone kinds with a pickaxe the worn-tool rule allows (stone, deepslate,
  andesite, diorite, granite, tuff, sandstone).
- **Which cell.** Its top is open (air, a plant, a snow layer), and it lies on a surface: at least 3 of the 4 cells
  beside the one over it are open, so the floor of a hole is never dug and every hole stays one deep. Never under or
  next to the feet, never a cell a liquid touches, never a built block (planks, bricks, cobblestone: what someone set
  down), never within 4 of the night rule's shelter (the shell needs its floor), never in the base (the navigator's
  protected area: `protectRadius` round home).
- **Inside the base** nothing qualifies: the bot walks out of it first, by branch mining's ways out (the line from
  home through the bot at `protectRadius` + 3, then 45 degrees either way: 3 tries), and digs there (`blocks: inside
  the base (48 round home): walking out to x z before digging`).
- **When.** A job digs them from 1 200 ticks before dusk when it is short (once a day; it ends its step for it),
  first after a death it goes on from (`deathReturn`), and before its end line (`dug the night shell's blocks`, or
  `the night shell N blocks short`). With no job running, the blocks chore (`blockschore`) digs them by day when
  nothing else runs and no hostile is within 16: after a respawn it comes before the walk home, and a death in the
  night is made good in the morning. A refill that ends short waits 5 minutes.

It is off by default because it digs the ground on its own (one-deep holes, 10 a refill at most, outside the base).

### The end line

A job's end line (`get kit iron: done ...`, `stopped ...`, `failed ...`) goes out through `Chat.sayKept`: when the
chat rate limit is full, or the bot is not spawned (a death, a reconnect), the line is kept and sent as soon as a
slot frees, in order. At most 4 lines are kept, each for 2 minutes; the same line is kept once. Every other reply is
dropped by a full rate limit as before. Seen once on a fresh world: a job's `stopped` line and its last step's reply
in the same second, and the owner saw neither.

### Measured on fresh worlds (n2 a world a side)

Three of Track E5's worlds (plains, the desert, the river bank), a fresh copy for every run, difficulty normal, the
bot alone. A run: the stone kit given at the spawn (a table, a stone sword, pickaxe and axe, 16 cobblestone, 6 bread,
16 logs), the clock set to 10000, `!home set` and `!shelter set` where the bot stands (open ground), `!get kit iron`.
Dusk comes about 100 s into the job, in its first mine step (branch mining, 51 blocks from home). The run watches
the job, or the bot alone once the job has ended, through the night to 2000 of the next day (800 s), then stops the
job and sets the clock to dusk again for a second night alone with `nightShell` on. "Before" is the code before this
track with its defaults (`nightShell` off in the first night). "After" has `jobDusk` and `nightShell` on from the
start and `shellBlocks` on once home is set.

| World, run | Night 1, in the job | Lowest health in night 1 | The morning after | Night 2, alone, the shell |
|---|---|---|---|---|
| plains, before 1 | the step waits at the shelter under the night rule (inside 151 s after dusk: 2 tries at the walk failed first); **died (arrow)** at 21098, `stopped by a death (arrow) after 543 s` | 0 | - | walled in (10), 0 deaths |
| plains, before 2 | waits at the shelter (inside 88 s after dusk: a try failed first) | 4 | the step goes on; running at the end | 1 cell open: the cell over the job's crafting table by the shelter; 0 deaths |
| desert, before 1 | waits at the shelter (32 s) | 9 | goes on; `stopped after 777 s: !furnace got nothing (the walk home failed (unreachable))` | walled in (10), 0 deaths, lowest 11 |
| desert, before 2 | waits at the shelter (32 s); **died (arrow)** at 21990, `stopped by a death` | 0 | - | `0 throwaway blocks for 10 open cells; standing in the open`; 1 death (a mob), lowest 4 |
| river, before 1 | waits at the shelter (43 s) | 20 | goes on; `stopped after 748 s: !craft furnace 1 got nothing (request_failed status 49)` | 2 cells open (one side); 0 deaths, lowest 12 |
| river, before 2 | waits at the shelter (43 s) | 3 | goes on; running at the end | 2 cells open; 0 deaths, lowest 16 |
| plains, after 1 | `paused ... at step 1 (mine iron_ore 33: 4 of 33)`; inside 13 s, walled in (10) | 20 | `dawn: going on` 92 s after dawn (the shell's wait for the hostiles near); `stopped after 750 s: !mine iron_ore 5 got nothing (health low)`; died to a witch's potion at 1799 | 2 cells open for lack of blocks (the death came 17 s before the clock was set to dusk; the chore dug 10 the next morning, outside the base); 0 deaths, lowest 17 |
| plains, after 2 | paused (4 of 33); the shelter out of reach from the mine's staircase (3 tries, 2 minutes), then `walled in where it stands` in the staircase (1 block) | 20 | going on 84 s after dawn; running at the end | walled in (10), 0 deaths |
| desert, after 1 | paused (0 of 33); inside 34 s, walled in (10) | 16 | going on 75 s after dawn; running at the end | walled in (the 2 of the opened side), 0 deaths |
| desert, after 2 | paused; inside 32 s, walled in (10) | 20 | going on 92 s after dawn; running at the end | walled in (2), 0 deaths, lowest 16 |
| river, after 1 | paused; inside 42 s, 2 cells open | 20 | going on 2 s after dawn; running at the end | 2 cells open; 0 deaths, lowest 17 |
| river, after 2 | paused; inside 42 s, 2 cells open | 10 | going on 16 s after dawn; **died (arrow)** by day at 806, 80 blocks out on the way to the mine: `stopped by a death` | the chore walked out of the base for its blocks (9 to 12); 2 cells open; 1 death (arrow), lowest 2 |

In all:

- **Deaths at dusk and in the night during the job: 2 of 6 before (arrows, at the open shelter), 0 of 6 after.** The
  lowest health of the night: 0, 4, 9, 0, 20, 3 before; 20, 20, 16, 20, 20, 10 after.
- **The job after the night.** Before, 2 of 6 ended by the death; the other 4 went on in the morning because their
  mine step's 10 minutes had run out under the night rule and the iron kit takes that as a short step. After, 6 of 6
  said where they spent the night and went on at dawn. No iron kit finished in either arm within the run (the mine is
  51 blocks out and the run ends 150 s into the second day).
- **By day after the night** 2 of 6 after-runs lost the bot (an arrow at 806, a witch at 1799), none before. The
  walk back out to the mine in the first minutes of the day meets what the night left; nothing in this track looks
  at that.
- **The shell closed fully** in 2 of 6 nights before (night 2) and in 7 of 12 after (4 of 6 in the job's night, 3 of
  6 in night 2). What kept it open: one side with nothing to place against at the river bank (6 nights of 6 there,
  both arms); the cell over the job's own crafting table (1, before: the click on a table opens it); no blocks after
  a death (1 before: none for the whole night; 1 after: 2 short until the morning's refill). In both no-block nights
  the death came by day or in the night before; with `shellBlocks` the chore refilled outside the base both times.
- A shelter the walk does not reach from the mine (plains, after 2: `shelter unreachable` 3 times from the staircase)
  is where the fallback acted: walled in where it stood, 20 health all night.

A first plains after-run is not in the table: `shellBlocks` was on from the spawn, the chore dug 2 cells before the
kit arrived, and `!home set` came with the bot standing in one of them. The shell over that hole closed with 5 blocks
both nights (0 deaths), but at dawn it opened one head cell and the bot stood under its own roof, inside the base,
with no step out: the job stopped 2 s after dawn. That is the fault `shellStepOut` fixes ("The night shell"); the run
was made again with the setting on after `!home set` (plains, after 1).

### Measured (e2e, the flat test server)

`early-dusk.test.ts` and `early-blocks.test.ts` on the flat, peaceful test server with the truth pack; the clock is
frozen there, so a case sets it to dusk once the step runs. Three runs of each suite on the final code, every case
passing in each; the numbers are the three runs' ranges.

| Case | With the rule | Without |
|---|---|---|
| `pause`: a shelter 6 blocks off, `nightShell` on, 8 iron ore, `!get iron_chestplate`, dusk after the first ore | `paused for the night at step 1 (mine iron_ore 8: 1 of 8), at the shelter x y z; resuming at dawn` 4.7 s after the command; walled in at the shelter 9.1 to 11.7 s after it (the 8 cells and the roof); nothing dispatched in the night; `dawn: going on (paused at !mine iron_ore 8)` 2.2 to 3.1 s after the clock went to dawn; `done in 123 to 125 s, 6 steps; paused for 1 night`: `mine iron_ore 8, mine iron_ore 7, craft furnace 1, furnace, smelt raw_iron 8, craft iron_chestplate 1`; the shelter as the owner set it | `jobDusk` off (`off`): 20 s into the night the bot stands at the shelter with the mine step waiting under the night rule; no line |
| `smelt`: a furnace and 8 raw iron carried, dusk once the iron is in the furnace | `paused for the night at step 2 (smelt raw_iron 8: 8 of 8 in the furnace), at the shelter x y z`; `dawn: going on (paused at !smelt raw_iron 8); smelted 8 iron_ingot in the furnace at x y z (0 s)`; `done in 124 s, 3 steps; paused for 1 night` | - |
| `here`: no shelter, no home, `nightShell` on | `paused ..., walled in where it stands (x y z)`, 9 of 9 cells; the night rule's shelter is that cell for the night and unset again at dawn; done in 115 to 117 s | `nowhere` (`nightShell` off): no pause; `done in 105 to 106 s, 5 steps; worked through a night (nowhere to shelter)` |
| `pit`: no job; the shelter in a one-deep hole inside the base, `nightShell` on | `night shell: walled in, 6 block(s) placed` (the head ring, the roof and its support); at dawn `opened (3 of 3 cell(s) dug)`: a side's head cell, the roof and the support; home 5.3 to 5.4 s after the clock went to dawn; 4 of 4 walls of the hole standing | on a fresh world before the rule: one head cell opened, no step out (above) |
| `chore`: nothing carried, by day, `shellBlocks` on | 10 blocks carried 29.0 to 30.1 s after the setting went on (`blocks chore: 0 -> 10 shell blocks, 10 dug`); no cell dug within 1 of the feet | - |
| `base`: home where the bot stands, `protectRadius` 16 | `blocks: inside the base (16 round home): walking out to x z before digging`; 10 blocks in 32.1 to 35.7 s; 0 cells dug within 11 of home; the bot ends 16.2 to 17.0 from home | - |
| `job`: 3 cobblestone and 2 sticks, the clock 50 s before dusk, `!get stone_pickaxe` | the blocks dug first (the `blocks` step), then the craft; `done in 37 to 38 s, 1 step; dug the night shell's blocks`; 10 carried at the end | - |
| `death`: `nightShell` on, 16 cobblestone, killed by day, the drops removed, then dusk | 10 blocks carried 29.6 to 30.1 s after the respawn (the chore), `night shell: walled in, 10 block(s) placed` that night, 9 of 9 cells | `shellBlocks` off: 0 blocks, `night shell: 0 throwaway blocks for 10 open cells; standing in the open`, 0 of 9 cells |

## Early-game leftovers (Track E10)

Five things Tracks E5 and E7 left open, each reproduced first and kept as a test. Decision record:
[decisions/0112-early-leftovers.md](decisions/0112-early-leftovers.md). No new setting.

### The night shell's open sides

A block goes in only against a face, a solid neighbour the server lets the bot click. Air, a plant, a crafting table
and a furnace are not faces: the last two open on a click. The shell's cells were placed in a fixed order, and a cell
with no face beside, under or over it got `no_face` on every try.

- **The river bank.** On the measured river spawn the ground north of the shelter is one lower: grass at the shelter's
  floor height minus one, a tuft over it. The north feet cell had nothing solid round it, and the head cell over it
  then had nothing either.
  - Before: 3 of 3 nights `seal: 8 block(s) placed, 2 cell(s) still open (0 0 -1, 0 1 -1)` (a fresh copy of that
    world a run, the chain's `shell` steps: 16 cobblestone, `nightShell` on, the clock to dusk).
  - After: 3 of 3 `night shell: walled in, 11 block(s) placed` in 7.5 to 8.5 s. The support stands under the north
    feet cell (probed).
- **The cell over a table.** A crafting table in a feet-ring cell (the job's own table by the shelter) gives the
  head cell over it no face, so that cell stayed open.
- **The rule (`faceSupports`, every shell: night, smelt, the reflex's seal).** The cells are taken in an order where
  each has a face, in the world or in a cell placed before it.
  - A feet-ring cell over a step down gets a support under it first: up to 2 deep, bottom-up, when the lowest has a
    face. One support is enough for any drop, because it touches the block the body stands on.
  - A cell over an interactive block gets a corner brace at its height, beside it, when that cell is free and faced.
  - On open ground nothing changes (10 cells).
  - The faces are the world's own (`SealDeps.face`, the nav grid plus the block's name).
  - With only the shell's own 10 blocks and a support needed, the shell is placed as far as the blocks go (the cell
    planned last stays open) instead of being refused.
- **The line.** A shell that does not close names each open cell and why:
  `night shell: 2 cell(s) open (x y z no_face, x y z no_face), 8 block(s) placed`, kept as `NightShell.lastOpen`.
- **Measured (e2e, the flat test server, n3 a side).**
  - The step down: before, 2 of 9 cells open (that side's feet and head cells) 3 of 3; after, every cell solid 3 of 3
    (`night shell: walled in, 11 block(s) placed`, cobblestone in the cell under that side's feet cell).
  - The table in the south feet cell: before, the cell over it open 3 of 3; after, every cell solid 3 of 3 (`walled in,
    10 block(s) placed`: the brace and 9 cells).

**A death in the night.** What the bot does today: it respawns, the night rule takes it back to the shelter, and the
shell refuses (`night shell: 0 throwaway blocks for 10 open cells; standing in the open`). With `shellBlocks` on, the
blocks chore digs 10 the next morning (Track E7). Nothing new is built for the night itself, for these reasons:

- A dig needs the bot out of the shelter cell for 10 to 30 s, at night, with the mobs that killed it near.
- The only measured night deaths were arrows at an open shelter. Whether a dig in the dark is safer than standing in
  guard at the shelter was not measured.

The safest answer with the rules that exist is the bed (Track E3). After a death the respawn is by the bed, and the
night rule sleeps there with no blocks at all. That is why sheep for the bed come next.

### The fuel

The obtain job counted the fuel kinds together, while the furnace's fuel slot takes one kind. With 6 raw beef, 3
planks and 2 logs the job counted 7.5 items of fuel. The cooker put in the 3 planks (4.5 items), cooked 4 and said
`cook: no fuel (...) (cooked 4 cooked_beef first)` with the 2 logs still carried. A second `!cook` used them.

Now `planFuel` takes the best kind that covers the batch alone. When the slot runs empty with input left, it is
fuelled again from what is carried (up to 3 times), and `no fuel` comes only when nothing is carried that burns
([food.md](food.md) "Fuel for the whole batch").

- e2e, a furnace by the bot, 6 beef, 3 planks, 2 logs, `!cook`: before, 3 of 3 `no fuel` with 4 cooked in 62.3 s;
  after, 3 of 3 `cooked 6 cooked_beef ... (63 s, fuel 3 oak_planks, 2 oak_log)` in 63.8 to 64.0 s, with `cook: the fuel ran
  out with 2 beef left: fuelled again`.
- The iron kit's e2e (`iron-get`), counted in one run on the final tree: 0 `no fuel` log lines. The 13 raw iron were
  smelted and the 6 beef cooked, with the logs for the fuel gathered by the job (`gather 6`, `gather 1`).

### Sheep for the bed

The bed's wool comes from a hunt (`!kill sheep 3`), which looks within 32, then from two walks to herds the bot
remembers. On fresh worlds this found no sheep in 3 of 10 runs.

A spectator was teleported over a grid 64 apart round two of Track E5's spawns, waiting 4 s at each point for the
mobs the server sends:

| World | Sheep within 256 of the spawn | Within 32 / 64 / 128 of the spawn | Within 32 / 64 / 128 of where a kit ended | Groups |
|---|---|---|---|---|
| plains | 9 | 1 / 4 / 9 | 3 / 4 / 6 and 0 / 2 / 6 | 1 or 2 each |
| desert | 0 | 0 / 0 / 0 | 0 / 0 / 0 at both | none |

The sheep stand alone or in twos, spread over 100 blocks and more; the desert has none within 256 at all. The server
sends a player the mobs within about 64 to 80 blocks (the flat test server: sheep 39 and 65 off sent, 80 to 192
not), so the herd memory holds only those the bot came that near, and a mark is where a sheep stood then. A look of 32
misses most of them. Four ways were weighed:

- a wider look: the server sends mobs only within its range, so a wider radius sees none of the far ones;
- string to wool (4 string, `minecraft:string_to_wool`, in the server's recipes): an early bot carries no string;
- a reply that says how far it looked: kept, but on its own it finds no sheep;
- a bounded search walk by day: chosen.

**The search walk (`chat/kit-search.ts`).** A hunt for a job's material that got none, with no remembered herd left
to walk to, searches once a job in the shape of Track E8's water search:

- legs 96 out along +x, +z, -x and -z, 32 at a time, at most 300 s;
- after each step it looks at the mobs the server has sent; the first of the kind seen is walked to (when it is more
  than 24 off) and the hunt runs again;
- a leg that moves less than 8 is given up for the next;
- the steps are the job's own `!goto` steps, so `jobDusk` ends them at dusk (the job searches again by day) and the
  flight count covers them;
- the end line says how far it looked: `looked for sheep: walked 412 along the axes in 240 s, none seen` or `...,
  one seen 71 off`.

e2e, no sheep within 32 and none remembered, a flock of 6 held still 110 east, 3 planks and a table, `!get bed`:
before, 3 of 3 `get bed: stopped after 2 s, 1 step: !kill sheep 3 got nothing (kill sheep: 0/3, no more within 32
blocks)`; after, 3 of 3 `get bed: done in 38 s` to `44 s` with `looked for sheep: walked 32 along the axes in 7 s, one
seen 108 off` (108 to 110). At 110 the flock lies past the range the server sends mobs within, so the bot has never
seen it. A flock within that range is in the herd memory already, and the code before walked to it (3 of 3 in 31 to
35 s when the flock lay 70 off).

On the plains world, a fresh copy each run, the bot put where a stone kit had ended with no sheep within 32 of it
(0 / 2 / 6 in the table), a table, a sword and 3 planks, noon held, `!get bed`, n3 a side: before, a bed 1 of 3 (74 s;
the other two `stopped after 54 s, 7 steps: !kill sheep 1 got nothing`, the two remembered herds walked to and used
up); after, a bed 3 of 3 in 38, 111 and 116 s. One run needed no search (the herds were enough). In the other two the
search ran with `one seen 64 off` (seen at its start, before a step) and `walked 64 along the axes in 20 s, one seen
121 off`. 0 deaths in either arm.

### A step lost to flights

Under spruce on the snowy world, skeletons in the shade paused a gather step flight after flight until its 10
minutes ran out. The end line was `stopped by the step's 10-minute limit (!gather 2) after 600 s`, with nothing
about the flights.

The reproduction (e2e): no blade, a skeleton with no bow held still among four trees, difficulty easy for the case,
`!get oak_planks 16`. The flight on foot (`bareArcher`) fires each time the bot walks back into the skeleton's
sight. Before: no end line in 180 s, with 37 flights, 105 s of them fleeing (58 %) and 0 logs.

Now the job counts the flights while a step runs: the flee process holding the body, their time, and the hostile
kinds within 24 then (`chat/kit-flights.ts`).

- Every step's record carries them: `!gather 4: 0 of 4 logs in 182 s: 6 flights took 141 s (skeleton)`, as a note
  in the end line.
- A step is ended as mostly flight when all of these hold: it has run 120 s, it gained fewer items than one every 30 s, it had 3 or
  more flights, and 40 % or more of its time went on fleeing. The job then stops with `get oak_planks: stopped after
  121 s, 1 step: !gather 4: 0 of 4 logs in 120 s: 25 flights took 70 s (skeleton); the step was mostly flight`.
- The share alone is not the measure: the flights are short (about 3 s each), and the walk back to the tree between
  them is lost as well.
- A step that still gets its items goes on, flights or not. A gather that works gets a log every few seconds. "Nothing
  gained for 120 s" was tried first and missed a run that took 2 logs in 180 s (33 flights, 97 s fleeing).
- When the bot flees is not changed.

Before: 3 of 3 no end line in 180 s (35 to 37 flights, 103 to 105 s fleeing, 0 logs), and the step would have run on to
its 10 minutes. After: 3 of 3 `stopped after 120 s` or `121 s`, with 21 to 25 flights taking 63 to 70 s and 0 to 3 logs
gathered.

### `!get status` after a job

`!get status` named the last plain `!get` (`get: idle (last: 8 oak_log via !gather 8)`) after an obtain job had
ended. Now an obtain job that ended after the last plain `!get` is the last: `get: idle (last: get stick: done in
...)`, cut at 160 characters. e2e, `!get oak_log 2` and then `!get stick 4`: before, 3 of 3 `get: idle (last: 2 oak_log via
!gather 2)`; after, 3 of 3 `get: idle (last: get stick: done in 1 s, 1 step (craft stick 4))`.

## The way home and the morning after (Track E9)

Decision record: [decisions/0111-way-home-and-morning.md](decisions/0111-way-home-and-morning.md). Track E7's runs
left three things: the walk home from the mine was refused at once, 2 of 6 bots died in the first minutes of the day
after a night, and no iron kit finished within a run. This track finds why the walk was refused and makes it, looks
at what stands round the shelter at dawn and makes the job wait for it, and runs the same protocol to the job's end.

### The walk home from the mine

**Where it was refused.** Seven refusals from Track E7's runs, each asked again offline: the run's own world cache
with every dig and placement the log has after the refusal undone, so the planner is given the blocks it had then.

| World, walk | The body | The plain search | The dig way's 12 blocks | The way out |
|---|---|---|---|---|
| plains, the night rule's walk at dusk (two runs) | in a one-wide shaft the mine step dug straight down from the surface, 11 deep, 5 and 6 back up on its own cobblestone pillar | `none`, 1 node: no move from the start | `none`, 495 and 499 nodes | a stair of 15 and 18 dug blocks |
| a desert, the furnace step's walk home in the morning | at the end of a cut whose last legs were drops of 2 and 3 | `none`, 24 nodes (the run's log: `start:none/22n/24e`) | `none`, 2 629 | 24 |
| the same run, the night rule's walk 22 s later | on the way up, 7 higher | `none`, 29 | found with 12 (the run's log: `none` after 1 926) | 13 |
| plains, the furnace step by day (the clock at 4000) | in a pocket 29 under home's level | `none`, 13 | `none`, 1 643 | 20 |
| plains, the furnace step (an earlier run) | at the foot of a shaft 34 under home's level | `none`, 16 | `none`, 2 658 | 48 |
| plains, the night rule's walk (an earlier run) | at the foot of a shaft 36 under home's level | `none`, 17 | `none`, 1 638 | 61 |

Every one is the same thing. The mine step's own walks dig and place: one digs straight down to an ore under its
feet and pillars back up, another drops down a cut it made. The walk that comes next is another caller's and plans
as every goto does: no place moves, and a dig way of at most 12 natural blocks. From inside the shaft that is an
exhaustive search of a closed pocket, and the goto ends `unreachable` within a few ticks. The miner's own way back
(`returnUp`, which may dig) is a walk of its own that the job's next step takes the body from. It is not the
staircase of branch mining (that one has steps of 1 and is walked), not the base's protect rule, not unloaded chunks
and not a search limit: the searches were exhaustive and said so (`no path (exhaustive search, 1 nodes expanded): no
move from the start ...`).

**The rule.** A goto whose last level ends in an exhaustive `none` over loaded world is shut in, and plans once more
with a dig way of 128 blocks ([pathfinding.md](pathfinding.md) "Shut in": `goto: shut in (...): no way out on foot
or with 12 dug blocks; digging out, up to 128 natural blocks`). The dig way's rules hold: natural terrain, nothing in
the base, nothing beside a liquid or under gravel or sand, no place moves. It follows the setting `digWay` (on).

**A walk that fails says why.** The furnace step, the bed step and the night rule now ask the navigator why a walk
was refused and say it: `furnace: the walk home failed (unreachable: rule protected_area: no digging in the base
(protectRadius))`, `night: shelter unreachable (unreachable: budget: the searches or the walk ran out before the
goal), attempt 1/3`. `budget` is a search's limit; `world` means nothing gets there.

**Measured on the worlds where it failed.** A fresh copy of the world for every run, the stone kit given, home and
shelter at the spawn, `!get kit iron`. "By day": the clock held at noon, the run watched until the furnace step
ended (the furnace stands by home, so that step is the walk home from wherever the mine step ended). "At dusk": the
clock put to dusk at the moment the mine step has its ore, so the night rule's walk to the shelter starts from the
same kind of place; the run watched until the night rule is inside its shelter, or 300 s.

| The walk | Tree | n | Got there | What was said and done |
|---|---|---|---|---|
| by day, plains: the furnace step's walk home, from 17 to 28 under home's level, about 115 blocks off | before | 3 | 0 of 3 | `furnace: the walk home failed (unreachable)` 0.8 to 0.9 s into the step, the job's end |
| | after | 3 | 3 of 3 | `furnace placed at ... by home`, the step 40 to 48 s; shut in in 2 of them (19 and 20 blocks dug; the walk 42 and 47 s over 108 and 123 blocks), the dig way's 12 blocks enough in the third |
| by day, a desert | before | 2 | 1 of 1 that got to the step | the other bot stood in a one-cell pool inside the base from 16 s into its run ("Still missing", 19) |
| | after | 2 | 2 of 2 | the step 50 s each; neither walk started shut in |
| at dusk, plains: the night rule's walk to the shelter, from 28 to 32 under home's level, about 45 blocks off | before | 5 | refused 5 of 5 | `night: shelter unreachable (unreachable), attempt 1/3` 0.3 s after dusk; inside the shelter within 300 s: 1 of 5 (105 s after dusk). The bots came up by the miner's own walk back (`returnUp`, 45 s) where nothing took the body from it, and walked home in the dark after |
| | after | 5 | refused 0 of 5 | `night: inside the shelter` 36, 61, 48, 48 and 48 s after dusk; shut in in 3 (20 to 23 blocks dug), the dig way's 12 blocks enough in 2 |

No bot died in these 20 runs. A walk that starts in a mine is not always shut in: where the mine step ends
differs from run to run on one world, and in 3 of the 8 walks after, the pocket was small enough for the dig way's
12 blocks. Dusk left to fall where it falls (the clock at 10000 as in Track E7) did not show the refusal on the
tree before: 5 of 5 times the bot stood on the surface at 12000 and was inside its shelter 13 to 27 s later (in
Track E7's four plains runs it stood in the shaft in 3). Nor did four runs with the clock put to dusk at the walk's
first pillar block: that pillar was a step near the surface, and both trees walked home.

e2e (`early-home.test.ts`, the flat test server; before once on the tree before, after 3 of 3). `shaft`: before
`furnace: the walk home failed (unreachable)` after 0.6 s, nothing dug; after `furnace placed at ... by home` in
20.4 to 20.5 s, 18 blocks dug, `goto: shut in (no path (exhaustive search, 513 nodes expanded)): ...`. `night`:
before `night: shelter unreachable (unreachable), attempt 1/3` after 0.4 s; after `night: inside the shelter after
20.5 to 20.7 s`, 18 blocks dug. `craft` (the job's craft with no cell for its table, "The iron kit to its end"):
before `get furnace: stopped after 1 s, 1 step: !craft furnace 1 got nothing (craft: made no furnace (no_table);
...)`; after `get furnace: done in 25 s, 4 steps; crafted again at home after no room for a table; ...`, 18 blocks
dug on the walk home.

### The morning after

**When the undead burn.** The night rule's dawn is 23000. Six undead summoned on an open plain at 22900 (three
zombies, three skeletons, nobody near, their health read every second): the first fire damage came at 23446 (the
three skeletons), 23494 and 23640 (two zombies); three were gone at 23867 and one at 39 of the next day. One skeleton
walked down into a cave at 12 health and lived. One zombie never caught fire in 3200 ticks. So on open ground the sun
starts at about 23460 (the tick a bed stops taking a sleeper) and is done by about 60; in shade, in water or
underground nothing burns at all, and a creeper, a spider, a witch or a husk never does.

**What stands round the shelter at dawn.** The truth pack's own list of every mob within 48 of the bot, asked every
5 s from 600 ticks before dawn to 2400 of the day, in the runs below (the bot walled in at its shelter, or out
already):

| World | Mornings | Hostiles within 16 just before dawn | Within 32 | Within 32 when the job went on |
|---|---|---|---|---|
| plains | 6 | 0 to 2 | 8 to 15 (zombies, creepers, skeletons, spiders, a witch in 3) | 2 to 16 |
| a desert | 4 | 2 to 7 | 17 to 18 (zombies, husks, creepers, spiders, zombie villagers, a parched or a bogged, a witch in 2) | 17 to 21 |
| a river bank | 8 | 0 to 1 | 2 to 7 (creepers, drowned, zombies, skeletons, spiders) | 3 to 6 |

Two things in it. The crowd is 16 to 32 blocks off, not at the door: within 16 there were 0 to 2 on plains and at
the river and 2 to 7 in the desert. And it does not thin out by itself: with or without the wait, as many stood
within 32 when the job went on as before dawn, because what is left by then is what does not burn (creepers,
spiders, husks, a witch) or stands in shade or water. Where the bot goes first is its mine: 31 to 135 blocks from
home in these runs, straight through that ring.

**What the bot's rules do with a morning as they are.**

- The night rule lets go at 23000. A night shell stays shut while a hostile is within 16, for 90 s at most, then
  opens the side away from them. Both happen before anything burns.
- The job goes on the moment the night rule lets go, and its step walks at once: the mine step 50 to 90 blocks to
  where it was. Nothing looks at what is near first: trip readiness (eat and heal under 14, no trip by night without
  a chestplate) is asked by `!come`, `!follow`, `!kill` and the walks of the PvE layer, not by `!mine`.
- The reflex strikes what comes within reach under every step (a zombie takes 3 or 4 strikes of a stone sword, a
  creeper 4). The flight on foot starts under 8 health (`fleeHealth`) and pre-empts the step (`mine: paused`); the
  step goes on when it ends. Guard is off unless the owner turns it on.
- **An archer** out of reach gets no answer until the health is under 8: with a blade carried the flight does not
  start for it earlier, and nothing walks at it. One run stood 25 s at its mine with two skeletons 8 and 10 blocks
  off while its walk planned, took 5 arrows and died on the flight.
- **A witch** is not a night mob: she does not burn and does not leave. With guard on and a blade she is the first
  target within 12 (docs/pve.md "The witch, by kit"); with guard off, as a job runs, the reflex strikes her only
  within reach, the potion side step runs for a splash it sees coming, and the flight starts under 8 health, which
  her poison has by then. One of Track E7's runs left its shell at the end of the 90 s with her 4 blocks off and was
  dead 52 s later. The job's steps respect the fight rules in the sense that a flight or a guard fight takes the
  body from the step and gives it back; no step waits for a witch to be gone.

**The rule (`jobMorning`).** A job that waited out a night goes on only once:

1. the sun is up: the time of day has reached `MORNING_SUN` 23460 (`morning: waiting (the sun is not up)`);
2. the undead it burns are gone: `MORNING_BURN` 600 ticks later, 60 of the day (`the undead are burning`);
3. no live hostile is within `MORNING_NEAR` 16 blocks of the bot, burning or not (`a creeper 9 blocks off`);
4. or `MORNING_MAX` 3000 ticks have passed since the night rule's dawn (2000 of the day, 150 s). A mob that is still
   near then is not leaving by itself, and the job says so: `dawn: going on after 150 s (the morning did not clear:
   witch 4 blocks off)`. The bound also runs on the wall clock, so a server whose clock stands still does not hold
   the job for ever.

Until then the night rule keeps the bot where it spent the night (`NightSafety.hold`: `dawn: staying in the shelter
for the morning (...)`): a night shell stays shut, the walk home at dawn waits, and no other process takes the body.
A night shell has a dawn wait of its own (shut while a hostile is within 16, 90 s at most); a dawn that was held 90 s
or longer (`HELD_DAWN_MS`) has waited for it, and the shell opens at once, on the side away from what is near. So the
longest morning is the rule's 150 s, not 150 and 90 (one run before this waited 242 s for a zombie at the shell's
corner). A clear morning costs 53 s of the 650 between dawn and dusk. The rule waits and nothing else: it digs and
places nothing and changes no fight rule. It asks only about a job that paused for the night; an idle bot's dawn is
as before.

**Why these numbers, for any world.** Leaving at 23000 is leaving by night: nothing has burned yet, at the shelter
or on the way (one run found 7 zombies and 3 skeletons at full health at its mine, 77 blocks from where it had spent
the night, 30 s after dawn). From 60 of the day what stood in the open is gone. 16 blocks is the range an archer or
a witch hits from and the night shell's own dawn radius. What the rule cannot do is clear what does not burn, or
stands in shade or water: it holds for it up to its bound and then goes.

**Measured, n6 a side** (the three worlds, a fresh copy a run, Track E7's protocol; counted as Track E7 counted:
deaths in the 3400 ticks from the night rule's dawn to 2400 of the day, the lowest health in them, the job going
on). "Before" is `jobDusk`, `nightShell` and `shellBlocks` on, `jobMorning` off, on this track's tree; Track E7's
own six runs of that arm, on the tree before, are the second "before" row. "After" adds `jobMorning`.

| Arm | Deaths, dawn to 2400 of the day | Lowest health then | The job went on | Seconds after dawn | Deaths in the 120 s after it went on | Lowest health in them |
|---|---|---|---|---|---|---|
| before, Track E7's runs | 2 of 6 (a witch's potion at 145 s, an arrow at 94 s) | 0, 20, 20, 17, 20, 0 | 6 of 6 | 93, 84, 75, 92, 2, 16 | 2 of 6 | 0, 20, 20, 17, 20, 0 |
| before, this track's tree | 1 of 6 (an arrow at 77 s) | 0, 20, 20, 20, 11, 20 | 6 of 6 | 2, 3, 64, 2, 93, 92 | 1 of 6 | 0, 20, 20, 20, 10, 20 |
| after (`jobMorning`) | 0 of 6 | 20, 20, 16, 20, 7.2, 20 | 6 of 6 | 242, 90, 152, 153, 56, 152 | 0 of 6 | 20, 20, 1, 15, 7.2, 20 |

The "after" runs are the six iron kits below, their first morning; the first of them ran before a held dawn opened
the shell at once (its 242 s are the rule's 150 and the shell's 90). Six more mornings with the rule (the kits'
second mornings, and both mornings of two later runs): 0 deaths, the job went on in 6 of 6 after 54 to 171 s,
lowest health 15 to 20. In all: 0 deaths in 12 mornings with the rule, 3 in 12 without.

What the numbers carry. Nothing hurt a bot while it waited, in any of the 12 mornings. One death in six against
none is not a difference n6 can carry by itself; with Track E7's six it is 3 of 12 against 0 of 12. What the rule
does not change is the walk back out: the lowest health in the two minutes after the job went on is no better with
it (the right-hand column), and the ring 16 to 32 blocks off is as full as before dawn. The cost: 54 to 90 s where
the morning cleared (5 of 6 mornings at the river bank) and the whole 150 s where it did not (6 of 6 mornings on
plains and in the desert: a zombie 2 blocks from the shell, a skeleton, a creeper, a witch, husks).

**Off by default.** Every run here had the night shell on, and the night shell is off by default: without a shell
the rule would hold the bot in an open shelter while a hostile is within 16, and no run looked at that. With
`nightShell` on it is the cautious choice (`!set jobMorning on`).

e2e (`early-home.test.ts`, the flat test server, 3 of 3). `morning`: a creeper in a stone box 10 blocks from the
shelter, the night shell shut, the clock put to 1500 and held: `get iron_chestplate: morning: waiting (a creeper 10
blocks off)`, `dawn: staying in the shelter for the morning (a creeper 10 blocks off)`, the shell's 9 cells standing
6 s later; the creeper taken away: `dawn: going on after 10 s (paused at !mine iron_ore 8)` (10 to 11 s) 2.3 to
3.1 s later, the
shell opened. `morning off` (`jobMorning` off, no shell): `dawn: going on (paused at !mine iron_ore 8)` 1.1 to 1.2 s
after the clock went to 1500, the creeper alive 10 blocks off.

### The iron kit to its end

Track E7's dusk protocol, watched to the job's end line instead of the first morning (50 minutes at most): a fresh
copy of the world a run, the stone kit given, the clock set so that dusk falls in the first mine step, home and
shelter at the spawn, `jobDusk`, `nightShell`, `shellBlocks` and `jobMorning` on, `!get kit iron`. Six runs, two a
world, in the order they ran. Each ran on the tree as it was then: what ended a run was fixed before the next ones
where the fault was the job's (the last column).

| World | The job's end line | Game day, nights | Deaths, lowest health | Iron | What ended it | Then |
|---|---|---|---|---|---|---|
| plains | `stopped after 1033 s, 3 steps` | 2, 1 | 0, 20 | 33 of 33 ore mined, none smelted | `!craft furnace 1 got nothing (craft: made no furnace (open_failed) ...)`: the table, set down under the floor of the mine's last cut, did not open | the job crafts again, at home |
| a river bank | `stopped after 2006 s, 23 steps` | 3, 2 | 0, 15 | all 8 pieces made, the armour on | the last step: `!cook got nothing (cook: timeout in the furnace ...)`, 30 s after the furnace opened with 2 beef | not fixed (the cooker) |
| a desert | `stopped after 834 s, 3 steps` | 2, 1 | 0, 1 | none | a witch stood 2 blocks from the shell all morning; at the wait's bound the shell opened, the reflex killed her (3 strikes) and her poison left 1 health: `!mine iron_ore 9 got nothing (mine iron_ore: stopped at 0/9, health low)` | the job waits for the health |
| plains | `stopped after 950 s, 3 steps` | 2, 1 | 0, 15 | 33 of 33 ore mined, none smelted | `!craft furnace 1 got nothing (craft: made no furnace (no_table) ...)`: `craft: no free cell next to the bot for a crafting table`, in the same cut | the job crafts again, at home |
| a river bank | `stopped after 2265 s, 26 steps: 24 steps and not done` | 3, 2 | 0, 7.2 | all 8 pieces made, the armour on, 11 cooked food | the step limit, with the bed's wool being hunted | the limit is 40; a step cut at dusk does not count |
| a desert | `stopped after 915 s, 3 steps` | 2, 1 | 0, 17 | 2 ore | no iron within the rules: `!mine iron_ore 7 got nothing (mine iron_ore: 0/7, no seen iron_ore left (29 skipped as unsafe))` | not fixed (the miner) |

**0 of 6 ended `done`.** 2 of 6 (the river bank, both times) had every iron piece made and the armour on, in game
day 3 after two nights; the other four ended in game day 2 before the first ingot. No bot died in any of them
(Track E7's six runs of this protocol, watched to the first morning: 2 deaths, both in that morning).

What ended them, and what the job does now:

- **The craft in the mine's last cut (plains, 2 of 2).** The mine step ends where its last ore was, in a cut one
  cell wide; the job's next step crafts the furnace there. The crafter found no cell beside the bot for its table,
  or set it under the cut's floor and could not open it. A craft step that ends `no_table`, `open_failed` or
  `request_failed` with nothing made is now tried again, twice a job at most (`OBTAIN_CRAFT_RETRIES`): the table
  is picked up, and when the place is the fault (the first two) the bot walks home first, where the furnace step
  and the smelt are anyway (`crafted again at home after no room for a table`). A refused request is tried where
  the bot stands (seen once since: `crafted again after a refused request`, and the kit went on).
- **A mine step that stopped `health low` (the desert).** The miner ends under 8 health. The job ended there
  with the bot alive, and had first cut its targets as if the ore were short. Now it waits for the health to come
  back to 14 (`OBTAIN_HEAL_HEALTH`; up to 180 s, twice a job) and plans again, capping nothing; the kit eats and
  the flee rule runs as ever (`waited for health after a step that stopped for it`). Unit tests only: no run
  since met it.
- **The step limit (the river bank).** 24 steps were the limit; a fresh world's iron kit over two nights needs
  more (two pickaxes worn out and replaced, stone for the furnace, a craft tried again, the food cooked in three
  goes). The limit is 40 (`OBTAIN_MAX_STEPS`) and a step the job cuts itself at dusk does not count.
- **The walk home's timeout.** On the final tree's first run the furnace step's walk home dug out of the mine
  (`goto: shut in ...`) and ended `furnace: the walk home failed (timeout)` after 36 blocks of its stair: a goto's
  timeout is a budget of ticks without getting a block nearer its goal, and a stair gains a block every two or
  three digs. The job went on (the step had gained the dug blocks) and the next `!furnace` walked the rest. A
  block dug on the way out of a pit now counts as progress ([pathfinding.md](pathfinding.md) "Shut in").
- **Not fixed: the cooker's timeout** (once in the 4 cook steps of these runs; a slice of bread was being eaten when
  the furnace opened; cause not found) and **no iron in the desert within the rules**: the 101 iron ores the bot
  knew of were skipped, all but one for lying inside the protected base (`protectRadius` 48 round home, home at
  the spawn), and the branch mine's staircase was refused under sand (`branch: step to ... blocked:
  gravity_above`, `branch: blocked (cannot get back to the staircase ...)`).

**With the job's rules as they are now**, one more run a world (the desert's is the sixth of the table):

| World | The job's end line | Game day, nights | Deaths, lowest health |
|---|---|---|---|
| plains | `get kit iron: done in 2050 s, 17 steps; paused for 2 nights; replaced the stone_pickaxe (worn); ...; food 5 of 6: !food 1 got nothing (... nothing left to hunt within 48 blocks ...)` | 3, 2 | 0, 16 |
| a river bank | `get kit iron: done in 1950 s, 15 steps; paused for 2 nights; ...; food 4 of 6: !food 2 got nothing (...)` | 3, 2 | 0, 15 |
| a desert | `stopped after 915 s, 3 steps: !mine iron_ore 7 got nothing (...)` | 2, 1 | 0, 17 |

2 of 3 end `done`, with every iron piece made and the armour on, in the third game day (33 to 34 minutes), n1 a
world. Neither met the craft's walk home or the wait for health: on plains the crafter found room in the cut this
time, and no morning took the health under 8. Those two rules rest on the unit tests and, for the craft, on the e2e
case below. The plains run is the one whose walk home dug out of the mine and timed out once.

## Early-game leftovers, round two (Track E11)

Decision record: [decisions/0117-early-leftovers-round-two.md](decisions/0117-early-leftovers-round-two.md). Three
faults Tracks E9 and E10 measured and left: a gather that never started after the flight case, the cooker's timeout
in a river bank's iron kit, and the walk back out after a morning that did not clear. Each was reproduced first; the
reproductions are e2e cases in `early-round2.test.ts` and unit tests.

### A gather after a stopped pause

**The cause.** The afk task keeps one gather task (`GatherWoodTask`) for every `!gather`. When the flight on foot takes
the body, the gather is paused (the process manager's `halt('pause')`). A gather stopped while it is paused (the
job's flight rule ends the step, `!get stop`, `!gather stop`) kept its pause, and the next run sat in its loop waiting
for a resume that never came. Track E10's debug line shows it: `processes gather 0/2 logs (find, 0 trees); ... said
get: nothing to stop | stopped (was fleeing)`. A gather paused by the night rule and stopped there does the same.

**The rule.** A run never inherits a pause: the gather's start and stop clear it.

**Measured** (e2e `gather`: four trees, a shelter set, `!gather 12` until the first log, the clock to dusk so the night
rule holds the body, `!gather stop`, then by day `!get oak_log 4`). Before, 3 of 3: `not ended in 90 s: processes
gather 0/4 logs (find, 0 trees)`, one gather line after its start (`gather: target 4 logs, chest none, search radius
48`), 0 logs. After, 3 of 3: `gather done: 5/4 logs` in 18.8 to 20.0 s. Unit test (`gather.test.ts`): a run stopped
while paused, then a new run: `stalled` before, `done` after.

### The cooker's timeout

The furnace's batch time and why the river run said `timeout` are in [food.md](food.md) "The batch's time". In short:
that run's tree put in its 1 plank for 2 beef with 6 logs carried, had no second fuelling and read the deadline before
the fuel. Track E10's fuel plan takes the logs now. Reproduced on the flat test server with the run's inventory and a
bread eaten as the walk ends (`mix`): on a copy of that tree 3 of 3 `cook: timeout in the furnace` after 34.4 to
34.7 s with a cooked beef left in the furnace; on this tree 3 of 3 `cooked 2 cooked_beef ... (21 s, fuel 2 oak_log)`,
the bread eaten as the furnace opened. What was left is a race: a true shortage whose last item runs into the
deadline. `short` (2 beef on 1 plank, a furnace beside the bot): before, 3 of 4 `cook: no fuel ... (cooked 1
cooked_beef first)` after 32.1 to 32.3 s and 1 of 4 `cook: timeout in the furnace` after 31.9 s with 1 beef and 1
cooked beef left in the furnace; after, 3 of 3 `no fuel (cooked 1 cooked_beef first)` in 32.2 to 32.3 s, the cooked and
the raw beef carried, the furnace empty.

**The job.** A cook or smelt step that gained nothing and said `timeout in the furnace` or `request failed` is tried
once more (`OBTAIN_COOK_RETRIES` 1), as a craft is (`OBTAIN_CRAFT_RETRIES`): both clear. `no fuel` is not retried.

### The walk back out (`morningWay`, off)

**What the morning leaves.** Track E9 found the ring 16 to 32 blocks from the shelter as full when the job went on as
before dawn: what is left is what does not burn (creepers, spiders, husks, witches) or stands in shade or water. The
job's first walk is to its mine, 31 to 135 blocks off, straight through it.

**What the rules support.** No new fight rule and no change to when the bot flees. Three ways were weighed:

- a longer wait for creepers only: Track E9's mornings that ran to the bound were held by zombies in shade, husks,
  skeletons and witches as often as creepers, and a wait does not move them;
- the next step starting with what is near in its line: it says, and changes nothing the body does;
- the navigator's own mob avoidance, wider for the walk out. The navigator prices a cell near a hostile
  ([survival.md](survival.md), `avoidMobRadius` 4: melee reach and a margin, capped per mob) and keeps it passable,
  so a way round is taken when one exists and a goal inside a zone is still reached.

**The rule.** With `morningWay` on, when a job that waited out a night goes on, its walks plan with the mob avoidance
at `MORNING_WAY_RADIUS` 16 (an archer's and a witch's reach, the morning rule's own `MORNING_NEAR`) for
`MORNING_WAY_MS` 120000 (the two minutes the morning's damage is counted in), then it is put back (`morning: the walk
out keeps 16 blocks from hostiles for 120 s (near: zombie 15)`; the end line notes `walked out wide of the hostiles
after a night`). An owner's radius already 16 or wider is left as it is. It applies after every night the job waited
out, not only when something stood near the shelter: a plan prices the hostiles the bot knows when it plans, and the
first fresh-world morning measured below was ended by two skeletons at the mine, about 90 blocks out, in no census at
the shelter. Limits it keeps from the avoidance: a mob more than 3 blocks above or below a cell is not priced, and a
mob the server has not sent yet is not known.

**Measured, e2e** (`way`: a job paused for the night at its shelter, a zombie held still 15 blocks off on the straight
line to the job's ores 30 blocks off, `jobMorning` off so the job goes on at once; the bot's nearest horizontal
distance to the zombie until it is 26 blocks along). Off, 3 of 3: 4.8 blocks (the default radius of 4 and its
margin), past it in 5.3 to 5.4 s. On, 3 of 3 (and 3 of 3 more in the suite's gate runs): 15.0 to 15.2 blocks (it never
came nearer than it started), past it in 6.9 to 7.0 s. No damage and no flight in any.

**Measured, fresh worlds** (Track E9's protocol: a fresh copy of the world a run, the stone kit given, home and shelter
at the spawn, `jobDusk`, `nightShell`, `jobMorning` and, late, `shellBlocks` on, `!get kit iron`; the night shortened
the same way in both arms, the clock put to 18000 once the bot was inside its shelter; counted from the job's `dawn:
going on` for 120 s). n6 a side, two runs a world, the arms run in turn. "The walk" is from going on to the first
block the mine step digs; "nearest" is the nearest hostile in the truth pack's own census, taken every 5 s.

| Arm | Deaths in the 120 s | Hurt | Damage | Lowest health | The walk (s) | Nearest hostile on the walk | Within 8 in the 120 s |
|---|---|---|---|---|---|---|---|
| before (`morningWay` off, the tree before) | 2 of 6 (river bank: an arrow at the mine 109 s after going on; a witch's potion at the mine at 59 s) | 3 of 6 | 18, 28, 0, 7, 0, 0 | 0, 0, 20, 14, 20, 20 | 50, 120, 21, 21, 65, 120 | 2.1, 1.2, 5.1, 1.7, 4.0, 5.7 | 36 of 116 censuses |
| after (`morningWay` on) | 2 of 6 (river bank: a creeper's blast at the mine at 72 s, struck by the reflex in reach; a fall in a flight at the mine at 109 s, 11 of its damage from two skeletons at the shelter's door) | 3 of 6 | blast, 19, 0, 0, 0, 10 | 0, 0, 20, 20, 20, 14 | 48, 105, 20, 24, 93, 110 | 3.7, 4.6, 15.1, 8.9, 6.6, 4.5 | 26 of 136 |

What it carries. The walk keeps farther from what is near: the nearest hostile on it 1.2 to 5.7 blocks before
(median 3.1), 3.7 to 15.1 after (median 5.6), and a census with a hostile within 8 in 31 % of the 120 s before
against 19 % after. The deaths are not changed by it: all four were on the river world, at the mine 82 to 110 blocks
from the shelter, 59 to 109 s after the job went on, in both arms; that is where the step's goal is, and the rule
does not move a goal. n6 cannot tell 2 of 6 from 2 of 6 apart in either direction, and the walk out on the plains
takes 20 to 24 s, so the rule has little to work on there. What follows the bot is not stopped by a plan (the
zombies that came at the river walk with the rule on were struck by the reflex as before), and a mob at the door
(two skeletons at 2 and 7 blocks) is met before any walk. It ships off: it changes no fight or flee rule and costs
seconds, but its gain on real ground is a wider berth, not fewer deaths.

## The mine's dangers (Track E12)

Track E11's deaths after the morning were at the mine, not on the walk: an arrow and a witch's potion while mining, a
creeper's blast as the bot dug its own pillar down onto it (a zombie at the foot too, struck first by the reflex),
and a fall in a flight after two skeletons at the shelter's door had shot the job as it went on. ADR 0119; the rules
are in [pve.md](pve.md) "A job at work and the shooters" and "A creeper under the feet".

### The four deaths as scenes

Each was built on the flat test server (`test/e2e/early-mine.test.ts`): one bot with the early kit (stone sword,
pickaxe and axe, 16 cobblestone, bread; no armour), guard off as it ships, difficulty normal while a run lasts, the
undead given fire resistance so the sun does not take them. A run ends when the bot died, every mob of the scene is
dead, or after 60 s (the door: 45 s after the job went on). With the rules as they were, n5 or more a scene:

| scene | runs | deaths | damage a run | lowest health |
|---|---|---|---|---|
| `pillar`: a one-wide pillar 8 high, ore at its foot, a creeper (and a zombie) waiting there | 21 | 0 | median 1.6; 17.1 and 18.6 in 2 | 5.4 |
| `archers`: two skeletons 10 and 12 off, `!mine iron_ore 24` in the open | 5 | 0 | 20 to 30 | 3 to 5 |
| `archer`: one skeleton 12 off, the same mine | 5 | 0 | 24 to 29 | 4 to 6 |
| `witch`: a witch 8 off, the same mine | 5 | 0 | 26 to 29 | 1 in all 5 |
| `door`: a job paused in its night shell, two skeletons 2 and 7 off at dawn (`jobMorning` on) | 5 | 0 | 0 to 23 | 4 to 20 |

**What the bot knew, and when.** In every scene the bot had each mob from the first tick after it was summoned (6 to
17 blocks off, the process running then noted). Nothing was missed: the rules chose not to act.

- Guard is off by default, so nothing fights at range: the reflex strikes what comes in reach, and the flee starts
  below `fleeHealth` (8). Under fire the work went on until the flee, then the job walked back to its ore and was shot
  again (2 to 11 flights a minute).
- A witch was worse off than that. The flee leaves a witch the bot "fights first" (`firstTarget`) alone, a rule
  written for guard on; with guard off nobody fights her, so she was neither fought nor run from (the lowest health 1).
- A creeper cannot climb. It waits at the foot of a pillar the walk dug down, and lights when the body comes to about
  3 blocks over it. The reflex strikes it as it comes in reach: most runs took 1.6 or less, but 2 of 21 took 17 and
  18.6, as the fresh world's blast did with no armour.
- At the door, the reflex struck the near skeleton in reach before the shell opened; the job then went on under the
  other's arrows.

None of the scenes killed the bot (it died on fresh worlds with rough ground, falls in a flight and more mobs); their
measure is the damage and the lowest health.

### The fixes, before and after (n5 a side, the pillar 21 against 15)

Two settings, both off by default. Neither changes a rule while it is off.

- **`workGuard`** (guard's own fight for a job at work: a witch the bot fights first, and a lone archer that shoots at
  it from 16 or less, at 14 health or more; the fight on an archer ends when a second comes within 16):

  | scene | off: damage, lowest | on: damage, lowest |
  |---|---|---|
  | `witch` | 29, 29, 29, 26, 28; 1 in all 5 | 0, 0, 0, 2, 5; 20, 20, 20, 20, 17 |
  | `archer` | 25, 24, 29, 26, 25; 5, 4, 4, 4, 6 | 4, 4, 4, 0, 4; 16, 16, 16, 20, 16 |
  | `archers` | 30, 26, 20, 26, 25; 3, 5, 4, 5, 5 | 29, 26, 28, 24, 28; 3, 4, 4, 4, 3 (no fight: two archers) |
  | `door` | 0, 16, 23, 18, 19; 20, 7, 4, 8, 4 | 5, 0, 3, 0, 3; 15, 20, 17, 20, 17 (one fight a run, at 3.4 to 15.8 blocks) |

  A fight on two archers was measured on the way and dropped: the first died, the second shot the bot during the
  approach, the damage was as with no fight and nothing was mined; counting only the archers that aimed let a second
  fight begin at 12 health, and one run of 5 died.
- **`creeperRise`** (a lit creeper 2 or more blocks under the feet: up 2 blocks on throwaway blocks, the navigator's
  own pillar move, and stand until it is gone or 3 s):

  | `pillar` | runs | damage a run | over 14 | lowest health |
  |---|---|---|---|---|
  | off | 21 | median 1.6, mean 4.0, the highest 18.6 | 2 | 5.4 |
  | on | 15 | median 6.0, mean 6.0, the highest 9.9 | 0 | 12.1 |

  Every run rose, 1 to 7 times (a fuse that went out lit again when the body came back down after 3 s); 29 of 30 rises
  went up 2 blocks (about 26 ticks), one timed out and stood. The blast then came 4 to 5 under the feet; but its push
  threw the body off the one-wide top in 14 of 15 runs, a fall that costs 2 to 4. It trades a rare near-fatal blast
  for a sure small one.

### Fresh worlds

Track E9's and E11's protocol (a fresh copy of the world a run, the stone kit given, home and shelter at the spawn,
`jobDusk`, `nightShell`, `jobMorning` and, late, `shellBlocks` on, `morningWay` off, `!get kit iron`, the night
shortened the same way in both arms; counted from the job's `dawn: going on` for 120 s), on the river, plains and
desert worlds, two runs a world a side, the arms in turn; "on" is both settings on. Listed river, plains, desert,
river, plains, desert.

| Arm | Deaths | Hurt | Damage | Lowest health | The walk (s) | Nearest hostile on the walk | Within 8 in the 120 s | Work fights, rises |
|---|---|---|---|---|---|---|---|---|
| off | 0 of 6 | 4 of 6 | 0, 4 (a skeleton), 0, 3 (a zombie), 3 (a zombie), 7 (a parched) | 20, 16, 20, 17, 17, 13 | 55, 22, 120, 52, 24, 76 | 1.9, 2.8, 5.9, 3.7, 4.8, 1.0 (median 3.3) | 44 of 124 censuses (35 %) | - |
| on | 0 of 6 | 2 of 6 | 0, 3 (a zombie), 0, 12 (a skeleton 3, zombie villagers 9), 0, 0 | 20, 17, 20, 11, 20, 20 | 50, 21, 58, 58, 22, 72 | 8.3, 4.9, 5.1, 1.8, 0.7, 4.3 (median 4.6) | 31 of 144 (22 %) | 1 fight (a skeleton 1.8 off, killed in 2 strikes), 0 rises |
| on, an earlier archer rule (n3: every archer that aimed and was in sight counted) | 0 of 3 | 1 of 3 | 14 (skeletons), 0, 0 | 10, 20, 20 | 116, 23, 28 | 3.4, 1.7, 4.2 | 30 of 71 | 4 fights, 2 rises (one up, one timed out standing; no creeper damage either time) |

Against Track E11's arms (the same protocol, n6 each: 2 deaths of 6 in each, all on the river world at the mine):
no death in these 15 mornings, in either arm. The difference is in the mornings, not in these rules: the off arm runs
Track E11's rules with `morningWay` off. The rules were met rarely on real ground: with the final rule one fight
in 6 mornings, no rise; the mornings' damage came from melee mobs (zombies, zombie villagers) as much as from
archers, and from a parched in the desert.

### What ships, and why

Both off.

- **`workGuard`** is not worse in any scene and better in three (the witch, one archer, the door), and the fresh
  worlds show nothing worse (0 deaths a side, the damage 15 against 17). But it changes how the bot fights: it walks
  up to 16 blocks to an archer, over ground the scenes do not have (edges, water, a cave mouth), and on real ground
  it fought once in 6 mornings, so "not worse" there rests on one fight. It is the first candidate to turn on, after
  a series on rough ground or the Realm.
- **`creeperRise`** removes the near-fatal blast in the scene but costs more on average (mean 6.0 against 4.0) and
  never fired on the fresh worlds with the final code: off.

## Two archers at the work (Track E13)

Track E12 left two archers or more to the work and the flee, and the parched (the desert's skeleton) out of every pve
archer rule. ADR 0120; the rules are in [pve.md](pve.md) "One archer list (Track E13)" and "Two archers at the work
(Track E13)".

### Where the damage came from

The `archers` scene again (two skeletons 10 and 12 off a bot that mines 24 iron ore in the open; the stone kit, no
armour, guard off, `workGuard` on as it ships), now watched until the job ended and both skeletons were dead, or 120
s: 41 to 44 damage, the lowest health 2 or 3, in 5 of 5. The job stopped at health 8 after 12 to 24 s with 4 to 10 of
24 mined, and then the flee ran 16 to 23 times: each run ended 16 from the skeletons (`no threat within 16`), inside
their range, and the next arrow under 8 started the next one. `workGuard` does not take two archers (Track E12: the
second shoots while the first is fought), so nothing took the body out of their line.

### The ways tried (n5 each; the chosen one 10)

| Way | Damage a run | Lowest health | The job |
|---|---|---|---|
| none | 41, 42, 44, 42, 42 | 3, 3, 2, 3, 3 | stopped at health 8 in 5 of 5 |
| wall in where it stands, eat, open once fewer than two are within 16 at full health | 0, 0, 4, 0, 0; 5, 8, 0, 0, 9 | 20, 20, 16, 20, 20; 15, 12, 20, 20, 11 | done in 9 of 10, 57 to 87 s; once stopped after 60 s walled in, no damage |
| walk out to 24 from them, eat, back once the place of the work is clear | 8, 33, 8, 11, 8.5 | 16, 2, 16, 13, 15 | done in 4 of 5, 92 to 111 s; once they followed and nothing was mined |
| wall in, then out at the nearest from full health, one at a time | 4, 8, 4, 8, 4 | 16, 12, 16, 12, 16 | done in 5 of 5, 54 to 66 s, one sortie a run |

The wall works because of what a skeleton does without a line on its target: it walks up to it. At the wall it is in
the reflex's reach, and in 9 of 10 runs the reflex had killed one (both, once) before the shell opened 16 to 41 s
after it went up; `workGuard` then fought the other from full health. Once, the strikes at the wall did not kill, both
stayed, and the job was stopped after 60 s walled in, unhurt. Walking out gave them the bot on the way out and back,
and they followed (one run of 5: 33 damage, the lowest 2, the flee's runs at their range again); the sortie finished a
few seconds sooner and cost about 5 more a run.

**The door at dawn** (two skeletons 2 and 7 off the night shell, the job watched 45 s after it went on, n5): none 16,
24, 0, 4, 0 (the lowest 11, 4, 20, 16, 20); with the wall 4, 0, 3, 0, 4 (16, 20, 17, 20, 16). The wall went up once
in 5, with no damage that run; in the others the reflex killed the near one at the shell and `workGuard` fought the
other. With the sortie (n3): 4, 0, 4, the rule never acting.

### The parched

The parched was an archer for the fight's sprint in (`isArcher`) and a melee mob for the duel, the flee's shooter
scan, the dodge and `workGuard`, because pve kept its own copy of the archer list. The lists are now one
(`skills/combat/hostiles.ts`; [pve.md](pve.md) "One archer list"). One parched 12 off the same mine, `workGuard` on, the
run over when the job ended (n5 a side): before 19, 12, 17, 20, 13 damage, the lowest health 6, 9, 11, 5, 11, the job
done in 3 of 5 (46 to 90 s) and stopped at health 8 in 2, no fight; after 0 in all 5, the lowest 20, the job done in
46 to 47 s, one `workGuard` fight a run.

### Fresh worlds

Track E11's and E12's protocol (a fresh copy of the world a run, the stone kit given, home and shelter at the spawn,
`jobDusk`, `nightShell`, `jobMorning` and, late, `shellBlocks` on, `morningWay` off, `!get kit iron`, the night
shortened the same way in both arms; counted from the job's `dawn: going on` for 120 s), on the river, plains and
desert worlds, two runs a world a side, the arms in turn; `workGuard` on in both, as it ships. Listed river, plains,
desert, river, plains, desert.

| Arm | Deaths | Hurt | Damage | Lowest health | The walk (s) | Nearest hostile on the walk | Within 8 in the 120 s | Work fights, shells |
|---|---|---|---|---|---|---|---|---|
| before | 0 of 6 | 1 of 6 | 0, 0, 0, 0, 4 (a skeleton), 0 | 20, 20, 20, 20, 16, 20 | 26, 21, 73, 56, 66, 44 | 2.2, 0.9, 4.3, 4.9, 4.1, 4.6 (median 4.2) | 43 of 144 censuses (30 %) | 4 fights |
| `workArchers` | 0 of 6 | 4 of 6 | 3 (a zombie), 0, 7 (a skeleton), 11 (a skeleton 8, a zombie 3), 9 (skeletons), 0 | 17, 20, 14, 12, 15, 20 | 49, 28, 21, 61, 21, 74 | 4.2, 3.1, 7.2, 1.8, 9.9, 4.6 (median 4.4) | 36 of 144 (25 %) | 5 fights, 1 shell |

The rule acted once in the 6 mornings, as in the scene: on the plains a lone skeleton's work fight cost 5 and ended
when a second came within 16; the bot walled in with 7 blocks at health 15, the reflex killed the first at the wall,
the shell opened after 23.5 s at health 20, and `workGuard` killed the second for 4. Nothing hit the bot in its
shell. The other damage of that arm came in mornings where the rule never acted (no second archer within 16): two
lone skeletons fought by `workGuard` (7 and 8) and zombies (3 and 3). Track E12's arms on the same protocol: 17
damage and hurt 4 of 6 with `workGuard` off, 15 and 2 of 6 with it on (and `creeperRise`).

### What ships, and why

`workArchers` is off by default. It is better in the scene it was made for (0 to 9 damage a run against 41 to 44,
the job done in 9 of 10 against none) and not worse at the door (the highest 4 against 24), and on real ground it
acted once and was not hurt doing it; but the fresh worlds' totals were worse with it (30 against 4, hurt 4 of 6
against 1 of 6), most of it in fights it took no part in, and one shell on real ground is too little to call that
chance. It also leaves blocks in the world. It is the candidate to turn on after a series on rough ground. It acts only with
guard off, only while two archers or more shoot at a job at work, and with the night shell's wall, the reflex and
`workGuard` as they are; a hit in the shell gives the body back to the flee. It leaves up to 8 blocks of its shell
where the job was. The parched fix is not a setting: every archer rule counts it now.

## Still missing for the early game

In the order they matter, with the reason measured here:

1. **Done by Track E3:** a bed set down where the night rule sleeps, the spawn point moved to it, the sheep left by
   the food hunt, a walk to a remembered flock ("A bed"). Left: shears; a flock the bot has never seen; a bed taken
   along on a trip.
2. **A shelter that is one.** `!shelter set` marks a point; on open grass it holds the bot where skeletons shoot it.
   The night shell (off) closes that gap where it was measured; on by default it needs runs on slopes, ledges and in
   water (a cell with no floor under it stays open) and a creeper's blast (it opens the shell).
3. **Done by Track E2:** a furnace set down and cooked food (`cookFurnace`), smelting and iron ("The iron age").
   Left from it: the smelt stands 5.5 minutes in the open when no home or shelter is set and `smeltShell` is off
   (Track E3: "The furnace wait"). Done by Track E4 ("Wear and setbacks"): a worn pickaxe is replaced, a furnace
   walked away from is used again, a death ends the job with what is where (and, with `deathReturn` on, it walks back
   for the drops and the furnace output).
4. **All the armour.** The iron kit wears what the ore allows (24 ingots for the four pieces after the 9 the tools,
   the shield and the bucket take); a short mine step leaves the chestplate, leggings and helmet off. More iron needs a
   second mine trip, which the job does not make; leather is slow (a tunic is 8, a day's hunt gave 0 or 1).
5. **Done by Track E6:** `!farm new` makes a plot (a hoe, seeds from grass, water, a fence), and with `farmFood` on
   the farm chore harvests it and bakes bread before the hunt ("A farm"). Track E8 made the plot wet with the kit's
   empty bucket (surface water seen, remembered or searched for; "A farm: water and seeds") and, under `farmFood`,
   plants every cell by day 6. Left: a watered plot still gives its first wheat on day 3 and about a loaf a day on
   days 4 to 6, so the hunt still feeds the early bot; seeds at the set-up (1 in 8 plants, 11 to 28 for 80 cells);
   a plot site on steep ground (2 of 3 mountain spawns had no 9 x 9 within 24 of home); bone meal; a pen and
   breeding; carrots and potatoes; `farmFood` on by default.

6. **A mob at the top of a shaft** (Track E3, "A mob at the top of a shaft"): the reflex strikes with the blade now;
   the walk still climbs on with a mob over it, and a bot with no blade in the hotbar strikes with what it holds.

From Track E5's five worlds ("Other ground"), worst first; 7 and 8 are Track E7's ("Dusk, the shell's blocks, the
end line"), 7, 8, 10 and 11 Track E10's ("Early-game leftovers"), the rest is not fixed:

7. **Arrows by dusk and night.** 19 of 25 deaths were arrows, 6 of them in a step that ran past dusk (the smelt of
   33, the bed's sheep hunt, a mine step) and the rest in the nights alone. **Done by Track E7 for the job:** it
   waits out the night where the bot shelters and goes on at dawn (`jobDusk`). Left: a bot at an open shelter is
   shot unless the night shell is on (`nightShell`, off) and closes. **Done by Track E10:** a side with nothing to
   place against (a river bank: 6 nights of 6, and 8 of 8 in Track E9's runs) gets a support first, and the cell
   over the job's own crafting table a brace; a shell that does not close names the cells and why. Left: the first
   minutes of the day, when the job walks back out to its mine (2 of 6 runs lost the bot there: an arrow, a witch).
   **For the morning, Track E9** ("The morning after", `jobMorning`, off): the job waits in the shelter until the
   sun has burned what burns and nothing is within 16; 0 of 6 bots died in the morning with it (1 of 6 without, 2
   of 6 in Track E7's runs). Left there: what does not burn or stands in the shade is still there when the wait's
   bound runs out, and the walk back out meets it (items 13 and 15).
8. **The night shell after a death.** A death drops every block, so in 5 of 10 nights with the shell on there was
   nothing to build it with (`night shell: 0 throwaway blocks for 10 open cells; standing in the open`). **Done by
   Track E7** with `shellBlocks` on (off by default): 10 blocks are dug outside the base by day. Left: a death in
   the night itself leaves the rest of that night without blocks (nothing is dug in the base or by night). Track E10
   kept it so (a dig by night near the mobs that killed the bot is not obviously safer); the answer with the rules
   that exist is the bed, where the respawn is and the night is slept with no blocks.
9. **Hostiles in caves by day.** The iron kit's mine step and coal step walk into dark caves; 2 deaths and 2 stops at
   low health came from zombies, skeletons and creepers there in daylight. Desert 2's reflex struck a creeper in reach
   (from 18 health) and the blast killed the bot. Track E7 measured the creeper case in a tunnel replica (pve.md "A
   creeper in reach"): the strikes kill it (27 of 28, no death), a back-off rule was better in no cell and ships
   off; the fresh world's death was not reproduced.
10. **No sheep near.** On plains and in the desert `!get bed` found no sheep within 32 after its two herd walks in 3
   of 10 runs; on the mountain one kit's food step found nothing within 48. **Done by Track E10** for the job's hunt:
   a search walk 96 out along the axes, by day, at most 300 s, with the distance in the end line. Left: the food
   step's own look (48) and a flock farther than about 160.
11. **Flees pre-empting a step.** Under spruce, skeletons that stay in the shade kept pausing the gather until its 10
   minutes ran out (snowy 2), with no reply that names the cause. **Done by Track E10:** the flights are in the end
   line, and a step that is mostly flight ends the job after 120 s. Left: nothing finds another place to work (the
   owner decides), and a bot with no blade still has no answer to the skeleton.
12. **The night alone on a slope or underground.** The shelter set where the kit ended was unreachable from the mine
   (mountain 2: `shelter unreachable`, three tries, the night spent in the tunnel); a fall while fleeing on the
   desert's dunes killed one bot at 2 health. Track E9 found the refusal's cause on plains and in a desert (the body
   shut in where the mine step's own walk left it) and the walk digs out now ("The walk home from the mine"); the
   mountain's run was not repeated.

From Track E9's iron kits ("The iron kit to its end"), worst first;
16 is fixed by Track E11, 13 and 15 have its walk out (off):

13. **What does not burn at the shelter's door.** In the desert the morning never cleared: husks, a parched,
   creepers, a spider and once a witch 2 blocks from the shell stood within 16 through the whole wait (2 of 2
   runs). On plains every morning ran to the bound too (4 of 4): a zombie 2 blocks from the shell that was still
   alive at 2000 (twice; why it was not burned down was not looked at), a skeleton 13 blocks off, a creeper 2
   blocks off. The morning rule holds to its bound (150 s) and the
   job then goes on beside them: the witch cost 19 health (the reflex killed her, no death). No rule clears the
   door: guard is off while a job runs, and Track E9 was to add no fight rule. **Track E11** ("Early-game
   leftovers, round two", `morningWay`, off) keeps the walk out 16 blocks from them where a way does; it clears
   nothing, and a mob at the door itself is still passed.
14. **No iron in a desert within the rules.** With home at the spawn the base (`protectRadius` 48) covers the ore
   the bot can see, and the branch mine's staircase is refused under sand (`gravity_above`), so the mine step ends
   `no seen iron_ore left (... skipped as unsafe)` and the job with it (1 of 2 desert kits; the other ended first).
15. **The walk back out after the wait.** The mine step walks 50 to 135 blocks to where it was; what stands in
   shade, in water or in a cave mouth on the way did not burn. One river run took 16 damage (a skeleton, a zombie,
   a creeper) and fled twice in its first two minutes (lowest 7.2); a plains run was shot once. No death in these
   mornings, but nothing looks at the way before the step walks. **Track E11** (`morningWay`, off): for 120 s after
   the job goes on its walks plan with the mob avoidance at 16 instead of 4. Left: a mob more than 3 blocks above or
   below the way, one the server has not sent yet when the walk plans, an archer that walks up to the bot; the mine
   itself, where the step's goal is.
16. **Done by Track E11: the cooker's timeout.** The run's tree put in its 1 plank for 2 beef with 6 logs carried and
   read the batch's deadline before the fuel (Track E10's fuel plan had already fixed the first part); a true
   shortage whose last item ran into the deadline still said `timeout` and left the cooked beef in the furnace. It
   now says `no fuel` with what it cooked, and a job's cook or smelt step that timed out is tried once more
   ([food.md](food.md) "The batch's time").
17. **The night shell at a river bank** still leaves 2 cells open (`2 cell(s) open (not placed)`): 8 of 8 nights
   there in Track E9's runs, which ran before Track E10's supports; the reflex killed a skeleton, a zombie and a
   spider at the open side in one of them (5 damage). **Done by Track E10** (a support under a side over a step
   down: 3 of 3 walled in on the river world); left: a blocks refill digs 10, and that bank takes 11.
18. **The crafter in the mine's last cut.** It digs a side cell of stone for its table where it can, never a
   falling block or a cell under one; in a cut with gravel beside it, it found no cell, or set the table under the
   floor and could not open it (plains, 2 of 3 runs that got there), and twice a craft at a table in such a cut was
   refused by the server (`request_failed status 49`). The job walks home and crafts there now; a craft typed by
   hand in such a place still ends `no_table`.
19. **A pit inside the base.** A one-cell pool 9 blocks from home, inside the protected base, held one desert bot
   from 16 s into its run (`trapped in water: no swim exit and no step to dig (... sand: inside the protected base
   ...)`): the base may not be dug, and no other way out of water is tried.
20. **The mine's dangers** (Track E11's deaths after the morning, all at the mine). **Track E12** ("The mine's
   dangers", `workGuard` on by default, `creeperRise` off): `workGuard` fights a witch near a job at work and a lone archer that shoots at it (a witch:
   0 to 5 damage a minute against 26 to 29; one skeleton: 0 to 4 against 24 to 29; the door at dawn: see there);
   `creeperRise` goes 2 blocks up over a lit creeper under the feet. **Track E13** ("Two archers at the
   work"): `workArchers` walls the body in from two archers or more until fewer than two are within 16 (0 to 9 damage a
   run against 41 to 44, the job done in 9 of 10 against none), and the parched counts as an archer. Left: three
   archers or more, archers with melee mobs; a creeper beside the body on its own level (`creeperReach`); a blast's push
   off a one-wide top after the rise; armour, which no scene wore; the flee's runs from archers end at 16, inside their
   range (the next arrow starts the next run: 16 to 23 runs in 2 minutes with two skeletons and no other rule).

Smaller, from the same runs: the miner's own walk back up (`returnUp`) is taken from under it by the job's next
step and resumes later as a stale walk towards the mine's mouth; a crafting table is left standing in the mine when
the job's last craft there is followed by the walk home (`a crafting table left at ...`).

Smaller, seen once each: the fuel rule counting coal and logs together burned only the coal, the smelt timed out at 8
of 9 and the job mined 9 more ore (fixed for the base case by F3; the mix itself by Track E10: one kind that covers
the batch, and the slot fuelled again when it runs dry); a crafting table left
standing after `!get bed` on the mountain; a job's end line dropped by the chat rate limit (the food step's
reply and the job's `stopped` line in the same second, so the owner saw neither; Track E7 keeps the end line: "The
end line").

Seen in Track E7's runs: the walk home from the mine was refused as unreachable at once (`furnace: the walk home
failed (unreachable)` ended the iron kit in the desert's first before-run and in a run with an earlier clock; the
night rule's walk to the shelter failed 3 of 3 from there in one run, and 1 or 2 times before it went through in two
more). **Done by Track E9** ("The walk home from the mine"): it was not the staircase; the body was shut in where
the mine step's own digging and placing walk had left it, and a walk that starts shut in digs out now.

Seen in Track E10's e2e: after the case where the flight took a gather step again and again (the job ended, the
skeleton killed, difficulty back to peaceful), the next `!get oak_log 2` started a gather that showed `gather 0/2
logs (find, 0 trees)` for 90 s and logged nothing after its start (3 of 3 runs on the tree before that track and 3 of
5 after it). **Done by Track E11** ("A gather after a stopped pause"): the gather stopped while the flight held it
paused kept its pause, and the next run waited for a resume that never came.

Smaller: the obtain job crafted a second table when the first one's drop had not been picked up yet when the next
step planned (seen once; Track E4 holds the table standing and counts it, and looks for a lost drop wider). Left by
Track E4: a sword, axe or shovel worn out in a step is replaced only when the plan next needs it (only the mine step
is watched); a death outside a job walks nowhere; `deathReturn` has not been run on real terrain.

## Tests

- Unit: `craft-chain.test.ts` (the chain on the recorded early recipes: planks, sticks, the table, tags, beds, kept
  items), `obtain.test.ts` (the next command; a whole kit, a bed and a stone pickaxe from nothing on a simulated
  inventory), `table-spot.test.ts` (the measured litter case), `kit-commands.test.ts` (the job: done, a step that gets
  nothing, stop, a moving command), `night-shell.test.ts` (sky, blocks, tries, the exit, NightSafety's order at dawn).
- e2e (flat, peaceful, the truth pack; `CRAFT_BDS_PORT` / `CRAFT_BDS_CONTAINER` choose the server):
  `dayone-craft.test.ts` (chain, names, litter), `dayone-get.test.ts` (a stone pickaxe from nothing, `!get stop`, a
  refusal), `dayone-shell.test.ts` (on: walled in at dusk, out and home at dawn; off: nothing placed; leaf litter round the feet: dug, then walled in; a zombie boxed 8 away at
  dawn: shut until it is killed, opened 3.3 s after; under a leaf canopy: walled in; under planks: nothing placed).
- Track E2, unit: `smelt.test.ts` (the smelt table, `!smelt` words, the cooker smelting on a simulated furnace, the
  job: crafted, placed, resumed at its furnace), `obtain-iron.test.ts` (the smelt steps, the fuel rule, the soft
  armour, the pickaxe tiers, on the recorded iron recipes), `kit-commands.test.ts` (the shield in the offhand, the iron
  kit with 13 iron), `table-spot.test.ts` (the tunnel), `mine-baritone.test.ts` (the vein after a timeout).
- Track E2, e2e: `iron-smelt.test.ts` (`!furnace`, `!smelt` of 5, a furnace by home, `!cook` setting one down, the
  tunnel), `iron-get.test.ts` (`!get iron_pickaxe` from the stone kit, `!get iron_ingot`, `!get kit iron` with 13 iron
  ore in the ground).
- Track E4, unit: `obtain-wear.test.ts` (the plan without worn tools, the placed furnaces, the death-return rule,
  the stacks recovered), `kit-setbacks.test.ts` (the job on a fake host: a pickaxe worn out in a step and mid-step,
  the held table, a death with the setting off, on by day and on by night), `craft-crafter.test.ts` (the held table
  and its sweep, home's table kept, the wider drop pick-up), `smelt.test.ts` (the preferred furnace, a smelt that only
  collects), `recover-process.test.ts`, `test-recovery.test.ts` (two respawn claims).
- Track E4, e2e: `early-wear.test.ts` (`wear`: the limit reached mid-step; `worn`: past it at the start; `furnace`:
  the walk to the coal with no home; `death` and `night`: `deathReturn` on by day and by night; `E4_BEFORE=1` records
  without asserting, for the base tree).

- Track E6, unit: `farm-new.test.ts` (the site, the own base and the ore vein under it, the fence kind and the mixed
  fence, the plot job on a fake bot: the pond, the far water, a dig that times out, a dry plot tilled for its seeds,
  the walk to the plot for seeds, the fence with the bot on the line, mixed posts; the farm chore: when it starts,
  the threshold from the crops, the drops in the water, the food chore's `farmFirst`), `farm.test.ts` (a stand
  where nothing gets done).
- Track E6, e2e: `early-farm.test.ts` (a 5 x 5 by home with a pond and the run again: nothing to do, the gate open;
  the farm chore and its bread; the hoe and the fence crafted; a base that is not the bot's own; seeds from grass).
  `fresh-days.test.ts` is the harness for the days left alone (`FRESH_DAYS=1`; `FRESH_PHASE=setup|day|probe`,
  `FRESH_FARM`, `FRESH_WATER`, `FRESH_SET`, `FRESH_ASK`; not a gate: it needs a fresh normal world).

- Track E8, unit: `farm-water.test.ts` (surface water and caves, pools, the pool under the plot, remembered water,
  the search walk, nothing found, none reached, the walk back, seeds from one stand and the wide ring, the chore's
  seed top-up). e2e: `early-farm-water.test.ts` (9 cases on a flat world: a pool under the plot, a pond 117 off, one
  remembered 222 off, one found 236 off by the search, none, a pour read `rejected`, ferns, dense grass, the top-up).
- Track E3, unit: `blade-strike.test.ts` (the swap and its refusals), `smelt-shell.test.ts` (when, the cell, the
  brace, the pause, the open at dawn), `bed-place.test.ts` (the spot, covers, the job, the wool count),
  `night-shell.test.ts` (control kept while the shell is shut), `kit-commands.test.ts` (the herd walk, the bed last).
- Track E3, e2e: `early-shaft.test.ts` (a zombie at the top of a one-wide obsidian shaft: killed with the sword, the
  top reached; `EARLY_SHAFT_*` for the A/B), `early-smelt.test.ts` (the smelt by night with mobs: walled in, 8
  ingots, out at dawn; `EARLY_SMELT_SHELL=off|leave` for the other ways), `early-bed.test.ts` (no home: the bed by the
  bot over a litter cover, the waypoint; home 10 off: the bed there and a respawn by it; a night slept through).
- Track E5, unit: `branch.test.ts` (the walk out of the base, its direction, no walk outside it), `craft-chain.test.ts`
  (spruce logs make spruce planks), `kit-coal.test.ts` (coal inside the base not counted), `craft-crafter.test.ts`
  (the own table in reach used with no clear line), `obtain-gather.test.ts` (the gather total).
- Track E5, e2e: `early-base.test.ts` (`base`: the staircase with home where the bot stands; `spruce`; `coal`: coal
  ore inside the base; `gather`: 2 logs carried and `!get chest 2`; `pit`: the kit in a one-wide pit; `E5_BEFORE=1`
  records without asserting, for the base tree).
- Track E7, unit: `kit-dusk.test.ts` (the job on a fake host: a mine step ended at dusk and gone on with at dawn, a
  job started by night, nowhere to shelter, the shelter out of reach, the blocks dug before dusk and at the end, the
  end line through `sayEnd`), `kit-night.test.ts` (the night's window, the refill window, the step's progress, the
  plan, the enclosed spot and its flood), `shell-blocks.test.ts` (the cells, the dig from a hole, a hole's floor, the
  base and the walk out, the shelter's ground, the blocks chore), `night-shell.test.ts` (`retryNow`, the step up out
  of a shell over a hole), `chat.test.ts`
  (`sayKept`).
- Track E7, e2e: `early-dusk.test.ts` (`pause`: a mine step at dusk, walled in at the shelter, gone on with at dawn;
  `smelt`: the furnace's output taken at dawn; `here`: walled in where it stands; `nowhere`: worked on; `pit`: a shell
  over a hole in the base opened by a step up; `off`: the rule off), `early-blocks.test.ts` (`chore`, `base`: the walk
  out of the base, `job`: dug before dusk, `death`: 10 blocks after a respawn and the shell closed that night;
  `E7_BLOCKS=off` for the before side). The creeper replica `early-creeper.test.ts` is in pve.md.
- Track E10, unit: `seal-faces.test.ts` (flat ground unchanged, the river step, the code before, a deeper drop, a
  pillar, nothing to face, the table and its brace, 10 blocks for 11 cells, the shell's open-cell line), `food.test.ts`
  (the fuel table, the second fuelling), `kit-search.test.ts` (the legs, the standing cell, a flock found on the second
  leg, none, dusk), `kit-flights.test.ts` (the count, the bounds, a step ended as mostly flight, one flight noted, the
  status line). e2e: `early-leftovers.test.ts` (`step`, `table`, `fuel`, `flee`, `bed`, `status`; `E10_BEFORE=1` records
  without asserting, `E10_CASE` picks cases).
- Track E9, unit: `nav-shut-in.test.ts` (the two places Track E7's runs refused the walk from, as the planner saw
  them: both searches exhaustive, the stair out; the closed loop out of both; a stair slower than the caller's
  timeout; the dig way off; a pit of built blocks with its cause; a tower with a fall allowed; a refused walk's
  words in the furnace step and the night rule),
  `kit-morning.test.ts` (the sun, what holds and what does not, a burning mob, the cap, the census),
  `kit-dusk.test.ts` (the job waits, says so once, goes on with the seconds waited; the cap's line; the bound on
  the wall clock; `!get stop` in the wait; a craft that made nothing for `open_failed`, `request_failed` or
  `no_table` tried again, at home when the place was the fault, twice at most; a mine step that stopped `health
  low` waited out, its bound and its count), `night-shell.test.ts` (`NightSafety.hold`: the dawn waits in the
  shelter, the shell shut, no walk home; a dawn held 90 s opens the shell at once; a body pushed out is not held).
- Track E9, e2e: `early-home.test.ts` (`shaft`: `!furnace` from the foot of a shaft in a block of stone 19 wide, home
  16 off; `night`: the night rule's walk from there; `craft`: `!get furnace` there with a table carried: no cell
  for the table, home, crafted there; `morning`: a creeper boxed 10 blocks from the shelter at dawn
  holds the paused job and the shell, and the job goes on once it is gone; with `jobMorning` off the job goes on
  at once; `E9_BEFORE=1` records without asserting, for the tree before).
- Track E11, unit: `gather.test.ts` (a run stopped while paused, and a run paused and started again: the next run
  gathers), `food.test.ts` (a furnace that lags the bot's clock by 0, 10 and 15 ticks: `no_fuel` with the beef cooked
  and the furnace emptied; one that never cooks: `timeout`), `kit-dusk.test.ts` (a smelt step tried once more after a
  furnace timeout and after a refused request, the second failure ends the job, `no fuel` is not retried; the walk
  out set up once as the job goes on after the night, before its next step), `kit-morning.test.ts` (the radius on,
  off and with the owner's own wider; the guards). e2e: `early-round2.test.ts` (`gather`, `short`, `mix`, `way`;
  `E11_BEFORE=1` and `E11_COOK_E9=1` record without asserting on the trees before, `E11_WAY_OFF=1` the way with the
  setting off, `E11_CASE` picks cases).
- Track E12, unit: `skills/work-guard.test.ts` (the lone archer that aims or hit, not one that does not, not past
  16; off, guard on, no blade, low health; only for work, not idle, a walk, a kill job or `!pause`; a second archer
  in range, aiming or not, stops a pick and ends a fight on an archer; the health bar; the witch first, also below
  `fleeHealth`; melee mobs and creepers not its business), `creeper-rise.test.ts` (the lit creeper 2 or more under
  the feet and within 3 level, not one on the bot's level, unlit, too far aside, with no blocks or no room, the
  nearest of two; the rise over the job, the hold until it is gone or 3 s, a failed walk up that stands for the
  blast, the retry wait, off). e2e:
  `early-mine.test.ts` (`pillar`, `archers`, `archer`, `witch`, `door`; `E12_SET` the arm's switches, `E12_N` runs a
  case, `E12_ZOMBIE=1` a zombie at the pillar's foot, `E12_EXPECT=1` asserts no death).
- Track E13, unit: `work-archers.test.ts` (the trigger: two archers in range, one shooting; not one, not two that do
  not shoot, not one in reach, not with a melee mob or a creeper close, not without a job at work; the shell over the
  job, the side facing the nearest first; a bite in the shell; the open side away from them once fewer than two are in
  range at full health; the job stopped after 60 s; hit in the shell: out of it, no shell for 30 s; the 5 s between
  shells; off, no shell possible; the parched as
  pve counts it, and the process there and idle with the setting off), `skills/archer-lists.test.ts` (the one list
  against the game's ids, the other lists built from it, no copy of an archer id elsewhere). e2e: `early-mine.test.ts`
  `parched`, and `E12_UNTIL=step` (a run ends when its job ended) or `both` (when its job ended and its mobs are
  dead).

## Not proven

- The night shell on real terrain beyond the one forest above; a creeper at the shell (the blast opens it); a shelter
  on a slope or a ledge (a cell with no floor under it stays open); the corners (a spider reached through them once).
- The dawn wait on the fresh world past the run's end: three times it held the shell shut with hostiles near until the
  run stopped at 500; whether it opens at the cap with mobs still near was seen only on the test server.
- The cover rule on the fresh world: one night (kit 12) dug a litter cell and closed; the before and after numbers are
  the test server's.
- The obtain job with other wood kinds than oak and birch, in a desert or on snow, or with the stone deep under the
  surface; `!get bed` on real terrain (the wool path is unit-tested only).
- Track E2: gold, copper, sand and the blast furnace (unit tests only); a furnace someone else uses during the smelt;
  a home whose furnace spot cannot be reached; the iron kit on other seeds and biomes; diamonds (the planner would plan
  them: `pickaxeFor('diamond_ore')` is the iron pickaxe).
- Track E3: the smelt shell on real terrain (slopes, a furnace against a wall, water), against a creeper, or with a
  smelt longer than the case's 8; the leave way on the fresh world (the flat case only); the bed on other seeds and
  biomes, a bed spot on a slope, colours other than white; the herd walk to a flock out of view; the blade strike with
  an axe as the blade, and in a real shaft on the fresh world (the replica only).

- Track E4: the wear stop and the replacement on a fresh world, with the kit's soft targets (the cap rule is
  unit-tested only); `deathReturn` on real terrain, against the mob that caused the death, in a cave or a shaft, or
  with the drops spread over more than 8 blocks; the 5-minute despawn and the daylight margins (unit tests only); a
  table near home kept and a table more than 24 off (unit tests only); the furnace memory with a home set.
- Track E6: `!farm new` on other seeds and biomes (one world, seed 7, with 5 setups on it), on slopes, near
  water that is not still, or with the kit's empty bucket and water within 96 on a fresh world (the far water is
  unit-tested only); the drop pick-up beside the middle on a fresh world; the farm chore over more than three days,
  replanting the bare cells over time, and with a home far from the farm; the mixed fence with three kinds.
- Track E7: three worlds at n2 a side, one seed a kind, the kit given and the clock set so that dusk falls in the
  first mine step: a smelt, a hunt or a gather at dusk on a fresh world (the smelt by e2e only), a job over more
  than one night, a bed (the plan's first choice: unit tests only), home with no shelter set, the enclosed spot on a
  real world (unit tests only; the one fallback seen walled in where the bot stood), `jobDusk` with `nightShell`
  off on a fresh world (by construction the body does what the night rule did with it before); `shellBlocks` where
  the ground near is sand or gravel (not dug: no kind the shell places), under trees, on a slope, and the refill
  before dusk inside a job on a fresh world (the bot carried its blocks in every run); the kept end line beyond the
  unit tests; anything on the Realm.
- Track E8: the water rules on one normal world (four spawns, n3 a side) and a flat test world; water farther than
  about 200 on a real world (none was found within 1 400 of a spawn); the search walk over rough ground; a water trip
  cut by the night and resumed (the rule is the night process's own pre-emption, not run here); the plot-height rule
  where the plot stands below the water; the seed top-up on other worlds (two 6-day trials on one spawn) and with a
  `farmFood` day longer than one process; anything on the Realm.
- Track E9: three worlds, one seed a kind. The walk out of a pit with a wooden or an iron pickaxe, from deeper than
  34 under the surface, where the stair meets water, lava, gravel or sand, in the Nether, or in a pit whose way out
  is more than 128 blocks; the same refusal on the mountain world of Track E5 (not run). `jobMorning` without the
  night shell (the default: not run), with a bed or home alone as the place for the night, and in rain (nothing
  burns then: the rule would run to its bound every morning). The two arms of the morning at n6, on the same three
  spawns. The craft tried again at home on a fresh world (the e2e case and unit tests: the later runs found room
  in the cut), the wait for health on any server (unit tests only), a refused craft request tried again (seen once
  on a fresh world). Whether the kit ends `done` on a fresh world: n1 a world with the job's rules as they are.
  Anything on the Realm.
- Track E5: the five worlds at n2 each, one seed a kind (each run a fresh copy of it); the chain's later runs had the
  fixes as they went in, so the per-world table mixes code states. The base walk-out where the base's edge is water,
  lava or a cliff (it tries the line away from home and 45 degrees either way, then gives up and says so; the e2e and
  the plains cases only); the own-table rule with a table
  someone else set down (it is not used); spruce only among the other woods on a real world (other kinds by the
  recipe rule, unit-tested); a jungle, a swamp, badlands, a cherry grove; a home set somewhere other than where the
  kit ended.
- Track E10: the shell's supports on the river spawn (one world, 3 nights a side) and the flat test server; a step down
  deeper than 2 or with water in it; the brace beside a furnace (a table only); the search walk on rough ground and on
  a fresh world in a job (a flat world and unit tests); a flock that moves away during the walk; the flight rule on a
  fresh world (the skeleton held still by the e2e); the second fuelling in a smelt step on a fresh world; anything
  on the Realm.
- Track E11: the cook and smelt retry on a fresh world (unit tests only: no run met a furnace timeout); the race
  in a smelt step (the cooker's rule is shared, the case is a cook); `morningWay` without the night shell, with a
  bed or home alone, in rain; the fresh-world mornings at n6 a side on three spawns, one seed a kind, with the
  night shortened (the clock to 18000 once inside the shelter); a mob above or below the walk, an archer on a
  ridge.
- Track E12: a death in any scene (none killed the bot; their measure is the damage and the lowest health); armour,
  a better blade, more than one witch, a witch with archers; a fight for the work over rough ground (one fight in 6
  fresh-world mornings with the final rule); the rise on a ledge wider than one block and with two creepers;
  anything on the Realm.
- Track E13: the wall against three archers or more, archers with melee mobs, a pillager's crossbow, skeletons that
  keep away from the wall (once in 10 runs the strikes at the wall did not kill, and the job was stopped); a shell on a
  slope, a ledge or in water; armour or a better blade; the rule on real ground beyond one shell (one in 6 fresh-world mornings);
  anything on the Realm.
- Anything on the Realm.
