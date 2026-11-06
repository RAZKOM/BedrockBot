# 0062: The map-first panel screen: one painting module, map tiles on the push channel, actions as visible commands

Date: 2026-11-05. Status: accepted (web panel programme, step 2, Track P2). It builds on
[0026](0026-lan-control-panel.md), [0039](0039-panel-interactions.md),
[0060](0060-surface-layer.md) and [0061](0061-panel-push-and-modules.md). Details are in
[../map.md](../map.md) (views, layers, painting, wire, overlays, actions, recipes, checklist) and
[../panel.md](../panel.md) "Map screen".

## Context

The panel's map was one collapsible card among a dozen: a 14.5 KB module drawing `/map.json`. Every 2 s
it polled the window's changed tiles together with every overlay and the whole palette. The debug page
`/map` painted the same tiles with its own copy of the colour rules, kept as a JavaScript string
(`PAINT_JS`), so every change to the colours had to be made twice.

On a phone the owner mostly wants to see where the bot is and what is around it, then tell it to go
somewhere or do something there. The cards answer the other questions. Step 2 of the programme asked
for these:

- **The map first.** The page opens on a full-screen map, touch-first, with the cards one tap away.
- **One painting module** for the panel and `/map`.
- **Tiles pushed** over the step 1 channel instead of polled.
- **Closer zooms** with block textures, a class view and a Y-slice.
- **Overlays** for what the bot knows.
- **Point-and-click and box actions** that cannot surprise the owner.

## Decision

### 1. Two views, the map first

`GET /` renders both views. A tiny inline script sets `data-view` on `<html>` before the first paint,
from `bbpanel-view` in storage (default `map`), so neither view flashes. Storage is read and written in
try/catch, so a private window still works.

The cards are unchanged, and a page on the cards joins no map topic and runs no map timer. The map's
subscription starts the first time the map is shown. The HUD (health, food, the job with its ETA,
Stop) renders from the same state the cards use.

### 2. One painting module, used by both pages

`health/panel/client/paint.ts` is a pure browser module with no DOM and no globals. It holds the
painting rules: decode a tile, the surface colour with relief, the water depth, the class fallback,
the under-roof layer, and the freshness fade.

- The panel imports it like any client module.
- The debug page gets `PAINT_JS = paintScript()`: the same file, type-stripped, with its import and
  export lines removed, built once per process.
- A unit test runs `PAINT_JS` in a VM and checks the pixels match the module's.

**Freshness.** A column the bot sees now is painted at full strength. A remembered column is mixed
toward a pale grey (`MAP_PALE`, #a8acb2) by `0.25 + 0.35 × (1 − 2^(−age_h / 24))`, which is 0.25 at
once and approaches 0.6. It is paled rather than darkened, so old ground still reads as ground and is
not mistaken for shadow.

### 3. Map tiles on the push channel

`health/map/live.ts` (`MapLive`) adds two topics to the panel's `StreamHub` and two GET routes.

- **`GET /api/map/tiles?cid&cx&cz&r&pal`** returns the compact tiles of a window. It also registers
  that window for client `cid`: at most 8 windows, each expiring after 2 min.
- **The `map` topic** is an event topic. Every second, if the cache's revision moved and a client is
  streaming, it sends the tiles that changed inside any registered window as `{from, rev, dim, tiles,
  palFrom, palette}`. `from` chains the messages, so a page that missed one fetches with `since`. A
  dimension change sends `reset`.
- **The `map-live` topic** is a state topic: a snapshot, then deltas. It carries the bot, trail,
  path, goal, entities, home, shelter and waypoints, which used to be repeated in every poll.
- **`GET /api/map/slice?y`** returns the cache class of every cell at height y. For loaded columns it
  also returns the block names.
- **Compact tiles** store heights as a base plus u8 offsets, and the surface y as an int8 difference
  (`sd`), falling back to the old fields when a value does not fit. The global palette is
  append-only, so each client is sent each entry once.
- **Without SSE** the page polls `/api/map/tiles?live=1` every 2 s.

Rejected:

- **WebSocket**: the step 1 channel is SSE, and the map needs no client-to-server stream.
- **Per-client tile diffs on the server**: one revision stream plus registered windows is simpler.
  A gap is cheap to repair with `since`.
- **Binary frames**: SSE is text. The gzip from the compact fields comes close, with nothing new to
  parse.

### 4. Textures at the closest zooms, from the owner's own game files

`GET /tex/<block>.png` serves the block's 16 × 16 top face from the installed resource pack (the same
source, allowlist and caching as `/icons/`). It returns 404 when there is no art, and the map keeps
the colour. Nothing derived from the art is in git. The page asks for textures only at 10 CSS
pixels per block or more, and keeps 96 tiles of them.

### 5. Actions are chat commands shown before they are sent

`client/mapdefs.ts` holds the registries the screen is built from:

- `MAP_OVERLAYS` (16 switches);
- `MAP_LAYERS` (surface, classes, Y-slice). Under a roof, as in the Nether, the surface layer shows
  the layer under the roof by default;
- `MAP_ACTIONS`: each action names its chat command and builds the exact text from the tapped block
  or the dragged box.

The sheet shows that text, and the size for a box. Only Send posts it, through `POST /api/cmd`: the
panel's owner and rate limit, with the reply under the command. The map adds no command of its own.
Every action is an existing command (`!goto`, `!fly`, `!wp set`, `!home set`, `!shelter set`,
`!build clear|fill|floor|wall`, `!tunnel`, `!quarry`), so no `chat/commands-map.ts` was needed.

Rejected:

- **A map-only REST API for actions**: a second path into the skills, with its own checks.
  Commands are already audited, rate-limited, owned and documented.
- **Sending on tap**: one confirm tap is cheap, and it shows the owner exactly what will run.

### 6. Guards

`map-guards.test.ts` checks four things:

- every action's command is registered in the real afk registry (a subcommand must appear in the help);
- each built command fits one chat message;
- every action, overlay and layer has exactly one row in docs/map.md;
- every overlay is drawn.

The budgets gain `mapMessage` (96 KB: a row of 21 worst-case tiles is 75 KB), `mapLive`,
`mapLiveDelta` and `mapFetch`. `modules` rises from 120 000 to 170 000.

## Consequences

- **Cost of the open map.** Over 10 s at r=4 on bds-cache land terrain, with the bot standing, the
  map moves 2.4 KB gzip. The old poll moved 7.1 KB gzip, before counting the cards' own poll. A
  changed block reaches the page in 0.1 to 0.9 s.
- **First load.** A first load is 4 to 25 % smaller gzipped than `/map.json` for the same window
  (17 to 32 % raw). The rest of the gain comes from never sending a full window again.
- **Page weight.** The map screen is about 80 KB of modules (`modules` 160 KB in all, 53 KB gzip),
  fetched once per bot version. The page HTML is 116 KB at worst, against a 120 KB budget.
- **Debug page.** `/map` and the panel can no longer disagree on colours.
- **Adding to the map.** A new overlay or action is one registry entry, one drawing or command
  function, and one doc row. The guards fail until the row exists.
- **Tests that read the HTML.** Tests that read the page see the map first. The fake-DOM harness
  defaults to the cards view so the card tests keep working.
- **Generated-world e2e.** The e2e runs on a generated world (bds-cache). `CORE_FEET_Y` lets the
  flat-world panel e2e suites run there too.
