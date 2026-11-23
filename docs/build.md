# `!build`: the builder (wave 9, Track AL)

The bot builds simple structures legitimately, from its own inventory, with the same clicks a player
makes: fill / clear / replace a box, walls, floors, pillars and structure files (`.mcstructure`, a
hand-written JSON layer format, and since Track B2 the Java files people share: Sponge `.schem`, MCEdit
`.schematic`, Litematica `.litematic`, vanilla `.nbt`). PLAN.md 7.17 "builder". Decision records:
[decisions/0033-builder.md](decisions/0033-builder.md), [decisions/0124-block-states.md](decisions/0124-block-states.md)
(block states: orientation, two-cell blocks, attached blocks), [decisions/0125-java-files-and-bill.md](decisions/0125-java-files-and-bill.md)
(Java files, the bill of materials, a fetch that crafts and smelts), [decisions/0128-builder-at-full-size.md](decisions/0128-builder-at-full-size.md)
(large builds in sections, tall builds, resume, speed: "Large builds (Track B3)"). Placing and digging themselves are
the PlaceSkill and the Digger ([interaction.md](interaction.md), [digging.md](digging.md)).

## Files

| Path | What |
|---|---|
| `bot/src/skills/build/types.ts` | `BuildBlock`, `BuildSpec`, block name helpers, `MAX_BUILD_CELLS` (262 144 since Track B3), `SECTION_CELLS` (4096) |
| `bot/src/skills/build/states.ts` | Track B1: block states (`placementOf`: the click each block needs, what is verified, the refusals; `chooseClick`; `doorHinge`; `rotateStates`; `resolveBlocks`; `unsupportedBlock`, `itemFor`) |
| `bot/src/skills/build/spec.ts` | `!build` arguments -> `BuildSpec` (`~` coordinates, Bresenham walls), `buildStepText` (the NL step) |
| `bot/src/skills/build/sim.ts` | the world plus the build's changes (`SimWorld`), stand / reach / support rules, reachability (`reachableStands`) |
| `bot/src/skills/build/plan.ts` | the planner: order, stands, support scaffolds, scaffold columns, dig lists (`planBuild`, `planBuildAsync`) |
| `bot/src/skills/build/materials.ts` | materials against the inventory, the throwaway reserve (`usable`, `materialsOf`, `materialsLine`) |
| `bot/src/skills/build/runner.ts` | `BuildRunner`: executes the steps on the bot (walk, place, dig, pillar, descend, verify, retry, skip); Track B3: bursts of clicks, the time by kind, the restock end, the scaffold blocks out |
| `bot/src/skills/build/job.ts` | Track B3: `BuildJob`, a build in sections (`placeSections`, `boxSections`), each planned when the one before is done; the restock rounds, the sweep, the resume survey, the scaffold a restart left |
| `bot/src/skills/build/worker.ts` | Track B3: the planner worker (a section's area as a snapshot, `BuildPlannerClient`, `runBuildPlanWorker`; started through `startWorker`) |
| `bot/src/skills/build/progress.ts` | Track B3: the progress file (`BuildProgress`: the command, the file's hash, a bitset of the cells done, the scaffold blocks out, the state) |
| `bot/src/skills/build/formats/mcstructure.ts` | `.mcstructure` reader and writer (little-endian NBT) |
| `bot/src/skills/build/formats/layers.ts` | the JSON layer format |
| `bot/src/skills/build/formats/index.ts` | structure folders, the extensions (`STRUCTURE_EXTENSIONS`), `readStructure`, `loadStructure`, `listStructures` (`!build files`), rotation (`placeStructure`) |
| `bot/src/skills/build/formats/nbt.ts` | Track B2: Java NBT (gzipped or not, big-endian), the size limits, long values |
| `bot/src/skills/build/formats/schem.ts`, `schematic.ts`, `litematic.ts`, `vanilla.ts` | Track B2: the Sponge, MCEdit, Litematica and vanilla structure readers, and a writer of each for the tests |
| `bot/src/skills/build/formats/java.ts`, `java-blocks.json` | Track B2: Java block ids and states to Bedrock (one module, one data file), checked against the game's block palette |
| `bot/src/skills/build/formats/java-cells.ts` | Track B2: a Java file's cells through the mapping, the unknown blocks counted |
| `bot/src/skills/build/bill.ts` | Track B2: the bill of materials (have, make, get, cannot) and the fetch's next command |
| `bot/src/tasks/process/build.ts` | `BuildProcess` (a user process) |
| `bot/src/chat/commands-build.ts` | `!build`, `BuildController` (plan, materials, fetch, status, stop), registration |
| `bot/src/config/settings.ts` | `buildScaffold` (on); Track B3: `buildColumnMax` (6), `buildBurst` (4), `buildResume` (on) |
| `packs/truth/src/build.ts` | `truth:blocksdiff` (with states), `truth:blockstates` |
| `bot/test/unit/skills/build-plan.test.ts`, `build-states.test.ts`, `build-formats.test.ts`, `build-fakes.ts`, `bot/test/unit/build-commands.test.ts`, `bot/test/unit/fixtures/build/gate.mcstructure` | unit tests on fakes, the hand-built fixture |
| `bot/test/unit/skills/build-java.test.ts`, `build-bill.test.ts`, `bot/test/unit/fixtures/crafting-data-build-1.26.60.json` | Track B2: the Java readers (hand-built files and round trips), the mapping's guard, rotation, the bill on the server's own building recipes |
| `bot/test/e2e/build-box.test.ts`, `build-shapes.test.ts`, `build-java.test.ts`, `build-states.test.ts`, `build-truth.ts` | e2e on bds-build (Track B2: a Java house built from raw materials; Track B1: every family of states at 0, 90 and 180) |
| `bot/test/e2e/build-measure.test.ts`, `build-probe.ts` | Track B1: the measurements behind the rules (`BUILD_MEASURE=1`, raw clicks with a chosen face, point and view) |
| `bot/test/e2e/build-speed.test.ts` | Track B1: one structure of 40 oriented blocks timed (`BUILD_SPEED=1`; it imports nothing from the builder, so it runs on older code too) |
| `bot/test/unit/skills/build-b3.test.ts`, `bot/test/unit/build-commands.test.ts` ("large builds") | Track B3: safe stands, clustering, bursts, columns kept, grown and chosen by cover, digs from a column top, the restock, sections, the job, the resume, the scaffold a restart left, the progress file, the planner worker; the controller's rounds, stop, resume and restart |
| `bot/test/e2e/build-large.test.ts`, `build-hall.test.ts`, `build-rate.test.ts` | Track B3: a 5 801-block castle from the home chests with a stop, a resume and a restart (`BUILD_LARGE=1`); a 734-block hall timed on the code before and after (`BUILD_HALL=1`); the server's place rate (`BUILD_RATE=1`) |
| `docker/compose.build.yml` | `bds-build`, udp/19200, flat, peaceful |

## Commands (owner only, afk task with walking)

Coordinates are block coordinates; `~` is the bot's own feet coordinate and `~N` an offset from it
(`!build pillar ~2 ~ ~ 5 cobblestone`).

| Command | Reply |
|---|---|
| `!build fill x1 y1 z1 x2 y2 z2 <block> [fetch]` | `building fill 5x3x5 cobblestone: 75 to place`, at the end `build fill 5x3x5 cobblestone: done, 75 / 75 placed, 0 skipped in 56 s (80 blocks/min)`. Every free cell (air, grass, water is refused) of the box; cells holding the block already count as done, other blocks are left (`3 occupied (left)`) |
| `!build clear x1 y1 z1 x2 y2 z2` | `building clear 5x3x5: 75 to dig` ... `build clear 5x3x5: done, 75 / 75 dug, 0 skipped in 113 s (40 blocks/min)`; the drops are picked up |
| `!build replace x1 y1 z1 x2 y2 z2 <from> <to> [fetch]` | every `<from>` in the box is dug and `<to>` placed in its cell (`replaced`) |
| `!build wall x1 y z1 x2 z2 <height> <block> [fetch]` | a wall along the line (x1, z1) -> (x2, z2) (straight or diagonal, 8-connected), from y up |
| `!build floor x1 y z1 x2 z2 <block> [fetch]` | a one-block-high rectangle at y |
| `!build pillar x y z <height> <block> [fetch]` | a column from y up (height 1..64) |
| `!build file <name> [x y z] [0\|90\|180\|270] [skip unknown] [fetch]` | a structure file with its min corner at the bot's feet or at x y z, turned clockwise (seen from above) by the angle; a file with blocks that have no Bedrock block is refused unless `skip unknown` (see "Unknown blocks") |
| `!build materials [<build>]` | `materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)`, or `...; have everything`; without arguments: the running or the last build. Track B1: the blocks the builder refuses follow on the same line (`; 2 refused (water: no liquids; ...)`, see "Block states"), or on a line of their own when the first would pass the chat's length. When something is missing the bill follows (`bill for ...`, `bill: ...`, see "Bill of materials"), then one line per unknown block (`unknown: create:gearbox x 4 (not a Bedrock block)`) |
| `!build files` | Track B2: `build files: house (schem, 5x3x5, 65 blocks, 2.1 KB), tower (litematic, 7x20x7, 610 blocks, 4 unknown, 3.0 KB)`: the files of the folders with their format, size, block count, unknown blocks and bytes (at most 40 read; a file that cannot be read with its reason; `too big to build` past 262 144 blocks, 4096 before Track B3) |
| `!build status` | `build: 212 / 640 placed, 3 skipped, eta 4 min` (`(paused)` while pre-empted), `build: idle (last: ...)`; Track B3: a large build adds its section (`, section 2 of 3`), a fetch round its step (`build: fetching materials for ... (round 4): step 2, !bring ...; 1710 / 5801 placed, ...`) |
| `!build stop` | `stopped build fill 5x3x5 cobblestone: 40 / 75 placed, 0 skipped`; `build: nothing to stop`; Track B3: with scaffold blocks out (the bot on a column) `...; taking 9 scaffold blocks down`: they come down in a process of their own |
| `!build resume` | Track B3: `resuming build file castle at 36967 -60 38508: 1474 of 5801 done`, then as a new build; the cells done before are checked against the world first (`; 3 changed since, 2 air again (placed again), 1 another block (left): x y z stone`), scaffold blocks a restart left are dug first (`; 14 scaffold blocks left from before (dug first)`); `build: nothing to resume`, `build: ... is done (nothing to resume)`, `build: cannot resume ...: castle.schem changed since it started` |

A build that needs more blocks than the inventory holds is refused with the materials line and `(add
fetch to get, craft and smelt them first)`, then the bill. With `fetch` the bot works through the bill
first (Track B2, see "Fetch"): what the home chests hold, raw materials with `!get`, crafts and smelts,
then the build. What nothing can make is refused before any command (`build: nothing fetched: cannot get
3 end_stone (no recipe and !get does not know it)`, then the materials line).

The build is a **user process** (priority 40, docs/processes.md): flee, guard, night and newer
commands pre-empt it, `!pause` holds it, `!resume` / the end of the pre-emption continue at the same
step, `!stop` and `!build stop` end it, a death drops it. `!status` shows it in the stack (`[active]
build fill 5x3x5 cobblestone: 12 / 75 placed, 0 skipped, eta 46 s`). One build at a time (a new one
replaces the old). Track B3: a build over 4096 cells, or one whose blocks do not fit in the inventory, runs in
sections with fetch rounds between them ("Large builds (Track B3)"); every build keeps its progress, and one that was
running when the bot went away goes on by itself when it is back (`buildResume`).

## Order rules

- **Place builds**: bottom layer first. Inside a layer the cell farthest from where the bot stood
  when the build started comes first and the order works towards the bot, so the bot never walls
  itself in; a cell without any clickable neighbour yet waits for one that has (the farthest cell
  with a support goes first, else the farthest). Track B3: once the bot is at a stand it places every ready cell
  of the layer that stand reaches, and the cells of the next 4 layers above it reaches that stand on a block
  (placed or there), the lowest first, never beside or over its own body: a wall goes up several layers a
  stand. Each column of cells still goes from the bottom up. When that stand has nothing left, the next cell is
  the ready one of the layer nearest the bot (the farthest from the start on a tie), not the next by distance from
  the start: that order took the cells of a ring round the start (a curtain wall) from opposite sides in turn. A cell
  with no stand when its turn comes (its stands are blocks of the layer still to place: a room's floor inside its
  walls) waits for the rest of the layer and is tried again, round after round while each round places something,
  and only then skipped as `out of reach`.
- **Stands**: the bot works from a stand: feet and head cells free (no collision box, no liquid),
  neither of them a cell the build fills later, a full block top under the feet, no lava, fire,
  cactus, magma ... next to the body. The cell must be within 4.5 blocks of the eye (eye = feet +
  1.62, to the cell's centre), not in the body, and for placing a clickable neighbour (solid, not a
  door / chest / ... ) within the PlaceSkill's click reach (5 to its closest point; the server allows
  7.19 to its corner). The current spot is kept when it qualifies, else the bot walks to the nearest
  stand (a goto to any of the 12 nearest, `allowBreak` and `allowPlace` off so the walk never digs
  through or pillars onto the structure).
- **Reachability** (planner): stands joined by 4-neighbour steps of at most one block up or down,
  both ways walkable (no drop the bot cannot climb back), seeded from the bot and from every stand on
  the edge of the work area (the build's box plus 6 blocks; the edge is assumed reachable from
  outside). Placed blocks become stands as the build grows (a floor's middle is reached by walking
  on its edge).
- **Clear / replace**: dig lists, top layer first. Inside a layer the cells go in lanes 4 wide, back and
  forth along the layer's longer side, from the corner nearest the bot (the next layer from the corner
  where the last one ended): consecutive digs are neighbours, so one stand digs everything around it
  before the bot moves on. A dig's stand more than one block over its target costs 3 per block more, so
  the bot follows the dig down into the pit instead of walking the rim (the planner's walks step one
  block up or down; from the rim a pit two deep is out of reach). Measured on the planner (flat world,
  stand-to-stand walking): a 32 x 32 layer 368 blocks instead of 10 050 with the old nearest-first
  rings, a 32 x 32 x 4 box 1 389 instead of 40 278, every cell dug in both. Never the block
  under the feet (a stand on the target is not used), never a block next to water or lava, never an
  unbreakable one; liquids are skipped. A replace digs the cell and places the new block from the
  same stand (it needs another clickable neighbour of the cell).
