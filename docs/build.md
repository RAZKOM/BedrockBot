# `!build`: the builder (wave 9, Track AL)

The bot builds simple structures legitimately, from its own inventory, with the same clicks a player
makes: fill / clear / replace a box, walls, floors, pillars and structure files (`.mcstructure`, a
hand-written JSON layer format, and since Track B2 the Java files people share: Sponge `.schem`, MCEdit
`.schematic`, Litematica `.litematic`, vanilla `.nbt`). PLAN.md 7.17 "builder". Decision records:
[decisions/0033-builder.md](decisions/0033-builder.md), [decisions/0124-block-states.md](decisions/0124-block-states.md)
(block states: orientation, two-cell blocks, attached blocks), [decisions/0125-java-files-and-bill.md](decisions/0125-java-files-and-bill.md)
(Java files, the bill of materials, a fetch that crafts and smelts), [decisions/0128-builder-at-full-size.md](decisions/0128-builder-at-full-size.md)
(large builds in sections, tall builds, resume, speed: "Large builds (Track B3)"), [decisions/0129-builds-from-shulker-boxes.md](decisions/0129-builds-from-shulker-boxes.md)
(a large build fed from shulker boxes: "Shulker boxes (Track B4)"), [decisions/0132-map-art-builds.md](decisions/0132-map-art-builds.md)
(map art on the map grid, sparse files, tiled sections: "Map art (Track B7)"). Placing and digging themselves are
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
| `bot/src/skills/build/mapart.ts` | Track B7: the map grid (`mapCorner`), a map art's layout with its noob line (`mapLayout`), the y over the ground (`mapArtY`, `groundTop`), the kinds whose Bedrock map colour differs (`MAP_COLOUR_DIFFERS`) |
| `bot/src/skills/build/reply.ts` | Track B5: the reply budget (`REPLY_LINES`, `LINE_BYTES`, `FULL_BYTES`), the summaries (`materialsSummary`, `stepsLine`, `cannotLine`, `fitEntries`: `+N more`), the full materials text (`materialsFullDense`), the pages (`pageLines`) |
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
| `bot/test/e2e/castle.ts` | the large-build generator (Track B3's castle with its defaults; smaller forts with options) |
| `bot/src/skills/supply/supply.ts`, `boxes.ts` | Track B4: the boxes as the build's source and store (`contents`, `boxRoom`, `takeMany`, `stowMany`, `outstanding`, `watch`, `adopt`; `BoxState.onChange`) |
| `bot/test/unit/skills/build-b4.test.ts`, `build-supply.test.ts`, `build-bill.test.ts`, `supply.test.ts`, `bot/test/unit/build-commands.test.ts` ("carried shulker boxes") | Track B4: the boxes in the progress file, the job's cells no box goes on, the boxes picked up before a resume builds, the box process; the runner's loads; the bill's pool and box steps; the multi-kind take and stow; the controller's pickup, box steps, stop and resume |
| `bot/test/unit/build-replies.test.ts` | Track B5: the guard: every `!build` reply for a 125-kind fixture with every bill section full within 3 lines of 250 bytes, `!build more` holding all of it, the log and `GET /api/build`, and 8 commands at once through the real chat sender with no line dropped (`B5_PRINT=<file>` writes every reply with its bytes) |
| `bot/test/e2e/build-boxes.test.ts` | Track B4: a 2 348-block fort fed only from 9 shulker boxes (raw materials crafted and smelted), stopped with a box out and resumed (`BUILD_BOXES=1`) |
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
| `!build file <name> map [x z \| x y z] [valley] [skip unknown] [fetch]` | Track B7: a map art on the map grid (`building file art map at 1984 -60 -65 (2x2 maps from 1984 -64, noob line north): ...`): its first map square is the one holding x z (the bot's feet without them), the noob line north of it, and without a y every column's lowest block one above that column's highest block; blocks with another map colour on Bedrock are refused unless `skip unknown`; no rotation; Track B8: `valley` re-heights it to the lowest staircase with the same map and builds it from free stands with hidden supports (see "Map art (Track B7)") |
| `!build materials [<build>] [more [page]]` | `materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)`, or `...; have everything`; without arguments: the running or the last build. Track B1: the blocks the builder refuses follow on the same line (`; 2 refused (water: no liquids; ...)`, see "Block states"), or on a line of their own when the first would pass the chat's length. When something is missing the bill follows (`bill for ...`, `bill: ...`, see "Bill of materials"), then one line per unknown block (`unknown: create:gearbox x 4 (not a Bedrock block)`). Track B5: all that only when it fits in 3 lines; else a summary in 3 (the totals, `most: ...`, the bill's steps) ending `(all: !build more)`; `more [page]` pages through the whole of it ("Replies that fit the chat") |
| `!build more [page]` | Track B5: a page (3 lines) of the full text of the last reply that left something out (`... (page 1 of 9: !build more 2)`); past the end the last page; `build: nothing more to show (...)` when no reply left anything out |
| `!build files [more [page]]` | Track B2: `build files: house (schem, 5x3x5, 65 blocks, 2.1 KB), tower (litematic, 7x20x7, 610 blocks, 4 unknown, 3.0 KB)`: the files of the folders with their format, size, block count, unknown blocks and bytes (at most 40 read; a file that cannot be read with its reason; `too big to build` past 262 144 blocks, 4096 before Track B3); Track B5: past 3 lines `build files: 40 files: ..., +33 more (all: !build more)`, `more [page]` pages through all of them |
| `!build status` | `build: 212 / 640 placed, 3 skipped, eta 4 min` (`(paused)` while pre-empted), `build: idle (last: ...)`; Track B3: a large build adds its section (`, section 2 of 3`), a fetch round its step (`build: fetching materials for ... (round 4): step 2, !bring ...; 1710 / 5801 placed, ...`) |
| `!build stop` | `stopped build fill 5x3x5 cobblestone: 40 / 75 placed, 0 skipped`; `build: nothing to stop`; Track B3: with scaffold blocks out (the bot on a column) `...; taking 9 scaffold blocks down`: they come down in a process of their own; Track B4: with a shulker box set down `...; picking up 1 shulker box` (also after the scaffold) |
| `!build resume` | Track B3: `resuming build file castle at 36967 -60 38508: 1474 of 5801 done`, then as a new build; the cells done before are checked against the world first (`; 3 changed since, 2 air again (placed again), 1 another block (left): x y z stone`), scaffold blocks a restart left are dug first (`; 14 scaffold blocks left from before (dug first)`), Track B4: shulker boxes the progress names are picked up before anything is built (`; 1 shulker box left out (picked up first)`); `build: nothing to resume`, `build: ... is done (nothing to resume)`, `build: cannot resume ...: castle.schem changed since it started` |

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
- **Step** (Track B9): a target with no reachable stand and no column (the middle of a floor's second layer, its top
  two over the ground) gets one scaffold block on the ground beside a reachable stand, from whose top the floor is one
  step up; dug at the end of its layer like a support ("What a fetch round gathers").
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
   shulker boxes (the runner takes them out itself, Track BJ; Track B4: everything they hold is in the pool the
   making draws on too, see "Shulker boxes"), then the **home chests** as the chest memory
   knows them (`!chests scan`, docs/home.md; loose items and what the boxes in them hold).
2. **Make**: what is still short is planned at once by the crafter's own chain (`skills/craft/chain.ts`, the
   recipes the server sent at login: docs/crafting.md) on one pool, what is left in the inventory, in the carried
   boxes (Track B4) and at home,
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
`|`, `;` or `,`). Track B5: when that is more than 3 lines a summary is said instead and the whole is kept for
`!build more` ("Replies that fit the chat"). The cannot step names the reason once for all the items it covers
(`cannot get 2297 smooth_quartz, 364 moss_block (no recipe and !get does not know it)`). The e2e house with its raw
materials in a home chest, in full (5 lines: the chat gets the summary in the next section, then 2 pages):

