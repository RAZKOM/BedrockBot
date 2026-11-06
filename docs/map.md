# The map screen

The control panel ([panel.md](panel.md)) opens on a full-screen 2D map of what the bot knows about the
world: its world cache ([world-cache.md](world-cache.md)) with the surface layer
([decisions/0060](decisions/0060-surface-layer.md)), the bot and what is around it, and the places it
remembers. You can tap a block or drag a box to send the bot there or set it to work. Every action is
one chat command: the sheet shows the exact `!command` (and a box's size) first, and one tap on **Send**
posts it through `POST /api/cmd` like every panel action. Decision:
[decisions/0062](decisions/0062-map-screen.md).

The `/map` debug page ([world-cache.md](world-cache.md) "Debug map") stays. It is a plain page on the
health server that polls `/map.json`, and it paints with the same module as the map screen
("Painting" below).

## Views

- **Map** (the default). A fixed full-screen canvas over the page. In the top left a compact HUD
  shows health, food, the current job with its ETA, and **Stop** (`!stop`). On the right are the
  controls: **Cards**, follow (the target), zoom `+` / `-`, box mode, and layers.
- **Cards**: the panel's cards as before. The **Map** button in the header goes back to the map.

The choice is kept in this browser: `localStorage` `bbpanel-view`, in try/catch like every storage
access. A tiny script in `<head>` applies it before the first paint, so a phone that chose the cards
does not flash the map. The map's switches (layer, overlays, textures) are kept in `bbpanel-map`. A
page on the cards joins no map topic and fetches no tile until the map shows.

**Gestures** (`client/mapinput.ts`) are touch first:

- **Drag** pans. **Pinch** zooms about the fingers' midpoint. The **wheel** zooms about the pointer.
- **Tap** a block for its sheet. A right-click or a long-press does the same.
- **Follow** (on at the start) keeps the bot centred. Panning turns it off; the target button turns it
  on again and re-centres.
- **Box mode** (the square button): a drag draws a box, and the four corner handles can then be
  dragged. A tap draws a one-block box.

The layout works from 360 px wide. The HUD shrinks and ellipsises the job, the controls sit in one
column on the right, and the sheet slides up from the bottom; from 760 px the sheet is a card on the
right.

## Layers

| id | What it shows |
|---|---|
| `surface` | The default. Each column in its surface block's map colour, shaded like the in-game map: relief against the column to the north, liquids darker with depth with the game's checkerboard. In a roofed dimension (the Nether) the under-roof layer is shown, so you see the floor the bot walks on and not the bedrock roof. At the closest zooms (10 CSS px per block and more) each column shows its block's top-face texture ("Textures"). |
| `class` | The cache's 2-bit classes (air, solid, water, lava) shaded by height: the view from before the surface layer, and what columns without surface data always show. |
| `slice` | A horizontal cut at one height. The **-** / **+** buttons or the slider move it one block at a time; it starts at the bot's feet. Remembered columns show the 2-bit class of each cell (air dark, solid grey, water blue, lava orange). Loaded columns show the real block's colour, and a tap names it (`100 12 -50: iron_ore`). The slice is fetched per height for at most 8 chunks around the view (`GET /api/map/slice`). |

## Painting

Painting lives in one module, `health/panel/client/paint.ts`. It has no imports but types, reads no
browser global (base64 is decoded in the module), and covers:

- decoding a tile (the `/map.json` form and the compact form);
- surface colours;
- relief shading against the column to the north;
- liquid depth shading;
- the class view, and the class fallback for columns without surface data;
- the freshness fade;
- the Y-slice;
- the text a tap shows.

The map screen imports it as a browser module. The `/map` page is a classic inline script on the plain
health server, which has no panel, no `/ui/` route and no token, so it embeds the same file as text:
`health/map/paint.ts` `PAINT_JS` is `paint.ts` with its types stripped (Node's
`stripTypeScriptTypes`, as the panel serves its modules) and the `export` keywords dropped, made once
per process. A unit test checks that `PAINT_JS` paints the same pixels as the module.

**Freshness.** A loaded (live) tile is drawn as it is. A remembered tile is mixed toward pale grey
(`MAP_PALE`, 168 172 178) by

    fade(age) = 0.25 + 0.35 x (1 - 2^(-age / 24 h))

So it is 0.25 at once, 0.43 after a day, 0.51 after two days, and approaches 0.6. The older the
memory, the paler the column. Loaded tiles have an outline on the debug page.

**Textures.** `GET /tex/<block>.png` is the block's top face, 16 x 16 (decision 0046's reader of the
installed `minecraft-assets` package, the same tints as the map colours). It has the same name rule
(`[a-z0-9_]{1,64}`), the same token, and the same caching as `/icons/`: a day for a picture, 5 minutes
for a 404. Art at higher resolution is scaled to 16 x 16, and an animated texture uses its first
frame. The page builds one 256 x 256 canvas per tile, with each column's texture shaded and faded like
its colour. A 404 keeps the colour. The textures are off when the server has no art (`state.icons`
false) or when the owner switched them off. Nothing derived from the art is in git.

