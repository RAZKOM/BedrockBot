# Persistent world cache and debug map (`bot/src/world/cache`, `bot/src/health/map`)

PLAN.md Phase 7, tasks 7.12 (persistent world cache) and 7.15 (debug map). Decision record:
[decisions/0015-world-cache.md](decisions/0015-world-cache.md); the surface layer and the block colours
of the 2D map: [decisions/0060-surface-layer.md](decisions/0060-surface-layer.md). The world model it extends is in
[world-model.md](world-model.md), the planner that reads it in [pathfinding.md](pathfinding.md).

```ts
import { openWorldCache, findCachedTrees } from './world/cache/index.ts';
const cache = openWorldCache(world, { server: '127.0.0.1:19184' });  // <config dir>/cache/<server id>/
// from now on:
worldSource(world).blockAt(x, y, z);   // unloaded but remembered column: a stand-in block (planner)
world.find(isLog, { origin, radius: 200, max: 50, class: 'log' });   // remembered logs, `cached: true`
findCachedTrees(world, cache, origin, 200);                         // remembered trees
await cache.flush();   // also every 30 s
cache.close();         // at exit: writes everything, detaches
```

The CLI attaches a cache to every walking task (`--walk`, `--home`, `--shelter`, gather): root
`<config dir>/cache` (next to the config file; default `%LOCALAPPDATA%\bedrockbot\cache` or
`~/.bedrockbot/cache`), env `BEDROCKBOT_CACHE_DIR` overrides the root, `BEDROCKBOT_CACHE=0` turns it off.
It is closed (written) on every graceful exit.

## Files

| File | What |
|---|---|
| `world/cache/types.ts` | classes (`CLS_AIR`, `CLS_SOLID`, `CLS_WATER`, `CLS_AVOID`), `CachedMark`, `CachedTerrain` (what query.ts and find.ts read), `FoundPos` |
| `world/cache/classes.ts` | `StateTable`: per state id the class, roof flag, mark name and movement-signature id; the stand-ins |
| `world/cache/summary.ts` | `ChunkSummary` (cells, tops, roofs, marks, surface), `summarizeColumn` (plus the diff against what the planner read), record encode / decode, `checksum()` |
| `world/cache/surface.ts` | Track PC: the surface layer: `SurfaceData` (name table, top and under-roof layers), `scanTop`, `scanUnderRoof`, `roofedDimension`, the record trailer |
| `world/cache/region.ts` | region file format, atomic read / write |
| `world/cache/cache.ts` | `WorldCache`: hooks, live summaries, LRUs, flushes, lookups, map tiles, stats |
| `world/cache/trees.ts` | `findCachedTrees`, `cachedLookup` |
| `world/cache/index.ts` | `openWorldCache`, `serverIdFor`, `defaultCacheRoot`, exports |
| `world/cache/cli.ts` | `node src/world/cache/cli.ts info / checksum / chunk <dir>` (read-only inspection) |
| `health/map/schema.ts` | zod schema of `/map.json` |
| `health/map/data.ts` | `MapBuilder` (the JSON), `parseMapQuery`, status shape helpers |
| `health/map/page.ts` | the `/map` page (HTML + canvas, no dependencies) |
| `health/map/paint.ts` | Track PC: `PAINT_JS`, how a 2D map paints tiles (block colours, relief, liquids, the class view, the hover text); since decision 0062 generated from the panel's browser module `health/panel/client/paint.ts` (type-stripped, imports and exports removed), so `/map` and the panel paint alike |
| `health/panel/icons/colours.ts` | Track PC: `BlockColours`, a map colour per block name from the `minecraft-assets` art (top-face average), `CLASS_FALLBACK` |
| `health/map/routes.ts` | `mapRoutes(source)`: the route hook for `HealthServer` |

## Format

**Per chunk column** (`ChunkSummary`):

