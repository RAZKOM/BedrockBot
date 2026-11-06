# The coarse layer (`bot/src/skills/coarse`)

Track CB, [decisions/0066-coarse-layer.md](decisions/0066-coarse-layer.md). The shared long-range layer for
every mover: a graph of open space over every chunk the bot has ever seen (the live world plus the persistent
world cache, [world-cache.md](world-cache.md)) and one query, `CoarseLayer.plan`, that answers "which way, in
which mode" for a trip of any length: a corridor of legs (walk, mine, fly), the openings it crosses and
waypoints in world coordinates. The fine planners follow it a window at a time: the navigator on foot (this
document, "Following a corridor on foot"), the flight through its own executor (Track F4b, the flight
session). The contract between them is `bot/src/skills/coarse/types.ts`; change it only together.

```ts
import { attachCoarseLayer } from './skills/coarse/index.ts';

const coarse = attachCoarseLayer(world);             // over World.cache (a WorldCache); undefined without one
const layer = coarse!.layer;
const c = await layer.plan({ start: feet, goal, modes: ['walk'] });            // walk only
const m = await layer.plan({ start: feet, goal, modes: ['walk', 'mine'] });    // may dig (allowBreak)
const f = await layer.plan({ start: feet, goal, modes: ['fly'], goalStanding: false }); // flight registers 'fly' first
c.status;                 // 'found' | 'partial' (budget hit: ends nearest the goal) | 'none' (exhaustive)
c.legs[0].waypoints;      // from, every portal centre crossed, to (world coordinates)
c.legs[0].minClearance;   // the tightest opening on the leg: { height, width }
c.unknownFraction;        // share of the corridor through never-seen chunks
layer.markPortal(c.legs[0].portals[0].id, 'walk', 'failed');   // the executor could not pass it: refused 30 min
layer.onChange((chunks) => { /* chunks whose volumes changed: re-plan near them */ });
layer.setCost('fly', flyCost);                                 // a mode's prices (flight's own)
skills.nav.coarseLayer;                                        // the layer the navigator follows (index.ts wires it)
```

The owner's cases this exists for (2026-11-06): the bot at home, the goal inside a cave 1000 blocks away whose
entrance is 600 blocks along: the flight landed over the goal and the walking A* could not find an entrance 400
blocks away; and long detours round lakes and ravines, where each segment of the fine planner only sees its
budget (500 000 nodes / 2 s main, 60 000 / 300 ms per segment in the worker) and walks into dead ends. The
knowledge was already in the cache (a 2-bit class per cell, underground included); nothing planned over it at
long range.

## Files

| File | What |
|---|---|
| `types.ts` | The contract: `Volume`, `Portal`, `CoarseCost`, `Corridor`, `CorridorLeg`, `PlanRequest`, `CoarseLayer`. Frozen with the flight session; two optional additions documented below (`Portal.dug`, `CoarseCost.ticksPerBlock`) |
| `source.ts` | What the graph reads: `CoarseSource` (one `ChunkCells` per chunk: the cache's 2-bit classes), `cacheSource` (the WorldCache: live summaries first, then decoded records; other dimensions unknown), `terrainSource` (any `TerrainSource`, classified with the cache's own `cellClassOf(classify(block))`: generated test worlds see what the bot sees) |
| `chunk.ts` | One chunk column's graph: the sky scan, the per-section flood fill into volumes with their stats, the faces inside the chunk, the border faces with a neighbour, the largest clear rectangle, the floor rule, dig portals |
| `graph.ts` | `CoarseGraph`: chunk graphs built lazily on demand, kept in an LRU (`maxChunks`, default 1024), border portals cached against both sides' build numbers, `invalidate`, `volumeAt`, `portalsOf`, `digPortalsOf`, `portal(id)` |
| `costs.ts` | `walkCost`, `mineCost` (the shipped prices), `walkable` (the opening rule), `PortalMarks` (markPortal feedback, failures decay after 30 minutes) |
| `search.ts` | `planCorridor`: weighted A* over (portal, volume, mode) states in 6 ms slices, the unknown-space ellipse, the corridor assembly into legs |
| `layer.ts` | `CoarseLayerImpl` (the `CoarseLayer`), `attachCoarseLayer(world)` (the chunk store's events keep it current) |
| `bot/src/skills/nav/corridor.ts` | Following a corridor on foot: the waypoint window, passing and re-aiming, change detection |
| `bot/src/skills/nav/navigator.ts` | `attachCoarse`, the corridor requests, the intermediate goals, the feedback (Track CB comments) |
| `bot/src/config/settings.ts`, `bot/src/chat/help.ts` | `coarseMin` (default 96 blocks; 0 = off), in the `walking` group |
| `bot/src/index.ts` | Wires the layer over the cache after `openWorldCache` and attaches it to the navigator |

## The graph

**Cells.** The cache's 2-bit class per cell: air, solid (anything with a collision box: stone, logs, leaves, fences,
slabs), water (and the water plants the planner swims through), avoid (lava, fire, cactus, cobweb ...). Passable
= air or water. A chunk the cache has no record of is unknown. Cells above a chunk's stored rows are air; outside
the dimension's y range solid.

