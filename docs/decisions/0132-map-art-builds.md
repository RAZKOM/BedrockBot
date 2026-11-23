# 0132: Map art builds (Track B7)

Date: 2026-11-23. Status: accepted. No new setting. Details: [../build.md](../build.md) "Map art (Track B7)"; large
builds are [0128](0128-builder-at-full-size.md), shulker boxes [0129](0129-builds-from-shulker-boxes.md), replies
[0130](0130-build-replies-that-fit.md).

## Context

A Java map art from Litematica is one region of 256 x 145 x 257 (2 x 2 maps and a noob line): 9.5 M cells of which
65 792 are blocks, one a column, staircased north to south (each block 1 up, level or 1 down from its north
neighbour) with east-west steps up to 81. The reader refused it (over 4 Mi cells); the job's sections (layer bands
over the whole footprint) took minutes each to plan; the planner could not reach a block standing alone high over
open ground (no support); and nothing put the art where the game's maps see it.

## Decision

1. **Read sparse boxes by their blocks.** A `.litematic` region may be up to 16 Mi cells (`MAX_SPARSE_VOLUME`) and
   16 MiB of unpacked NBT (`MAX_SPARSE_NBT_BYTES`); the dense formats keep 4 Mi cells and 64 MB. The packed longs are read
   as 32-bit words (no BigInt a cell), the non-air cells counted first, and a file over `MAX_READ_BLOCKS` (2 x 262 144)
   blocks is refused before any block is kept. Measured: about 9 bytes of heap per unpacked NBT byte (the map art's 6
   MB of longs: 55 MB), the whole read 172 ms and a 77 MB peak on the PC; 16 MiB unpacked stays under about 150 MB.
2. **Tiles for a sparse build.** A build with more columns than a section holds and at most 2 cells a column is cut into
   sections of 32 x 32 columns at every height, in serpentine rows from the corner nearest the bot, each low to high;
   the sweep the same way. A tile plans in seconds.
3. **A support at a column top.** A cell with nothing to click against is placed from a scaffold column beside it: a
   scaffold block set next to the cell from the column top, the cell placed against it, the support dug again, then
   the column. No new step kind (an `unscaffold` with the column top as its stand).
4. **The progress bitset deflated** past 64 KiB in the file (`z: 1`), and the progress box up to 16 Mi cells.
5. **`!build file <name> map [x z | x y z]`.** The file's first map square on the 128 x 128 square holding x z (the
   bot's feet without them), the noob line (a file one row longer than whole maps) north of it; without a y, every
   column's lowest block one above the highest non-air block of its column (all of the art's columns must be loaded
   or the command says how many are not). The label names the corner (`file art map at X Y Z (2x2 maps from X Z, noob
   line north)`); the progress keeps the chosen corner and y, so a resume does not read the ground again (the art is
   on it by then). No rotation (it would turn the picture).
6. **The grid and the colours were measured on Bedrock.** Maps made with an empty map on BDS 1.26.65.1 at six places
   (both sides of a square's edge, negative coordinates) have their origin (centre) at 128 k, covering 128 k - 64 to 128
   k + 63: Java's grid. The shading is Java's too: x 220/255 level with the north neighbour, x 255/255 higher, x 180/255
   lower, whatever the step. 98 kinds measured at five heights: all the art's 27 kinds show Java's colour; grass,
   leaves (biome tinted) and the purple group (purple concrete, mycelium, amethyst) do not, and `map` refuses them
   like unknown blocks (`skip unknown` builds without them). Substitutes are listed in the docs and not made.
7. **What the builder places is what the file has.** No flattening of the staircase, no substitution.
8. **A resumed job's bill leaves out what was placed before** (a map art fed with exactly its bill was refused at the
   resume: `cannot get 47 black_wool`, the blocks placed counted as still needed).
9. **Two planner fixes the map art showed.** A cell waiting for its layer's end (out of reach) is no longer picked
   again by the near-cell rule before then: one that failed again at once was picked for ever, and a tile beside a
   placed one planned for more than 25 minutes; the retries at the layer's end are at most 8 rounds
   (`LATER_ROUNDS`). A block that falls (sand, gravel, concrete powder, anvils) is placed only on a block that stays
   under it, else skipped (`it falls (nothing under it)`).

## Consequences

- A map art is read, sectioned, planned and resumed like any large build, from boxes (B4) and home chests.
- The planner reaches only what a scaffold column of `buildColumnMax` (at most 32) reaches from the ground: on the
  map art, planned whole on flat ground with columns of 32, 38 367 of 65 792 blocks (58 %; 27 391 `no support`, 34 out
  of reach) with 11 275 columns of 219 821 scaffold blocks in all; standing on the art's own staircase (drops
  over 3 beside it) is not planned. A taller column limit or walking the art is a later decision.
- Each reached block costs a scaffold column of its height, placed and dug: map art builds are slow (see the docs'
  measured rate).
- Trips to a far build (flight, teleport) and the chores on the way belong to Track B6; nothing here changes them.