| Field | Size | Meaning |
|---|---|---|
| cells | 2 bits x 256 x rows | class per cell from the dimension floor (y0, -64 in the overworld) up to the top of the highest non-empty subchunk (`rows`, a multiple of 16; cells above are air). Index `(y - y0) * 256 + z * 16 + x`, 4 cells per byte, low bits first |
| top | int16 x 256 | highest solid y per column (`-32768` = none) |
| roof | int16 x 256 | highest roof block per column (the planner's sky rule: any collision box except leaves, and liquids) |
| surface (Track PC) | name table + 5 bytes x 256 per layer | per column the block a 2D map shows, its y, and under a liquid the floor block and the depth; in the Nether a second layer under the roof ("Surface layer" below) |
| marks | 6 bytes each + a name table | logs (natural, not stripped), chests, trapped / ender chests, barrels, shulker boxes (Track AG; the chest memory `chests.json` beside the regions is docs/home.md), crafting tables, furnaces / blast furnaces / smokers (lit too), beds, mob / trial spawners, every `*_ore` and ancient debris, farmland, doors; with position and an `exposed` bit (a face touches air or water inside the chunk: an ore the bot could have seen) |
| updatedAt | float64 | wall-clock ms of the last change seen |

Classes come from `skills/terrain/classify.ts`: danger (lava, fire, magma, cactus, campfires, sweet
berry bush, wither rose, cobweb, powder snow, pointed dripstone, portals, lava cauldrons) is **avoid**;
other liquids (water, seagrass, kelp, bubble columns) **water**; anything with a collision box
(including leaves, fences, slabs, unknown runtime ids) **solid**; the rest **air** (flowers, grass,
torches ...). Layer 0 only, as the planner reads it.

**Record** (little endian, then raw deflate level 6): `u8 version, i32 cx, i32 cz, f64 updatedAt,
i16 y0, u16 rows, i16 top[256], i16 roof[256], u8 cells[rows * 64], u16 nameCount, (u8 len, utf8)...,
u32 markCount, (u32 key = yRel << 8 | z << 4 | x, u8 nameIndex, u8 flags)...` with keys ascending;
flags bit 0 = exposed, bit 1 = seen (Track Z, next section); then the optional **surface trailer**
(Track PC): `u8 'S' (0x53), u8 surface version 1, u8 flags (bit 0 = under-roof layer), u8 nameCount,
(u8 len, utf8)..., per layer (top, then under): u8 idx[256], i16 y[256], u8 floor[256], u8 depth[256]`.
Column index `z * 16 + x`; name index 255 = none. The top layer's y is stored as `y - max(top, roof)`
of the column (0 or 1 almost everywhere, so it deflates to almost nothing); the under layer's y as is.

### Seen marks (Track Z: ore memory, decision 0021)

The miner's OreMemory ([mining.md](mining.md) "Ore memory across restarts") persists its records as
a flag on the marks: **bit 1 of a mark's flags byte = seen** (the bot saw an open face of that block).
Readers that only know bit 0 ignore it, so the record version stays 1 and old files load unchanged.

| Call | What |
|---|---|
| `markSeen(p, name)` | flag the mark at p when it is a `name` mark (live summary: marked dirty, written with the next flush; cached summary: re-encoded into its region). False when there is no such mark |
| `seenMarks(origin, r)` | seen marks within r, live columns first-hand, others from the cache (decoded) |
| `loadedMarks(origin, r)` | every mark of the loaded columns within r (the passive ore scan: no block-by-block visit) |

Life of a flag: a block update that keeps the block keeps it (`setMark` of the same name); another
block there removes the mark and the flag with it (mined or replaced ore forgets itself); a section
re-send keeps the flags of the previous live summary; a column that **loads** takes the flags of its
remembered record: from the decoded summary when there is one, else `decodeSeenMarks(record)` (inflate
and read only the name table and marks, no summary built). `stats.seenCarried` / `seenCarryMs`.

Measured: `decodeSeenMarks` over the stored records of a natural-terrain run (bds-cache, cache-gather:
2 013 chunks) costs 0.021 ms per chunk, so a login of 369 columns pays under 10 ms for the carry. The
summaries' checksums include the flags byte (a flagged mark changes the chunk checksum).

### Surface layer (Track PC, decision 0060)

What a 2D map needs of a column is its top block, which is cheap to keep. Every summary built from a
loaded column carries it (`ChunkSummary.surf`, `SurfaceData`):

- **top layer**: the highest block on layer 0 that the map sees (`mapView` in `classes.ts`, per state
  in `StateTable` as `vis` / `mapName`): visible blocks count **with or without a collision box**
  (flowers, short grass, snow layers, carpets, rails, redstone: that is what the ground looks like from
  above); the map **looks through** air, technical blocks (light blocks, barriers, structure voids,
  invisible bedrock), clear glass and glass panes (stained glass is visible), torches, buttons, levers
  and tripwire; **liquids** (water, lava, and the water plants the planner treats as water: seagrass,
  kelp, bubble columns) are a liquid surface named by the fluid (`water`, `lava`), with the **floor**
  (the first visible non-liquid block below) and the **depth** (cells from the surface to the floor;
  one byte, 255 = 255 or deeper; no floor above the dimension floor = floor none);
- **under-roof layer** (`roofedDimension(dim)`: the Nether only): the top layer of a Nether column is
  its bedrock roof, which tells a map nothing. Below the roof (the first run of non-air-class cells
  from the top) the scan takes **the first floor with two open cells above it**: a floor is a solid
  block or a liquid, open is the cache's air class (air, roots, fungi, vines, fire), so a one-cell slit
  in the roof counts as roof and the weeping vines hanging from it are passed. When the cell above the
  floor is a visible plant (crimson roots on nylium), that is the surface shown, at its own y; a lava
  sea is a liquid surface with its floor and depth like water. Why this one: it is where the bot can
  walk and what the Nether's terrain looks like, the highest open space under the roof; a full Y-slice
  view (step 2) needs the cells, which the cache already has (`cls`), not more layers;
- **stored** as a per-chunk name table (at most 255 names; a 256th distinct name in one chunk reads as
  none; natural terrain has 1 to 12 names per chunk, mean 3 to 7) plus one byte per column per field;
  names are compacted (unused ones dropped) when the record is written;
- **kept current**: a block update on a loaded column re-reads that column's surface from the real
  blocks (`rescanSurface`, from the top of the stored rows down to the first visible block, deeper for
  liquids and the under-roof layer), so a placed pumpkin, a mined hilltop or a drained pool shows at
  once; a section re-send re-summarizes the column;
- **compatible both ways**: the record version stays 1. A record written before the layer has no
  trailer: `surf` is undefined, `surfaceAt` returns undefined, the map tile has no `s`, and the map draws
  the column by class as before. A record with the trailer is read by an older bot (which stops after
  the marks) without the layer; if that bot rewrites the chunk the trailer is gone until the column
  loads again. A damaged trailer drops the layer, not the chunk. The planner's `cells` / `top` / `roof`
  are untouched, so planning, stand-ins and corrections do not change. The checksum covers the layer.

**Recipe: read the surface of a column.**

```ts
const s = cache.summary(x >> 4, z >> 4);                 // live or remembered (decodes the record)
const top = s?.surfaceAt(x & 15, z & 15);                // { name: 'grass_block', y: 64 } or undefined
// water: { name: 'water', y: 62, depth: 5, floor: 'sand', floorY: 57 }
const under = s?.surfaceAt(x & 15, z & 15, 'under');     // Nether: the first standable floor under the roof
if (!s?.surf) { /* a record written before decision 0060: only cls / top / roof */ }
```

From the command line: `node src/world/cache/cli.ts surface <dir> <cx> <cz> [--dim 1]` prints every
column of one chunk; `info` counts the chunks that have the layer (`surfaceChunks`).

**Reviewer checklist** (changes to the surface layer):

- the planner's arrays and the stand-ins are not touched, and nothing in the planner reads `surf`;
- new see-through or liquid rules go in `mapView` (one place), with a case in `surface.test.ts`;
- the trailer stays after the marks with its tag, the record version stays 1, and a record without it
  still loads (`surface.test.ts` "records written before the layer", "older readers");
- a format change bumps `SURFACE_VERSION`; a reader seeing a newer surface version reads the record
  without the layer;
- the map gets names and colours through `/map.json` (`s`, `p`, `palette`), never a colour table in
  git; painting rules change in `paint.ts` only.

### Block colours (Track PC)

`BlockColours` (`health/panel/icons/colours.ts`, next to the item icons) gives each block name a map
colour: the Java block state of the name (Bedrock names through the icons' `ALIASES` plus a few map
ones: `flowing_water`, `seagrass` and `kelp` are water, `magma` is `magma_block`, ...), its first
variant's model (resolved like the icons), the **up face of the model's highest unrotated box** (else
the model's `top` / `end` / `all` / `cross` / `particle` texture: water, plants drawn as crossed planes),
and the **alpha-weighted average** of that texture's first frame (transparent texels do not count),
with the plains tint of the face multiplied in (grass block top, leaves, short grass, ferns, vines,
lily pads, sugar cane; water `#3f76e4`). Computed on the first request per name and kept in memory
(4 096 names at most); `peek(name)` is the cached answer (a number, `null` = no art, undefined = not
computed yet), `load(names)` computes. A block without art (Bedrock-only blocks, entity-rendered ones,
or no package: `pnpm install --no-optional`) has no colour and the map paints the class fallback
(`CLASS_FALLBACK`: nothing `#181a1e`, solid `#8a8a80`, water `#2f6fd0`, avoid `#e0531f`). The parsed
index files are shared with the icons (`FsAssets.json` keeps one parse per file per process). Nothing
derived from the art is written anywhere. The guard test fails when a common overworld or Nether
surface block (grass, sand, stone, water, lava, the leaves, snow, dirt, gravel, ice, terracotta,
netherrack, nylium, ...) gets no colour while the package is installed.

**Region file** `r.<rx>.<rz>.bin` (32 x 32 chunks, `rx = cx >> 5`): `"BBWC", u8 version 1, u8 0,
u16 count, (u8 lx, u8 lz, u32 length, record)...`. Overworld files sit directly in
`<root>/<server id>/`, other dimensions in `<root>/<server id>/dim<N>/`.

**Server id**: `serverIdFor(label)` = a slug of the label (lowercase, `[a-z0-9.]`, at most 40) plus
`-` and 8 hex digits of FNV-1a over the full label. The CLI uses `host:port` for a BDS
(`127.0.0.1-19184-99999ced`) and the Realm label (`realm "<name>" (nethernet/services)`) for a Realm,
so two servers never share a cache, and the same server over RakNet or NetherNet shares one.

**Checksum**: `ChunkSummary.checksum()` = FNV-1a over the record without version, position and
timestamp (cells, tops, roofs, sorted marks). `cli.ts checksum <dir>` prints the aggregate (FNV-1a over
the sorted `cx,cz:checksum` lines) and, with `--chunks`, every chunk's.

## Life cycle

| When | What |
|---|---|
| a column finishes loading (`ChunkStore.onColumnLoaded`) | summarized (`summarizeColumn`), kept "live"; if the planner read stand-ins from this column while it was not loaded, the read cells whose stand-in differs from the real block are announced (next section) |
| a block update on a loaded column (`onBlockSet`) | the live summary's cell, column top / roof, mark and the neighbours' exposed bits are updated; Track PC: the column's surface is re-read from the real blocks |
| a loaded column's section is re-sent (`onSection`) | the column is summarized again |
| a column unloads (`onColumnUnloaded`) | the live summary is encoded into its region (memory) and kept decoded in the LRU |
| every `flushIntervalMs` (30 s) | dirty live summaries are encoded; changed regions are written (async, `<file>.<pid>.<n>.tmp` + rename) |
| `close()` (CLI exit, `disconnectCacheBot` in tests) | everything encoded and written synchronously, hooks removed |
| the first lookup in a region | the region file is read (sync, about 1 ms for a few hundred chunks); a corrupt file is renamed `*.corrupt-<ms>` and the region starts empty |

**Memory bounds** (options of `WorldCache`): decoded summaries of unloaded columns `maxChunks` 1024
(LRU), regions (deflated records) `maxRegions` 32 (LRU; a dirty region is written before it is
dropped), map tiles `maxTiles` 16 384 (768 bytes each). Live summaries follow the loaded columns (369
at view radius 10). Measured on the generated world: about 30 kB per decoded summary in memory
(12 kB of cells, the rest the mark map: deep chunks hold a few hundred ores), so the defaults hold
about 15 MB live + up to 30 MB decoded + 2 MB per full region. `cache.info().approxBytes` reports it.

**Two processes on one server** (two bots, or a bot restarted while the old one still writes): before
a region is written, if its file changed on disk since it was read, the chunks this process did not
change are taken from the file. Last writer wins only for a chunk both changed.

## Planner integration

`terrain/query.ts` (`worldSource`) reads `World.cache` at call time (the CLI attaches the cache after
BotSkills is built):

- `blockAt(x, y, z)`: loaded blocks as before; for an unloaded column the cache's **stand-in**:
  `air`, `stone` (solid), `water` (source), `lava` (avoid), or `oak_leaves` for a solid cell above the
  column's roof (canopies keep their leaf cost and do not make the ground under them "underground").
  `undefined` only when the column is neither loaded nor cached.
- `columnTop(x, z)`: for an unloaded column the cached roof, so the sky scan (surface preference,
  `NavGrid.skyTop`) works on cached terrain.
- `cached(x, z)`: true for a remembered, unloaded column. `liveBlockAt`: loaded blocks only; the
  physics (`blockQueryOf`) uses it, so the body never collides with a stand-in.

A goto into remembered terrain is therefore planned through it in one search (status `found`, not
`partial`), and the navigator walks it. The body only ever walks through loaded columns because the
server streams 10 chunks around the player and the plan reaches the remembered part 150 blocks or
more ahead: measured 0 ticks in unloaded columns over 300-block gotos.

**When the cache is wrong** (the world changed while the bot was away, or a stand-in differs from the
real block: slabs, stairs, paths, flowing water, doors, chests, leaves under a branch): when the column
loads, every cell the planner had read from it (tracked per cell through `blockAt`) whose stand-in has
a different movement signature than the real block (the navigator's own signature: boxes, floor,
liquid and height, danger, cost factor, friction, roof, doors, fences, gravity, protect, climbable) is
announced through `World.onBlockUpdate` with the stand-in as `before` (`BlockUpdates.emit`); a column
whose roof the planner read and whose roof moved announces the new roof cell. The navigator handles
them like block changes: its grid forgets the cells, and it re-plans (`block`) if one is near the rest
of the path. Columns and cells the planner never read announce nothing. Cells whose stand-in has the
same signature as the real block (grass under the stone stand-in) stay in the navigator's grid with
the stand-in's name; only dig costs (`allowBreak`) read names, and the dig action works on the real block.

### What the navigator would need for better cached-terrain behaviour (not done here: not this track's module)

1. **End the walked part of a segment at the loaded edge.** Today a plan through cached cells is
   `found` and the follower would walk into a cached column if the server ever lagged behind. A
   per-node "cached" flag (from `TerrainSource.cached(x, z)`, set when the search reads a stand-in)
   and, in `startLeg`, `to` = the node before the first cached node with `stopAtEnd` false and a
   re-plan when that column loads, would make it explicit. The cost would be one Set lookup per
   expanded column.
2. **Invalidate per column on load.** `NavGrid` has no "forget column (cx, cz)" call. With one, the
   cache could call it on load instead of announcing single cells, and the names of equal-signature
   stand-ins would be refreshed too.
3. **A larger main budget, or a coarse pre-plan, for long goals.** A cold 300-block plan over natural
   terrain expands 12 000 to 32 000 nodes (90 to 260 ms in one go). The default `mainMs` 40 (about
   5 000 cold expansions) would give a partial first plan; the e2e passes `mainMs: 600` (still sliced,
   max 9 ms per tick; `CACHE_MAIN_MS` overrides). Measured with `CACHE_MAIN_MS=40`: the first plan was
   `found`, 301 nodes in 32 ms, but only because the suite's acceptance search had already warmed
   the navigator's grid cache. Weighted A* (heuristic x 1.5) on cached cells, or a chunk-level
   pre-plan over cached column tops, would make long cold plans cheap.
4. **Expose the path in the report** (`GotoReport.path`, remaining nodes) so the debug map can draw it;
   the map reads `lastGoto.path` when present and draws the goal and the bot's trail meanwhile.

## Finders

`World.find(pred, opts)` visits, for every column in range that is not loaded, the cached marks of
that column (with `opts.class`, only marks of that class); the predicate gets the block's default
state (`registry.stateIdOf(name)`). Results are sorted with the loaded ones by distance, and cached
positions carry `cached: true`. `opts.cached: false` restricts the search to loaded columns.

`findCachedTrees(world, cache, origin, radius)` runs the wood skills' tree model (`treesFrom`) over a
lookup that reads loaded blocks, then marks, then stand-ins; leaves and soil are approximate in the
cache, so it accepts bare log columns (`minLeaves` 0, `requireSoil` false) and every result is
`partial: true, cached: true`: a candidate to walk to; the loaded chunk decides.
`BotSkills.findTrees` (skills/index.ts, not this track's) still only returns trees it can verify on
loaded blocks; the gather task walks to remembered forests through its own fallback (next section).

### Remembered forests (Track Z, decision 0021)

`findLogClusters(world, origin, radius, { skip })` (world/find.ts) groups the logs `World.find`
returns (loaded ones and the cache's marks of unloaded columns, flagged `cached`) into clusters:
single link, two logs within 6 blocks on every axis, grid-hashed, nearest cluster first, with the
logs for which `skip` is true (Track R's blacklist) left out and, for the gather task, only logs from
24 below to 48 above the bot (`FOREST_MAX_BELOW` / `FOREST_MAX_ABOVE`: the first e2e run on seed 7
walked to log clusters at y -10 to -14 under a y 64 start, an underground structure, and found them
unreachable one after the other).

`GatherWoodTask` (tasks/gatherWood.ts) gets a `ForestFinder` (`useForests(cachedForests(world,
nav.blacklist))`; the afk task's `!gather` through the Track Z registration line, `--task gather`
in its own factory). When find-tree finds no tree within the search radius (48):

1. the cluster the last forest walk went to yielded nothing: its logs go on the blacklist;
2. the nearest cluster within `forestRadius` (256) is walked to with an `any` goal (`near` r 4 on its
   8 nearest logs; timeout 1 200 ticks + 20 per block): `gather: no tree within 48 blocks; walking
   to a forest of 23 logs (0 remembered) at 120 64 -40, 72 blocks away`;
3. arrived: the search origin moves to the cluster's centre and find-tree runs again; the cluster
   counts as productive once a log is broken there. Unreachable: blacklisted at once. Interrupted
   (pre-empted): not counted, walked again after the resume. At most `maxForestWalks` (8) per run;
   no cluster at all: the old no-tree rounds and failure.

`stats.forestWalks`, `stats.forestsBlacklisted`.

Measured (`cache-gather`, bds-cache seed 7): seed 7 has trees almost everywhere (nearest natural log
from 41 random starts: 3 to 71 blocks, median 7), so the suite plants its forest 100 blocks away or
closer (at least 52, beyond the 48-block search) when natural logs are nearer, keeping it the nearest
cluster. Run with the forest 68 blocks away: after the restart the CLI's `!gather 8` logged `no tree
within 48 blocks; walking to a forest of 25 logs (0 remembered) at -1773 65 -1778, 65 blocks away`,
arrived, felled 2 trees and was done with 10 logs 54.5 s after the command (truth:inv), 5.3 blocks
from the forest. (At 52 to 100 blocks the forest is still in the loaded view distance of 10 chunks:
`remembered` counts the cache's marks of unloaded columns and is 0 here; unit tests cover cached ones.)
Two earlier runs found the planted trees on stone / sand ground: `findTrees` needs soil under a
trunk, so the walk ended with `no tree found there` and the cluster was blacklisted (the suite now
sets grass under each trunk).

## Debug map

`GET /map` and `GET /map.json` on the health server (`--health-port`, runbook "Operations"). The page
polls `/map.json` every second with `since` (the last `rev`) and `win` (the last window), so only
changed tiles travel; it draws:

- chunk tiles (Track PC, `paint.ts`): **blocks** (default): each column in its surface block's colour
  (the response palette, "Block colours"), with the in-game map's relief rule: **darker (180/220) when
  the column to the north is higher, lighter (255/220) when it is lower**, the same when equal (row 0
  of a tile compares with the tile to the north, so a tile is repainted when its north neighbour
  arrives); liquids instead shaded by depth like the game (lighter when shallow, darker when deep, a
  checkerboard between); columns without surface data or colour in their class's flat colour with the
  relief. **classes**: the view of before (solid green to brown to white by height, water blue, avoid
  orange-red, nothing dark). The **layer** select shows the under-roof layer in the Nether (`auto`, the
  default, picks it where a tile has it). Remembered-only chunks fade toward a pale grey with age (decision 0062, [map.md](map.md) "Painting"), loaded ones outlined;
- the bot (arrow by yaw), its trail (sampled once a second), the last goto's goal (and its path when the
  report has `path`), entities by kind (players, hostiles, neutral, passive, items), home and shelter
  (from the task status), waypoints from a `waypoints` field of the task or skills status (array of
  `{name, x, y, z}` / `{name, pos}` or a `{name: vec}` record);
- a side panel: server, position, navigator state, cache counts and the column under the cursor:
  `grass_block, y 64`, `water, y 62, 5 deep over sand`, `crimson_roots, y 41 (under the roof)`, or the
  class and height for a column without surface data.

`/map.json` (`MapJsonSchema`): `v`, `ts`, `server`, `dimension`, `rev`, `center`, `radius` (default 12,
max 64), `window`, `tiles[] {cx, cz, live, rev, updatedAt, y (base64 int16 x 256), c (base64 2-bit x 256)}`,
Track PC additive (`v` stays 1): per tile `s` (base64 u8 x 256: surface name per column as an index into
the tile's `p`, 255 = none), `p` (the tile's names as indices into the response's `palette`), `sy`
(base64 int16 x 256 surface y, only when it differs from `y` somewhere: flowers, snow layers, glass
roofs), `f` / `d` (floor index into `p` and depth, base64 u8 x 256 each, only when the tile has a
liquid column), `u {s, sy, f?, d?}` (the under-roof layer, Nether); and `palette[] {name, rgb}` (`#rrggbb`,
null = no art: paint the class colour). A tile without `s` is a record written before the layer. The
route answers once the palette's colours are computed (at most 3 s; the first request after a start
reads the art, later ones find them cached) and gzips bodies of 4 KiB and more for clients that accept
it (browsers and `fetch` do).
`bot`, `trail`, `nav {busy, running, path, goal, result, plans}`, `entities[] {id, type, name?, kind, x, y, z}`
(feet, nearest 256), `home`, `shelter`, `waypoints`, `cache {dir, live, decoded, regions, approxBytes,
lookups, corrections, errors}`.

## Measured (bds-cache, BDS 1.26.60.6, seed 7, 2026-10-29; ranges over 7 e2e runs)

| What | Result |
|---|---|
| summary size | raw record 12.1 to 13.4 kB, deflated 1.56 to 1.94 kB per chunk (natural terrain, surface around y 60 to 150); region files 1 564 to 1 906 B per chunk on disk |
| summarize on load | 0.64 to 0.90 ms per column (369 columns at login: about 300 ms spread over the packet bursts) |
| write cost | encode 0.20 to 0.31 ms per chunk; region write (async, whole region rewritten, about 250 chunks) 3 to 11 ms; `close()` with 1 200 to 1 400 chunks 260 to 280 ms |
| reload | a fresh process (`cli.ts checksum`, node start included) read 1 233 to 1 410 chunks in 340 to 850 ms; every chunk checksum equal to the in-memory summary in every run (e.g. 1410/1410, 1233/1233) |
| memory | 1 200 to 1 500 summaries (450 to 485 live, the rest decoded): 30 to 48 MB by `approxBytes` (about 30 kB each; the mark map dominates); with 3 000 summaries seen the LRU held 1 000 to 1 020 decoded (evictions 900 to 1 430) |
| 300-block goto into remembered terrain | acceptance search (one go, 600 000 nodes / 5 s): found, 301 to 336 nodes, 12 400 to 32 100 expanded, 88 to 257 ms. First goto plan (`mainMs` 600): found, 301 to 336 nodes, 32 to 88 ms over 4 to 11 ticks, **0 columns loaded before it**; arrived in 65 to 94 s, max 8.4 to 9.2 ms per tick, **0 ticks in unloaded columns** |
| corrections | first version (whole-column diff): 52 077 cells from 44 columns, 7 `block` re-plans. Current (cells the planner read): 49 to 624 cells from 19 to 37 columns, 1 to 6 `block` re-plans |
| trees after a restart | 25 to 740 logs within 24 blocks remembered; after the restart 7 000 to 10 900 blocks away `World.find` returned all of them flagged cached in 3 to 8 ms, `findCachedTrees` 5 to 63 trees in 3 to 160 ms, the 3 planted ones always among them |
| `/map.json` | r = 12 (625 chunks, 277 to 369 known): 236 to 315 kB, 3 to 4 ms; incremental poll with nothing changed: 0 tiles |

Natural terrain limits the nav suite, not the cache: about half of the random areas have water at an
end or no path within the cached corridor, and one run (before the steepness filter) planned fine
through a mountain area (start y 152) but the walk ended `unreachable` after 3 stuck re-plans on
terraces. The suite now tries up to 14 areas and skips plans that climb more than 24 blocks.

## Measured: the surface layer (bds-cache, BDS 1.26.60.6, seed 7, 2026-11-05; 5 e2e runs)

| What | Result |
|---|---|
| correctness | 48 random columns per run within 40 blocks of the bot compared with the server's own blocks (`truth:blocks` over y -64..319, scanned with the same rule): 48 / 48 in every run (plains and ocean, badlands, frozen ocean, ice spikes); a pumpkin set on the ground showed as the surface, and after its removal the block under it; the `/map.json` names equal the cache for every sampled column; after a hop of 600 blocks and a quit, fresh processes (`cli.ts surface`) read the same 49 columns from the regions |
| record growth per chunk | raw +1 310 to +1 376 B; **deflated +99 to +203 B, +6.7 to +11.1 %** (1 425 -> 1 570 and 1 635 -> 1 817 ocean, 2 229 -> 2 432 badlands, 1 554 -> 1 707 and 1 492 -> 1 592 frozen ocean) over 369 to 396 live chunks per run; 1 to 12 surface names per chunk (mean 3.4 to 6.7). `cache-world` after the change: region files 1 752 B per chunk on disk, every checksum equal after the reload |
| summarize on load | 0.68 to 0.80 ms per column (the surface scan included; before: 0.64 to 0.90) |
| `/map.json` tile growth | +1 082 to +1 337 B per tile as JSON: r = 4 (81 tiles) 158 to 179 kB uncompressed, **16 to 21 kB gzipped on the wire**; `sy` in 3 to 81 of the 81 tiles, floor / depth in 2 to 79 (ocean). `cache-map` (the CLI, r = 12, 369 tiles): 756 kB uncompressed (was 236 to 315 kB) |
| colours | the first `/map.json` after a start: 33 to 44 ms with the colours of 18 to 31 names read and averaged; the next one 4 to 6 ms; every palette name had a colour in every run |

## Tests

| Test | What |
|---|---|
| `test/unit/cache/world-cache.test.ts` | summaries (classes, tops, roofs, marks, exposure), block updates, encode / decode and region round trips, stand-ins and the physics guard, find with `cached`, cached trees, planning through cached terrain (`found` vs `partial` without the cache), corrections only for read cells, region files and a fresh reader, periodic flush and the LRU bound, corrupt files, two writers on one region, server ids, record size |
| `test/unit/cache/map.test.ts` | `/map.json` against the schema with every field, incremental tiles, no world / no cache, bad shapes rejected, query and waypoint parsing, `/map` and `/map.json` through `HealthServer` |
| `test/e2e/cache-world.test.ts` | a 200 x 200 loop of teleport hops: column unloads, region files, a fresh process (`cli.ts checksum`) reads identical checksums; trees planted, the bot leaves, a new bot with the same cache directory far away finds them (`World.find` flagged, `findCachedTrees`) |
| `test/e2e/cache-nav.test.ts` | a goto 300 blocks into remembered, unloaded terrain: first plan > 250 nodes before any new column, arrival, 0 ticks in unloaded columns |
| `test/unit/cache/world-cache.test.ts` (Track Z) | seen flags: set, kept through same-block updates, dropped with the block, on disk (bit 1), carried onto a reloaded column by a new process, read by a fresh reader; `logClusters` / `findLogClusters` |
| `test/e2e/cache-gather.test.ts` (Track Z) | a forest planted and seen by run 1; after the restart a new CLI process at a treeless start (`!gather 8`) walks to it and gathers 8 logs; the cost of `decodeSeenMarks` per stored chunk |
| `test/e2e/mine-memory.test.ts` (Track Z, bds-dig) | seen ore persisted by run 1 and mined from memory by a new CLI process ([mining.md](mining.md)) |
| `test/e2e/cache-map.test.ts` | the CLI with `--health-port 953x`: `/map.json` validates, incremental polling, `/map` serves the page, region files written on a graceful exit |
| `test/unit/cache/surface.test.ts` (Track PC) | what a column shows (`mapView`, flowers, glass, torches, liquids with floor and depth), updates on block changes (and the map tile), encode / decode round trip and checksum, records without the trailer, older readers of new records, a damaged trailer, the 255-name table, compaction, the Nether's under-roof layer (slits, vines, plants, lava sea, a column loaded in dimension 1) |
| `test/unit/health/map-colours.test.ts` (Track PC) | the top-face average (alpha, tint), name and tint rules, model and state lookups, a fake package (cached, null without art, fallbacks), **guard**: the common surface blocks all get a colour from the installed package; `PAINT_JS`: plain JavaScript, relief, liquids, dimming, the class view, old tiles |
| `test/unit/cache/map.test.ts` (Track PC) | tiles carry `s` / `p` / `palette`, `f` / `d` only with liquid, `sy` only when it differs, decoded with the page's code; colours filled once computed; the schema's additive fields; gzip on the route |
| `test/e2e/cache-surface.test.ts` (Track PC) | after standing in a private area: sampled columns against `truth:blocks`, a placed and removed pumpkin, `/map.json` names and colours on a health server (ports 9930 to 9939), the record and tile growth, and a fresh process reading the same names after a restart |

```sh
node scripts/bds.mjs --profile cache up      # bds-cache, udp/19184 (first start generates the world: ~2 min)
node scripts/bds.mjs --profile cache pack    # the truth pack
cd bot
BDS_E2E=1 pnpm exec vitest run --project e2e test/e2e/cache- --silent=false   # 2 to 3 minutes
node src/world/cache/cli.ts info "%LOCALAPPDATA%\bedrockbot\cache\127.0.0.1-19184-99999ced"
```

Env: `CACHE_BDS_HOST`, `CACHE_BDS_PORT` (19184), `CACHE_BDS_CONTAINER` (`bds-cache`), `CACHE_AREA=x,z`
(pin the area), `CACHE_MAIN_MS` (the nav suite's main plan budget, default 600), `CACHE_HEALTH_PORT`
(pin the map suite's port; default the first free of 9531 to 9538; the surface suite's default is the
first free of 9930 to 9939), `CACHE_VERBOSE=1`. The suites
set `gamerule falldamage false` (the hops teleport to y 300 and let the bot fall), peaceful, no mob
spawning, noon; they work in random areas 1 500 to 9 500 blocks from spawn, plant and remove their
own trees, and delete their cache directories.

## Known gaps

- `World.blockAt` stays `undefined` for unloaded columns; only `worldSource` (planner) and the
  finders read the cache. Tasks that call `blockAt` directly (tree detection, chest skill) need loaded
  chunks, as before.
- The navigator does not distinguish cached from loaded cells (see "What the navigator would need").
- Blocks changed while a column is unloaded are only learnt when it loads again. Block entities
  (chest contents), block states, light and biomes are not cached.
- Surface layer (Track PC): only layer 0 is read, so a waterlogged block shows as the block, not as
  water; colours are the plains tints (no biome colours: swamp water and badlands grass look like
  plains); the map shows only the top layer outside the Nether (caves need a Y-slice over the cells,
  step 2); a column's surface reflects its last load or block update, like everything else here.
- `exposed` looks only inside the chunk (an ore on a chunk border facing the next chunk's cave reads
  as buried).
- Region writes rewrite the whole region (7 to 11 ms async for about 250 chunks); a region of 1 024
  chunks would be about 2 MB per write.
- Marks dominate memory (a `Map` entry per ore); a packed array would cut a decoded summary to about
  14 kB.
