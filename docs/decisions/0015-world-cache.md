# 0015: Persistent world cache: 2-bit cells per chunk in region files, stand-ins for the planner, corrections as block updates

Date: 2026-10-29. Status: accepted (PLAN.md tasks 7.12 and 7.15). Server: BDS 1.26.60.6 (`bds-cache`,
generated DEFAULT world, seed 7, peaceful). Details and numbers: [../world-cache.md](../world-cache.md).

## Decisions

1. **What is stored: 2 bits per cell plus a few named blocks.** Per chunk column: for every cell
   from the dimension floor to the top of the highest non-empty subchunk a class (air, solid, water,
   avoid), per column the highest solid y and the highest *roof* block (the planner's sky rule:
   any box except leaves, and liquids), and a list of marks (logs, chests, barrels, crafting tables,
   furnaces, beds, spawners, ores, farmland, doors) with name, position and an "exposed" bit. Block
   states, light, biomes and block entities are not kept. Rationale: that is what the planner and
   the finders need beyond the loaded area; it deflates to about 1 to 3 kB per chunk (below).

2. **Classes come from the planner's own classification** (`skills/terrain/classify.ts`): danger
   (lava, fire, magma, cactus, berry bushes, cobweb, powder snow, portals ...) is `avoid`, other
   liquids `water`, anything with a collision box `solid`. One source of truth, so a cached cell
   means what the planner would have concluded from the real block.

3. **The planner reads stand-ins and keeps planning past the loaded edge.** `terrain/query.ts`
   (`worldSource`) answers `blockAt` for cells of unloaded columns from the cache: air, stone,
   water, lava, or oak leaves for solid cells above the column's roof (so canopies keep their leaf
   cost and do not count as a roof). `columnTop` returns the cached roof, so the surface preference
   works on cached terrain. The physics (`blockQueryOf`) never sees stand-ins (`liveBlockAt`).
   Consequence: a plan into cached terrain is `found`, not `partial`, and the navigator walks it.
   The body never reaches a cached column because the server streams 10 chunks around the player
   (measured: 0 ticks in unloaded columns over a 300-block goto).

4. **When the cache was wrong: corrections are block updates.** When a column the planner has read
   from the cache loads, every cell whose stand-in differs from the real block by the navigator's
   movement signature (boxes, floor, liquid and its height, danger, cost factor, friction, roof,
   doors, fences, gravity, protect, climbable) is announced through `World.onBlockUpdate` with the
   stand-in as `before`. The navigator invalidates its grid and re-plans if the remaining path is
   near, exactly as for a block change. Columns the planner never read produce no events.
   Rejected: editing the navigator to end a segment at the loaded edge (not this track's module;
   see docs/world-cache.md "What the navigator would need").

5. **Region files of 32 x 32 chunks, one directory per server.** `<config dir>/cache/<server id>/
   r.<rx>.<rz>.bin` (other dimensions in `dim<N>/`), each chunk a raw-deflated record. The server id
   is a slug of `host:port` (BDS) or the Realm label plus 8 hex digits of FNV-1a, so caches never
   mix. Files are replaced atomically (temp file + rename); before writing, a region whose file
   changed on disk since it was read takes the other writer's chunks it did not change itself (two
   bots on one server keep each other's chunks). A corrupt file is moved aside and starts empty.

6. **When things are written and how much stays in memory.** Live summaries are built when a
   column loads and kept current by block updates; on unload they are encoded into their region
   and stay decoded in an LRU (1024 chunks, about 30 MB measured); dirty live summaries are encoded every 30 s;
   changed regions are written asynchronously on that timer and synchronously on exit. Regions are
   read lazily on the first lookup and kept in an LRU of 32. Bounds are options of `WorldCache`.

7. **The finders consult the cache.** `World.find` adds the marks of unloaded columns in range,
   flagged `cached: true` (`cached: false` opts out); `findCachedTrees` groups cached logs into
   trees with the wood skills' tree model. `BotSkills.findTrees` is unchanged (it needs real blocks
   to verify a tree; wiring it to cached candidates is a skills change, see docs/world-cache.md).

8. **Debug map on the health server.** `GET /map` (dependency-free canvas page) and `GET /map.json`
   (zod schema `health/map/schema.ts`), mounted with a `routes` hook on `HealthServer`; tiles are
   sent incrementally (`since` / `win`).
