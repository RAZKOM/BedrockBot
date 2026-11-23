# 0133: Valley map art (Track B8)

Date: 2026-11-23. Status: accepted. No new setting. Details: [../build.md](../build.md) "Map art", "Valley"; the map
art builder is [0132](0132-map-art-builds.md), large builds [0128](0128-builder-at-full-size.md), shulker boxes
[0129](0129-builds-from-shulker-boxes.md).

## Context

Track B7 builds a map art file as it is: the 2 x 2 map art measured stands 145 high, every block high over open ground
needs a scaffold column of its own height, 42 % of it is out of a 32-high column's reach, and the rate measured was
214 blocks an hour (about 180 hours for what it reaches). A map pixel's shade only depends on the step to the block
north of it, so most of that height shows nothing. And on Bedrock a step of 1 shades at only one parity of x + z (both
games compare dy x 4/5 + ((x + z) & 1 - 0.5) x 0.4 with 0.6; Java's doubles pass at the boundary, Bedrock's do not,
measured): the file built as it is shows the wrong shade on 34 % of its pixels.

## Decision

1. **`valley`: the least staircase with the same map on Bedrock.** Each north-south strip is re-heighted on its own to
   the least heights whose Bedrock shades (`stepShade`: a rise or drop of 1 where the parity shows it, else 2; a level
   step of 0 or of the 1 the map shows level) are the ones the file means (the sign of its steps): a backward pass for
   what the steps ahead need, a forward pass taking the least each step allows; the strip's lowest block at 0. A unit
   test compares the file's pixels with the build's cells as a Bedrock map shows them: 0 differ. The 2 x 2 map art: 145
   high to 106, a strip 43 at the median.
2. **Hidden supports.** Cobblestone only under a block that has nothing to click against at its turn, found a tile
   (32 x 32 columns) at a time so the tile order does not matter: a layer group with no anchor gets the shortest chain
   down under one of its cells. A support is under an art block of its own column, never a column's top, so no map
   shows it. The world's blocks count (the ground, earlier supports at a resume).
3. **Free stands.** A valley build is planned free (`PlanOptions.free`, set by the spec): a stand places every ready
   cell it reaches at any height, the stand cover counts them all, and the next cell is the nearest ready one of any
   layer when the stand has nothing left. Offline on the art: half the walking and stand moves of layer order.
4. **Ground.** Plants and tree parts are not ground (a plant is built over); a block standing in or over the art
   (leaves, logs, terrain) refuses the build with what and where. The plan line says the valley's heights, the ground
   range under the y and the support count.
5. **No scaffold left.** At the end of a valley build the scaffold blocks still out in the world are dug by sections
   of their own.

## Consequences

- Without `valley` a map art builds as B7 did (the same cells, layer order).
- The supports cost blocks (0.80 an art block on the art measured) and the bill counts them.
- A map art built without `valley` keeps the file's heights and so its wrong shades on Bedrock; `valley` is the way to
  build a Java map art for a Bedrock map.
- The art no longer matches the file's heights: a schematic check of the built art against the file fails by design;
  the map is what matches.
- Falling blocks over air are still skipped as in B7 (the art measured has none).