## Wire

| What | How |
|---|---|
| First load and window changes | `GET /api/map/tiles?cid&cx&cz&r&pal[&since&win][&live=1]`, gzipped. It returns the compact tiles of the window (r up to 16 chunks; incremental with `since` + `win` like `/map.json`) and registers the window of client `cid` for the `map` topic. The page asks when the view leaves the registered window or grows, and again every 45 s to keep the registration (it expires after 2 min). |
| Tile changes | The `map` topic on the panel's stream (`GET /api/stream?topics=...,map`), an event topic. Every second, when the cache's revision moved, the server sends the tiles that changed in any registered window: `{from, rev, dim, tiles?, palFrom?, palette?}`. A message whose `from` is newer than the page's revision means one was missed, so the page fetches with `since` = its revision. A dimension change sends `{reset: true}` and the page reloads its window. With no streaming client nothing is sent, and the revision moves on, so a late client gets no backlog. |
| Overlays | The `map-live` topic, a state topic (a snapshot, then deltas): `{dim, bot: [x, y, z, yaw], trail: [[x, z]...], path, goal, busy, result, ents: {id: [kind, type, x, y, z, name?]}, home, shelter, wps: [[name, x, y, z]...]}`. Sampled every second while a stream listens. |
| Marks | `GET /api/marks?cx&cz&r` for the view's window, every 15 s while the map shows: chests with what the chest memory knows (`top`, `stacks`, `size`, `readAt`), herds, and `blocks` (ores, spawners, beds, stations, farmland, forests) from the cache's marks. |
| Y-slice | `GET /api/map/slice?y&cx&cz&r&pal` (r up to 8): `{y, tiles: [{cx, cz, live, updatedAt, y, c, n?, p?}]}`. `c` is the cache class of each cell (64 bytes), and `n` + `p` the block names of loaded columns (u8 indices into `p`, which indexes the palette; 255 = air or unknown). |
| Without the stream | The page polls `/api/map/tiles` every 2 s with `live=1` (the overlays come along) and the slice with it. |

**Compact tiles** (`CompactTileSchema`) cut the payload in two ways:

- **Heights.** `yb` (a base) plus `y8` (256 x u8 offsets, 255 = nothing) when the tile's height range
  fits in 254, else `y` (int16) as before.
- **Surface y.** `sd` (256 x int8, surface y minus height) when every offset fits, else `sy` as
  before.

**The palette.** `p` indexes one global palette per process, append-only, so each answer and message
carries only the entries the client lacks (`pal` = how many it has, `palFrom` / `palette` = the new
ones). The server waits for an entry's colour before it sends the entry, so a colour never changes
after a client has it.

**Measured.** These numbers compare `/map.json` with `/api/map/tiles` for the same window on bds-cache's
generated terrain (from the panel-map e2e measurement lines; gzip is `gzipSync` level 6). Two
random areas are shown: land with forest, and open ocean. At r=12 the window held 399 tiles, the chunks
the bot had seen.