**Volumes.** Per chunk column:

- one **sky** volume: every cell from `skyY` (the highest non-air cell of the chunk + 1) to the world's top.
  Its `floorCells` are the columns whose cell at `skyY - 1` is solid (the hilltop; all 256 on flat ground, 0 over
  a lake), its headroom the band's height, its minSpan 16. Label 1, id `dim:cx:cz:sky:0`.
- per 16 x 16 x 16 **section** below `skyY`, the 6-connected components of passable cells of one class: air
  components are `cave`, or `surface` when they touch the chunk's own sky from below; water components are
  `water`. Stats from the flood fill: `cells`, `floorCells` (air cells over a solid cell), `headroom` (clear
  cells above the floor cells, counted up to 8, min and max), `minSpan` (the narrowest slice across the
  bounding box's longer horizontal axis). Id `dim:cx:cz:sy:n`, n the component's index inside its section in
  scan order (stable while the section's cells do not change).
- an **unknown** chunk: one `unknown` volume per section (`dim:cx:cz:sy:0`), 4096 cells, no floor, minSpan 16,
  joined vertically by full-face portals.

A section with no passable cell has no volumes (one number, no label array); otherwise the chunk keeps a byte
per cell of label (a 16-bit array only past 255 volumes in a chunk). A chunk graph is 20 to 60 KB on a generated
world; the LRU bounds the total.

**Portals** are the faces between two volumes: inside a chunk (+x, +z and +y of every passable cell below the
sky, which gives the section borders, the sky contact at `skyY - 1`, and the air / water contacts), and across
each chunk border (built when a search first steps over it, from both sides' label arrays; above both skies the
band is one sky-to-sky face). Faces are grouped by volume pair and axis, then split into 4-connected openings:
two gaps in one wall are two portals, so a failed one does not refuse the other. Per portal:

- `min` / `max`: the opening cells, one cell thick, on the lower-coordinate side (for y: the lower volume's top
  row); `a` / `b`: for y, a is the upper volume; for x / z, a is on the lower-coordinate side.
- `clearance` and `center`: the largest clear rectangle in the opening (histogram method); for x / z `height` is
  its y extent and `width` its extent across, `center.y` its lowest cell (feet height); for y the two horizontal
  extents, larger first. `.5` on an axis where the rectangle is even.
- `floorY`: the feet y of the lowest standable floor under the opening within 3. For x / z: an opening cell with
  solid under it on **both** sides of the face (the far side's cell is one step along the axis), else the
  rectangle's centre column scanned 3 down on both sides (both must find one; the lower wins): a chunk-border
  face over a cliff edge has a floor on one side only and gets none. For y: a floor directly under any opening
  cell (standing in the opening: a staircase, a cave mouth) gives `min.y`, else the centre column scanned down
  (a drop of 2 or 3 into a cave).
- `id`: `dim:axis:x:y:z` of the opening's first cell (lowest y, then z, then x). Stable across rebuilds and
  restarts while the opening keeps that cell: `markPortal` feedback survives a chunk reload.
- `known`: unknown when either volume is.

**Dig portals** (the `Portal.dug` addition, mine mode only). From a volume the graph also offers synthetic portals
to every volume of its chunk (the sky included) and of the neighbouring chunks' sections at its height that no
real portal joins, never into water: one cell in the solid between the two bounding boxes, `clearance` 2 x 1
(what the miner digs), `dug` the gap between the boxes along the axis (at least 1), id `dim:axis:x:y:z:dig`.
`CoarseLayer.portal` does not find them; every cost but mine must return Infinity for `dug !== undefined`.

**Currency.** `attachCoarseLayer` drops a chunk's graph (`invalidate`: revision + 1, `onChange` once per
event-loop turn with every chunk changed in that turn) when a column loads, a loaded column's section is
re-sent, or a block is set whose class differs (the registry's `blockInfo` classifies before / after; an unknown
runtime id counts as a change). The rebuild happens on the next lookup. A column that unloads keeps its graph:
the cache keeps its summary.

## Costs

Every cost is in ticks, so modes compare directly. The shipped ones (`costs.ts`) are rough on purpose: the
corridor ranks ways, the fine planner prices the steps.

| | walk | mine |
|---|---|---|
| per block | 4 (`WALK_TICKS`; a sprint is 3.6, a walk 4.7), x 3 swimming, 16 through unknown (`UNKNOWN_TICKS`) | the same |
| per portal | 10 (`PORTAL_TICKS`) | 10 |
| an opening it cannot walk (`walkable` false) | Infinity | + 2 blocks dug (a narrow opening widened), a y opening without a floor: + the drop (at least 2) dug or pillared |
| a dig portal | Infinity | + `dug` x 80 (`DIG_TICKS`: 15 to 20 of break time plus `digPenalty` 60: 13 walked blocks per dug block, as the fine planner) |
| `switchCost` from fly | 20 (`LAND_TICKS`) onto the portal's floor or the volume's floor cells, else Infinity | the same |
| `ticksPerBlock` (the heuristic) | 4 | 4 |
| `clearance` | 2 x 1 | 1 x 1 |
| a `failed` mark for the mode | Infinity | Infinity |

`walkable(portal, from, to)`: a real opening, 2 high and 1 wide for x / z with a floor (or water on either side:
swimming in or out); along y a drop with a floor within 3 (down), or a floor in the opening itself and floor cells
in the upper volume (up; up out of water onto floor cells counts); the sky only where it has floor cells; anything
to or from an unknown volume. A ravine's chunks are entered from the rim only where some opening cell has a
floor on both sides, so a sheer edge refuses the walk and the corridor goes round; a staircase whose steps cross a
section border is a y portal with a floor in the opening and is walked both ways.

**Feedback.** `markPortal(id, mode, 'failed')` makes the mode's cost see `outcome: 'failed'` on that portal for
30 minutes (`FAILED_DECAY_MS`); `'ok'` is remembered without decay. Marks are per mode: a tunnel the walk failed
is still offered to mine and fly.

## The search

Weighted A* (`f = g + 1.5 h`, `HEURISTIC_WEIGHT`: the corridor is at most 1.5 x the cheapest, for a fraction of
the nodes; plain A* across 64 x 64 hilly chunks expanded 48 000 nodes and built every chunk) over states (portal
about to be crossed, the volume entered, the mode). An edge crosses that portal and travels inside the volume to
one of its other portals, priced by the entered mode's `edgeCost(portal, from, to, blocks, outcome)` plus the
switch cost when the mode changes (`switchCost(from, at, near)` of the entered mode, else
`PlanRequest.modeSwitchCost`, default 40). The start is a pseudo-portal at the start point (16 x 16 clearance, a
floor when `startMode` is not fly); a volume holding the goal gets a terminal edge straight to it (with
`goalStanding`, a fly arrival needs floor cells there). The heuristic is the straight-line distance x the smallest
`ticksPerBlock` over the requested modes (0.5 for a cost without one).

- **Slices**: 6 ms of search, then `setImmediate`, so a physics tick never waits more than a slice plus one
  chunk build (about 0.2 ms on a generated world). Budgets: `maxNodes` 200 000, `maxMs` 500 (search time, the
  slices summed). Both exceeded: `partial`, the corridor to the node nearest the goal, `reason` says which limit.
- **Unknown space is unbounded**, so a portal into an unknown volume is taken only inside the ellipse
  `d(start) + d(goal) <= 1.5 x |start - goal| + 64` (`UNKNOWN_REACH_FACTOR`, `UNKNOWN_REACH_MARGIN`). `none`
  is exhaustive over the known world plus that ellipse. A goal in a sealed cave gives `none` quickly; a goal on
  the far side of a ravine with no known way round gives a corridor through never-seen chunks at the unknown
  price (and the walk explores, the layer re-plans as the chunks arrive).
- **Start / goal in solid**: looked for up to 2 cells above and below (a slab, a feet position inside a block),
  else `none` with the reason.

**Legs.** A leg is a maximal run of steps in one mode. It enters through the portal where the switch happened
(the switch is priced before the crossing; `entry`, in `portals`), crosses the portals of its steps, and leaves
by the next leg's entry (`exit`, in `portals` too); the last leg of a `found` corridor ends at the goal, of a
`partial` one at its last portal (no `exit`, the portal listed). A leg's end at a switch is the portal's centre
lowered to its `floorY` (a landing, a takeoff stand), so a fly leg followed by a walk leg ends on a floor (the walk
cost's `switchCost` refuses a landing without one). `waypoints`: from, the centres of the portals crossed inside,
to. `blocks` is the polyline length, `cost` the steps' prices, `unknownFraction` the share of the length inside
unknown volumes, `minClearance` the smallest height and the smallest width over the leg's portals (separately;
16 x 16 without portals).

## Following a corridor on foot (`nav/corridor.ts`, the navigator)

A goto whose goal has a point and is farther than `coarseMin` (straight line; default 96; 0 = off) asks the
layer for a corridor at its start, modes `['walk']` or `['walk', 'mine']` with `allowBreak`, `goalStanding`.
The first main plan waits up to 12 ticks for it (`CORRIDOR_WAIT_TICKS`). The corridor's waypoints (every leg's,
the start dropped, portal centres lowered to their floors, the goal last when `found`) become the fine planner's
goals a window at a time:

- the search goal is the farthest waypoint within 32 blocks of corridor ahead of the body (`WINDOW_BLOCKS`), as
  `near` with radius 2 (`WAYPOINT_RADIUS`; portal centres sit on cell edges); the goto's own goal once what is
  left of a `found` corridor is at most 48 blocks (`GOAL_DIRECT`) or the window reaches it;
- a waypoint within 4 blocks of the body is passed (`WAYPOINT_REACH`); otherwise the nearest upcoming one
  within 8 is re-aimed at (a re-plan from somewhere along the corridor; `REAIM_REACH`);
- a segment that reaches a waypoint is recorded `partial`, not `found`: its end plans ahead to the next window
  (the body does not stop), and the goto never finishes at a waypoint;
- a main plan towards a waypoint that comes back `none` or without progress is the corridor's failure, not the
  goto's: the waypoint's portal is marked `failed` for the leg's mode, the corridor dropped, a fresh one asked
  for, and the next plan goes to the goto's own goal meanwhile (today's behaviour). After 3 such failures in one
  goto (`CORRIDOR_MAX_FAILURES`) no corridor is asked for again;
