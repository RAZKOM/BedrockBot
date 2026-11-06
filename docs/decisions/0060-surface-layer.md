# 0060: World cache: a surface layer per column, block colours from the game art, a 2D map painted like the game's

Date: 2026-11-05. Status: accepted (web panel programme, step 1, Track PC; extends [0015](0015-world-cache.md),
uses the asset reader of [0046](0046-item-icons.md)). Server: BDS 1.26.60.6 (`bds-cache`, seed 7).
Details and numbers: [../world-cache.md](../world-cache.md) "Surface layer", "Block colours", "Debug map".

## Context

The owner chose a 2D map with real block colours as the panel's main screen (step 2 of the programme).
The cache keeps 2 bits per cell (air / solid / water / avoid) plus the planner's `top` / `roof` heights,
so a map can only colour by class and height: grass, sand, stone and a house roof look alike. A 2D map
needs only the top block of each column; recording it now means the map has real data for everything
the bot walks past from today on.

## Decisions

1. **One surface record per column, with names.** The block a map shows (the highest visible block on
   layer 0), its y, and under a liquid the floor block and the depth, stored as a per-chunk name table
   (at most 255 names) plus one byte per column per field. Visible means what the ground looks like from
   above: flowers, short grass, snow layers, carpets, rails count although they have no collision box;
   air, technical blocks, clear glass, torches, buttons, levers and tripwire are looked through; liquids
   (water, lava, and seagrass / kelp / bubble columns, which the planner treats as water) are named by the
   fluid. The rule is one function (`mapView`) computed once per block state with the other cache facts.
2. **The Nether gets a second layer: the first standable floor under the roof.** The top of a Nether
   column is the bedrock roof, which tells a map nothing. Below the roof the scan takes the first solid
   or liquid cell with two open (air-class) cells above it: a one-cell slit counts as roof, hanging vines
   are passed, a plant on the floor is what is shown, the lava sea is a liquid surface with floor and
   depth. That is where the bot can walk and what the Nether's terrain looks like. Other levels (caves,
   the Y-slice view of step 2) come from the cells the cache already has, not from more layers.
3. **A trailer, not a new record version.** The layer is appended after the marks with a tag and its
   own version; the record version stays 1. Records without it load as before (no surface data: the map
   draws them by class), and a bot of an older build reads new records (it stops after the marks), so a
   rollback costs the layer, not the cache. The top layer's y is stored relative to `max(top, roof)`
   (0 or 1 almost everywhere), which is why the layer costs 100 to 200 deflated bytes per chunk
   (7 to 11 %) instead of the 1.3 kB it is raw. The planner's arrays, the stand-ins and the corrections
   are untouched.
4. **Kept current like the rest.** A block update in a loaded column re-reads that column's surface
   from the real blocks; a section re-send re-summarizes the column.
5. **Colours are computed from the art at run time, never stored.** The map colour of a name is the
   alpha-weighted average of its top face (the up face of the model's highest box, else the model's
   top / cross / particle texture), with the plains tint of tinted faces, from the `minecraft-assets`
   package the icons already read (same reader, model resolution, Bedrock to Java names and tints; the
   parsed index files are shared). Lazy, cached in memory, a class fallback colour without art. Nothing
   derived from the art goes into git or onto disk.
6. **`/map.json` grows additively.** Tiles gain the surface indices into a per-tile name list, which
   points into a per-response palette of names and colours; `sy` only where the surface y differs from
   the old `y`, floor and depth only in tiles with a liquid, and `u` for the Nether layer. The route
   answers once the palette's colours are computed (the first request reads the art) and gzips large
   bodies. `v` stays 1 and every old field is unchanged.
7. **Painting lives in one plain-JavaScript module.** `paint.ts` `PAINT_JS` holds the block view (block
   colour with the in-game map's relief: darker when the column to the north is higher, lighter when
   lower; liquids shaded by depth with the game's checkerboard), the class view of before, the decoding
   of tiles and the hover text. The debug map embeds it verbatim, the unit tests evaluate the same text,
   and the panel's map screen (step 2) is meant to embed it too, so the colours and shading are written
   once.

## Consequences

- Per chunk on natural terrain: deflated record 1.57 to 2.43 kB (was 1.43 to 2.23 kB on the same
  chunks), summarizing 0.68 to 0.80 ms per column (unchanged within noise). A `/map.json` tile grows by
  about 1.1 to 1.3 kB as JSON (a full r = 12 window 756 kB instead of about 300 kB uncompressed); gzip
  brings an r = 4 window from 160 to 180 kB down to 16 to 21 kB on the wire.
- The map is only as current as the last visit, and only layer 0 is read (a waterlogged block shows as
  the block); colours are plains colours (no biome tints for grass, leaves and water).
- An older build that rewrites a chunk drops its layer until the column loads again under a new build.
- The panel's map-first screen (step 2) gets names, colours and the painting code from here; the
  Y-slice view will need a cell query over `/map.json` or a new route, not a change to this layer.