| Window | Area | `/map.json` raw | `/map.json` gzip | `/api/map/tiles` raw | `/api/map/tiles` gzip |
|---|---|---|---|---|---|
| r=4 (81 tiles) | land | 173 849 | 30 408 | 119 668 (-31 %) | 23 793 (-22 %) |
| r=4 (81 tiles) | ocean | 156 340 | 10 265 | 128 608 (-18 %) | 9 588 (-7 %) |
| r=12 (399 tiles) | land | 825 256 | 146 786 | 558 779 (-32 %) | 110 639 (-25 %) |
| r=12 (399 tiles) | ocean | 767 670 | 42 994 | 634 715 (-17 %) | 41 246 (-4 %) |

**After the first load,** the stream moves only the tiles that changed: about 1.4 KB per tile on
generated terrain. The first message after a client registers was 25 tiles, 35.7 KB; one changed block
was 1 tile, 1.0 KB.

**The open page over 10 s** (r=4, the bot standing):

- The `map` topic sent 12 messages, 14 711 B raw (2 379 B gzip). Over ocean it sent 12 messages, 37 445 B raw
  (2 830 B gzip).
- The old page's poll, five `/map.json?since=&win=` calls, would have moved 22 005 B raw (7 074 B gzip) on
  land and 39 959 B raw (6 402 B gzip) over ocean,
  because each answer repeats the overlays and the palette.

The overlays now come once a second as `map-live` deltas, which these counts do not include. The unit
budget test measures a busy delta at 1 276 B.

The budgets are in `health/panel/budgets.ts` (`mapMessage`, `mapLive`, `mapLiveDelta`, `mapFetch`).
`panel-budgets.test.ts` checks them on synthetic worst cases.

## Overlays

Each overlay has a switch in the layers panel; the switches are built from `mapdefs.ts`
`MAP_OVERLAYS`, so the markup needs no change for a new one.