- a `partial` corridor walked to its end asks for the next stretch from there;
- `onChange` with a chunk of, or next to, a remaining waypoint marks the corridor dirty; it is re-planned at most
  every 60 ticks (`CORRIDOR_REPLAN_TICKS`);
- a corridor that arrives while a plan towards the raw goal is under way re-plans (`ReplanReason` `corridor`);
- the no-retry skip of a no-progress plan (pathfinding.md) compares the search goal too (`noProgress.wp`), so a
  dropped corridor is a new search.

The report (`skills.status().lastGoto.corridor`): requests, the last corridor's status / legs / blocks /
waypoints / ms, waypoints passed, waypoints failed; the goto's log line ends with it.

Not changed: `bot/src/skills/fly/**` and `commands-fly.ts`. The flight registers its cost on
`skills.nav.coarseLayer` and follows fly legs itself (Track F4b).

## Budget (measured 2026-11-06, `coarse-perf.test.ts`, a 64 x 64-chunk hilly source with ponds, 32 rows)

| | |
|---|---|
| corridor across the diagonal (1 579 blocks, 144 waypoints), cold | 134 ms: 276 nodes expanded, 321 chunk graphs built in 79 ms (0.25 ms each), 453 borders in 45 ms |
| the same, warm | 2.9 ms |
| walk + mine, warm (dig portals in every expansion) | 8.9 ms, 479 expanded |
| plain A* (weight 1), cold, for comparison | 1 956 ms: 48 820 expanded, every chunk built (4 283) |
| closed loop on a generated world (`nav-corridor.test.ts`): a wall on a chunk border, one gap 40 blocks off the line, goal 120 away | reached in 586 ticks following the corridor (14 plans); the fine planner alone (3 000 nodes per segment) also reached it in 576 ticks here: the wall is 15 blocks away, well inside one segment's sight. The corridor's value is at the owner's scale (hundreds of blocks), which a unit closed loop cannot afford |