- **Verify**: every placement is checked in the world model after the server's `update_block` (the
  block name at the cell, and for a structure file's blocks the states the click chooses: see "Block
  states"), every dig too (no collision box left). A failed step is retried twice (walking again),
  then skipped and reported (`skipped: x y z (place: place: rejected)`).

## Scaffolding (`buildScaffold`, default on)

Scaffold blocks are throwaway blocks (cobblestone, dirt, cobbled deepslate, netherrack; kinds the rest
of the build does not use first), placed to reach or to click, and removed afterwards; their drops
are picked up. Track B3: a kind a carried tool (or the hand) harvests goes first: without a pickaxe dirt before
cobblestone, which by hand takes 10 s a block and drops nothing (a tall build's columns are hundreds of blocks:
carry a pickaxe). The digs wear the tool out (an iron pickaxe lasts about 250 scaffold blocks; the e2e castle's
columns take about 1 100): in a job with `fetch`, when no carried tool harvests the scaffold kind any more (a tool
the survival kit keeps from breaking, with a few uses left, does not count: the digger does not use it), the bot
asks a fetch round for stone pickaxes at the foot of its next column, or of one whose dirt runs out before its top
(enough for the scaffold blocks left, at most 2, beyond the worn ones it carries; made of cobblestone and sticks,
when the bill can make or get them), once until one digs the kind again; without one it goes on by hand. The worn
tools stay in the inventory. Out of scaffold blocks on the ground, the bot first picks up what lies round it and
waits up to 3 s for it (the drops of a column it has just dug come in a moment later), then asks a round. Out of
them on a column (a top's support block, a column that grows), the bot never walks off to fetch: that cell (or the
column's cells) is skipped for the sweep and the column comes down as usual, so a short count costs a few cells, not
the build. A round counts the scaffold blocks carried once: the peak against everything carried (the reserve too,
it comes back when the column is dug), and only the shortfall is fetched (each stone pickaxe takes 3 cobblestone
from the same pool).

- **Support scaffold**: a target cell with no clickable neighbour at its turn gets the shortest chain
  (up to 3) of scaffold blocks from a cell that has one, through free cells that the build does not
  fill later. They are dug at the end of their layer (highest first). The e2e overhang (a block one
  cell beside the top of a 3-high post, nothing under it) needs exactly one.
- **Scaffold column**: a target out of reach from every reachable stand (e.g. the 7th block of a
  pillar: from the ground the eye reaches cell centres up to 5 blocks above the feet) gets a column
  within 2 blocks of it: the bot walks to the column's base, pillars up (the PlaceSkill's
  jump-and-place, docs/interaction.md "Pillar-up") until the target is in reach (the fewest blocks,
  then the top closest to the target), places from the top everything of that layer it reaches, then
  digs the column under its feet top-down, landing on each block, and picks up the drops. A column
  is at most `buildColumnMax` high (default 6; Track B3: kept, grown and chosen by what its top reaches, see
  "Height"). When the bot is pushed off a column (a pre-emption, a flight), the resumed build digs the column
  from the ground and pillars again.
- `!set buildScaffold off`: such cells are skipped (`no support (buildScaffold off)`, `out of reach
  (buildScaffold off)`).

## Materials

`materials` counts the blocks the plan places per item (cells already right are not counted) and
compares them with the inventory. The survival keeper's throwaway reserve (`throwawayMin` throwaway
blocks, default 16) is **never** built with: a throwaway kind is usable for the build only beyond what
the reserve still needs after the other throwaway kinds are counted (75 cobblestone + 16 dirt builds
75 cobblestone; 91 cobblestone alone too; 75 cobblestone alone stops at 59: `build ...: stopped at 59
/ 75 placed: out of cobblestone (16 kept as the throwaway reserve)`). Scaffold blocks may be lent
from the reserve, because they come back. The scaffold note (`1 scaffold block, picked up again`)
and a reserve shortfall are added in brackets.

Carried shulker boxes (Track BJ, decision [0052](decisions/0052-shulker-aware-jobs.md), docs/home.md "Supply"):
what the carried boxes hold counts as material (not the fireworks box; `bot_loot` boxes do), and the line says
what will come out of them (`...; have everything (out of my shulker boxes as needed: 55 cobblestone)`). The
runner uses the task's `Supply`:

- **Refill**: out of a block (or of scaffold blocks) while on the ground, it takes what the rest of the build
  still needs of it (at most what fits loose with 4 slots free, `Supply.room`) out of the carried box holding most
  of it (`Supply.ensure`); the box is placed on a cell
  next to the bot that is not in the build's footprint (the planned cells and the pillar / descend columns),
  emptied of just that, broken and picked up. Never from a column top.
- **Before a column**: on the ground before pillaring, the column's own blocks and the scaffold blocks for it
  (its height, plus the throwaway-kind places on it) are topped up the same way; scaffold blocks prefer the
  throwaway kinds the build does not place.
- **Stow**: at the end (done or stopped), what was taken out and not used goes back into a carried box
  (`Supply.stow`, down to what the build held at the start).
- **A pause** (`!stop`, `!build pause`, a pre-emption) during a refill: the box is picked up again; a box whose
  break was interrupted stays marked and the next run recovers it first (`Supply.recover`), on the ground only:
  never while the next step is a column top's place or the descend (a walk would leave the column).
- **Inventory full**: the boxes still hold the block but nothing more fits loose: the build stops with `my
  inventory is full (my shulker boxes still hold 100 cobblestone)` instead of `out of cobblestone`.
