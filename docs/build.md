# `!build`: the builder (wave 9, Track AL)

The bot builds simple structures legitimately, from its own inventory, with the same clicks a player
makes: fill / clear / replace a box, walls, floors, pillars and structure files (`.mcstructure`, a
hand-written JSON layer format, and since Track B2 the Java files people share: Sponge `.schem`, MCEdit
`.schematic`, Litematica `.litematic`, vanilla `.nbt`). PLAN.md 7.17 "builder". Decision records:
[decisions/0033-builder.md](decisions/0033-builder.md), [decisions/0125-java-files-and-bill.md](decisions/0125-java-files-and-bill.md)
(Java files, the bill of materials, a fetch that crafts and smelts). Placing and digging themselves are the
PlaceSkill and the Digger ([interaction.md](interaction.md), [digging.md](digging.md)).

## Files

| Path | What |
|---|---|
| `bot/src/skills/build/types.ts` | `BuildBlock`, `BuildSpec`, block name helpers, `unsupportedBlock` (the limits), `itemFor`, `MAX_BUILD_CELLS` (4096) |
| `bot/src/skills/build/spec.ts` | `!build` arguments -> `BuildSpec` (`~` coordinates, Bresenham walls), `buildStepText` (the NL step) |
| `bot/src/skills/build/sim.ts` | the world plus the build's changes (`SimWorld`), stand / reach / support rules, reachability (`reachableStands`) |
| `bot/src/skills/build/plan.ts` | the planner: order, stands, support scaffolds, scaffold columns, dig lists (`planBuild`, `planBuildAsync`) |
| `bot/src/skills/build/materials.ts` | materials against the inventory, the throwaway reserve (`usable`, `materialsOf`, `materialsLine`) |
| `bot/src/skills/build/runner.ts` | `BuildRunner`: executes the steps on the bot (walk, place, dig, pillar, descend, verify, retry, skip) |
| `bot/src/skills/build/formats/mcstructure.ts` | `.mcstructure` reader and writer (little-endian NBT) |
| `bot/src/skills/build/formats/layers.ts` | the JSON layer format |
| `bot/src/skills/build/formats/index.ts` | structure folders, the extensions (`STRUCTURE_EXTENSIONS`), `readStructure`, `loadStructure`, `listStructures` (`!build files`), rotation (`placeStructure`) |
| `bot/src/skills/build/formats/nbt.ts` | Track B2: Java NBT (gzipped or not, big-endian), the size limits, long values |
| `bot/src/skills/build/formats/schem.ts`, `schematic.ts`, `litematic.ts`, `vanilla.ts` | Track B2: the Sponge, MCEdit, Litematica and vanilla structure readers, and a writer of each for the tests |
| `bot/src/skills/build/formats/java.ts`, `java-blocks.json` | Track B2: Java block ids and states to Bedrock (one module, one data file), checked against the game's block palette |
| `bot/src/skills/build/formats/java-cells.ts` | Track B2: a Java file's cells through the mapping, the unknown blocks counted |
| `bot/src/skills/build/formats/rotate.ts` | Track B2: direction and axis states turned with a rotated structure |
| `bot/src/skills/build/bill.ts` | Track B2: the bill of materials (have, make, get, cannot) and the fetch's next command |
| `bot/src/tasks/process/build.ts` | `BuildProcess` (a user process) |
| `bot/src/chat/commands-build.ts` | `!build`, `BuildController` (plan, materials, fetch, status, stop), registration |
| `bot/src/config/settings.ts` | `buildScaffold` (on) |
| `packs/truth/src/build.ts` | `truth:blocksdiff` |
| `bot/test/unit/skills/build-plan.test.ts`, `build-formats.test.ts`, `build-fakes.ts`, `bot/test/unit/build-commands.test.ts`, `bot/test/unit/fixtures/build/gate.mcstructure` | unit tests on fakes, the hand-built fixture |
| `bot/test/unit/skills/build-java.test.ts`, `build-bill.test.ts`, `bot/test/unit/fixtures/crafting-data-build-1.26.60.json` | Track B2: the Java readers (hand-built files and round trips), the mapping's guard, rotation, the bill on the server's own building recipes |
| `bot/test/e2e/build-box.test.ts`, `build-shapes.test.ts`, `build-java.test.ts`, `build-truth.ts` | e2e on bds-build (Track B2: a Java house built from raw materials) |
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
| `!build materials [<build>]` | `materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)`, or `...; have everything`; without arguments: the running or the last build. When something is missing the bill follows (`bill for ...`, `bill: ...`, see "Bill of materials"), then one line per unknown block (`unknown: create:gearbox x 4 (not a Bedrock block)`) |
| `!build files` | Track B2: `build files: house (schem, 5x3x5, 65 blocks, 2.1 KB), tower (litematic, 7x20x7, 610 blocks, 4 unknown, 3.0 KB)`: the files of the folders with their format, size, block count, unknown blocks and bytes (at most 40 read; a file that cannot be read with its reason; `too big to build` past 4096 blocks) |
| `!build status` | `build: 212 / 640 placed, 3 skipped, eta 4 min` (`(paused)` while pre-empted), `build: idle (last: ...)` |
| `!build stop` | `stopped build fill 5x3x5 cobblestone: 40 / 75 placed, 0 skipped`; `build: nothing to stop` |

