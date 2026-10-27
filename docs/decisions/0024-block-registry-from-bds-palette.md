# 0024: Block registry from a BDS palette dump

Date: 2026-10-29. Status: accepted (PLAN.md Phase 7 wave 8, Track AC; follows
[0022](0022-stairs-and-partial-blocks.md)). Server: BDS 1.26.60.6 (`bds-reg`, udp/19192). Details and
numbers: [../versions.md](../versions.md) "Block states", [../world-model.md](../world-model.md) "Decode path".

## Context

The Realm bot logs `unknown block runtime id ... (registry data is from 1.26.30); treated as a solid
"unknown" block`. Block runtime ids on 1.26.x are FNV-1a hashes of the NBT {name, states}; the registry
resolved them through minecraft-data, whose bedrock block states stop at 1.26.30. On 1.26.60 that left
every stairs block (new `minecraft:corner`), every fence, glass pane, bars, fire, chorus plant and
redstone wire (new connection states) and 124 new block types (poplar wood, wool and concrete stairs
and slabs, icicle, ...) unresolved. Unknown ids are solid cubes to the planner (1.5 high in the terrain
layer), so these blocks were invisible walls or floors that are not there. Track AA special-cased stairs
in the terrain layer (0022); everything else stayed unknown. Waiting for minecraft-data to ship newer
block data would leave the bot blind after every game update.

Measured while building the dump: the Script API (`BlockPermutation.getAllStates`) does not report the
states the network hash uses. It also reports flattened-away legacy states (`color` on every stained
glass pane, `top_slot_bit` on slabs next to `minecraft:vertical_half`, `direction` on doors next to
`minecraft:cardinal_direction`, `wall_block_type` on walls; 39 names, 66 053 permutations instead of
23 941). Hashing the Script API states as they come gives the wrong id for 494 of 1488 placed blocks.
BDS sends `minecraft:unknown` as runtime id -2, not as its hash.

## Decisions

1. **Dump the palette from BDS itself, through the truth pack, and check it in.** `truth:palette`
   enumerates every block type and every resolvable combination of its states; the dumper
   (`tools/bump-version/dump-palette.mjs`) also places the default permutation of every type
   (`truth:palettestrip`), reads the runtime ids the server sends, and per type drops the smallest
   state subset that makes the hash match (1473 of 1480 types verified; the 7 that cannot be held in
   place drop the states the others mostly drop). The result is `bot/data/block-palette/<version>.json`,
   keyed by game version (95 kB, compact, one block per line), with the BDS build and the probe
   statistics in the file. One command per BDS build; 1.26.61 is a re-dump.
2. **The registry's runtime-id table comes from the palette when the shim names one** (`blockPalette`
   in `version-shims/1.26.60.ts`), from minecraft-data otherwise (1.26.51, or a version without a
   file). Palette states equal to a minecraft-data state keep its state id, so everything indexed by
   state id (terrain classes, shapes.ts, the world cache's state table) is unchanged for those blocks;
   the others get ids after minecraft-data's (16 913 up).
3. **Palette-only states borrow hardness and collision boxes** from the closest minecraft-data state of
   the same block, or of a shape donor chosen by name suffix for new blocks (`_stairs` → oak_stairs,
   `_slab` → oak_slab, `_door` → wooden_door, ...). Blocks with no relative stay full solid cubes (the
   safe default the unknown fallback already had) but carry their real names. The boxes come from
   minecraft-data's blockCollisionShapes, as the terrain layer reads them for known states.
4. **Hash with an own FNV over the NBT bytes** (`fastBlockHash`, 26 ms for 23 941 states, about 4x
   faster than building the NBT with prismarine-nbt), checked equal to `blockHash` on every state in a
   unit test. Hashes are computed once per process.
5. **Keep the `unknown` fallback** (solid cube, warning once per id, `unknownRuntimeIds`) for ids still
   missing, e.g. a server newer than the dump; map runtime id -2 to the unknown block.
6. **Leave Track AA's stairs special case in place.** It is redundant on 1.26.60 (no stairs id is
   unknown); a unit test checks both paths give the same boxes. It still helps a 1.26.60+ server
   without a dump.

## Consequences

- 0 unknown runtime ids for one of every block type on BDS 1.26.60.6 and for the recorded fixture
  world; the world-registry e2e matches name and states against the truth pack for stairs (4 kinds,
  4 facings, corners, upside-down), slabs, doors, trapdoors, walls, fences, panes, bars, candles,
  copper and new 1.26 blocks, 0 mismatches.
- Fences, panes, bars and redstone wire are now known blocks to the terrain layer (fences: the 1.5-high
  post with arms from their neighbours, as for known fences; before: 1.5-high unknown cubes). nav-fence,
  nav-stairs, world-chunks and world-updates pass unchanged.
- Registry build cost is unchanged warm (about 50 ms, prismarine dominates); the first build in a
  process adds about 40 ms (13 ms file load, 26 ms hashing). The data file adds 95 kB to the repo per
  game version.
- Every BDS update needs a re-dump (one command, about 30 s on a local container) and a shim line;
  without it the bot falls back to the old behaviour for changed blocks, with the warning naming the
  data source.
- Shapes of palette-only states are borrowed, not measured: new door types use minecraft-data's single
  door shape (the terrain layer's state-dependent door panel applies to minecraft-data door ids only),
  and the new connection states are not used for collision yet (the terrain layer still derives fence
  and pane arms from the neighbours). Both are terrain-layer follow-ups (skills/terrain/shapes.ts
  `boxesOf`, Track AA's file).
