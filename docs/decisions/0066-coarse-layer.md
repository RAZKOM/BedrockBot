# 0066: The coarse layer (long-range planning over the world cache)

Date: 2026-11-06. Status: accepted (Track CB; builds on [0015](0015-world-cache.md) and
[0060](0060-surface-layer.md) (the persistent world cache the graph reads), [0023](0023-planner-worker.md) (the
fine planner's budgets) and the flight programme ([0058](0058-flight-planner.md), [0064](0064-route-landings-and-takeoffs.md));
the contract with the flight session's executor, Track F4b, is `bot/src/skills/coarse/types.ts`). Guide:
[../coarse.md](../coarse.md).

## Context

Long trips fail when the only way runs through a far-off opening. The owner's two cases (2026-11-06): the bot at
home at 0, 0 and the goal inside a cave 1 000 blocks away whose entrance is 600 blocks along: the flight lands
over the goal and the walking A* cannot find an entrance 400 blocks away; and long detours round lakes and
ravines, where the segmented A* (Baritone-style best-so-far partial paths) walks into dead ends because each
segment sees only its budget (500 000 nodes / 2 s for a main plan, 60 000 / 300 ms per segment in the worker)
and the loaded chunks. The world cache already remembers a 2-bit class per cell (air / solid / water / avoid) for
every chunk column ever loaded, underground included, so the knowledge is usually there; nothing planned over
it at long range. The flight session is building a flight executor against the same contract, so the layer has
to be one shared module with one query, not a walking-only fix.

## Decisions

1. **One graph over the cache, per chunk, built lazily, bounded by an LRU** (`chunk.ts`, `graph.ts`). Volumes
   are the connected components of passable cells per 16 x 16 x 16 section plus one sky volume over the column
   tops; unknown chunks are one volume per section. Portals are the shared faces between volumes (section
   borders, the sky contact, air / water contacts, chunk borders), split into connected openings, each with its
   largest clear rectangle, the rectangle's centre, a floor rule that needs a floor on both sides of a vertical
   face, and a cell-based id that survives rebuilds. Chunk graphs are built on first lookup and dropped when a
   column loads, a section is re-sent or a block's class changes; border portals are cached against both sides'
   build numbers. The memory is whatever `maxChunks` (1024) allows, never the size of the cache.
2. **One search for every mode** (`search.ts`): weighted A* (f = g + 1.5 h) over (portal, volume, mode) states,
   edges priced by the entered mode's `CoarseCost.edgeCost` plus a switch cost when the mode changes, run in 6 ms
   slices with the event loop between them. Weight 1.5 over plain A* because the corridor is rough anyway and
   plain A* across 64 x 64 hilly chunks expanded 48 000 nodes and built every chunk (1 956 ms) where the weighted
   search expands 276 and builds 321 (134 ms cold, 2.9 ms warm). Unknown space is crossable at a price but only
   inside an ellipse of 1.5 x the straight-line distance + 64 blocks round the start and the goal, because it is
   unbounded and `none` must be able to end.
3. **Rough prices in ticks, shipped for walk and mine; flight registers its own.** Walk: 4 a block, x 3 in water,
   16 through unknown, 10 per portal, Infinity for an opening it cannot walk (`walkable`) or one marked failed.
   Mine adds a dig price of 80 a block (the fine planner's `digPenalty` policy: 13 walked blocks per dug block),
   for synthetic dig portals through solid (`Portal.dug`, an optional field added to the contract and
   documented) and for openings too narrow or too deep to walk. A landing costs 20 and is refused without a
   floor, so a fly leg followed by a walk leg ends on a floor. Failures decay after 30 minutes.
4. **Two optional additions to the contract, nothing else changed:** `Portal.dug` (mine's synthetic portals;
   every other cost must refuse them) and `CoarseCost.ticksPerBlock` (the heuristic's slope; 0.5 when absent).
   Volume ids use `sky` as the section index of the sky volume (`dim:cx:cz:sky:0`); dig portal ids end in
   `:dig`. The flight session is told of both.
5. **The navigator follows a corridor a window at a time** (`nav/corridor.ts`, `navigator.ts`): a goto farther
   than `coarseMin` (96) asks for a corridor at its start and waits up to 12 ticks for it; the fine planner's goal
   is the farthest waypoint within 32 blocks of corridor as a `near` goal, the goto's own goal once the rest is
   short; a reached waypoint is a `partial` segment whose end plans ahead; a waypoint the fine planner cannot
   reach marks its portal failed and asks for a fresh corridor, the raw goal meanwhile; a change near the
   corridor re-plans it (throttled). Today's behaviour is the fallback whenever there is no corridor.
   `bot/src/skills/fly/**` and `commands-fly.ts` are untouched; the flight registers its cost on
   `skills.nav.coarseLayer`.
6. **Wired after the cache opens** (`index.ts`): the command registrations run before `openWorldCache`, so the
   layer is attached where the cache is, not in the registry. Without a cache (`BEDROCKBOT_CACHE=0`) there is no
   layer and the navigator plans as before.

## Consequences

- **The owner's cases on generated worlds** (`coarse.test.ts`): from the surface right over a cave room whose
  only entrance is 100 blocks back, the walk corridor goes to the entrance, down the staircase and along the
  tunnel (the landing over the goal is no longer a dead end); a ravine 16 wide across the way is detoured round
  its end, and with no known way round the walk corridor goes through never-seen chunks at the unknown price
  while mine digs straight across; from the foot of a mineshaft the corridor climbs the shaft to the hill top and
  refuses the 15-block cliff behind it. Unknown crossings report their fraction and cost more than known ones;
  portal and volume ids are equal across rebuilds and after a change elsewhere in the chunk; a failed portal
  re-routes through the other gap and is usable again after the decay; a fly-only corridor with a stub fly cost
  pays its takeoff and is under half the walk's price; a mixed corridor lands at the cave mouth.
- **Budget**: 134 ms cold / 2.9 ms warm across a 64 x 64-chunk hilly area (the contract's default is 500 ms);
  8.9 ms with mine. `nav-corridor.test.ts` walks a goto through a gap 40 blocks off the line following the
  corridor (586 ticks); on that small world the fine planner alone also manages it (576 ticks), so the unit
  closed loop proves the plumbing, not the gain: that is the owner's scale, hundreds of blocks, and needs the
  Realm or a BDS e2e.
- **Rough by construction.** One sky volume per chunk cannot see a trench or a wall inside a chunk (the fine
  planner handles those within its sight; a chunk-wide ravine is seen); floors are found at the opening, not
  along the way; headroom and minSpan are bounding-box estimates; `partial` is not `found`; knowledge is
  `known` or `unknown`, never `partial` (the cache's summaries are whole columns).
- **Not done**: an e2e on a BDS container (none started: the owner's rule, ports 10010+, ask first); the fly
  executor (the flight session's); the panel's status page for the layer (`layer.info()` exists); corridors
  across dimensions (the cache serves the current one; other dimensions are unknown); a `!corridor` chat line.
