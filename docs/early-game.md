# The early game: day one from an empty inventory (Track E1), the iron age (Track E2), the shaft, the furnace wait and a bed (Track E3), wear and setbacks (Track E4)

What the bot does on a fresh survival world when it starts with nothing, the commands an owner types for the first
day, the iron age after the stone kit (a furnace, smelting, cooked food, iron tools and armour), and what is still
missing before it can live through the first nights on its own. Decision records:
[decisions/0098-day-one-from-nothing.md](decisions/0098-day-one-from-nothing.md),
[decisions/0099-iron-age.md](decisions/0099-iron-age.md),
[decisions/0100-shaft-furnace-bed.md](decisions/0100-shaft-furnace-bed.md),
[decisions/0101-wear-and-setbacks.md](decisions/0101-wear-and-setbacks.md) (the job through wear and setbacks, Track E4).

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
- A tag cell (any planks, a stone tool material) tries the kinds carried, most first, then a default (`oak_planks`,
  `cobblestone`), then the rest the server knows. Kinds are not mixed in one cell's count.
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
the process it started (at most 10 minutes a step, 24 steps), then re-plans from the inventory. It ends:

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
  again from what the slot holds then.
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
5. **A farm.** In the first kit run the hunt ran out (4 of 6 food, nothing left within 48 blocks); a second day
   would find less. `!farm` works a field that exists; making one (a hoe, seeds from grass, water) is not done.

6. **A mob at the top of a shaft** (Track E3, "A mob at the top of a shaft"): the reflex strikes with the blade now;
   the walk still climbs on with a mob over it, and a bot with no blade in the hotbar strikes with what it holds.

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

- Track E3, unit: `blade-strike.test.ts` (the swap and its refusals), `smelt-shell.test.ts` (when, the cell, the
  brace, the pause, the open at dawn), `bed-place.test.ts` (the spot, covers, the job, the wool count),
  `night-shell.test.ts` (control kept while the shell is shut), `kit-commands.test.ts` (the herd walk, the bed last).
- Track E3, e2e: `early-shaft.test.ts` (a zombie at the top of a one-wide obsidian shaft: killed with the sword, the
  top reached; `EARLY_SHAFT_*` for the A/B), `early-smelt.test.ts` (the smelt by night with mobs: walled in, 8
  ingots, out at dawn; `EARLY_SMELT_SHELL=off|leave` for the other ways), `early-bed.test.ts` (no home: the bed by the
  bot over a litter cover, the waypoint; home 10 off: the bed there and a respawn by it; a night slept through).

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
- Anything on the Realm.