| id | Default | Data | Drawn as |
|---|---|---|---|
| `bot` | on | `map-live` `bot` | a white arrow by its yaw, drawn last |
| `trail` | on | `map-live` `trail` (about one point a second, 300 kept) | a faint line |
| `path` | on | `map-live` `path` and `goal` (the navigator's report) | a yellow line and an X at the goal |
| `waypoints` | on | `map-live` `wps` (the afk task's waypoints) | cyan diamonds, named at close zoom |
| `home` | on | `map-live` `home` and `shelter` | green (home) and violet (shelter) squares |
| `players` | on | `map-live` `ents` of kind player | dots, named at close zoom |
| `hostiles` | on | `map-live` `ents` of kind hostile | red dots |
| `passive` | on | `map-live` `ents` of kind passive or neutral, and `/api/marks` herds | green dots; herds as rings (`herd: 5 cow (penned)`) |
| `items` | off | `map-live` `ents` of kind item | small yellow dots |
| `ores` | on | `/api/marks` `blocks.ore` (cache marks) | diamonds coloured by ore (diamond cyan, iron tan, gold yellow ...) |
| `chests` | on | `/api/marks` `chests` | brown squares; a tap shows what the chest memory knows (`holds 12 coal, 3 iron ingot (2/27 slots)`, `read 3 min ago`) |
| `spawners` | on | `/api/marks` `blocks.spawner` | crossed squares |
| `beds` | on | `/api/marks` `blocks.bed` | red squares |
| `stations` | off | `/api/marks` `blocks.station` (crafting tables, furnaces, smokers, blast furnaces) | tan squares |
| `farmland` | on | `/api/marks` `blocks.farmland` | brown cells |
| `forests` | off | `/api/marks` `blocks.forest`: a chunk with `FOREST_LOGS` or more log marks, placed at the logs' centroid | green rings with the log count |

A tap lists the markers within 1.5 blocks under the block's name: its height, and for a chest its
contents.

## Actions

The sheet offers the actions that apply (`mapdefs.ts` `MAP_ACTIONS`). For a block, "feet" means the
block above the tapped one: its surface y + 1, or the bot's y when the map does not know the height.

| id | Label | Command | When |
|---|---|---|---|
| `walk` | Go here | `!goto x feet z` | the height is known, or the bot's is |
| `fly` | Fly here | `!fly x feet z` | the bot wears or carries an elytra |
| `wp` | Set waypoint... | `!wp set <name> x feet z` | asks a name (1..32 of a-z 0-9 _ -); Send stays off until it is valid |
| `home` | Set home here | `!home set x feet z` | as Go here |
| `shelter` | Set shelter here | `!shelter set x feet z` | as Go here |
| `dig` | Dig this block | `!build clear x y z x y z` (a 1 x 1 x 1 clear) | the block is known and not air, water, lava or bedrock |
| `tunnel` | Tunnel to here | `!tunnel <north/south/east/west> <length>` | the block is within one block of a straight line north, south, east or west of the bot, 2 to 256 away (`!tunnel` digs from the bot's feet) |
| `clear` | Clear | `!build clear x1 y1 z1 x2 y2 z2` | a box |
| `fill` | Fill | `!build fill x1 y1 z1 x2 y2 z2 <block>` | a box and a block picked from the inventory |
| `floor` | Floor | `!build floor x1 y1 z1 x2 z2 <block>` | a box and a picked block (at the lower y) |
| `wall` | Wall | `!build wall x1 y1 z1 x2 z2 <height> <block>` | a box and a picked block; along the drag, first corner to second, from the lower y up |
| `quarry` | Quarry | `!quarry x1 y1 z1 x2 y2 z2` | a box (`!quarry` caps each side at 64) |

The box's y range is two numbers. They default to the lowest and highest surface of the box's columns,
and you can edit them. The sheet shows the size (`5 x 3 x 5 = 75 blocks`) with every box command. The
block picker lists the blocks the bot carries, most first.

**What is not offered.** Mining a single ore by position needs no new command, because Dig is
`!build clear` on one block. `!get <ore>` is not positional. No command was missing, so there is no
`chat/commands-map.ts`.

**Offline.** While the bot is not spawned the sheet shows the banner's state instead of actions, as
the panel's menus do.

## Files

| File | What |
|---|---|
| `health/panel/client/paint.ts` | the shared painting (above) |
| `health/panel/client/tiles.ts` | the tile store: fetches, the `map` topic, gaps, the palette, the slice |
| `health/panel/client/mapview.ts` | the screen: the view switch, layout, drawing, the tap sheet, layers, HUD |
| `health/panel/client/mapinput.ts` | gestures (pan, pinch, wheel, tap, box handles) |
| `health/panel/client/maptex.ts` | the textures of the closest zooms |
| `health/panel/client/overlays.ts` | markers from `map-live` and marks, and their drawing |
| `health/panel/client/mapsheet.ts` | the sheet: what was tapped, the actions, confirm before Send |
| `health/panel/client/mapdefs.ts` | the registries: overlays, layers, actions (pure; the server and the guards import it) |
| `health/map/live.ts` | `MapLive`: the topics, `/api/map/tiles`, `/api/map/slice`, the window registry |
| `health/map/data.ts` | `MapBuilder` (tiles, `live()`), `packTile`, `GlobalPalette` |
| `health/map/paint.ts` | `PAINT_JS` for the debug page, generated from `paint.ts` |
| `health/panel/marks.ts` | `/api/marks`: chests with contents, herds, block marks |
| `health/panel/icons/colours.ts` | `BlockColours.texture` (`/tex/`) |

## Recipes

### Add an overlay

1. Add an entry to `MAP_OVERLAYS` in `client/mapdefs.ts`: an id, a label, a colour, on or off by default,
   and the source. The layers panel gets its switch from this.
2. If the data is new, add it to the source:
   - `MapBuilder.live()` in `health/map/data.ts` for something that moves (sampled every second, sent
     as deltas). Keep it small: the `mapLive` budget.
   - `mapMarks` in `health/panel/marks.ts` for something remembered (fetched every 15 s).
3. Push the markers in `markers()` in `client/overlays.ts` behind `on('<id>')`, with a shape and a
   label. Add `more` lines if a tap should show details.
4. Add a row to "Overlays" above. The guard test fails until the row is there.
5. Run the unit tests: `map-guards.test.ts`, `panel-budgets.test.ts`, and `panel-page.test.ts` for
   the screen.

### Add a map action

1. Find the chat command. If none does the job, add one in a new `chat/commands-map.ts` and register
   it in `index.ts`, with help text naming its subcommands.
2. Add an entry to `MAP_ACTIONS` in `client/mapdefs.ts`: an id, a label, the kind (`point` or
   `box`), `command` (its words, e.g. `build clear`; the guard checks they are registered), a `doc`
   line, and `point` / `box` returning the exact command, or null when it does not apply. A name to
   ask goes in `prompt`, with `{name}` in the command.
3. A destructive box action gets `confirm` in `boxActions`, which makes Send red.
4. Add a row to "Actions" above. The guard test checks the row and the `!command`.
5. Test it end to end against a BDS: `test/e2e/panel-map.test.ts` shows how.

## Reviewer checklist

- [ ] Every action shows its exact command (and a box's size) before it is sent, and only Send posts
      it (`POST /api/cmd`, the panel's rate limit and owner).
- [ ] Every `MAP_ACTIONS` command is registered, and every action, overlay and layer has its row here
      (`map-guards.test.ts`).
- [ ] The browser modules read no browser global outside `boot.ts`, and each one stays under 20 KB
      (`panel-modules.test.ts`, `panel-budgets.test.ts`).
- [ ] A new wire field is in `schema.ts` (`CompactTileSchema`, `SliceTileSchema`) and in "Wire"
      above. A topic message stays under its budget.
- [ ] Nothing derived from Mojang art is committed: `/tex/` and `/icons/` read the installed package
      at run time.
- [ ] A page on the cards still joins no map topic, and the map still works without the stream (it
      polls with `live=1`).
- [ ] No real coordinates, names or server details in tests or docs.

## Tests

- `test/unit/health/map-colours.test.ts`: the painting, `PAINT_JS` equal to the module, the compact
  decode, the freshness curve, and `BlockColours.texture`.
- `test/unit/cache/map-live.test.ts`: `/api/map/tiles` (compact, palette once, windows, `live=1`),
  the `map` topic over a real hub and SSE (`from` chaining, dimension reset, quiet without
  clients), `map-live`, the slice, the routes, and the payload against `/map.json`.
- `test/unit/health/panel-page.test.ts` "the map screen": the screen on the fake DOM. It covers the
  view switch, the topics, tiles over the stream and gaps, the tap sheet with Go here, a waypoint
  name, Dig, box Clear and Floor, the slice, kept switches, follow and pan, and the poll fallback.
- `test/unit/health/panel-menu.test.ts`: the action commands (`pointActions`, `boxActions`) and the
  block marks.
- `test/unit/health/panel-server.test.ts`: `/tex/` behind the token.
- `test/unit/health/map-guards.test.ts`: the guards.
- `test/e2e/panel-map.test.ts` on bds-cache (`BDS_E2E=1`). The map screen loads, and tiles over the
  stream match the truth for sampled columns. A Y-slice matches the truth. Go here sends `!goto` and
  the bot arrives. A box Clear digs a small area. A waypoint set from the map is in `!wp`. It also
  prints the sizes above. Run it from `bot/`:

  ```
  BDS_E2E=1 PANEL_MAP_E2E_PORT=9950 npx vitest run --project e2e --silent=false test/e2e/panel-map.test.ts
  ```

  It builds a floating stone platform at y 200 in a random far area and removes it afterwards.
- The panel-core, panel-actions and panel-stream e2e also run on a generated world. They need
  `CORE_BDS_PORT=19184 CORE_BDS_CONTAINER=bds-cache CORE_FEET_Y=240`: their floor then floats at
  y 238 to 239.
