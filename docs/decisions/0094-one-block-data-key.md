# 0094: One block data key, minecraft-data 3.119.0 (Track U2)

Date: 2026-11-16. Status: accepted. Takes the block data move that [0093](0093-protocol-bumps-keep-the-block-data.md)
decision 1 left for a change of its own. Details and numbers: [../versions.md](../versions.md) "minecraft-data
3.119.0: the block data move".

## Context

minecraft-data 3.119.0 regenerates the bedrock block and item data. Up to 3.118.0 every bedrock key the bot loaded
pointed at the same 1.26.30 tables (1356 blocks, 16 913 states, 1933 items), so it did not matter that the world
registry read `bedrock_1.26.60` while the collision shapes, mining data, stack sizes and item names read
`bedrock_1.26.51`. In 3.119.0 each key has tables of its own (`bedrock_1.26.60`: 1480 blocks, 23 960 states, 2080
items; `bedrock_1.26.51`: 22 091 states). With the old wiring the shapes would be looked up by another key's state
ids. Two encodings changed as well: `harvestTools` keys are now the version's own item ids (iron_pickaxe 299, not
the old Java-style ids from 939), and air has hardness -1 while `unknown` has 0.

The 1.26.70 previews (protocol 2259) bring a block palette no minecraft-data release has. The bot must keep one
meaning per state id inside a process, because the terrain layer caches classes and shapes by state id, and a
reconnect may speak another version than the first join.

## Decision

1. **One block data key per process.** `bot/src/data/blockData.ts` names it (`BLOCK_DATA_KEY = 'bedrock_1.26.60'`)
   and loads it (`blockData()`). The world registry's state ids, the collision shapes (`skills/terrain/shapes.ts`),
   the mining data (`data/mining.ts`), stack sizes (`skills/container/chest.ts`) and item names
   (`skills/home/search.ts`) all read it. Version shims no longer name a registry key or a block data version.
2. **A game version's states come from its palette.** That is a BDS dump (`blockPalette`, `bot/data/block-palette/`)
   or a minecraft-data key's own states (`paletteFromData`: 1.26.51 uses `bedrock_1.26.51`). A palette state equal to
   a block data state keeps that state's id. The others get ids from the block data's count up. These ids are
   process-wide: the same state has the same id in every registry of the process, whichever version brought it.
   They take hardness and boxes from the closest state of the same block, or of a shape donor by name suffix. The
   registry reads its version at every build (`version` may be a function), so one World follows a reconnect that
   speaks another version.
3. **The bot keeps its own meaning where the data's encoding changed.** `harvestTools` is decoded by item name.
   `HARDNESS_FIXES` keeps air at 0 (a fill plan would otherwise skip every air cell as unbreakable) and `unknown` at
   -1 (the bot's name for an unresolved block).
4. **Generated test worlds keep neighbour-derived fence arms.** The block data's fences, panes and bars carry
   connection states; their default is a lone post. `blockInfoOf(name)` for such a block named without connection
   states drops them and offsets the state id (`GENERATED_CONNECT_BASE`), so the arms come from the neighbours as
   before. The server's own states still win in the live world model.
5. **BDS is the truth for the data.** The data was checked on BDS 1.26.65.1:
   - dig times: e2e dig, 7 cases of changed blocks;
   - stack sizes: `truth:itemmax`, every registered item type against `maxStackOf`;
   - standing heights: an armor stand dropped on every block whose terrain class changed, against the bot's boxes;
   - display names: BDS's `en_US.lang`.

   3.119.0 agreed with the server everywhere it was measured, so no Bedrock correction is applied. A correction found
   later goes in `blockData.ts` next to `HARDNESS_FIXES`, with its measurement.
6. **The guard is updated on purpose.** `test/unit/world/data-pin.test.ts` pins `bedrock_1.26.60`'s counts and
   fingerprints (blocks, states, items, shapes, materials). On the next bump that changes them,
   `bot/scripts/data-view.ts dump` (before and after) and `diff` show what moves for the bot. The e2e suites
   `data-truth` and `dig` measure it on BDS, and the fingerprints change in the same change.

## Consequences

- On 1.26.60 every one of the 23 941 states BDS sends is a block data state: 0 palette-only states, against 7 664
  before. The poplar set and the wool and concrete stairs and slabs have mining data of their own, so the bot digs
  them at their own times.
- What changed for the bot, by the states BDS sends:
  - collision boxes of 64 blocks: fences, panes and bars per arm, the end portal frame with an eye 1 -> 0.8125,
    straw_bed 0.5625 -> 0.25, icicle, ice_crystal, red_shrub, shelf_mushroom;
  - terrain classes of 7 blocks;
  - hardness of 158 blocks: obsidian and crying obsidian 50 -> 35, wool stairs and slabs 0.8, concrete stairs and
    slabs 1.8;
  - break ticks of 182 blocks;
  - stack sizes of 3 items a player can hold: armor_stand 16 -> 64, board and ice_bomb 1 -> 16;
  - 260 display names, nearer the game's own (1235 of 1249 match BDS's lang file, against 1058 of 1126).
- The update check no longer lists minecraft-data as newer.
- A palette whose blocks the block data lacks (1.26.70's calcite, packed ice brick and snow brick sets) is still
  read. Its walls, stairs and slabs take a donor's shape. Its other new blocks are solid cubes, and the digger
  refuses them (`unknown_block`) until block data has them.
- Rollback: revert the change (minecraft-data 3.118.0 with `patches/minecraft-data@3.118.0.patch`, the shims
  naming their keys again) and `pnpm install`. Nothing on disk depends on state ids: the world cache stores a 2-bit
  class per cell and blocks by name (`world/cache/summary.ts`), recordings store the server's runtime ids.