```
materials for file house at 100 -60 20: 22 oak_planks, 15 oak_slab, 10 oak_stairs, 8 oak_log, 4 stone_bricks, 3 glass, 2 smooth_stone, 1 brick_block; need ...
bill for file house at 100 -60 20: oak_planks 22: have none; craft 22 from 6 oak_log | oak_slab 15: have none; craft 15 from 9 oak_planks | oak_stairs 10: have none; craft 10 from 18 oak_planks |
oak_log 8: have 8 at home | stone_bricks 4: have none; craft 4 from 4 stone | glass 3: have none; smelt 3 from 3 sand | ...
bill: from home: 24 oak_log, 3 sand, 30 cobblestone, 4 clay_ball; craft first 1 crafting_table; a furnace (8 cobblestone); smelt 6 cobblestone -> stone, 3 sand -> glass, 2 stone -> smooth_stone, 4 clay_ball -> brick; fuel 3 oak_planks,
8 oak_planks (from 2 oak_log)
```

## Replies that fit the chat (Track B5, decision [0130](decisions/0130-build-replies-that-fit.md))

The chat sends at most 8 replies in 10 s and keeps 16 lines waiting for 60 s; past that a line is dropped
([chat-style.md](chat-style.md) "The reply queue"). Two lines of 250 bytes never join on the wire (the join limit is
480 bytes), so each takes a slot. A build file of 125 kinds made `!build materials` say 67 lines, and all were dropped.

**The budget**: a `!build` reply is at most **3 lines of at most 250 bytes** (`REPLY_LINES`, `LINE_BYTES` in
`skills/build/reply.ts`; bytes, not characters). 3 lines leave 5 of the 8 slots for everything else, and 8 build
commands typed at once (24 lines) still fit the 8 sent and the 16 waiting. An end line over 250 bytes goes on in a
second line; the fetch's first reply has 2 (the line about the boxes picked up may come before it).

**Whole when it fits.** A reply whose whole text wraps into 3 lines is said as it is (a small build's materials and
bill, the e2e strings). Otherwise a summary is said and the full text kept:

| Reply | Summary |
|---|---|
| `!build materials`, a build refused for its blocks | the totals (`9573 blocks, 125 kinds: 127 have (30 at home), 3273 to make or !get, 6173 cannot get (smooth_quartz 2297, ..., +103 more)`), the biggest items (`most: smooth_quartz 2297, stone_bricks 900, ..., +110 more`), the bill's steps (each step in full, else its biggest entry and `+N more`, else `N kinds`, whatever fits) with the refused and unknown counts; the refusal ends `(add fetch to get, craft and smelt them first; all: !build more)` |
| a fetch refused for what cannot be got | `build: nothing fetched: cannot get 6173 blocks of 108 kinds (no recipe and !get does not know it): 2297 smooth_quartz, ..., +101 more`, then the totals |
| the fetch's first reply | its steps, each as above |
| `!build files` | the files that fit, `+N more` |
| the plan line, the end line, `!build status`, `!build stop`, `!build resume` | the lists cut with `+N more` (`fire bedrock kelp +2 more: not placeable by the builder; +2 more reasons`); a line that still does not fit is cut in the third line with `... (+N more lines: !build more)` |

Every list that leaves something out says `+N more`, and every summary ends with `(all: !build more)`. The e2e house
(65 blocks, 8 kinds, its raw materials at home):

```
materials for file house at 100 -60 20: 65 blocks, 8 kinds: 8 have (8 at home), 57 to make or !get
most: oak_planks 22, oak_slab 15, oak_stairs 10, oak_log 8, stone_bricks 4, glass 3, smooth_stone 2, brick_block 1
bill: from home: 30 cobblestone, +3 more; craft first 1 crafting_table; a furnace (8 cobblestone); smelt 6 cobblestone -> stone, +3 more; fuel 8 oak_planks (from 2 oak_log), +1 more (all: !build more)
```

**The full text** of the last reply of each topic (materials, refused, fetch, files, plan, status, end, stop, resume)
is kept by the controller, wrapped at 210 bytes (`FULL_BYTES`: room for the page note), at most 400 lines. It goes:

- to the chat by `!build more [page]`, 3 lines a page (`... (page 1 of 9: !build more 2)`; the last page ends `(page 9
  of 9)`), the last topic kept; `!build materials <build> more [page]` and `!build files more [page]` keep and page
  through those directly;
- to the log once, as INFO lines: `build: materials for file house at ...: the full text, 27 lines (!build more pages
  through it)`, then `build: [1/27] ...`; the same text kept again is not logged again;
- to the panel: `GET /api/build` answers `{ "texts": [{ "topic", "title", "lines", "at" }] }`, the newest first
  ([panel.md](panel.md); no card shows them yet).

In the full materials text each fact is said once: the totals and notes, the refused blocks with their reasons, the
bill's entries without those nothing has or makes (the cannot step names them), the bill's steps, the unknown blocks
grouped by reason. For the 125-kind file that is 27 lines (9 pages) instead of 67.

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

Track B4: with carried shulker boxes the boxes handed over are picked up first, and a take out of the boxes comes
before each craft, the furnace, the fuel and each smelt whose materials are in them, a stow into them when the
inventory runs short of room ("Shulker boxes").

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
  its place kept; the controller runs a fetch round for the next stretch (what the running section has left that fits
  in the free slots, less a margin of 4, and the boxes' room; Track B9: never the sections after it, "What a fetch
  round gathers"; the bill's `!bring ... home`, `!get`, `!craft`, `!smelt` as in "Fetch"), then the bot walks back near its next
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

## Shulker boxes (Track B4, decision [0129](decisions/0129-builds-from-shulker-boxes.md))

A build can be fed from shulker boxes alone: boxes of the build's blocks, or of what they are made from (logs, sand,
cobblestone), and `!build ... fetch` crafts and smelts what the build places out of what the boxes hold, as it does from
the home chests. The box work is the task's `Supply` (docs/home.md "Supply"), under the home logistics' lock.

- **Boxes handed over.** `!build ... fetch` first picks up the shulker boxes lying within 8 blocks of the bot
  (`HANDED_RADIUS`; the owner dropped them for the build) and says `build: picked up 8 shulker boxes lying near me (8
  carried now)`; with none lying there it says nothing. A box put in a home chest is home once the chest is read
  (`!chests scan`): the bill counts what it holds, and `!bring` brings the box itself (the home's own rule, docs/home.md
  "bring"), which is a carried box from then on: the materials come out of it on site.