- Stats: `refills`, `refilled`, `stowed`. Without carried boxes nothing changes: `out of cobblestone` stops it.

Measured (e2e home-supply on bds-home, 2026-10-31): fill 5 x 3 x 5 cobblestone with 20 loose and a carried
box: 75 / 75 placed in 62 s, 55 out of the box in one refill, no loose cobblestone left over.

## Bill of materials (Track B2)

`skills/build/bill.ts` (pure: counts and recipes in, the bill out). For each item the build places (a double
slab counts two slabs; the scaffold blocks short count as cobblestone):

1. **Have**: out of the usable inventory first (the throwaway reserve held back, as above), then the carried
   shulker boxes (the runner takes them out itself, Track BJ), then the **home chests** as the chest memory
   knows them (`!chests scan`, docs/home.md; loose items and what the boxes in them hold).
2. **Make**: what is still short is planned at once by the crafter's own chain (`skills/craft/chain.ts`, the
   recipes the server sent at login: docs/crafting.md) on one pool, what is left in the inventory and at home,
   so two items that need the same planks share them; a crafting table is added when a 3x3 recipe needs one.
   What the chain cannot craft is **smelted** when the smelter makes it (`SMELTS` in skills/food/smelt.ts:
   glass from sand, stone from cobblestone, smooth stone from stone, bricks from clay balls, ...), its input
   from the pool or itself smelted, crafted or got (smooth stone: cobblestone -> stone -> smooth stone). An ingot
   is left to `!get`, which mines and smelts it itself.
3. **Get**: a raw material the pool does not hold is got with `!get` when the catalog gathers, mines or hunts it
   (clay balls as `!get clay`, 4 a block; farming is not used: it never ends by itself).
4. **Cannot get**: the rest, with the reason (`no recipe and !get does not know it`; before the server's
   recipes arrived `no recipes yet`).