Real chunks have 384 rows but most sections are all solid or all sky, which the builder skips; expect a few ms per
chunk on a cached area and a first corridor of a few hundred ms over 1 000 blocks, then milliseconds.

## Recipes

**A new mover (a boat, a minecart, a horse).** Write a `CoarseCost`: `clearance`, `allows(kind)`, `edgeCost`
(Infinity for `portal.dug !== undefined` unless it digs; Infinity on `outcome === 'failed'`; price `to.kind ===
'unknown'` with `unknownCost`), `switchCost` (Infinity where the mode cannot start: a boat not on water), and a
truthful `ticksPerBlock`. Register with `layer.setCost(mode, cost)` (a new `CoarseMode` is a types.ts change:
ask). Request with `modes: [...]`; follow the legs of your mode; `markPortal` what fails.

**A mixed trip.** `modes: ['walk', 'fly']`: the legs alternate; a fly leg before a walk leg ends on the entry
portal's floor (the cave mouth): land there, hand the walk its leg. Compare against `modes: ['fly']` for the
fly-only price.

**A plan-only question** ("is there a walk to X at all?", "how far is the cave entrance?"): `plan` with
`maxMs` small; read `status`, `blocks`, `unknownFraction`, `legs[i].minClearance`. Never throws.

**A test world.** `terrainSource(gen)` over a `GenWorld` (`test/unit/skills/genworld.ts`), `new
CoarseLayerImpl(source, { now })` (the clock for the decay); chunks outside the box are unknown, so a sealed test
needs the start enclosed by known solid, and `known: (cx, cz) => ...` hides chunks to test unknown crossings.
After `gen.fill` call `source.reset(cx, cz)` and `layer.invalidate(cx, cz)`.

