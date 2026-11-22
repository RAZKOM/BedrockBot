# 0125: Java structure files, a bill of materials, and a fetch that crafts and smelts (Track B2)

Date: 2026-11-22. Status: accepted. No new setting. Details: [../build.md](../build.md) "Java files (Track B2)",
"Bill of materials (Track B2)", "Fetch (Track B2)"; the builder itself is [0033](0033-builder.md).

## Context

The builder read `.mcstructure` and a hand-written JSON layer format, and `fetch` ran `!get` for missing blocks:
anything `!get` does not know (planks, stairs, slabs, glass, bricks, stone bricks, smooth stone) was refused up
front. Most builds people share are Java files: Sponge `.schem` (WorldEdit since 1.13), the older MCEdit
`.schematic`, Litematica `.litematic` and vanilla structure `.nbt`, with Java block ids and states. And a real build
needs crafted and smelted blocks, which the bot can make (`!craft`, `!furnace`, `!smelt`, `!bring`, `!get`) but the
builder never asked for.

## Decision

1. **Four Java readers, one mapping.** `formats/schem.ts` (Sponge v1, v2, v3), `schematic.ts` (MCEdit, numeric ids
   through a table of Java 1.12 ids and data values to Java block states), `litematic.ts` (every region, negative
   sizes, the packed long block states that may span two longs) and `vanilla.ts` (`.nbt`), all on Node's own zlib and
   the NBT reader the protocol stack already ships; each written from the format's published description, with a
   writer of each used only by the tests. Every Java block goes through one module (`formats/java.ts`) whose rules
   are one data file (`formats/java-blocks.json`: renames, regex renames, states that pick another block, the
   state rules by family, the legacy id table) and whose every result is checked against the game's own block
   palette of the bot's version: a name the game does not know is never produced, and a state is kept only when
   the Bedrock block has it with that value. The guard test maps 1074 Java ids (Java 1.21's vanilla block ids, listed
   by hand in the data file: the repository has no Java registry to read them from) to palette blocks, and checks
   every rename, pattern and byState target and every legacy id.
2. **Unknown blocks refuse the file by default; `skip unknown` builds without them.** A mod's block, a Java-only
   block or an id no table knows is counted by its Java state and reason. A missing block can be the one that
   carries a floor, closes a wall or holds a roof, so building around it without being told leaves a hole the owner
   did not ask for; the refusal names the blocks, `!build materials file <name>` lists them one a line, and
   `skip unknown` is one word away.
3. **A file over 4096 blocks is refused with its size** (the planner's `MAX_BUILD_CELLS`; larger builds are a
   later track), and `!build files` lists the files with their format, size, block count, unknown blocks and bytes.
4. **The bill of materials** (`skills/build/bill.ts`, pure): for each item the build places, what is carried (the
   throwaway reserve held back), in the carried boxes, in the home chests (the chest memory); what is still short
   is planned at once by the crafter's own chain on one pool (so shared ingredients are counted once) and, where the
   chain cannot craft it, smelted from the smelter's table (stone, smooth stone, glass, bricks), its input itself
   taken, made or got; a raw material comes from the pool or `!get` (clay balls as clay blocks); the rest cannot be
   got. A smelt adds a furnace when none stands where `!smelt` looks, and fuel in the smelter's order, logs crafted
   into planks when the pool has no other fuel (a log smelts 6 items as planks, 1.5 as a log). A throwaway kind
   brought or got also covers the reserve's shortfall, or the reserve would keep it.
5. **`fetch` works through the bill one command at a time, as the owner, through the chat's handler**: each take
   from home (`!bring <item> <n> home`), each raw material (`!get`), the crafts possible from what is carried (an
   ingredient of another pending craft last), the fuel's planks, `!furnace`, the smelts whose input is carried
   (deepest first), and the bill made again after each command, so crafts that wait on smelted items come up when
   their input exists. It stops on a command that changed nothing, on nothing to do, after 40 commands or an hour.
   Reusing the commands keeps one path for each skill (their replies, their waits, their limits, `!stop`), and
   making the bill again after each step needs no model of what a command will do.
6. **The fetch is a user process** (named `build`): each command's own process pre-empts it and it gets control
   back in between. Without it the home chore ran in the gap between two commands: the chore unloads a `!get` job's
   haul when it ends at home, and would have put back what the next step was to use. `!build stop` and `!stop` end
   it, a death drops it, `!build status` says the step.

## Not taken (considered, not built)

- Planning the whole fetch once and running it blind: a craft's real output (crafts come in whole recipes: 18
  slabs for 15) and a bring that comes back short change the next steps; making the bill again after each command
  is cheap (milliseconds) and needed no model of the commands.
- Skipping unknown blocks by default with a note: rejected for the load-bearing reason in 2.
- Keeping `fetch` on `!get` only and adding the crafts to `!get`: `!get` is the front door for raw materials and
  tools; a build's bill mixes bringing, crafting and smelting, and the bill already knows the order.

## Consequences

- Measured on a flat, peaceful test server (BDS 1.26.65.1, e2e build-java): see build.md "Measured (Track B2)".
- Java states are mapped and turned with a rotated structure, but the runner places by the item, the clicked face
  and the yaw (Track B1 works on placing states): a Java house is right by names. Since Track B1 (decision 0124)
  the runner gives the mapped states and verifies them, and one turner turns them (states.ts `rotateStates`; this
  track's `formats/rotate.ts` was folded into it so no state is turned twice).
- The bill uses the smelter's table and the server's grid recipes only: stonecutter recipes and furnace recipes the
  table lacks (smooth sandstone, smooth quartz, terracotta, cracked stone bricks) make such blocks `cannot get`
  unless carried or at home.
- Not proven: a file from another tool (none was downloaded; the readers follow the published layouts and were
  checked on files the tests wrote byte by byte or with their own writers); anything on the Realm; a fetch with
  `!get` gathering in the wild (the e2e's raw materials were in a home chest); a build past one stack of an item
  per command (`!smelt` at most 64 a command, the fetch runs it again).