5. **Furnace and fuel**: a smelt needs a furnace: when none stands where `!smelt` looks and none is carried,
   one is added (crafted from 8 cobblestone by `!furnace`, which sets it down within 16 of home). Fuel burns 8
   smelts a coal or charcoal and 1.5 a plank or a log (the smelter's own `fuelValue`): what the pool holds is
   burned in the smelter's order (coal and charcoal, then planks), then logs, crafted into planks first when the
   recipe is known (a log as four planks smelts 6 items, as a log 1.5).
6. **The reserve**: a throwaway kind (cobblestone, dirt, ...) brought or got also brings or gets what the
   reserve lacks, or the reserve would keep what came.

`!build materials` says the materials line, then the bill when something is missing, each line within one
chat reply (250 characters: the chat cuts a reply at 256; a long list goes on in the next line, split at a
`|`, `;` or `,`). The e2e house with its raw materials in a home chest:

```
materials for file house at 100 -60 20: 22 oak_planks, 15 oak_slab, 10 oak_stairs, 8 oak_log, 4 stone_bricks, 3 glass, 2 smooth_stone, 1 brick_block; need ...
bill for file house at 100 -60 20: oak_planks 22: have none; craft 22 from 6 oak_log | oak_slab 15: have none; craft 15 from 9 oak_planks | oak_stairs 10: have none; craft 10 from 18 oak_planks |
oak_log 8: have 8 at home | stone_bricks 4: have none; craft 4 from 4 stone | glass 3: have none; smelt 3 from 3 sand | ...
bill: from home: 24 oak_log, 3 sand, 30 cobblestone, 4 clay_ball; craft first 1 crafting_table; a furnace (8 cobblestone); smelt 6 cobblestone -> stone, 3 sand -> glass, 2 stone -> smooth_stone, 4 clay_ball -> brick; fuel 3 oak_planks,
8 oak_planks (from 2 oak_log)
```

## Fetch (Track B2)

`!build ... fetch` works through the bill one command at a time, through the chat's own handler as the owner
(the replies are each command's own), and makes the bill again after each command:

1. what cannot be got stops it before any command;
2. each take from the home chests: `!bring <item> <n> home` (the trip ends at home);
3. each raw material: `!get <item> <n>`;
4. a craft of a build item that the chain can craft now from what is carried, an item another one is made
   from last (the planks after the stairs and slabs that use them): `!craft <item> <n>` (the table is crafted,
   set down and picked up by `!craft`);
5. the fuel's planks: `!craft oak_planks <n>`;
6. the furnace: `!furnace`;
7. a smelt whose input is carried, the deepest first: `!smelt <input> <n>` (at most 64 a command);
8. then the crafts that waited on smelted items (stone bricks from stone, a bricks block from bricks) come up
   in 4 on the next bill; when nothing is missing the build is planned again and started.

The fetch is a **user process** (named `build`, like the build it starts): each command's own process
pre-empts it and it gets control back in between, so the home chore (which runs only without a user process)
does not unload what one step brought before the next uses it. `!build status` says the step (`build: fetching
materials for file house at ...: step 7, !smelt cobblestone 6 (25 s; 140 s in all)`), and `!status` lists it.
`!build stop` ends the fetch (the running command's own process is left to its command; `!stop` ends both), a
death drops it. It stops with a line when a command changed nothing (the same command with the same inventory
twice), when nothing can be done from what is carried (`nothing to do from what I carry (cannot craft 4
stone_bricks yet); left: ...`), after 40 commands or after an hour; a command that started no process within 3 s
counts as done.

## Large builds (Track B3, decision [0128](decisions/0128-builder-at-full-size.md))

### Size

A build may have up to 262 144 cells (`MAX_BUILD_CELLS`: a structure file of that many blocks, a box of that
volume). One over 4096 cells (`SECTION_CELLS`), or one whose blocks do not fit in the inventory, is a **job**
(`skills/build/job.ts`) of sections:

- **Sections.** Place builds in bands of whole layers from the bottom up, each at most 4096 cells; a layer larger
  than that in even strips across its longer side (as few as fit), the farthest from the bot first. The blocks every
  build places last (power sources, doors, beds, tall plants: "Block states") are sections of their own at the end.
  Clear and replace in slabs of whole layers from the top down.
- **Planned one at a time.** A section is planned when the one before it is done, on the world as it is then (so it
  stands on what the last one built), in the planner worker (`skills/build/worker.ts`, started through `startWorker`;
  the main thread if the worker fails) on a snapshot of the section's area (its cells plus 3 sideways, 8 below, 4
  above; at most 4 M cells). Only the running section's plan is kept: the memory a build takes is one section's plan,
  its snapshot while it is planned, and one bit a cell for the progress.
- **The sweep.** A cell a section skipped (out of reach then, its support in a later section) gets one more try at the
  end, and the states that follow the neighbours (a fence beside the next section) are read again then.
- **The whole bill first.** `!build ... fetch` checks the bill of the whole build before anything (what cannot be got
  refuses it before any command); a build taller than 4 counts the scaffold blocks of one tall section (24) too. Without
  `fetch` a build whose blocks are not all there is refused as before.
- **Fetch rounds.** Out of a block on the ground, or short of one at a section's start, the job ends `restock` with
  its place kept; the controller runs a fetch round for the next stretch (what fits in the free slots, less a margin
  of 4: the bill's `!bring ... home`, `!get`, `!craft`, `!smelt` as in "Fetch"), then the bot walks back near its next
  stand (when farther than 16) and goes on at the same step. On a column top a missing block leaves the cell for the
  sweep (the bot never walks off a column to fetch). A worn-out scaffold tool asks a round too ("Scaffolding"): the
  round brings the tool first. A command of a round that changes nothing away from home (more than 6 blocks) is
  tried once more at home (a craft at a column's foot inside the build found no free cell for its table). At most
  100 rounds; a round that brings nothing new stops the build with its reason, the scaffold blocks out coming down
  first.
- **Replies.** `building file castle at 38247 -60 37996: 5801 to place in 2 sections; fetching in rounds as it goes`;
  `!build status` adds `, section 1 of 2, 3 fetch rounds`; the end line `build ...: done, 5799 / 5799 placed, 0
  skipped in 2582 s (54 blocks/min) (2 sections, 5 fetch rounds), 889 scaffolds placed / 889 removed`. The time and
  the rounds are those since the last resume (a resume is a new job on the progress); a cell found in place when a
  section is planned (a burst's last clicks as a stop came) counts as there, not placed, in both numbers. The log has
  each section's plan (`build: section 2 of 2 (1833 cells): 1833 to do, 0 already, 0 skipped, 889 scaffolds (peak
  22), 2031 steps in 5856 ms`), each round and the runner's time by kind.

### Height

- **Columns up to `buildColumnMax`** (default 6, at most 32). A fall from the top of a column costs its height less 3
  in health, so the default stays at the old builder's 6; a tall build sets it first (`!set buildColumnMax 28`: the
  e2e castle's tower is 25 high). The rules that keep a tall column safe:
  - the bot goes up and comes down its own column only, landing on each block; a column's top is never walked to or
    from, and the bot never steps off it;
  - while the bot stands on a column it put up, `Skills.onScaffold()` is true (decision 0051's rule): combat strikes
    without stepping and sneaks, the flee comes down first, and nothing else walks it off;
  - no stand of the build, on the ground or on the build's own blocks, is beside a drop deeper than 3 (the fall that
    costs no health; `safeEdge`, in the planner and in the runner's stand choice);
  - `!build stop` with scaffold blocks out takes them down (the bot first, from the column it stands on), in a
    process of its own; a death drops the build as before; a restart leaves them, recorded (see "Resume").
- **A column is kept and grown.** On a column the bot places from its top every ready cell it reaches, the layers
  above too; when the next cell is out of reach it grows the column by up to 3 blocks if that reaches it, and comes
  down only when nothing more is in reach (or support scaffold blocks of the layer wait to be dug from the ground).
- **A new column's height** is chosen by what its top reaches: among the bases within 2 of the cell and the heights
  that reach it (up to 4 above the least), the top that reaches the most cells still to place, less 0.75 a block of
  height (a block whose states the click chooses counts only from a top that gives them with a natural view). On the
  e2e castle this halved the scaffold blocks of the tall section (2 247 to 1 134 on the planner) and the walks (858 to
  573).
- **The build's own blocks** are stands like the ground as soon as they are placed (a floor, a wall top within the
  reach rules); a roof is built from columns beside it, never from its slopes (a stair's top is not a full block).
- **Clear and replace use columns too:** a cell out of reach from the ground is dug (or replaced) from a column top,
  which comes down after.

### Resume

Every build keeps its progress in `<config dir>/build/<server>.json` (`skills/build/progress.ts`; memory only with
`--no-config`): the command's words and the feet it was typed at (so `~` and a file's anchor come out the same), the
label, a structure file's name and SHA-256, the targets' box, the cells done as a bitset over the box, the scaffold
blocks out, the owner who started it (the fetch's commands run as them) and the state: `running`, `stopped` (`!build
stop`, a death, a stop) or `done`. It is written atomically (a temp file, then a rename), at most every 10 s while cells
are done, within 1 s of a scaffold block going up, and at once when the state changes.

- **`!build resume`** goes on with the last build: the file must be the same (its hash), and every cell marked done
  is checked against the world first: air again is placed again, another block is left and reported (never dug:
  someone changed it), so the reply says what it found (`resuming build ...: 1474 of 5801 done; 2 changed since, 1 air
  again (placed again), 1 another block (left): 36970 -59 38510 stone`).
- **A restart.** A build `running` when the bot went away goes on by itself once it is back (`buildResume`, default
  on): 5 s after it spawns, alive, and when no command of its own runs (a `!goto`, a `!chests scan` the owner typed
  goes first), and only within 128 blocks of the build's box sideways (`AUTO_RESUME_NEAR`): back farther away (a
  respawn at the world spawn, a server that kept no position) it says `build: ... was running when I went away, but
  it is 53919 blocks away: !build resume goes on` and walks nowhere by itself. With `buildResume` off it waits for
  `!build resume`, or for the setting turned on later in the session. The scaffold blocks it left are dug first, the
  column under its feet first (it comes down the way it went up), then the others, each from the ground; a scaffold
  cell that holds something else now is forgotten. What it carried must still be carried: a server that gives a
  returning player an empty inventory leaves the build to fetch it all again from home, and what it was carrying is
  gone.

### Speed

- **Where the time goes.** The runner counts its time by kind (walk, place, dig, pillar, collect, wait, refill, fetch)
  and logs it at the end (`build: time walk 35 s, place 17 s, wait 4 s (31 walks, 0 retries)`). Before Track B3 a
  75-block fill spent 35 of its 55 s walking between stands and 17 s placing one block at a time; after, it takes
  10 s, and the 734-block hall of "Tests" 221 s instead of 1 103 s ("Measured (Track B3)").
- **The server's place rate** (e2e build-rate: one stand, 48 free cells round it, each with a block under it to click):
  the PlaceSkill one at a time, as the builder did, 0.21 blocks a tick (0.27 without its look ticks); raw clicks
  without waiting for the answers 0.94 a tick at 1 a tick, 1.7 at 2, 3.0 at 4, 4.8 at 8 and 6.9 at 16, every click
  accepted. A click with the held item's old count is refused (the bot counts its stack down itself), and a block
  clicked on one placed in the same tick is taken when the click names the new block.
- **One stand places all it reaches.** The planner picks a stand by the cells of the layer it reaches (each one worth
  0.6 blocks less of walk, `COVER_WEIGHT`, among the 16 nearest stands) and then places
  every ready cell from it, the farthest first, and the cells of the 4 layers above it reaches that stand on a block,
  before it moves on; a column top does the same for every layer it reaches. Then the next cell is the one nearest
  the bot, and a cell out of reach waits for the rest of its layer ("Order rules"). On the planner (flat world, the
  e2e castle of 5 801 blocks in its two sections, stand-to-stand walking): 421 stand moves and 6 437 blocks walked
  with 86 cells skipped out of reach before these two rules, 514 moves and 2 458 blocks with none skipped after; the
  e2e hall (734 blocks) 89 moves, 612 blocks and 20 skipped before, 83, 326 and none after. The layers above alone
  (before the nearest-cell rule) took the castle's low section from 387 stand moves to 262.
- **Bursts.** The plain blocks one stand reaches (the same item, the same column top) go in one `placeMany` call,
  `buildBurst` clicks a tick (default 4, at most 16 a burst; 0: one at a time as before); each step then finds its
  block there and is verified like any other (one tick of wait for the burst, not one a block); a click the server
  refused is placed again the usual way. Blocks whose states the click chooses stay one at a time (their own look and
  verification).

## Formats

Folders, first hit wins: `values.builds` (tests), env `BEDROCKBOT_BUILDS`, **`builds/` next to the
config file** (`%LOCALAPPDATA%\bedrockbot\builds` on Windows, `~/.bedrockbot/builds` on the Mac; not
with `--no-config`), then `worlds/` in the working directory. `!build file hut` looks for
`hut.mcstructure`, `hut.json`, `hut.schem`, `hut.schematic`, `hut.litematic`, `hut.nbt` in that order
in each folder (`!build file hut.litematic` reads that one file); names are letters, digits, `_ - .` (no
paths). The log line `build: !build ready (structure folders: ...)` lists them, `!build files` lists
the files (a name an earlier file answers is listed with its extension: `hut.nbt`).

**Size**: a file with more than 262 144 blocks (`MAX_BUILD_CELLS`; 4096 before Track B3) is refused
with its size (`castle: 300000 blocks in 100x30x100 is too big (at most 262144)`); air and structure
void are not blocks. One over 4096 blocks is built in sections ("Large builds (Track B3)"). Before that,
a Java file over 16 MB, over 64 MB unpacked or over 4 Mi cells is not read at all.

**`.mcstructure`** (Bedrock structure blocks, `/structure save`, export from the game): uncompressed
little-endian NBT `{ format_version, size: [x, y, z], structure: { block_indices: [[...], [...]],
palette: { default: { block_palette: [{ name, states, version }] } } } }`. Cell (x, y, z) is index
`(x * sy + y) * sz + z` (x outermost, z innermost) of `block_indices[0]`; `-1` is structure void.
Air and structure void are not placed. The waterlogging layer, entities and block entity data (chest
contents, signs) are ignored. Verified against BDS: the truth pack's `probe.mcstructure` placed by
the server (`truth:place`) and the reader agree on every cell (build-shapes e2e).

**JSON layers** (written by hand):

```json
{ "name": "hut",
  "layers": [ ["#####", "#...#", "#####"],
              ["#####", "#...#", "#####"],
              ["ppppp", "ppppp", "ppppp"] ],
  "legend": { "#": "cobblestone", "p": "oak_planks" } }
```

`layers[0]` is the bottom; each layer is a list of rows (z = 0, 1, ...), each row one character per
column (x = 0, 1, ...). `.` and space are "no block" (nothing placed, nothing required). A legend
value is a block name or `{ "name": "oak_log", "states": { ... } }`.

### Java files (Track B2)

All four are gzipped (a plain file is read too) big-endian NBT, read with Node's own zlib and the NBT
reader the protocol stack already has (no new dependency). Each was written from the format's published
description; the fixtures are hand-built byte by byte where the layout is subtle (the varints, the packed
longs) and the rest round-trip through a writer of each format in the same module, used only by the tests.
No file from the wild was read (none was downloaded): files from other tools are not proven.

| Format | Reads | Does not read |
|---|---|---|
| Sponge `.schem` v1, v2, v3 (WorldEdit 7, FAWE, Amulet, most tools since 1.13) | `Width`, `Height`, `Length` (unsigned shorts), the `Palette` of block state strings and the block data, one unsigned LEB128 varint a cell (v1 and v2 at the root `Schematic`, v3 in `Schematic.Blocks.Palette` / `Data`); cell index `(y * Length + z) * Width + x` | block entities (chest contents, sign text), entities, biomes, `Offset` (the min corner goes where the command says) |
| MCEdit `.schematic` (MCEdit, Schematica, WorldEdit 6; before 1.13) | `Blocks` (the id's low 8 bits), `AddBlocks` (the high 4 bits, two cells a byte, the even cell in the high nibble), `Data` (the data value), `SchematicaMapping` (names for the ids); `Materials` must be `Alpha` (Java); the same index as Sponge. Each id and data value goes through the table of Java 1.12 ids (`legacy` in java-blocks.json: ids 0 to 255 but 36, 253 and 254, with their data values: wood kinds, colours, slab halves, stairs, logs' axes, torches, doors, beds, levels and ages) to a Java block state, then through the one mapping | `Materials` `Pocket` (refused with its reason), ids past 255 without a mapping, tile entities, entities |
| Litematica `.litematic` | every region of `Regions` (`Position`, `Size`, `BlockStatePalette`, `BlockStates`), placed relative to the lowest corner of them all; a negative size on any axis (the region runs from `Position` back to `Position + Size + 1`); each cell a palette index of max(2, bits of palette size - 1) bits packed from the low bit up across the longs (an index may span two longs); cell index `(y * sizeZ + z) * sizeX + x`; overlapping regions: the later one wins | tile entities, entities, pending ticks, the metadata (only the regions are read) |
| Vanilla `.nbt` (a Java structure block, data packs) | `size`, `palette` (or the first of `palettes`), `blocks` with `state` and `pos`; an unlisted cell is a structure void (left as it is) | block `nbt`, entities, the other palettes |

**Java blocks to Bedrock** (`formats/java.ts`, all rules in `formats/java-blocks.json`): one mapping for all
four formats, checked against the game's block palette of the bot's version (`bot/data/block-palette/`). In
order:

1. A namespace other than `minecraft:` is a mod's block: unknown (`not a Bedrock block`). Air, cave air, void
   air and structure void are no block. Java-only blocks (`test_block`, `test_instance_block`) are unknown with
   their reason.
2. A Java state that picks another Bedrock block (`byState`): `redstone_lamp[lit=true]` -> `lit_redstone_lamp`,
   unlit redstone torches, powered repeaters and comparators, the inverted daylight detector, the sticky
   piston head, cave vines with berries, `light[level=N]` -> `light_block_N`. A lit furnace, smoker or blast
   furnace is built unlit (the lit block has no item).
3. The renames (`rename`: `grass_block` stays, `short_grass`, `bricks` -> `brick_block`, `cobblestone_stairs`
   -> `stone_stairs`, `stone_stairs` -> `normal_stone_stairs`, `stone_slab` -> `normal_stone_slab`, `terracotta`
   -> `hardened_clay`, `light_gray_glazed_terracotta` -> `silver_glazed_terracotta`, `oak_door` ->
   `wooden_door`, `oak_trapdoor` -> `trapdoor`, `oak_fence_gate` -> `fence_gate`, `dirt_path` -> `grass_path`,
   wall torches -> the torch kinds, wall heads and skulls, the cauldrons, ... about 75), then the patterns
   (`*_sign` -> `*_standing_sign`, `*_wall_banner`, `*_bed` -> `bed`, `potted_*` -> `flower_pot`). Most ids
   are the same in both games (`oak_planks`, `white_wool`, `stone_bricks`, `smooth_stone`, ...): they are
   taken as they are when the palette has them.
4. A double slab (`type=double`) is the Bedrock double slab of that kind (`oak_double_slab`,
   `normal_stone_double_slab`, `double_cut_copper_slab`); the bill counts two slabs for it.
5. The states, by rules per Java family (`states`, the first rule whose Bedrock state the block has wins for
   each Java property; values are checked against the palette and a value it does not list is dropped):
   `axis` -> `pillar_axis`; stairs `facing` / `half` -> `weirdo_direction` (east 0, west 1, south 2, north 3) /
   `upside_down_bit` (`shape` is the game's to work out); slabs `type` -> `minecraft:vertical_half`; doors,
   trapdoors, fence gates, beds (`direction`, south 0, west 1, north 2, east 3; `open_bit`, `upside_down_bit`,
   `head_piece_bit`, `upper_block_bit`); wall and fence connections; torches (`torch_facing_direction`, the
   opposite of Java's `facing`); vines (`vine_direction_bits`); `facing` to `minecraft:cardinal_direction`,
   `facing_direction` (down 0, up 1, north 2, south 3, west 4, east 5), `minecraft:block_face`,
   `minecraft:facing_direction` or `direction`, whichever the block has; `rotation` -> `ground_sign_direction`;
   crop ages, snow layers, candles, sea pickles, cake bites, composter and respawn anchor levels, `lit`,
   `powered`, `open`, `hanging`, `attached`, `persistent` leaves, `half` of tall plants. `waterlogged` and
   Java-only properties are dropped.

Coverage: the guard test maps 1074 Java ids (the vanilla block ids of Java 1.21, written from the game's
list, not read from a Java registry) and every one gives a block the 1.26.60 palette knows; every rename,
pattern and byState target is a palette block; every legacy id the table has maps. The states are checked
on samples (logs, stairs, slabs, doors, beds, torches, walls, fences, vines, crops, leaves) and on every rule's
values against the palette; the placed states are Track B1's: the runner gives each block the mapped states
with the click that makes them and verifies them ("Block states"), and refuses the families no click gives.

**Unknown blocks**: a block that maps to nothing is counted by its Java state and reason (`create:gearbox
x 4 (not a Bedrock block)`; an MCEdit id the table does not know: `id 300 x 1 (not a vanilla block id)`, or
by its SchematicaMapping name). Choice: **refused by default**, `skip unknown` builds without them. A
missing block may carry a floor, close a wall or hold up a roof; building around it silently would leave a
hole the owner did not ask for. The refusal names as many as fit one reply, then `, K more kinds` (`house:
4 blocks have no Bedrock block: create:gearbox x 4 (not a Bedrock block) (add skip unknown to build without
them; !build materials lists them)`); `!build materials file <name>` lists them one a line after
the bill (at most 8 lines, then `N more kinds`); with `skip unknown` the label says `, 4 unknown skipped`
and those cells are left as they are.

**Rotation**: 90 / 180 / 270 turn the structure clockwise seen from above (east -> south); the min
corner of the turned structure is the anchor. The block states turn with it, once, for every format:
`rotateStates` (states.ts) in `placeStructure`; the readers, the Java ones too, hand over the file's
states unturned (Track B2's own turner, `formats/rotate.ts`, was folded into it when the tracks met, so no
state is turned twice). It turns every cardinal and facing state (`minecraft:cardinal_direction`,
`minecraft:facing_direction`, `minecraft:block_face`, `facing_direction`), `weirdo_direction`,
`direction` (a trapdoor's in its own order), `pillar_axis` and `portal_axis` (x and z swap),
`lever_direction`, `torch_facing_direction`, `ground_sign_direction` (+4 per quarter), `rail_direction`,
vine bits, a crafter's `orientation` and the keyed connection states (fences, walls, dust); vertical
directions and a stair's corner stay. The runner gives the block those states: see "Block states".

## Block states (Track B1, decision [0124](decisions/0124-block-states.md))

A structure file names every block's states. The builder gives each block its states with the click a
player makes: which face of which neighbour, the point on that face, the view sent with the click, where
the eye is, and clicks on the placed block afterwards. Every rule here was measured on BDS 1.26.60.6
(`build-measure` e2e: raw clicks with a chosen face, point and view on a flat world) and holds for any
world; Bedrock differs from Java in several (a piston faces the way the player looks, a door's facing is
a quarter turn from the view, the click point never chooses a door's hinge). The code is
`skills/build/states.ts`.

### What the server reads from a click

- **The face** (the side of the neighbour clicked): every attached block (torches, ladders, buttons,
  levers on a wall, wall signs, frames, heads on a wall, end rods, lightning rods, amethyst buds), a
  pillar's axis (the face's axis), a lantern's `hanging`, a slab's or stair's half (the bottom face of
  the block above gives the top half).
- **The point on a side face**: over the middle (y 0.75) gives the top half of a slab, a stair or a
  trapdoor, under it (0.25) the bottom half. The point on a top or bottom face changes nothing.
- **The view's cardinal**, quadrants split at 45 degrees (measured at 40 and 50): stairs, doors,
  trapdoors, gates, beds, every block that faces the player, repeaters, comparators, the axis of a lever
  on a floor or a ceiling, hanging signs, standing bells and grindstones, the level facing of six-way
  blocks.
- **The view's yaw to 22.5 degrees**: a standing sign's `ground_sign_direction` is the yaw plus 180 over
  22.5, rounded, modulo 16 (view 11 -> 8, 12 -> 9, 34 -> 10, -90 -> 4).
- **Where the eye is** (six-way blocks): facing up or down only when the eye is within 2 blocks of the
  cell's centre on both axes (1.0 counts, 2.0 does not); then more than 2 over the cell's bottom
  (measured 2.62; 1.62 is level) gives up, under the cell's bottom (-0.38) down; otherwise the view's
  cardinal. The planner keeps the eye 0.3 off both limits.
- **The neighbours** at the click: a door's hinge (below).

The server does not check that the view meets the clicked face. The builder looks at the click point
when that look already lies in the needed quadrant with 12 degrees to spare (a standing sign: within 5
degrees of its yaw), else it sends the needed direction's centre (a turned view) from wherever it
stands. The planner's stand choice counts a turned view as 2.5 blocks more walking, so natural views win
when a stand gives one at little cost.

### Families

| Family | States | The click | Verified |
|---|---|---|---|
| stairs | `weirdo_direction`, `upside_down_bit` | the view: east 0, west 1, south 2, north 3; upside down as a top slab | both at once; the corner shape has no state |
| slabs | `minecraft:vertical_half` | bottom: the top face below or a side low; top: the bottom face above or a side high | at once |
| double slabs | the name | a bottom slab, then a click on its own top face (point 0.5, 0.5, 0.5) with the same slab; a side clicked high or the block above clicked from below merge too; another kind of slab does not | the double's name |
| pillars (logs, basalt, ...) | `pillar_axis` | a face on the axis | at once |
| facing the player: furnaces, smokers, chests, pumpkins, glazed terracotta, looms, beehives, decorated pots, chiseled bookshelves, lecterns, shelves, petals | `minecraft:cardinal_direction`, `direction` or `facing_direction` | the view's opposite (placed looking south it faces north); a campfire faces the view, an anvil a quarter turn anticlockwise of it (looking south: east) | at once |
| doors | `minecraft:cardinal_direction`, `upper_block_bit`, `door_hinge_bit`, `open_bit` | the top face of the floor, the view a quarter turn anticlockwise of the facing (facing west: looking south); the upper half comes with it; open: one tap after | both halves at once (the hinge on the upper half), open after the tap (not iron) |
| trapdoors | `direction` (the view west 0, east 1, north 2, south 3), `upside_down_bit`, `open_bit` | the view; the half as a slab; open: a tap | at once, open after the tap (not iron) |
| fence gates | `minecraft:cardinal_direction`, `open_bit` | the view's opposite; open: a tap looking the way the gate faces (a tap looking back at it, as when it was placed, turns it round) | at once, open after the tap |
| beds | `direction`, `head_piece_bit` | the top face under the foot, the view the way the head goes (`direction` = the view: south 0, west 1, north 2, east 3); the head cell needs a floor too (rejected without) | foot and head at once |
| tall plants (sunflower, lilac, rose bush, peony, tall grass, large fern) | `upper_block_bit` | the top face of soil | both cells |
| torches (every kind) | `torch_facing_direction` | `top`: the top face; a side: the face of the block it hangs on (`west` = its support is to the west) | at once |
| lanterns (every kind) | `hanging` | the bottom face of the block above, else the top face below | at once |
| ladders, buttons, wall signs, frames, heads on a wall | `facing_direction` | the face clicked (a floor head's rotation is block entity data: not verified) | at once |
| end rods, lightning rods | `facing_direction` | the face clicked; an end rod on a side points back (`facing_direction` the opposite side) | at once |
| amethyst buds and clusters | `minecraft:block_face` | the face clicked | at once |
| levers | `lever_direction`, `open_bit` | a side: the face clicked; a floor or a ceiling: the face and the view's axis (`up_north_south` looking north or south); on: a tap | at once, on after the tap |
| tripwire hooks | `direction` | the side face | at once |
| bells, grindstones | `attachment`, `direction` | standing: the top face, the view's opposite; hanging: the bottom face above, the view's opposite; on a side: that face | at once |
| hanging signs | `hanging`, `facing_direction` | hanging: the bottom face above, the view's opposite; on a wall: a side face across its facing | at once (`ground_sign_direction` counts only on a chain: a click leaves it 0, a structure turned by the game turns it; not verified) |
| standing signs | `ground_sign_direction` | the top face, the yaw | at once |
| repeaters | `minecraft:cardinal_direction`, `repeater_delay` | the top face, the view's opposite; each tap adds one to the delay (four come back to 0) | the facing at once, the delay after the taps |
| comparators | `minecraft:cardinal_direction`, `output_subtract_bit` | as a repeater; one tap for subtract | the facing at once, the mode after the tap |
| pistons, sticky pistons | `facing_direction` | the view's cardinal (it points the way the player looks); up with the eye over the cell, down with it under | at once |
| observers | `minecraft:facing_direction` | the view's cardinal; up with the eye under the cell, down with it over (it looks where the player looks) | at once |
| dispensers, droppers, barrels | `facing_direction` | the view's opposite; up with the eye over the cell, down with it under | at once |
| crafters | `orientation` | `<d>_up` on the level (d the view's opposite); `up_<d>` with the eye over, `down_<d>` under | at once |
| hoppers | `facing_direction` | down: the top or bottom face; a side: the face of the block it points at | at once |
| candles, sea pickles, snow layers | `candles`, `cluster_count`, `height` | the top face, then one more click on the block itself with the same item per candle, pickle or layer | the count after the clicks |
| rails, dust, carpets, plates, flower pots, cakes | `rail_direction` (rails) | the top face below | at the end (below) |
| fences, walls, panes, bars | the connections | any face | at the end |

States no click chooses: a rail's shape (it follows the rails next to it; a lone rail is north-south
with every view, measured), the connections of fences, walls, panes and dust, a stair's corner shape,
power and signal states, age and growth, contents and fill levels, and every block entity: sign text, a
bed's colour, a banner's pattern, a floor head's rotation, a container's items. A container is placed
empty, a sign blank, a bed in the colour of the bed item the bot holds. These states are not verified.

### Order and stands

- **Supports first.** A cell is placed only from the faces its states allow; one whose allowed support
  is a cell the build fills later (a lantern under a ceiling, a torch on a wall of the next layer) waits
  for it, into later layers if needed. A missing allowed support gets a scaffold chain that ends there,
  except for blocks that hang on their support (attached blocks, standing signs): a scaffold would take
  them down with it, so those are skipped (`torch: nothing to hang it on`).
- **Two-cell blocks**: the planner blocks both cells, the stand is never in either, the second cell must
  be free (`door: its second cell is taken`), a bed's head cell needs a floor.
- **Doors** after every other block but the power sources: their hinge is read from the neighbours at
  the click, which are all there then.
- **Power sources** last (below).
- **Six-way blocks facing up or down** need a stand over or under the cell (a scaffold column for up
  when no stand is high enough).

### Doors' hinges

Measured: the hinge is chosen at the click and kept when the neighbours change afterwards (a wall dug
after the door leaves it). With the view V, `next` is the cell a quarter turn anticlockwise of V and
`next2` the one clockwise (both levels). A door in `next` gives 1 (the pair), a door in `next2` gives 0,
else 1 when `next2` holds more full solid blocks (lower and upper level) than `next`; glass, leaves and
other doors do not count, cobblestone does. The click point does not matter. The planner predicts the
hinge; when the build's own neighbours give the other one, it places scaffold blocks (lower, then upper
level) on the side that gives the right one, places the door and digs them right after. Where no
scaffold can go (a cell of the build, a liquid) the door gets what its neighbours give and the plan
says so.

### Verification and retries

- Right after the click: the block's name and the states the click chooses, and its other cells (a
  door's upper half with the hinge, a bed's head, a plant's top). A wrong one is dug (its drop picked
  up) and placed again by the next attempt; what the third attempt places is kept and reported. When
  the item is out after such a dig, a wider pickup (8 blocks, 10 s) runs before the build stops as
  out of it (a drop that fell out of the first pickup's reach).
- Then the merges (more candles, a double slab) and the taps (a repeater's delay, open), then the end
  states.
- After the last step: every placed block's end states again (a later neighbour may change them) and
  the states that follow the neighbours (connections, rail shapes). A rail with another shape is dug and
  placed once more (its neighbours are all there now); the rest is reported.
- The end line: `build file hut at 10 -60 3 (90): done, 52 / 52 placed, 0 skipped in 141 s (22
  blocks/min); 1 with other states: rail 12 -60 5 (rail_direction=1 not 0)`.

### Ordered redstone (the choice)

Power sources (redstone torches, redstone blocks, daylight detectors, observers, sculk sensors, a lever
the build wants on) are placed after everything else; a lever is placed off and switched on by its
last tap. TNT in a build that has a power source is refused. Why: a part placed next to a live source
switches while the build goes on (a piston extends into a cell the build fills next, an observer pulses
into its neighbours, dust lights a repeater, which changes its name); built in that order the circuit
is still until its last block. Not done: an order inside the circuit, timing, verifying power states,
checking that the finished circuit works (a powered repeater and an unpowered one count as the same
block).

### Refusals

| Block | Why |
|---|---|
| water, lava (any) | no liquids |
| fire, portals, bedrock, barriers, command and structure blocks, spawners, vaults, farmland, paths, scaffolding, piston heads, moving blocks, kelp, seagrass, bamboo, vines that hang (cave, weeping, twisting), dripleaves, pointed dripstone, pale moss carpet, cocoa, powder snow, budding amethyst, frosted ice, chorus plants, end portal frames, reinforced deepslate, tripwire | not placeable by the builder (no item, or it grows, or it needs more than a click) |
| wheat, carrots, potatoes, beetroot, stems, nether wart, torchflower and pitcher crops, sweet berries, sugar cane | crops grow from seeds (`!farm`) |
| vines, glow lichen, sculk veins, resin clumps | one face per click (not measured) |
| coral fans | not measured |
| banners | a banner's colour and pattern are block entity data |
| a hanging sign on a chain (`attached_bit`), a bell or grindstone between two blocks, more than one turtle egg, a mushroom block side | not measured, or chosen by its neighbours in the wild |
| a hopper facing up, a head facing down | no click gives it |
| the second cell of a two-cell block without its first | the file is cut |
| TNT in a build with a power source | it would be lit (ordered redstone) |
| a door, bed or tall plant typed by name (`!build fill ... oak_door`) | two-cell blocks need a structure file (their states) |

A structure file lists its refusals and builds the rest (`building file hut ...: 48 to place, 2 refused
(water: no liquids; standing_banner: a banner's colour ...)`), and `!build materials` lists them after
the materials. A block typed by name that is refused refuses the build.

## Truth commands (packs/truth/src/build.ts)

`truth:blocksdiff x1 y1 z1 x2 y2 z2 <palette> <runs>`: the box against an expected block list in the
canonical order of `truth:blocks` (y, then z, then x innermost); `<palette>` a comma list of ids
(`air,cobblestone`; `*` = any block), `<runs>` a comma list of `index*count`. Answer `{ count, diffs,
first: [{ x, y, z, expected, actual }] (20 at most), actual: { typeId: n } }`. Track B1: a palette
entry may name states, `name[key=value;key=value]` (`oak_stairs[weirdo_direction=1;upside_down_bit=1]`):
the cell must have those states too (others are not compared; `true` / `1` alike), and a state
difference's `actual` shows the compared states (`minecraft:oak_stairs[weirdo_direction=2]`). The
old form (names only) is unchanged.

`truth:blockstates x1 y1 z1 x2 y2 z2`: every cell of the box (4096 at most) with all its states, in
the same order: `{ from, to, size, order: 'yzx', palette: [{ typeId, states }], runs: [[index,
count]] }` (the e2e reads a structure BDS placed with it).

## Measured (e2e on bds-build, 2026-10-30, BDS 1.26.60.6)

Two gate runs of `build-box` + `build-shapes` (6/6 green each, 218 to 219 s per run), plus the
earlier runs:

| What | Result |
|---|---|
| fill 5 x 3 x 5 cobblestone (75 blocks), box 3 blocks from the bot | done in 56 s, **80 blocks/min** (walks included), 0 skipped, blocksdiff 0 of 75, 0 cobblestone and 16 dirt left, 1 correction; `!build status` 6 s in: `build: 9 / 75 placed, 0 skipped, eta 46 s` |
| clear of the same box (stone pickaxe) | done in 111 to 113 s, **40 to 41 blocks/min** with the pickup, blocksdiff 0 against air, all 75 cobblestone picked up |
| `!build materials` wall 10 x 4, empty inventory | `materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)` |
| JSON overhang (4 blocks, 1 support scaffold) | done in 5 s, the scaffold placed and dug, blocksdiff 0 of 9, the 16 dirt back |
| pillar of 7 | done in 7 s; 6 from the ground, one pillar-up (highest feet -58.75 in the jump), the 7th from the column top, the column dug: the bot at -60.00 on the ground (truth:pos), blocksdiff 0 of 7, 2 corrections (the pillar jump and the landing) |
| probe.mcstructure placed by BDS vs the reader | 0 of 18 cells differ |
| gate.mcstructure (11 blocks: cobblestone posts, an oak log beam, a stair) built rotated 90 | done in 5 s (136 to 143 blocks/min: one stand for all), blocksdiff 0 of 18 |

Regression on bds-build with the shared-file changes (afk task registration, settings, NL schema,
truth pack): get-front, get-stash, nl-core (GET_BDS_* / CORE_BDS_* pointed at bds-build): 8/8 green,
152 s.

### Measured (Track B2, e2e build-java, 2026-11-22, BDS 1.26.65.1, flat, peaceful)

The house of "Tests" (65 blocks) from a home chest of raw materials (32 oak logs, 8 sand, 48 cobblestone, 8 clay
balls) 3 blocks from home and an empty inventory, as `.schem` v3, `.litematic` and `.nbt`:

| What | Result |
|---|---|
| the bill | `from home: 24 oak_log, 3 sand, 30 cobblestone, 4 clay_ball; craft first 1 crafting_table; a furnace (8 cobblestone); smelt 6 cobblestone -> stone, 3 sand -> glass, 2 stone -> smooth_stone, 4 clay_ball -> brick; fuel 3 oak_planks, 8 oak_planks (from 2 oak_log)` (30 cobblestone: 6 smelted, 8 the furnace, 16 the throwaway reserve) |
| the fetch | 15 commands in 183 to 185 s, the same in every run: 4 `!bring ... home` (0 to 4 s: the chest is in reach of home), `!craft oak_slab 15` (18 made, the planks and the table first, the table set down and picked up), `!craft oak_stairs 10` (12), `!craft oak_planks 21`, `!craft oak_planks 8` (the fuel), `!furnace` (crafted, set down by home), `!smelt cobblestone 6` (61 s), `!craft stone_bricks 4`, `!smelt sand 3` (31 s), `!smelt stone 2` (21 s), `!smelt clay_ball 4` (41 s), `!craft brick_block 1`; the smelting is 154 s of it, the 11 planks burned are the bill's 3 + 8 |
| the build | `done, 65 / 65 placed, 0 skipped in 45 s (86 blocks/min)` (45 to 46 s; green runs: 3 `.schem`, 3 `.litematic`, 1 `.nbt`); truth:blocksdiff 0 of 75 by names (the 65 blocks and the 10 air cells: the doorway and the room); left over: 2 stairs, 3 slabs (whole recipes), the 16 cobblestone of the reserve, the crafting table |

### Measured (Track B1, e2e build-speed, build-shapes, build-box, build-states, 2026-11-22, BDS 1.26.60.6)

| What | Before (the code without block states) | After |
|---|---|---|
| `build-speed`: 40 oriented blocks (8 stairs, 8 upside-down stairs, 8 slabs, 8 logs, 4 furnaces, 4 pumpkins), one layer | done in 16 s (152 blocks/min), 31 of 40 with other states | done in 25 s (97 blocks/min), 4 scaffolds placed / removed, 0 of 40 with other states |
| `build-shapes` gate.mcstructure turned 90 (11 blocks, a stair) | 5 s | 10 s, 2 scaffolds (the stair's half and facing), blocksdiff 0 of 18 |
| `build-box` fill 5 x 3 x 5 cobblestone / its clear | 56 s / 112 s | 57 s / 114 s (blocks by name take the old path) |
| `build-states` b1states (64 to place: 68 cells, 38 with chosen states), turned 0, 90, 180 | refused (doors, redstone) | 68 to 74 s each, 6 scaffolds, 8 or 9 turned views, blocksdiff 0 of 468 |
| `build-states` b1states2 (33 to place, 14 with chosen states), turned 0, 90, 180 | refused (not every family placeable) | 19 to 25 s each, 3 to 6 turned views, blocksdiff 0 of 288 |
| `build-states` a Java `.schem` (2 stairs, a log, a furnace, a chest), turned 90 and 270, after the merge with Track B2 | (the Java readers came with Track B2) | 8 and 9 s, 2 scaffolds each, blocksdiff 0 of 9 against hand-written states |

A structure with oriented blocks costs about 1.5 times the time of the same cells by name (more stand
changes, scaffolds for halves and hinges); blocks by name are as fast as before.

### Measured (Track B3, e2e build-large, build-rate, build-hall, build-speed, build-box, 2026-11-22, BDS 1.26.60.6, flat, peaceful)

The castle of "Tests" (5 801 blocks in 51 x 25 x 41: a curtain wall 7 high, a house under a stair roof, a tower 25
high, a staircase) from 5 home chests holding its items, 192 cobblestone and 4 spare logs, the bot carrying an iron
pickaxe; `!build file castle ... fetch` with `buildColumnMax` 28; a `!build stop` and `!build resume` at a quarter, the
bot gone and back at 60 %:

| What | Result |
|---|---|
| the place rate (build-rate: one stand, 48 cells) | the PlaceSkill one at a time 0.21 blocks a tick (0.27 without its look); raw clicks 0.94 a tick at 1 a tick, 1.7 at 2, 3.0 at 4, 4.8 at 8, 6.9 at 16, 48 of 48 accepted; the held stack's old count in the click: 18 of 48 taken; a block on one placed the same tick: 1 of 9 taken, 6 to 9 of 9 when the click names the new block |
| sections | 3 968 cells (the lower layers, all from the ground: no scaffold) and 1 833 (the layers above: 889 to 986 scaffold blocks planned, peak 21 to 22); planned in 1.3 s and 5.8 to 6.0 s in the worker; a resumed section's rest in 0.4 to 0.8 s |
| the low section (7 runs) | 1 470 to 1 481 blocks before the stop in 191 to 193 s (place 74 to 76 s, walk 57 to 58 s, wait 14 s, 88 walks); the stop with no scaffold out, the resume 6 s later; the next 2 000 blocks walk 379 to 389 s, place 143 to 145 s, wait 30 s (about 270 walks); the restart at 3 481 to 3 487 blocks: back where it was and going on by itself 15 to 16 s after it went away; the section done 22 to 23 min after the command: about 340 s per 1000 blocks, two thirds of it walking (the courtyard's walls between the nearest cells, "Limits") |
| the tall section (4 runs) | 1 833 blocks in 36 min in the two green runs (2 165 and 2 168 s; 1 757 and 1 808 in the two before, which stopped short of scaffold blocks: fixed, see "Scaffolding"): about 1 180 s per 1000; runner time pillar 1 277 to 1 321 s (going up, coming down and digging 868 to 889 scaffold blocks), walk 888 to 1 004 s, place 209 to 219 s, collect 48 to 54 s, wait 42 to 44 s, 453 to 485 walks; every scaffold block placed was removed |
| fetch rounds | 11 to 12 a run (3 + 3 + 5 in the green runs: the numbering starts again at the resume and at the restart), 8 to 34 s each (`!bring ... home` from the chests in reach of home, 1 to 6 commands); the iron pickaxe worn after 243 scaffold digs, then a stone pickaxe round every 8 to 14 min (a table, sticks, 2 pickaxes: 13 to 21 s; a craft at a column's foot inside the build with no free cell for its table tried again at home: 1 to 2 a run); the scaffold blocks the pickaxes took fetched again (`!bring cobblestone 22 home`) |
| the column stop (`BUILD_LARGE_AT=column`, once) | the stop on a column: its scaffold down first, 0 left; the restart on a column: 1 left, dug first by the resume (the column under the feet), then the build went on |
| the whole build (2 green runs, 59 to 60 min each with the test's setup) | `done, 5799 / 5799 placed, 0 skipped in 2582 s (54 blocks/min) (2 sections, 5 fetch rounds), 889 scaffolds placed / 889 removed` (2 559 s in the other; the time and the rounds since the restart; 2 cells a burst had placed as the stop came were found in place at the resume, so they count as there, not placed), 3 536 and 3 544 s from the command: 609 to 611 s per 1000 blocks; truth:blocksdiff 0 of 52 275 cells (the box, with states) both; no scaffold block left; 19 fetch commands after the restart; left over: 22 cobblestone, 6 worn stone pickaxes, 2 planks, the crafting table |
| the hall (build-hall: 734 blocks, 24 x 6 x 16, no column needed, from the inventory; the same file on the code before the track and after) | before: `done, 713 / 713 placed, 0 skipped in 1101 s (39 blocks/min)`, 1 103 s from the command (1 502 s per 1000 blocks), 21 cells left out of reach; after: `done, 734 / 734 placed, 0 skipped in 220 s (200 blocks/min)`, 221 s (301 s per 1000), every cell with its block and states |
| build-speed (40 oriented blocks, each with its own look and click) | before 26.6 s, after 27.2 s: no change (a block whose states the click chooses is placed one at a time, as before) |
| build-box fill 5 x 3 x 5 cobblestone / its clear | fill: before 55 s (walk 35 s, place 17 s), after 10 s (463 blocks/min); clear: 111 s before, 110 s after (digging is one block at a time, as before); blocksdiff 0 of 75 both |

On the planner alone (flat world, stand-to-stand walking), the castle's two sections took 421 stand moves, 6 437
blocks walked and 86 cells skipped out of reach before "one stand places all it reaches" and the nearest-cell rule,
514, 2 458 and none after; the hall 89, 612 and 20 before, 83, 326 and none after.

## Limits

- No liquids, no entities (paintings, armour stands; item frames are blocks on Bedrock and are
  placed), no block entity data (contents, sign text, a bed's colour, banners, a floor head's
  rotation). The blocks in "Block states" / "Refusals" are refused, each with its reason
  (`water: no liquids`); a structure file builds the rest and lists them.
- States follow "Block states": what a click chooses is placed and verified, what follows the
  neighbours is verified at the end, the rest (power, age, contents) is neither. A block typed by
  name (`fill`, `wall`, ...) has no states: it gets what the click gives, and doors, beds and tall
  plants need a structure file.
- Redstone is placed in order (power sources last) but not checked as a circuit; TNT is refused in a
  build with a power source.
- A door's hinge is arranged with temporary scaffold blocks only where their cells are free; else
  the door takes what its neighbours give (`unmade` in the plan).
- A floor head's rotation and a hanging sign on a chain are not chosen; a head facing down, a hopper
  facing up, vines, glow lichen, coral fans, more than one turtle egg and mushroom sides are refused
  (not measured, or no click gives them).
- Up to 262 144 cells per build (Track B3), in sections of 4096; a build up to 4096 cells whose blocks fit is planned
  at once as before (on the main thread in chunks of 64 cells, yielding between them); a large one's sections in
  the planner worker. The progress box holds at most 8 Mi cells (a 1 MiB bitset).
- A solid fill wider than about 9 in both directions leaves the middle of its upper layers out of reach: a stand is
  never a cell the build fills later, so inside a solid box there is none, the ground stands round it reach about 4
  in, and a column needs a free base within 2 of the cell (`out of reach`). Hollow builds (walls, rooms, towers) and
  floors are not affected (a floor's middle is reached by standing on its edge). The same as before Track B3.
- Scaffold columns are at most `buildColumnMax` high (default 6); a tall build needs it set first. A column needs a
  free base within 2 of the cell and its own headroom; a roof is built from columns beside it, not from its slopes,
  and nothing bridges across a roof or a courtyard (a cell beyond 2 of every free base is `out of reach`).
- Clear and replace use columns too (Track B3), but deep holes are not dug (one-block steps only); a cell below a
  drop the bot could not climb back is skipped.
- A section is planned on the world as it is when it starts; a block someone places in its way while it runs is a
  step that fails (retried twice, then skipped and tried once more in the sweep).
- The stand choice and the next cell go by straight-line distance, not the walk: inside a walled courtyard the
  nearest cell may be on the other side of a wall (the walk goes round, through the gate), which is most of the walk
  time left on the e2e castle.
- The scaffold tool's wear is not in the bill: the tool is fetched when it is worn out (at the next column's foot), so
  the column it wore out on comes down by hand (cobblestone 10 s a block, nothing dropped); a restart that gives the
  items back as new (the e2e) hides wear.
- Shulker boxes in a large build: the build's own blocks in carried boxes are used ("Carried shulker boxes"), and
  boxes in the home chests count as home (raw materials in them are crafted from after `!bring`), but what carried
  boxes hold is not in the bill's crafting pool (logs in a carried box are not made into slabs), no fetch round takes
  a craft's inputs out of a carried box or stows into one, and a large build from boxes alone is not measured
  (decision 0128, "Consequences").
- Resume: a cell done and changed since is left as it is (reported), whatever it is; a resume needs the same file
  (its hash) and the progress file of this server; the last build's record only (a new build replaces it).
- A structure must be reachable on foot around it; the work area's edge is assumed reachable from
  outside, and the navigator decides the real path (a stand it cannot reach costs one goto failure,
  retried twice).
- A support chain longer than 3 blocks or a column higher than `buildColumnMax` is not planned (the cell is
  skipped).
- Java files (Track B2): the readers follow the published layouts and were checked on files the tests
  write, not on files from other tools. Block entity data (chest contents, sign text, banners' patterns,
  heads' owners) and entities are not read. Java blocks with no Bedrock block are unknown (refused or
  skipped). Java states that Bedrock keeps elsewhere or works out itself (stairs `shape`, fence and wall
  connections the game recomputes, `waterlogged`) are mapped where the block has the state and otherwise
  dropped. The mapped states are placed as "Block states" says (Track B1: chosen by the click, verified, the
  families no click gives refused); the e2e house is compared by names, a turned `.schem` with stairs, a log, a
  furnace and a chest by states (build-states).
- The bill (Track B2) knows the smelts of the smelter's table and the grid recipes the server sent; stonecutter
  recipes, smithing and the furnace recipes the server has but the table lacks (smooth sandstone, smooth
  quartz, terracotta from clay blocks, cracked stone bricks, ...) are not used, so such blocks are `cannot get`
  unless carried or at home. The home chests count as the chest memory knows them: a chest emptied by a player
  since the last scan is found out by `!bring` (the next bill has less at home). Dyes, concrete and other
  colour chains are only what the crafter's chain plans (concrete powder needs gravel and sand, which `!get`
  gets; concrete itself needs water).

## Tests

```sh
pnpm --filter bot exec vitest run --project unit build-                  # unit, fakes only (planner, runner, formats, commands)
node scripts/bds.mjs --profile build up && node scripts/bds.mjs --profile build pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e build- --silent=false   # build-box + build-shapes (~6 min)
```

Env: `BUILD_BDS_HOST` (127.0.0.1), `BUILD_BDS_PORT` (19200), `BUILD_BDS_CONTAINER` (bds-build),
`BUILD_VERBOSE=1` (the bot's log). Every run uses its own random 256-block cell from x, z = 36864,
random truth request ids, waypoints and settings in memory (`no-config`) and its own temporary
structure folder; the area is cleared and drops removed at the end.

- `build-box`: `!build materials wall ...` (10 x 4) with an empty inventory (the exact line); a
  5 x 3 x 5 cobblestone box 3 blocks from the bot with exactly 75 cobblestone and 16 dirt (`!build
  materials` says `have everything`, `!build status` while it runs, the done line, truth:blocksdiff 0
  of 75, 0 cobblestone and 16 dirt left); `!build clear` of the same box (blocksdiff 0 against air,
  the cobblestone picked up).
- `build-shapes`: the JSON overhang (one support scaffold, blocksdiff 0 with the scaffold cell air,
  the dirt back); a 7-block pillar (one pillar-up, blocksdiff 0, the bot's highest feet y >= -59,
  at the end on the ground at -60 per truth:pos); the probe structure placed by BDS against the
  reader (0 differences), then the hand-built `gate.mcstructure` built with `!build file gate x y z
  90` (blocksdiff 0 against the rotated reader output).
- `build-java` (Track B2): a 5 x 3 x 5 house (65 blocks: oak log corners, oak planks, 4 stone bricks, 2
  smooth stone, a bricks block, 3 glass, 10 oak stairs, 15 oak slabs) written by the test's own writer as
  `.schem` v3, `.litematic` or `.nbt` (`BUILD_JAVA_FORMAT`), a home with one chest of raw materials only (32 oak
  logs, 8 sand, 48 cobblestone, 8 clay balls) read by `!chests scan`, an empty inventory: `!build materials
  file house ...` (the bill), then `!build file house ... fetch`: the fetch's commands with their times, the done
  line, truth:blocksdiff against the file's Bedrock names (`BUILD_JAVA_OUT` appends each run's line to a file).
- `build-states` (Track B1): two fixtures with every family of "Block states" (68 and 33 cells; one
  inventory does not hold every family's item): stairs, slabs, a double slab, a log, blocks facing
  the player, glazed terracotta, a piston, a dispenser facing down, a barrel facing up, two doors with
  hinge 1 (one beside a wall, one alone) and one open, a bed, a trapdoor, a gate, attached blocks
  on a wall, a hanging lantern, an end rod, dust, a repeater, a comparator, rails, a plate, signs,
  power sources, candles, snow, a sunflower; a chest, an anvil, a bell, a hopper into a block,
  amethyst, a crafter, walls, a lightning rod, petals, pickles, a standing lantern, a grindstone, a
  tripwire hook, hanging signs; built by hand with truth:setblock / truth:door, saved by the server
  (truth:save) and written to `.mcstructure` from the server's own states (truth:blockstates). For
  0, 90 and 180 the server places its saved copy turned (truth:place, so the expected states are
  turned by the game, not by `rotateStates`), the bot builds `!build file` beside it with a kit of
  exactly the items, and truth:blocksdiff compares every cell with the states that matter for it
  (`BUILD_STATES_ROTS` picks the angles). Then a Sponge `.schem` written by the test (Java stairs
  facing east and north, one of them upside down, a log along x, a furnace, a chest) is built turned 90
  and 270 and compared with states written out by hand: a state turned twice or not at all is a
  difference (`BUILD_STATES_JAVA=0` skips it). `build-measure` (`BUILD_MEASURE=1`, not in the gate) is
  the measurement harness the rules came from.
- `build-large` (Track B3, `BUILD_LARGE=1`, about an hour; not in the gate): a castle of 5 801 blocks in 51 x 25 x 41
  written by the test as a Sponge `.schem` v3 (a curtain wall 3 thick and 7 high with glass windows, crenellations and
  a gate; a house 21 x 15 with oak log corners, plank walls 8 high, windows, a doorway and a gable roof of 294 oak
  stairs and a ridge of slabs, its top 16 up; a tower 9 x 9 and 25 high with windows; a staircase of stone brick
  stairs up the wall), five home chests holding exactly its items, 4 oak logs more (the sticks and the table of the
  stone pickaxes made when the iron one wears out) and 192 cobblestone, an iron pickaxe and nothing
  else in the inventory, a world cache (the chest memory on disk, as the CLI keeps it) and `buildColumnMax` 28: `!build file castle x y z fetch`; at a
  quarter `!build stop` (the scaffold comes down) and `!build resume`; at 60 % the bot goes away where it stands and
  comes back as the same player with the same cache and progress file, where it went away and with what it carried
  (the test puts it there and gives the items back, with `buildResume` off until then: this server's offline players
  come back new, at the world spawn and empty-handed), and the build goes on by itself
  (`BUILD_LARGE_AT=column`: the stop at the first moment after a quarter that the bot stands on a scaffold column, the
  restart at the first such moment 400 blocks after the resume, so the stop takes a column down and the resume digs
  the one the restart left, under the bot's feet first); then every
  cell is compared with the states that matter for it and the ground round it is checked for scaffold blocks left
  (`BUILD_LARGE_OUT` appends each run's line to a file).
- `build-hall` (Track B3, `BUILD_HALL=1`): a hall of 734 blocks (24 x 6 x 16: a floor, walls 4 high with log corners,
  windows and a doorway, 48 oak stairs on top) from the inventory, timed; it imports only the structure reader and
  writer from the builder, so it runs on the code before Track B3 too (`BUILD_HALL_LABEL`, the line to
  `.work/b3/hall-<stamp>.txt`). `build-rate` (`BUILD_RATE=1`): the server's place rate (see "Speed").
