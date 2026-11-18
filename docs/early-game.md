# The early game: day one from an empty inventory (Track E1)

What the bot does on a fresh survival world when it starts with nothing, the commands an owner types for the first
day, and what is still missing before it can live through the first nights on its own. Decision record:
[decisions/0098-day-one-from-nothing.md](decisions/0098-day-one-from-nothing.md).

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
- a full solid top under it, not a built block and not a container; not in the body.

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
   wooden pickaxe, iron ore a stone one; iron and better need smelted ingots: refused). Logs first, then a target the
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

## Still missing for the early game

In the order they matter, with the reason measured here:

1. **A bed, placed and slept in.** Every death measured here was at night at an open shelter (arrows), and a bed
   skips the night on a world where everyone sleeps. The night process sleeps in a bed it finds near the shelter or
   home (docs/survival.md) but nothing places one, and the wool loses to the food hunt: after `!get food` (which took a
   sheep among others) `!kill sheep 3` found 0 of 3 within 32. `!get bed` plans `!gather`, `!kill sheep 3`, `!craft
   bed` (unit-tested), so what is missing is the sheep before the food (or shears) and a bed set down by the shelter.
2. **A shelter that is one.** `!shelter set` marks a point; on open grass it holds the bot where skeletons shoot it.
   The night shell (off) closes that gap where it was measured; on by default it needs runs on slopes, ledges and in
   water (a cell with no floor under it stays open) and a creeper's blast (it opens the shell).
3. **A furnace set down, and cooked food.** All the day's food was raw (`cook: no furnace or smoker within 32 blocks;
   the raw food is kept`); `!cook` wants a furnace within 16 of home. The kit's 16 cobblestone make one (`!craft
   furnace` now chains its table), but nothing places it and the fuel is the day's logs or planks.
4. **Smelting, then iron.** `!get iron_pickaxe` is refused: `iron_ingot` comes from a furnace and the chain uses grid
   recipes only. Iron gates the bucket (milk, ADR 0096), the shield, iron tools and armour. With a furnace placed the
   obtain job needs a smelt step (`!mine iron_ore`, then the furnace's input, fuel and output as `!cook` does).
5. **Armour.** The bot wore nothing all day and night. Leather (a tunic is 8, a day's hunt gave 0 or 1) is slow; iron
   armour waits for 4.
6. **A farm.** In the first kit run the hunt ran out (4 of 6 food, nothing left within 48 blocks); a second day
   would find less. `!farm` works a field that exists; making one (a hoe, seeds from grass, water) is not done.

Smaller, seen once: the obtain job crafted a second table when the first one's drop had not been picked up yet when
the next step planned (both picked up two steps later).

## Tests

- Unit: `craft-chain.test.ts` (the chain on the recorded early recipes: planks, sticks, the table, tags, beds, kept
  items), `obtain.test.ts` (the next command; a whole kit, a bed and a stone pickaxe from nothing on a simulated
  inventory), `table-spot.test.ts` (the measured litter case), `kit-commands.test.ts` (the job: done, a step that gets
  nothing, stop, a moving command), `night-shell.test.ts` (sky, blocks, tries, the exit, NightSafety's order at dawn).
- e2e (flat, peaceful, the truth pack; `CRAFT_BDS_PORT` / `CRAFT_BDS_CONTAINER` choose the server):
  `dayone-craft.test.ts` (chain, names, litter), `dayone-get.test.ts` (a stone pickaxe from nothing, `!get stop`, a
  refusal), `dayone-shell.test.ts` (on: walled in at dusk, out and home at dawn; off: nothing placed; leaf litter round the feet: dug, then walled in; a zombie boxed 8 away at
  dawn: shut until it is killed, opened 3.3 s after; under a leaf canopy: walled in; under planks: nothing placed).

## Not proven

- The night shell on real terrain beyond the one forest above; a creeper at the shell (the blast opens it); a shelter
  on a slope or a ledge (a cell with no floor under it stays open); the corners (a spider reached through them once).
- The dawn wait on the fresh world past the run's end: three times it held the shell shut with hostiles near until the
  run stopped at 500; whether it opens at the cap with mobs still near was seen only on the test server.
- The cover rule on the fresh world: one night (kit 12) dug a litter cell and closed; the before and after numbers are
  the test server's.
- The obtain job with other wood kinds than oak and birch, in a desert or on snow, or with the stone deep under the
  surface; `!get bed` on real terrain (the wool path is unit-tested only).
- Anything on the Realm.