- **One pool.** The bill counts the usable inventory, then everything the usable carried boxes hold (not the
  fireworks box; `bot_loot` boxes do), then the home chests, as one pool: the crafting chain makes planks, stairs and
  slabs from logs in a box as from logs carried, and the smelts take sand out of a box as out of the inventory. What
  the making takes out of the boxes is the bill's first step (`bill: from my boxes: 236 oak_log, 26 cobblestone; craft
  first ...`). A throwaway kind taken out of a box (the furnace's cobblestone) takes what the reserve lacks with it.
  Only what the crafter was given can be used up: an item it keeps (a shulker box or a tool in a home chest) stays in
  the pool (before, it counted as used and the fetch brought the box home: `!bring orange_shulker_box 1 home`).
- **The fetch's box steps.** Besides `!bring`, `!get`, `!craft`, `!furnace` and `!smelt`, a step of the fetch (and of
  a fetch round) can be `take out of my boxes: 64 oak_log, 4 sand` or `stow into my boxes: oak_stairs, oak_planks`:
  - a take brings what the next craft (its inputs), the furnace (8 cobblestone), the fuel or the next smelt (at most
    64) needs, before that command;
  - a craft whose inputs come out of the boxes is cut to what the inventory holds with 3 slots kept free (its inputs
    and every step's output, in stacks: 36 stairs need 54 planks from 14 logs, 4 slots), so the crafter never runs
    out of room mid-craft (where it would drop the grid); the rest comes in the next take and craft;
  - with fewer than 8 slots free the build items the fetch has finished go into the boxes first (never a throwaway
    kind, a craft's or a smelt's input or the fuel), so what a round made and the inventory cannot hold goes back
    into a box;
  - each box step is a user process of its own (`build-boxes`: it pre-empts the fetch's process, which gets control
    back after it), says one log line (`build: fetch for ...: took 64 oak_log out of 1 box`), and when pre-empted
    runs again for what is left. `!build status` names it (`step 3, take out of my boxes: ...`).
- **A round's fit counts box room.** A fetch round brings what fits in the free slots plus the free slots of the
  carried boxes (the log says both), so what the round makes beyond the inventory can be stowed. Track B9: what is
  had already (carried or boxed) costs no slot, and the slots a park would free count as free.
- **The runner loads the stretch ahead.** On the ground, at a section's start and after each fetch round, the runner
  takes out of the boxes in one go (`Supply.takeMany`: each box holding any of it set down once, the one holding the
  most first) what the next steps place, as far as it fits in the free slots less 4 (and the throwaway reserve's
  share of a throwaway kind); when the take needs more room than there is, the loose build items that stretch does
  not use go into a box first (`Supply.stowMany`). Before a column the column's blocks are loaded the same way. Out
  of a block later it refills as before ("Carried shulker boxes" in "Materials").
- **Where a box goes.** On a free cell beside the bot (no block, no liquid, the cell above it free, a full block under
  it: never over a drop), never on a cell of the build (every section's, done or not; a clear's or replace's whole
  box), on a cell of a scaffold column or a planned stand of the running section, or under one of them. With no such
  cell beside the bot (beside a wall, among stands) it walks to the nearest stand within 6 that has one and tries once
  more; Track B9: with none within 6 (deep inside a wide build, every cell round the bot a cell of a later layer), the
  nearest within 32 sideways and 12 below, and a fetch round's box step goes `LAND_MARGIN` outside the build's box
  ("What a fetch round gathers").
- **No box left in the world.** The progress file records every box set down and not yet picked up (`boxes`: standing,
  or broken and lying on the ground), saved before the box's place request goes. `!build stop`, a stopped fetch and a
  build's end pick the boxes up in a process of their own once the work has wound down (`stopped build ...: 612 / 2348
  placed, 0 skipped; picking up 1 shulker box`). A resume (`!build resume`, or by itself after a restart) adopts the
  boxes the file names and picks them up before it builds anything (`resuming build ...: 612 of 2348 done; 1 shulker
  box left out (picked up first)`); a recovery still waiting when the resume comes gives way to it. A box not found
  where it was left (a player took it) is given up with a line in chat, as before (docs/home.md). Empty boxes are
  kept, never dropped.

## Map art (Track B7, decision [0132](decisions/0132-map-art-builds.md))

A map art is a structure file meant to be seen on a held map: a picture of blocks laid one per column over whole
128 x 128 map squares, often staircased (each block up, level or down from the one north of it, for the map's three
shades), with one extra row on the north side (the **noob line**: the blocks the first row's shading is measured
against). A Java Litematica map art of 2 x 2 maps is one region of 256 x 145 x 257: 9.5 M cells, 65 792 blocks.

### Reading it

| Limit | Value | Why |
|---|---|---|
| `.litematic` region box (`MAX_SPARSE_VOLUME`) | 16 Mi cells (dense formats: 4 Mi) | a map art's box is mostly air: 2 x 2 maps at 145 high are 9.5 M cells |
| unpacked NBT of a `.litematic` (`MAX_SPARSE_NBT_BYTES`) | 16 MiB (others: 64 MB) | the memory guard: the parsed NBT costs about 9 bytes of heap a byte (the map art's 6 MB of longs: 55 MB); 16 MiB stays under about 150 MB |
| blocks read (`MAX_READ_BLOCKS`) | 524 288 (twice a build's 262 144) | counted before any block is kept: a file a little over the build limit is still listed with its count |
| progress box (`PROGRESS_MAX_CELLS`) | 16 Mi cells, the bitset deflated in the file past 64 KiB | the map art's box is a 1.2 MB bitset (9.5 M cells), mostly zeros: deflated, the file stays small |

The cells are read from the packed longs as 32-bit words (no BigInt a cell). Measured on the PC (node 24): the map art
read in 172 ms, a peak of 77 MB of heap, 11 MB kept.

### Sections

A build whose footprint is wider than a section, more than 3 layers high and at most 2 cells a column on average is
**sparse**: its sections are tiles of 32 x 32 columns at every height (`TILE_SIDE`), in rows back and forth from the
corner nearest the bot (the next tile beside the last), each low to high; the sweep the same way. Bands of whole
layers (the dense rule) spread one section over the whole footprint: minutes of planning each and the bot walking end
to end. A tile plans in 1 to 25 s in the planner worker.

A block with nothing beside it to click against (a staircase block high over open ground) is placed from a scaffold
column next to it: from the column top a scaffold block is set beside the cell, the cell placed against it, that block
dug again, then the column. Columns are at most `buildColumnMax` high (32 at most): a map art needs it set high
(`!set buildColumnMax 32`). Blocks higher than a column reaches are skipped (`no support`): the builder does not stand
on the art's own staircase (the drops beside it are deeper than 3), and it does not flatten the art or change its
blocks. A layer's cells out of reach are retried at most 8 rounds (`LATER_ROUNDS`).

### The map grid

`!build file <name> map [x z | x y z] [valley] [skip unknown] [fetch]` puts the file's first (north-west) map square on the
game's map square holding x z, or the bot's feet. A scale-0 map covers x and z from 128 k - 64 to 128 k + 63, centred
on 128 k: Java's grid, and measured the same on Bedrock (BDS 1.26.65.1: maps made with an empty map at six places, on
both sides of a square's edge and at negative coordinates, came back with their origin at 128 k). A file one row
longer than whole maps (`size.z % 128 == 1`) has the noob line, and it goes just north of the first map row. Without
a y, every column's lowest block goes one above that column's highest block that is not air (water counts; since
Track B8 plants and tree parts do not: a plant is built over, a tree is refused, see "Valley"); every column of the art must be loaded, or the reply says how many are not (`map: the ground of 16
of 65792 columns is not loaded (stand nearer the art's middle, or give x y z)`): standing at the art's middle of 2 x 2
maps, 16 of its 65 792 columns were out of sight on the test server. The reply names the corner and the maps:
`building file art map at 1984 -60 -65 (2x2 maps from 1984 -64, noob line north): 65792 to place in 72 sections`. The
progress keeps the chosen corner and y: a resume does not read the ground again (the art stands on it). No rotation.

### Bedrock map colours

Measured on BDS 1.26.65.1 (e2e build-mapart): 98 kinds set on flat ground level with the block north of it, 1 and 3
higher and 1 and 3 lower, read from a map's pixels. Bedrock shades like Java: the base colour x 220/255 when level,
x 255/255 when higher and x 180/255 when lower (steps of 1 and 3; Track B8 found that a step of 1 shades at only one
parity of x + z: see "Valley"). Every map art palette block measured shows Java's
colour (the wools, terracottas, concretes, planks, stone, deepslate, diorite, clay, dirt, sandstone, iron and raw iron
blocks, mushroom stem, verdant froglight, ...), except:

| Block | Java map colour (higher) | Bedrock (higher) | Candidates (not substituted) |
|---|---|---|---|
| `grass_block` | 127,178,56 | biome tinted (145,188,88 in plains) | `slime` (127,178,56 on Bedrock) |
| `oak_leaves`, `spruce_leaves`, `birch_leaves` (and the other leaves) | 0,124,0 | biome tinted (63,92,24 / 52,82,52 / 69,90,46 in plains) | none measured |
| `purple_concrete`, `mycelium`, `amethyst_block` (and the purple wool, carpet, concrete powder, shulker box, budding amethyst) | 127,63,178 | 153,90,205 | none measured; the nearest: `magenta_concrete`, `purpur_block` (178,76,216) |

With `map` these are refused like unknown blocks (`art: 2 blocks have no Bedrock block or map colour: purple_concrete
x 2 (another map colour: Bedrock's purple is lighter)`); `skip unknown` builds without them. Blocks with no Bedrock
block at all are the Java reader's unknown blocks ("Unknown blocks"). Dirt next to grass turns into grass on a random
tick (a map art's dirt beside the ground's grass may change colour).

### Far away

A map art far from home (say 10 000 blocks) is reached by a trip (flight or teleport) that is Track B6's; the build
itself fetches from the carried shulker boxes (Track B4) and goes home only for what they lack: with boxes holding the
whole bill it never walks home.

Blocks that fall (sand, red sand, gravel, concrete powder, anvils, `GRAVITY_RE`) are placed only on a block that stays
(bottom up, as every build is): one over air or over a scaffold block is skipped (`it falls (nothing under it)`). Before
Track B7 the planner could place one against a side neighbour (a support chain's last block), where it would fall. A staircased map art of sand or concrete powder
is therefore mostly skipped (each block needs a permanent block under it, which the file does not have); the map art
measured has no falling blocks.

### Valley (Track B8, decision [0133](decisions/0133-valley-map-art.md))

`!build file <name> map [x z | x y z] valley [skip unknown] [fetch]` builds the same map from a much lower staircase.
**Shading on Bedrock.** Both games shade a pixel by e = dy x 4/5 + ((x + z) & 1 - 0.5) x 0.4, dy the block's height over
the block north of it: higher when e > 0.6, lower when e < -0.6, else level. A step of 1 lands exactly on 0.6 at one
parity; Java's doubles come out a hair over it (every step of 1 shows), Bedrock's do not. Measured (BDS 1.26.60.6, e2e
build-mapart with `BUILD_MAPART_SHADE=1`: stone over flat grass, 24 pixels a case, both parities):

| Step | x + z even | x + z odd |
|---|---|---|
| +2, +3 | higher | higher |
| +1 | **level** | higher |
| 0 | level | level |
| -1 | lower | **level** |
| -2, -3 | lower | lower |

So a Java map art built as it is shows the wrong shade on a Bedrock map wherever a step of 1 falls on the wrong
parity: 22 083 of the 65 536 pixels of the 2 x 2 map art (34 %). `stepShade` (mapart.ts) is the rule.

**The re-height.** A pixel's shade depends only on its step to the block north of it, so each north-south strip (one x)
is re-heighted on its own to the least heights whose Bedrock shades are the ones the file means (the sign of its steps):
a rise or a drop of 1 where the parity shows it and 2 where it does not, and a level step either the same height or a
step of 1 the map shows level (up at an even x + z, down at an odd one). A backward pass gives every block the least
height the steps after it need, a forward pass sets each block to the least its step from the block before allows;
every block is then as low as it can be (lowering any one changes a pixel). Every strip's lowest block is at 0 (over
the corner's y), and the strips no longer stand on each other (Litematica's staircases lift whole strips for the
east-west steps; those shade nothing). The parity is the world's (`x + z` of the column; a map square starts at an even
coordinate, so the pixel's is the same). The art keeps every block and colour, and every pixel shows the shade the file
means; a file with two blocks in a column is refused.

| | The 2 x 2 map art (65 792 blocks) |
|---|---|
| height of the art | 145 before, 106 after (77 if every step of 1 shaded, as on Java) |
| a strip's height after | 17 at least, 43 at the median, 61 at p90, 106 at most |
| pixels (the file read as Java means it, the build as a Bedrock map shows it) | 65 536: 0 differ for the re-heighted art, 0 for the build's own cells (supports in); 22 083 for the file built as it is |

**Supports.** A block with nothing to click against when its turn comes gets cobblestone (`MAP_SUPPORT`) under it,
never seen: a support is always under an art block of its own column, so it is never a column's top and the map does
not see it. They are found a tile (32 x 32 columns, the sections') at a time, so any order of tiles works: within a
tile every layer's group of side-by-side cells needs one anchor (a block or a build cell under one of its cells, a block
already in the cell or beside it); a group without one gets the shortest chain down under one cell, to a cell that has a
block or a build cell beside it or under it. The world's blocks count (read when the command is given); a resume reads
them again, and the supports already placed are blocks by then; where the world is not loaded the ground is taken just
under the art's lowest block (the same supports wherever the bot stands). The 2 x 2 map art re-heighted: 52 940
supports (0.80 a block: the steps of 2 and the level steps of 1 leave fewer side-by-side neighbours), cobblestone in
the bill like any other block (from boxes or home).

**Free stands.** A valley spec is planned free (`PlanOptions.free`): a stand places every ready cell it reaches at any
height (not the 3 x 3 cells at or above the feet), not only the current layer's, the cover of a stand counts all of
them, and when the stand has nothing left the next is the nearest ready cell of any later layer. Its scaffold columns
go as high as the art needs (`BuildSpec.column`: the art's height less 3, at most `MAP_COLUMN_MAX` 128), over
`buildColumnMax` when that is lower: with columns of 32 a valley art's blocks more than about 37 over the ground are
out of reach (6.5 % of the first three tiles of the art measured). A fall from 32 already kills, so the taller column
adds no new risk; the column rules of "Height" hold. Measured offline (the whole re-heighted art and its supports
planned tile by tile on a flat world, the sweep in, columns up to 103): all 65 792 art blocks placed, 119 461 cells,
103 639 blocks walked, 10 457 stand moves (11 cells a move), 3 523 columns of 74 982 scaffold blocks (0.63 a cell);
105 s of planning. On the earlier (Java-shade) valley, free stands walked 63 971 blocks in 9 316 moves for 93 657
cells against 141 637 in 20 956 layer by layer.

**Ground.** Without a y the corner goes one above the highest ground under any column (water counts, plants and tree
parts do not): the reply names the range (`y 71 over ground 68..70`). A plant in a cell of the art is replaced by the
block; anything else in a cell of the art or over it (a tree's leaves, terrain) is refused with the count, the kinds and
the first cells (`map: 12 blocks stand in or over the art (8 oak_leaves, 4 oak_log; ...): clear them first or give a
higher y`). The reply's plan line says what was chosen: `building file art map valley at X Y Z (2x2 maps from X Z,
noob line north): N to place in S sections; valley 106 high (a strip 43 at the median), was 145; y Y over ground A..B;
52940 cobblestone supports under blocks with nothing to click`.

**No scaffold left.** At the end of a valley build (the sections and the sweep done) the scaffold blocks the progress
still has in the world (a section that could not reach them to dig) are dug by sections of their own, once.

### Measured (Track B8, e2e build-mapart `BUILD_MAPART_VALLEY=1`, 2026-11-23, BDS 1.26.60.6, flat, peaceful)

The 2 x 2 map art above, `!build file <art> map <x> <z> valley fetch` (then with the flat ground's y: from the corner
the bot does not see every column) at a map square about 50 000 out, the bot starting 40 in from the north-west corner,
`buildColumnMax` 32 (the valley's columns go higher), 4 shulker boxes handed over (the first 6 144 cells' blocks) and
66 boxes in three home chests south of the art (the rest of the exact bill, the cobblestone supports in it); one loop
of 15 minutes:

| What | Measured |
|---|---|
| the plan line | `... valley 106 high (a strip 43 at the median), was 145; 52940 cobblestone supports under blocks with nothing to click`: 118 732 cells in 72 sections |
| stop and resume | stopped at 250 s with 562 placed, resumed at once (`562 of 118732 done`) |
| the loop | 870 cells in 739 s of building: 435 art blocks and 426 supports; 4 239 cells an hour, **2 119 art blocks an hour**; 0 skipped |
| blocksdiff | 0 of 861 placed cells (art and supports) |
| the map | a map made over the built part: 403 art pixels compared, 403 with the file's colour and the shade it means, 0 other |
| where the time went | the low part first (562 cells in 250 s: walk 120 s, place 67 s, pillar 27 s); then higher cells from columns of up to 50 (308 in 490 s: pillar 212 s, walk 172 s, place 37 s) |
| projected | 31 h for the 65 792 art blocks at the loop's rate; the offline plan's 74 982 column blocks (about 1.47 s each up and down, Track B3) make the higher tiles slower: about 40 h for the whole art |

Run before the parity rule (each step of 1 as Java shades it), the same map compare found 39 of 123 pixels level where
a step of 1 up stood at an even x + z: the measurement of "Shading on Bedrock" followed from it. Without the taller
columns 701 of the first tile's 1 953 cells were skipped (`no support`).

### Measured (Track B7, e2e build-mapart, 2026-11-23, BDS 1.26.65.1, flat, peaceful)

The 2 x 2 map art above (27 kinds, no unknown or refused blocks), `!build file <art> map <x> <z> fetch` at a map square
about 50 000 out, the bot standing at the art's middle, `buildColumnMax` 32, an iron pickaxe and 4 stacks of
cobblestone carried, 5 shulker boxes handed over (the first 6 144 cells' blocks) and 36 boxes in two home chests 6
south of the art (the rest of the exact bill):

| What | Measured |
|---|---|
| the map grid | maps made at x z 41000 41000, 41063 41100, 41064 40935, 41023 41023, 41024 41024 and -300 -700: origins 40960 40960, 41088 41088, 41088 40960, 40960 40960, 41088 41088 and -256 -640 (scale 0): squares 128 k - 64 .. 128 k + 63 |
| the y | without one: `the ground of 16 of 65792 columns is not loaded` from the middle; with the flat ground's y the corner and y as chosen (`map at X -60 Z-1 (2x2 maps from X Z, noob line north)`) |
| start | 3 to 5 s from the command (the 5 boxes picked up, the job of 72 sections: 8 of the noob line's 32 cells, 64 tiles of 1 024) |
| one 15-min loop | 720 s, stopped and resumed at 243 s (resumed 14 s after the stop: `13 of 65792 done`): 42 placed, 3 489 skipped (the first tiles stand up to 144 high), blocksdiff 0 of 42; 214 blocks an hour (the run before, without the resume's bill fix: 347 an hour over 56) |
| where the time went | pillars 236 s, walking 43 s, placing 19 s, digging 13 s, the boxes 11 s, a fetch round 14 s (a worn pickaxe) in the second part; a tile of 1 024 cells plans in 20 s (594 to do, 8 645 scaffold blocks) |
| the whole art, planned offline (flat, columns of 32) | 38 367 of 65 792 placed (58 %), 27 391 `no support` (too high for a column of 32), 34 out of reach, 261 support scaffolds left out of reach; 11 275 columns, 219 821 scaffold blocks; 765 s of planning |
| projected | at 214 blocks an hour, about 180 hours for the 38 367 the planner reaches |

Every block high over the ground costs a scaffold column of its height, placed and dug: about 8 s a block. Map art
needs another way of standing (on the art's own rows, or a flattened file) to be practical.

### Still missing

- Standing on the art: the staircase is 1 wide with drops deeper than 3 beside it, which the stand rules refuse. Since
  Track B8 a `valley` build reaches every block from columns as high as the art needs; the columns are its main cost
  (0.63 column blocks a cell in the offline plan). Without `valley` blocks over a column's reach are still skipped.
- Bridging along a row instead of columns: not planned.
- Falling blocks over air (a sand map art) are skipped, not supported from below.
- The trip to a far map art (flight, teleport) and the chores on the way: Track B6.
- Support scaffolds a section cannot dig again (`scaffold left (out of reach)`) stay in the world in a build without
  `valley` (261 in the B7 plan of this art); a `valley` build digs them at its end.
- The whole art built end to end (about 40 hours) has not been run: the loop measured its first tile.

## Trips, chores and a full inventory (Track B6, decision [0131](decisions/0131-fetch-builds-that-run-by-themselves.md))

A `!build ... fetch` runs by itself at a site far from home: its trips go the way `!goto` goes, the home chores wait
until it is over, and a full inventory makes room in the carried boxes instead of undoing the step before.

- **Trips home and back.** A fetch step done at home (`!bring ... home`, `!furnace`, `!smelt`) from farther than
  `flyMin` first travels home, and after the fetch (or a fetch round, or the boxes picked up after a stop) the trip
  back to the build is taken the same way. A trip farther than `flyMin` goes through the walk `!goto` uses: flown when
  `autoFly` is on and the flight kit is ready, walked otherwise (docs/flight.md). The trip back aims at a point
  `LAND_MARGIN` (4) blocks outside the build's box on the side the bot comes from, on the ground the world model has
  there. It never aims at a build cell, a scaffold column or a stand; the last few blocks are walked. Each such trip
  says one log line: `build: trip home for !bring stone_bricks 70 home: 104 blocks: flew in 8 s to ..., there; 0
  blocks from the goal`, or `walked (no flight: autoFly is off)` and the like. Shorter trips walk as before.
- **No chore during a build.** From the command (or a resume) to the end of the build, its fetch and the box pickup
  after it, a process `build-hold` stands in the process list. It is a user process ranked just over the chores and
  under every command, and does nothing. The chores (the home unload, mend, rockets, food, the room chore, ...) start
  only with no user process at all. Before, they took the body in the gaps between the build's own processes: at a
  fetch round's start, after the plan, at a step's end. The unload then put a carried full box and what was just
  brought back into the chests. `!stop` and `!build stop` end the hold with the rest. `!status` shows it as `build ...:
  between steps (the home chores wait)`.
- **A take's room keeps the build's items.** A take from the home chests with a full inventory makes room by
  unloading loot first (docs/home.md "Room for a take"). While a build's fetch runs, everything its current bill (the
  fetch's, or a large build's round's) needs, brings, makes or makes from (inputs, fuel) is protected: the room is made
  from other items, build items the round does not use among them, or the take says why there is none. (Protecting
  every item of the plan stopped a large build's round of planks: its last stack found no room beside the glass and
  stairs left from the round before.) Before, `!bring iron_ingot 95 home` unloaded the 64 clay balls the step before had
  brought, and the next step brought them again.
- **What cannot be got reads the chests again once.** When the bill would say `cannot get` and the home chests are in
  reach, they are read again (forced, every chest) once before the reply. A chest changed since it was read (by a
  player, a hopper, a console command) is seen then. `!chests scan` reads every chest as well (it skipped those read
  in the last 10 minutes). An empty dyed shulker box in a home chest is that item (`red_shulker_box`) for the bill and
  for `!bring`.
- **A full inventory.** A fetch never brings more loose than fits beside what the next craft or smelt needs:
  - before a take that does not fit, the finished build items go into the carried boxes (as below 8 free slots), then
    the inputs that wait for their craft or smelt (the craft takes them out again a chunk at a time). The take's own
    item stays, and so do shulker boxes (a box does not go into a box);
  - when nothing could be stowed, the take is cut to what fits with one slot kept free;
  - a box the build places (its own `red_shulker_box`) is never stow room: it stays empty for its cell;
  - a stow that moved nothing is not asked again on that free-slot count, and a take that changed nothing on a full
    inventory stops the fetch with `my inventory is full (0 free slots): !bring oak_log 64 home needs room (give me an
    empty shulker box or take some items)`, not `changed nothing` and not a trip home;
  - a box step (a take or a stow) that changed nothing never sends the bot home: the boxes are the same there.
- **`fetch skip missing`.** `!build ... fetch skip missing` builds without what the bill cannot get. The cells of
  those items (the highest first, as many as the shortfall) are refused like the builder's own refusals: in the plan
  line (`2 refused (end_stone: cannot get it (skip missing))`) and as skipped in the status and the end line. The rest
  is fetched and built. Without it the build is refused with the bill's reason, as before. Without `fetch` it is an
  error (`skip missing goes with fetch`).

## What a fetch round gathers (Track B9, decision [0134](decisions/0134-fetch-rounds-that-fit.md))

A large build handed over in shulker boxes, with the bot's kit, empty boxes, the boxes the build places and raw
materials to make the rest, fills all 36 slots before the first block. A round has to make room before it can craft,
and has to gather no more than the next blocks need.

- **The running section only.** A round gathers what the running section has left to place, as far as it fits in the
  free slots (less 4) and the carried boxes' free slots; the sections after it get rounds of their own, at their start.
  What is had of an item, carried or in a box, costs no slot (it is there already). Before, a round took the next
  sections too while they fitted: it crafted their planks, slabs and stairs hours ahead, four slots of planks for each
  slot of logs, and the boxes' room went to blocks placed much later. A round costs only its steps when its materials
  are boxed (no trip); at a far site each round that needs the home chests is a trip home ("Trips, chores and a full
  inventory").
- **Park what the round does not use.** With fewer than 8 free slots and free slots in the read home chests, the
  round's first step is `park at home: tuff, quartz, red_shulker_box, ...`: every loose stack of the kinds the round's
  bill does not use goes into the home chests (the nearest read chest with room first, never a shulker box block, each
  chest read again). Never parked: what the bill uses (its blocks, what it brings, takes out, crafts, smelts, burns or
  gets), what its crafts use of what is carried (the craft chain's inputs: the logs for its planks), the crafting
  table while a craft or a furnace still to make needs one, the furnace while a smelt does, the kit (anything that
  does not stack but a shulker box, food, rockets), the throwaway reserve (the scaffold), and the carried boxes; of
  the boxes the build places, an empty one is parked until its section. A park asked again with the same inventory
  (parked, then brought back) is skipped, never a stop (e2e build-far: the logs parked and brought back, then the
  table parked and the stairs or the furnace not made, before these rules). The bill counts the
  home chests, loose and in boxes, so a later round brings what it needs back (`!bring red_shulker_box 6 home`). A
  far home is travelled to first, as for a take. A park is a box-work process of its own like a take or a stow,
  says one log line (`build: fetch for ...: parked 16 tuff, 6 red_shulker_box at home`), and is not asked again on a
  free-slot count where it moved nothing. The round's line counts the parks (`(1 parking 180 at home)`), and the
  round's fit counts the slots a park would free.
- **A box deep inside a wide build.** A box never goes on a cell of the build, and on the lower layers of a wide build
  every cell round the bot is one. The runner then looks for a stand with a free cell beside it within 32 blocks
  sideways and 12 below (after the usual 6), walks there and takes out what it needs; a fetch round's take or stow
  that finds no cell goes to the point `LAND_MARGIN` outside the build's box nearest the bot, or on out from it (at
  most 8 more, `BOX_OFF_MORE`) to the first stand that is no planned stand and has a free cell beside it (the stands
  of a wall's cells lie up to 4 outside the box), walks to within 1 of it and tries once more. Before, the refill
  failed, the round found nothing to fetch (the boxes held it) and the build stopped `out of
  light_blue_glazed_terracotta` at 678 of 9 406; with the walk to the margin alone the take found the planned stands
  all round the bot there and stopped `take out of my boxes: ... nothing moved` at 2 126.
- **A step up onto a raised floor.** The planner's walks step one block up or down. A floor two blocks thick laid on
  the ground has its top two over the ground, and while its second layer goes down every cell over its first is a
  cell of the build (no stand): placed from the ground round it, the second layer's middle was out of reach (the
  house's 46 x 51 ground floor: 1 292 of its 2 128 cells, and 1 583 more over them for want of support; 2 875 of the
  second section's 4 055 cells skipped, and the sweep placed none of them). A cell that has no stand and no column now
  gets a step: one scaffold block on the ground beside a reachable stand, from whose top a stand one higher that no
  walk reached is one step up, tried from the unreached stand nearest the cell (at most 4 tries, each checked with a
  fresh walk search; a failed search is not repeated until the plan's world changes). The step is a support of its
  layer (dug at the layer's end, made again by the next layer when it needs it). Planned offline on a flat world, the
  house's sections then skip 25 cells (17 + 8) instead of 3 279, the sweep places 4 of them, and the second section
  plans in 2.3 s instead of 25 s; the 21 left are blocks the file has hanging on nothing the planner can click (end
  rods on end rods that hang on nothing, buttons and signs on air or a flower pot, carpets on a crafter or a smithing
  table, which the planner does not count as a floor). The search walks back from the stands that would place the
  cell over the stands no walk reaches, nearest first, to one a step beside a reached stand leads up to.
- **A walk across a line of slabs.** The planner's stands are on full tops; a bottom half (a slab, a stair's low half)
  was neither a stand nor a cell to walk through, so a line of slabs on a floor (placed early from the ground, a
  wall going up several layers a stand) walled the floor's middle off: with the server's block shapes the house's
  second section still skipped 626 cells with the step. A walk now crosses a half top (`canCross`: half a step up and
  down); it is never a stand (the eye would stand half a block lower than the plan's). Planned offline with the
  server's shapes: the second section skips 22 cells instead of 626.
- **Out of a block with a full inventory.** A stretch's take goes box by box, the box holding most of what is wanted
  first, and the items come out in part stacks: it can fill the inventory before the box holding the block the build
  is out of (`my inventory is full (my shulker boxes still hold 99 dead_fire_coral_block)` right after a take for the
  next 318 blocks). Once a step, the build's other loose kinds (not the throwaway kinds, not a box the build places)
  then go back into the boxes and the block comes out; what the next steps place comes out again with the next take.
- **A way out of the stand.** The runner places a block from any stand that reaches it, not only the plan's (the
  plan's walks all check out: replayed offline with the server's shapes, every walk from one stand to the next of the
  house's three sections exists). A cell the build leaves open (a refused one) among blocks topped with bottom slabs
  is a stand with a rise of 1.5 on every side but one; standing in it, the runner placed the block on the last side
  and could not walk out again (20 minutes of `walk: unreachable`, a shulker box set down beside it never picked up
  again, `cannot get` at 5 778 of 9 384). A placement now never uses a stand the block would shut in (`wayOut`: from
  the stand, with the block there, a walk climbing at most 1.25 and dropping at most 3 still leaves the build's
  footprint grown by 3, or finds more than 4 096 cells), the burst of blocks clicked from one stand included. A first
  rule (3 blocks sideways, or 64 cells) was not enough: the runner then shut itself in a room of 13 cells by its last
  pane, after a restart. A map art and a build wider than 64 (`FOOT_MAX`) keep that local rule, a walk out of so wide
  a footprint being too long a search; the check runs for the nearest stands only, until the walk has its 12. A
  floor, for the plan's stands and this walk, is a top that covers the cell's centre, the goto's own rule: an open
  trapdoor's panel (1 high at one side of its cell) was a floor to the check and none to the goto, and the runner shut
  itself in the same room again (the goto's search expanded 13 cells). The planner's walk search no longer steps from
  a half top onto a full top one higher (a rise of 1.5).
- **The boxes the build places stay empty.** A carried box of a kind the build places (running, or stopped with a
  resume) is never a target of the room chore. After a stop, the chore boxed 24 green_wool and 8 more of the build's
  kinds into an empty red box that the house places in a later section, where a placed box keeps what it holds.
- **A box is dug by hand once the pickaxe is low.** Every refill sets a box down and digs it again: on the house 239
  box digs wore a new iron pickaxe down to the wear limit (`toolWearLimit`) at 3 685 placed, and then no carried tool
  dug the scaffold blocks. A box drops whatever breaks it, so it is dug with the fastest tool only while that tool has
  more than 64 uses left (`BOX_DIG_KEEP`, skills/supply/boxes.ts), then from a hand slot (60 ticks against 10). The
  pickaxe's last uses are left for the scaffold, which needs one.
- **A round for the scaffold tool that cannot make one does not stop the build.** The runner asks for a stone
  pickaxe when no carried tool digs the scaffold blocks. A round that then stopped (`cannot craft 1 stone_pickaxe yet`:
  the cobblestone it took went to the scaffold reserve, nine takes of 3) stopped the build. It now goes on, digging the
  scaffold by hand, and no later round of the job asks for the tool again.
- **A placement the stop interrupted.** `!build stop` can land while a block is being clicked: the server still makes
  it (the item is gone) but the progress never marks the cell. The resume's bill then counted that block again, and
  with the boxes holding exactly what the house needs it refused (`cannot get 1 cactus`: the dye for one more
  green_wool). The resume's survey now also marks done every cell not marked that holds its block already, states
  included (`BuildJob.survey`, the `found` count).
- **No `!get` for what a gather does not bring.** The catalog takes `stripped_pale_oak_log` for the logs of that
  wood (a chop gathers natural logs), so the bill planned `!get stripped_pale_oak_log 6` for the house's stripped
  wood; the gather found no trees and the build stopped at its third section (`!get stripped_pale_oak_log 6 changed
  nothing`). A gather now counts for the bill only when it brings the item itself (`getHow`): a stripped log is
  `cannot get` from the start unless it is carried, boxed or in a home chest.
- **A section's own skips, once more before the next.** The cells a section skips as it runs (a walk that failed
  three times, no stand in reach) are planned once more right after it (`[again]`, BuildJob.tryAgain), before the next
  section is planned; its plan's own skips still wait for the sweep at the end. Four ceiling cells the house's second
  section skipped (the scaffold for them on a stand the goto did not reach then; replayed offline the goto reaches it)
  were the landing at the top of its stairs: planned offline on the bot's own world, the third section skips 413 of its
  3 222 cells with that hole and 122 without.
- **Dirt turns to grass.** Dirt the build places beside grass, in the light, turns to grass by the game's random
  ticks while the build goes on (175 cells of the house by the first stop). A resume leaves such a cell as it is
  (`another block (left)`), and the house e2e counts a dirt cell that is grass now as matching.

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
a Java file over 16 MB, over 64 MB unpacked or over 4 Mi cells is not read at all. Track B7: a `.litematic` region may
be up to 16 Mi cells and 16 MiB unpacked (a sparse box such as a map art; "Map art"), and a file of more than 524 288
blocks is refused before any block is kept.

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
| candle cakes (any colour) | no item: a candle placed on a cake (not measured) |
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

### Measured (Track B4, e2e build-boxes, 2026-11-22, BDS 1.26.60.6, flat, peaceful)

The fort of "Tests" (2 348 blocks in 41 x 14 x 33: 1 474 stone bricks, 555 oak planks, 228 oak stairs, 42 glass, 20 oak
logs, 19 oak slabs, 10 stone stairs) fed from 9 shulker boxes: 8 dropped beside the bot (24 stacks of stone bricks, 5
of oak logs, 2 of planks, 3 of cobblestone, 2 empty) and one in the home chest (a stack of sand); the bot carrying an
iron pickaxe only, `buildColumnMax` 12; `!build file fort ... fetch`, stopped at a quarter the first moment a box stood:

| What | Result (2 green runs: the resume after the stop's own pickup, and the quick resume) |
|---|---|
| the pickup | `build: picked up 8 shulker boxes lying near me (8 carried now)`; the boxes held 1 536 stone bricks, 320 oak logs, 128 planks and 192 cobblestone, 182 free box slots |
| the fetch (one round, 476 and 480 s) | 15 commands: `!bring sand 42 home` (it brings the chest's box), 7 takes out of the boxes (288 items: 204 logs in 4 takes before the crafts that use them, 42 cobblestone in 2, 42 sand), 5 crafts (228 oak stairs, 19 slabs, 425 and 28 planks, 10 stone stairs), `!furnace`, `!smelt sand 42`; the smelt alone about 420 s (one furnace, 10 s an item), the other 14 about 60 s; no stow needed (the round's makes fitted) |
| the runner's loads (4 a run) | at the start 345 planks, 36 glass, 4 stone stairs, 228 oak stairs and 24 slabs into a box to make room, then 896 stone bricks and 8 logs out of 3 boxes for the next 1 003 blocks; after the resume 578 stone bricks, 36 glass, 2 stone stairs, 410 planks and 12 logs out of 4 boxes for the next 1 038; then 228 oak stairs, 19 slabs and 60 planks out of 2 boxes for the last 307; one refill of 8 cobblestone for the scaffold |
| before the stop | 1 003 blocks in about 150 s after the round (walk 58 s, place 56 s, refill 14 s, wait 10 s; 99 walks) |
| the stop with a box out (at 636 and 641 s, 1 003 placed, a box standing for a load) | the progress file named the box at once (`boxes: {standing: [...]}`); `stopped build ...: 1003 / 2348 placed, 0 skipped; picking up 1 shulker box`. After the recovery: over in 4.3 s, 0 boxes in the world, the file's boxes gone, then `!build resume`. Quick: the resume taken 0.1 s after the stop, `resuming build ...: 1003 of 2348 done; 1 shulker box left out (picked up first)`, the box picked up 0.3 s later, before anything was built |
| after the resume | 1 345 blocks in 1 003 and 1 004 s (walk 492 to 493 s, pillar 286 to 287 s, place 151 to 152 s, wait 32 to 33 s, collect 22 to 23 s, refill 17 s; 326 walks): the house and its roof, 223 scaffold blocks placed and removed |
| the whole build (28 min a run with the test's setup) | `done, 2348 / 2348 placed, 0 skipped in 1004 s (80 blocks/min) (1 section), 223 scaffolds placed / 223 removed` (1003 s in the other), 1 647 s from the command both: 701 s per 1 000 blocks, about 520 s without the smelting; truth:blocksdiff 0 of 18 942 cells with states both; 0 scaffold blocks and 0 boxes (standing or lying) left; 9 boxes carried, 0 in the chest (the chest's came with `!bring sand`); left in the boxes 62 stone bricks, 96 logs, 142 cobblestone, 22 sand, 5 slabs, 3 planks, 2 stone stairs; loose the pickaxe, the crafting table and 24 cobblestone (the reserve); the furnace `!furnace` set down stays beside the build |

Found by the first runs (fixed before the green ones): the bill counted an item the crafter keeps as used when it was
in a home chest, so the round's first step was `!bring orange_shulker_box 1 home` ("Shulker boxes", "One pool").

### Measured (Track B6, e2e build-far, 2026-11-23, BDS 1.26.60.6, flat, peaceful)

`flyMin` 40, `autoFly` and `autoUnload` on; every control change of the process manager recorded from the command to
the end of the build.

| Case | Result |
|---|---|
| a far site: a hut of 119 blocks (49 oak planks, 70 stone bricks) 100 blocks from home; the home chest holds a full white box of stone bricks (1 728), 16 oak logs and a stack of cobblestone; the bot carries the flight kit and an iron pickaxe | steps `!bring stone_bricks 70 home` (the chest's box), `!bring oak_log 13 home`, `!craft oak_planks 49`; the trip home flown (104 blocks in 8 s, 0 from the goal), the trip back flown (102 blocks in 8 s to a point off the build, 11 from the goal, the rest walked); no chore got the body; `done, 119 / 119 placed`, 40 s from the command; blocksdiff 0 of 196 |
| a nearly full inventory: 33 of 36 slots (11 white boxes: one of 27 stacks of stone bricks, seven of dirt, three empty; 6 red shulker boxes the build places; 3 tools; 72 rockets; bread; 4 stacks of stone bricks, 2 of cobblestone and 4 of andesite loose); a yard of 67 blocks (45 stone bricks, the 6 red boxes, 8 iron bars, 4 oak stairs, 4 glass) by home; the home chest holds oak logs, 95 iron ingots, sand and coal | 12 steps: `stow into my boxes: stone_bricks`, four brings (3 logs, 6 ingots, 4 sand, 1 coal), `!furnace`, `!smelt sand 4`, then each craft (iron bars, oak stairs) with its output stowed after it; no `changed nothing`, no `inventory is full`, no room made at home; no chore; `done, 67 / 67 placed`, 130 s from the command; blocksdiff 0 of 90 |

The earlier suites on the same tree: build-boxes as in Track B4 (1 650 s from the command, 703 s per 1 000 blocks,
blocksdiff 0 of 18 942, the 9 boxes back); build-large 5 801 blocks in 3 756 s (648 s per 1 000), 4 fetch rounds after
the resume, blocksdiff 0 of 52 275, no scaffold left. Found by the first build-large run (fixed before the green one):
the room for a take protected every material of the plan, so a round of 270 planks found no room for its last stack
beside the glass and stairs left from the round before (`my inventory is full ...`); only the current bill's items are
protected now.

### Measured (Track B9, e2e build-house, 2026-11-24, BDS 1.26.60.6, flat, peaceful)

A Litematica house of 46 x 18 x 51 (9 573 blocks of 125 kinds, 167 refused, 9 406 to place) built from the 9 boxes it
was handed over in (its blocks and the logs for its wood), with the kit: an iron pickaxe and axe, 72 rockets, bread, 3
empty white boxes, the 6 red boxes the house places and 13 raw materials, 36 of 36 slots once the boxes are picked up;
two home chests beside the site, one holding 8 stripped logs (the bot can neither get nor make them). A `!build stop`
at a quarter, `!build resume`, a restart of the bot at 60 %.

| | Result |
|---|---|
| before Track B9 | `nothing to do from what I carry ...; my inventory is full` 4 s after the command, 0 placed |
| start to the stop | 2 353 placed in 908 s (the first 2 016 in 627 s: about 11 600 an hour on the ground floor) |
| the resume | 2 204 of 9 406 done: 150 cells of dirt had turned to grass (left as they are), the placement the stop interrupted found done |
| the restart | at 3 635 s (5 644 placed); boxes handed back 12 of 12; resumed 54 s later at 5 742 done |
| the upper floor | its section planned 120 cells skipped (the 5 cells the section before skipped tried again first; 413 without) |
| the end | 9 186 / 9 270 placed and 140 skipped after the sweep, 8 037 s from the command (about 4 100 blocks an hour); stopped `cannot get 12 smooth_quartz, 1 pale_oak_shelf` in the sweep's round |
| fetch | 26 rounds, 63 commands: 14 takes, 29 stows, 3 parks, 12 crafts, 5 brings, no get; 373 scaffold blocks placed and removed |
| time | walk 1 728 s, refill 945 s, place 695 s, pillar 541 s, wait 143 s (622 walks, 185 retries) |
| the world | blocksdiff 181 of 42 228 cells (52 dirt cells now grass counted as matching); the bot's world 0 of 42 228 from the server's; no box left out, none lying, no death |

Before the fixes of this track the runs ended: shut in a cell among slab-topped blocks at 5 778 (`cannot get` for a
box left beside it); the pickaxe worn out by 239 box digs at 3 685; shut in a room by its last pane (twice, the second
time over an open trapdoor's panel); `cannot get 1 cactus` on the resume (one green_wool placed as the stop came);
`!get stripped_pale_oak_log 6 changed nothing` at the upper floor; 419 skipped on the upper floor.

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
  the planner worker. The progress box holds at most 16 Mi cells (Track B7; a 2 MiB bitset, deflated in the file past 64 KiB).
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
- Shulker boxes (Track B4, "Shulker boxes"): boxes handed over are picked up only when dropped within 8 of the bot
  before `!build ... fetch` (or put in a home chest and read by a scan); a box a player takes while it stands is given
  up with a line in chat; a death drops the carried boxes with the body like any item (the resume finds no box to
  take from and fetches from home); the box opened first is the one holding the most of what is wanted, not the one
  the walk favours; a box's room is counted in free slots, not by what would stack into its part-filled slots. The
  progress file names the boxes out only for the last build.
- Trips and chores (Track B6, "Trips, chores and a full inventory"): the trip back aims off the build's box by the
  ground the world model has there (an unloaded column: the box's floor height); a fetch done away from home with
  the home chests out of reach does not read them again before `cannot get`; the build's own shulker boxes are
  carried for the whole build (they never wait in a home chest until their section); `skip missing` leaves out the
  highest cells of an item, not the ones that matter least to the shape.
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
  since the last scan is found out by `!bring` (the next bill has less at home); one filled since is seen when a
  `cannot get` reads the chests again (Track B6). Dyes, concrete and other
  colour chains are only what the crafter's chain plans (concrete powder needs gravel and sand, which `!get`
  gets; concrete itself needs water).

## Tests

```sh
pnpm --filter bot exec vitest run --project unit build-                  # unit, fakes only (planner, runner, formats, commands)
node scripts/bds.mjs --profile build up && node scripts/bds.mjs --profile build pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e build- --silent=false   # build-box + build-shapes (~6 min)
```

Env: `BUILD_BDS_HOST` (127.0.0.1), `BUILD_BDS_PORT` (19200), `BUILD_BDS_CONTAINER` (bds-build),
`BUILD_VERBOSE=1` (the bot's log), `BUILD_LOG_FILE=<file>` (Track B6: the bot's log lines appended to a file as they come; vitest
shows a test's console only at its end). Every run uses its own random 256-block cell from x, z = 36864,
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
- `build-replies` (unit, Track B5): see "Replies that fit the chat"; `B5_PRINT=<file>` writes each reply.
- `build-far` (Track B6, `BUILD_FAR=1`; `BUILD_FAR_ONLY=far|full` one case, `BUILD_FAR_OUT=<file>` appends each
  case's line and the notes): the two cases of "Measured (Track B6 ...)": a far site with a box in the home chest
  (every trip farther than `flyMin` flew or says why not, no chore, the box's stone bricks fetched, `done`,
  blocksdiff 0), and a nearly full inventory with boxes (`done`, blocksdiff 0, no step undone by the next).
- `build-java` (Track B2): a 5 x 3 x 5 house (65 blocks: oak log corners, oak planks, 4 stone bricks, 2
  smooth stone, a bricks block, 3 glass, 10 oak stairs, 15 oak slabs) written by the test's own writer as
  `.schem` v3, `.litematic` or `.nbt` (`BUILD_JAVA_FORMAT`), a home with one chest of raw materials only (32 oak
  logs, 8 sand, 48 cobblestone, 8 clay balls) read by `!chests scan`, an empty inventory: `!build materials
  file house ...` (the bill; Track B5: the summary, then every page of `!build more`), then `!build file house ... fetch`: the fetch's commands with their times, the done
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
- `build-boxes` (Track B4, `BUILD_BOXES=1`, about half an hour; not in the gate): a fort of 2 348 blocks in 41 x 14 x 33
  from the large-build generator (`castle.ts`: a curtain wall 2 thick and 5 high, a house of planks 18 x 12 with log
  corners, glass windows and a stair roof with a slab ridge, a staircase of stone stairs), written as a Sponge `.schem`,
  fed only from 9 shulker boxes: 8 dropped beside the bot (stone bricks, oak logs, a few planks, cobblestone, two
  empty) and one in the home chest holding sand; the bot carries an iron pickaxe only, `buildColumnMax` 12. `!build
  file fort x y z fetch` picks the 8 up, the fetch takes the logs, the cobblestone and the sand out of the boxes,
  crafts planks, stairs, slabs and stone stairs, sets a furnace down and smelts glass; at a quarter, the first moment a
  box stands, the build is stopped (the progress file must name the box) and resumed: by default after the stop's own
  pickup (0 boxes in the world, all 9 carried or in the chest, the file's boxes gone), with `BUILD_BOXES_RESUME=quick` at once, so the
  resume picks the box up first. Then every cell is compared with its states, and the test checks 0 scaffold blocks
  and 0 boxes in the world (standing or lying) and the 9 boxes carried or in the chest (`!bring sand ... home` brings
  the chest's box) (`BUILD_BOXES_OUT` appends each run's line to a file).