**Reading the graph.** `layer.volumeAt(p)` (feet cell), `layer.portal(id)`, `layer.graph.portalsOf(v)`,
`layer.info()` (chunks in memory, revision, marks, build / border counts and times, plans by status).

## Rules

1. `types.ts` is the contract with the flight; additive optional fields only, documented here and in the file.
2. The layer never throws out of `plan`: a failure is `none` / `partial` with a `reason`.
3. Nothing in the layer blocks a tick: the search is sliced, chunk graphs are built lazily and bounded by the
   LRU, border portals are cached against build numbers.
4. Portal ids are cell-based so feedback survives rebuilds; never derive an id from a volume's label.
5. Unknown space is crossable at a price, never free and never blocked, and only inside the ellipse.
6. Costs are rough and in ticks; the fine planner decides the steps. A cost that says Infinity must be
   right (a corridor refused is a long walk the bot never tries); a cost that is merely high is cheap to fix.
7. A mode's failure feedback is its own: mark the mode that failed, not every mode.
8. The navigator keeps today's behaviour whenever the corridor is none, unavailable, dropped or exhausted:
   the raw goal, the same budgets, the same re-plans.

## Reviewer checklist

- [ ] `types.ts` unchanged beyond documented optional additions; the flight session informed of any.
- [ ] A chunk graph for a flat chunk is one sky volume with 256 floor cells and no section labels; a sealed
      cave is `cave` with headroom; a lake is `water` with floor cells (its bed) and the sky over it has none.
- [ ] Portal ids equal before and after `invalidate` of the chunks along a corridor, and after a change
      elsewhere in a chunk (`coarse.test.ts`).
- [ ] A failed portal re-routes through the other opening and is tried again after the decay.
- [ ] A fly-only request from the ground pays a takeoff; from the air it does not; a mixed corridor's fly
      leg ends on the entry portal's floor.
- [ ] `coarse-perf.test.ts` cold under 500 ms; `layer.info().chunks <= maxChunks` after a long plan.
- [ ] `coarseMin` in `SETTING_GROUPS` (`style.test.ts` guards it); `!set coarseMin 0` turns the corridor off.
- [ ] A goto that follows a corridor ends `ok` at the goal, never at a waypoint; its report has `corridor`.
- [ ] `pnpm lint` clean, `pnpm test` green; a timing test that fails under load is re-run alone and reported.