A build that needs more blocks than the inventory holds is refused with the materials line and `(add
fetch to get, craft and smelt them first)`, then the bill. With `fetch` the bot works through the bill
first (Track B2, see "Fetch"): what the home chests hold, raw materials with `!get`, crafts and smelts,
then the build. What nothing can make is refused before any command (`build: nothing fetched: cannot get
3 end_stone (no recipe and !get does not know it)`, then the materials line).

The build is a **user process** (priority 40, docs/processes.md): flee, guard, night and newer
commands pre-empt it, `!pause` holds it, `!resume` / the end of the pre-emption continue at the same
step, `!stop` and `!build stop` end it, a death drops it. `!status` shows it in the stack (`[active]
build fill 5x3x5 cobblestone: 12 / 75 placed, 0 skipped, eta 46 s`). One build at a time (a new one
replaces the old).

## Order rules

- **Place builds**: bottom layer first. Inside a layer the cell farthest from where the bot stood
  when the build started comes first and the order works towards the bot, so the bot never walls
  itself in; a cell without any clickable neighbour yet waits for one that has (the farthest cell
  with a support goes first, else the farthest).
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
  block name at the cell), every dig too (no collision box left). A failed step is retried twice
  (walking again), then skipped and reported (`skipped: x y z (place: place: rejected)`).

## Scaffolding (`buildScaffold`, default on)

Scaffold blocks are throwaway blocks (cobblestone, dirt, cobbled deepslate, netherrack; kinds the rest
of the build does not use first), placed to reach or to click, and removed afterwards; their drops
are picked up.

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
  is at most 6 high. When the bot is pushed off a column (a pre-emption, a flight), the resumed
  build digs the column from the ground and pillars again.
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

## Formats

Folders, first hit wins: `values.builds` (tests), env `BEDROCKBOT_BUILDS`, **`builds/` next to the
config file** (`%LOCALAPPDATA%\bedrockbot\builds` on Windows, `~/.bedrockbot/builds` on the Mac; not
with `--no-config`), then `worlds/` in the working directory. `!build file hut` looks for
`hut.mcstructure`, `hut.json`, `hut.schem`, `hut.schematic`, `hut.litematic`, `hut.nbt` in that order
in each folder (`!build file hut.litematic` reads that one file); names are letters, digits, `_ - .` (no
paths). The log line `build: !build ready (structure folders: ...)` lists them, `!build files` lists
the files (a name an earlier file answers is listed with its extension: `hut.nbt`).

**Size**: a file with more than 4096 blocks (`MAX_BUILD_CELLS`, the planner's limit) is refused with its
size (`castle: 4400 blocks in 20x11x20 is too big (at most 4096)`); air and structure void are not
blocks. Before that, a Java file over 16 MB, over 64 MB unpacked or over 4 Mi cells is not read at all.

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
values against the palette; the placed states are Track B1's (the runner places by the item and the clicked
face, see Limits).

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
corner of the turned structure is the anchor. Track B2: the blocks' states turn with it (`rotate.ts`:
`weirdo_direction`, `direction`, `facing_direction`, `ground_sign_direction` (+4 a quarter turn),
`minecraft:cardinal_direction`, `minecraft:block_face`, `minecraft:facing_direction`,
`torch_facing_direction`, `pillar_axis` and `portal_axis` (x and z swap), vine bits, wall and fence
connections); whether the placed block gets them is the runner's (see Limits).

## Truth commands (packs/truth/src/build.ts)

`truth:blocksdiff x1 y1 z1 x2 y2 z2 <palette> <runs>`: the box against an expected block list in the
canonical order of `truth:blocks` (y, then z, then x innermost); `<palette>` a comma list of ids
(`air,cobblestone`; `*` = any block), `<runs>` a comma list of `index*count`. Answer `{ count, diffs,
first: [{ x, y, z, expected, actual }] (20 at most), actual: { typeId: n } }`.

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

## Limits

- No liquids, no redstone parts (dust, repeaters, pistons, observers, buttons, levers, plates,
  rails, TNT), no two-cell blocks (doors, beds, tall flowers), no entities (paintings, armour stands,
  item frames), no block entity data. Such blocks are refused (`water: no liquids`).
- Block states are not placed on purpose: stairs, logs, slabs and other oriented blocks get the
  orientation that the clicked face and the bot's yaw give (the planner does not choose faces for
  orientation). Verification compares the block name only.
- Up to 4096 cells per build. Planning runs on the main thread in chunks of 64 cells (it yields
  between chunks).
- Clear and replace do not use scaffolds: cells out of reach from the ground (more than about 5
  blocks above the feet, or below a drop the bot could not climb back) are skipped. Deep holes are
  not dug (one-block steps only).
- A structure must be reachable on foot around it; the work area's edge is assumed reachable from
  outside, and the navigator decides the real path (a stand it cannot reach costs one goto failure,
  retried twice).
- A support chain longer than 3 blocks or a column higher than 6 is not planned (the cell is
  skipped).
- Java files (Track B2): the readers follow the published layouts and were checked on files the tests
  write, not on files from other tools. Block entity data (chest contents, sign text, banners' patterns,
  heads' owners) and entities are not read. Java blocks with no Bedrock block are unknown (refused or
  skipped). Java states that Bedrock keeps elsewhere or works out itself (stairs `shape`, fence and wall
  connections the game recomputes, `waterlogged`) are mapped where the block has the state and otherwise
  dropped; the runner does not place by state (above), so a Java house is right by names, and by orientation
  only where the click and the yaw happen to give it.
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
