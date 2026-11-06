# LAN control panel (`bot/src/health/panel`)

Phase 7, wave 8 Track AE; the graphical inventory, the status blocks and the responsive layout are
wave 9 Track AP; the interaction (context menus, map actions, grouped settings, command palette) is
wave 10 Track AR; the real item icons are wave 11. Decision records: [decisions/0026-lan-control-panel.md](decisions/0026-lan-control-panel.md),
[decisions/0037-panel-inventory-and-statuses.md](decisions/0037-panel-inventory-and-statuses.md),
[decisions/0039-panel-interactions.md](decisions/0039-panel-interactions.md),
[decisions/0046-item-icons.md](decisions/0046-item-icons.md).
It extends the health endpoint ([runbook.md](runbook.md) "Operations") and embeds the debug map
([world-cache.md](world-cache.md)).

The panel makes the bot controllable from a phone or another machine on the owner's LAN without the
game open: one page at `/` on the health server, a JSON endpoint it polls, and a command box that runs
`!commands` through the same chat command handler as the game.

## Turning it on

Nothing changes until the health server runs: with `healthPort` (or `--health-port`) set, the panel
is at `http://127.0.0.1:<healthPort>/` on the bot's machine, next to `/healthz`, `/metrics` and `/map`
(which keep their paths and answers).

For the LAN, the config file's `panel` block (`pnpm config:init` writes it with a fresh token and
prints the token once):

```jsonc
"healthPort": 9465,
"panel": {
  "host": "0.0.0.0",            // default "127.0.0.1"; any other interface needs the token
  "port": 9466,                 // default: healthPort (one server)
  "token": "q3Xk...24 chars"    // A-Z a-z 0-9 . _ ~ -, 16..128 characters; env BEDROCKBOT_PANEL_TOKEN wins
}
```

| `panel.port` | What serves where |
|---|---|
| absent or = `healthPort` | one server on `panel.host:healthPort`: `/healthz`, `/metrics`, `/map`, the panel; with a token every path except `/healthz` needs it |
| another port | the health server stays exactly as before (127.0.0.1, no token); the panel gets its own server on `panel.host:panel.port` with `/healthz`, `/metrics`, `/map` and the panel, behind the token |
| neither port | off; `!panel` says how to turn it on |

**Without a token the panel never binds anything but the loopback.** `panel.host` `0.0.0.0` (or a LAN
address) without a token logs
`panel: refusing to serve on 0.0.0.0 without panel.token; serving on 127.0.0.1 only (...)` and serves
on 127.0.0.1. The bot keeps running either way; a port that is taken exits 2 like the health endpoint.

On start the log names the URLs: `control panel: http://192.168.1.20:9466/ http://127.0.0.1:9466/
(token required)`. In game, `!panel` replies with the same list (the machine's LAN IPv4 addresses for
`0.0.0.0`), never the token.

**Keep it on the LAN.** The panel can make the bot walk, fight, drop its inventory and quit. Never
port-forward it on the router or expose it through a tunnel; if the token leaks, change it in the
config file and restart the bot (old cookies stop working).

## The page (`GET /`)

The server renders the structure, the settings table and the current state as JSON. Then the page's
browser modules (TypeScript under `health/panel/client/`, type-stripped at startup and served by the
bot; "Browser modules" below) fill every node from that JSON at once. After that the push channel
keeps them current: `GET /api/stream`, with `/api/state?lite=1` polling as the fallback ("Live
updates"; decision 0061).

There is no build step and nothing external:

- no CDN and no web fonts (the system font);
- no image files in the page: the item glyphs are inline SVG, and the real icons are requests to
  the panel itself ("Item icons" below).

The machine may be offline from the internet.

### Layout

Dark by default; the **light / dark** button in the header switches and remembers the choice in the
browser (`localStorage` `bbpanel-theme`; every storage access is in try/catch, so a private window
or blocked storage just means the choice is not kept). Without a stored choice the browser's
`prefers-color-scheme: light` gives the light theme. A tiny script in `<head>` sets the theme before
the first paint (no dark flash on a light phone).

**The page opens on the map** (decision 0062; [map.md](map.md)), a full-screen map with a small HUD
(health, food, the job and its ETA, Stop). The **Cards** button switches to the cards and the **Map**
button in the header switches back. The choice is kept in `localStorage` `bbpanel-view`, and a tiny
script in `<head>` applies it before the first paint. A page on the cards joins no map topic and runs
no map timer.

The cards sit in a grid: **one column on a phone** (under 760 px wide; the order is inventory, bot,
status, commands, combat, memory, planner, connection, log, settings, help), **two columns** on
a tablet or a small laptop window, **three** from 1200 px (inventory, bot and status side by side on
the first row). Settings and help always span the full width. Nothing is wider than the screen
at 360 px: tables scroll inside their card, long lines wrap, and the body never scrolls sideways.

### Inventory

The inventory looks like the game's: a 9 x 3 grid of the main inventory (slots 9..35) with the
hotbar (slots 0..8) as a separate bottom row, the selected hotbar slot outlined in the accent
colour, and the four armour slots (head, chest, legs, feet) plus the offhand **beside** it when the
card is at least 430 px wide (a container query), or as a row above it on a phone. Cells scale with
the card (about 30 px on a 360 px phone, 46 px at most).

Each cell shows the game's own icon when there is one ("Item icons" below) and otherwise is drawn: a
hand-drawn 16 x 16 glyph for the item's class (`sword`,
`pickaxe`, `axe`, `shovel`, `hoe`, `bow`, `shield`, `helmet`, `chestplate`, `leggings`, `boots`,
`food`, `block`, `ore`, `box`, `bucket`, `torch`, else a plain rounded `item` tile) in the item's
colour (the material's colour for iron / gold / diamond / netherite / wood / stone / leather / ... ,
else a colour from an FNV-1a hash of the name, so the same item has the same colour everywhere), a
2 to 3 letter abbreviation in the corner (`Co` cobblestone, `ISw` iron sword, `USB` undyed shulker
box), the count when above 1, and a **durability bar** (green above 50 %, yellow above 20 %, red
below) on tools, weapons and armour (NBT `Damage` against the durability tables of
`skills/survival/tools.ts`). Hovering shows the full name, count, durability and box contents;
**tapping a cell** shows them in the line under the grid and opens the cell's action menu (Track AR,
"Interaction" below; tap again to close). Empty armour slots show a diagonal stroke.

### Item icons

A cell asks `GET /icons/<name>.png` once per item name (`cobblestone`, `iron_sword`; Bedrock names,
lower case) and shows the picture over its glyph when it arrives; the count, the durability bar and
the tooltip are the same. The glyph and the letters stay when the answer is a 404 (an item with no
icon), when the request fails, or when the server says it has no pictures (`icons: false` in the
state: the package below is not installed; the panel logs `panel: item pictures off (the
minecraft-assets package is not installed: pnpm install); ...` once and asks for nothing). A name that answered 404 is remembered by the page, so it is not asked again.

Where the pictures come from: the `minecraft-assets` npm package (PrismarineJS, MIT; the art is
Mojang's), folder `26.1` of `node_modules`, installed by `pnpm install` like any dependency (the Mac
gets it through `pnpm deploy:server`). Nothing of it is in git. The server (`health/panel/icons/`) reads
the item and block models and textures on the first request and renders each icon on demand:

- **a flat item** (`iron_sword`, `bread`, `bucket`) is its texture, untouched (16 x 16; the first
  frame of an animated one), with the game's tints: leather armour brown, the potion's liquid, a
  lily pad, short grass, ferns and vines the grass green;
- **a block** (`cobblestone`, `oak_stairs`, `glass`, `oak_leaves`, `grass_block`) is its model as
  the inventory draws it: the game's `display.gui` view (rotation 30, 225, 0), top face lit 100 %,
  the left (east) face 80 % and the right (north) face 60 %, translucent faces over what is behind,
  32 x 32; grass, leaves and vines carry the plains tint;
- **no icon** (404): chests, shulker boxes, beds, banners, heads, the shield and the conduit are
  drawn by the client's entity renderer, not from a block model; also technical blocks and
  Bedrock-only content (cinnabar, sulfur, poplar, `element_N`). The cell keeps its glyph.

Bedrock names that differ from Java's are mapped (`names.ts` `ALIASES`: `wooden_door`, `reeds`,
`snow`, `stone_stairs`, `fireworks`, `brick_block`, ...). Over the creative catalogue and the block
palette (1772 identifiers) 604 are drawn as blocks, 596 as flat items, 572 have no icon.

The route (`routes.ts`) sits behind the same token as everything else and takes `GET` / `HEAD`:
`200 image/png` (`cache-control: private, max-age=86400`), `404 {"error":"no icon for this item"}`
(`private, max-age=300`), `500` when the files cannot be read (not cached, tried again on the next
request). The name must match `[a-z0-9_]{1,64}`; the reader only opens paths named by the package's
own index files and refuses anything outside `^[a-z0-9_]+(/[a-z0-9_]+)*$`. Rendered icons are kept
in memory (4096 names at most). A new game version: change `ASSET_VERSION` (`icons/source.ts`) and
the package pin.

### Status blocks

- header: bot name, connection state, server, task, game version; a green / red dot = `/healthz`;
  a red **stale** badge when the last poll failed (with how long ago the last good one was; the cards
  fade until a poll succeeds again) and the error after it;
- **Bot**: health, food, saturation and armour points as bars with the numbers (saturation from the
  server's `update_attributes`, armour from the worn pieces); a small 24-hour clock (noon at the top,
  the hand turns with the time of day) with the time as hh:mm, the phase (day / dusk / night / dawn)
  and the world's day number; position, dimension, weather (clear / rain / thunder from the server's
  rain and thunder events; `unknown` until one arrived since the bot started), deaths this run and
  the last death's cause and time;
- **Status**: the current job in bold (the active user process's own status line: `!get`, `!build`,
  `!unload`, `!explore`, `!goto` ..., with its ETA), the process stack as a numbered list (a state
  badge: active / idle / paused / held by `!pause`; the name; user or auto and the priority; the
  line and ETA), then the `!status` reply;
- **Combat**: fights, kills, retargets, flees, guard triggers, damage taken (and in how many hits)
  since the bot started, the last hit and how long ago;
- **Memory**: chests remembered (reachable / unreachable; the second half of a double chest is not
  counted), how many were opened, herds and the animals in them, forests (16-block columns with at
  least 6 remembered logs) and ores the bot saw (by kind) within 64 blocks; **chest list** opens the
  remembered containers as a table (`GET /api/chests`: where, kind and label, slots used, the top
  kinds, reachable or why not). Counts only; `no world cache` when the cache is off
  (`BEDROCKBOT_CACHE=0`);
- **Planner**: `plannerThreads` and whether the worker runs, plans (interims, results, failed), the
  main-thread milliseconds spent forwarding world changes to the worker (total and the longest flush),
  crashes and starts;
- **Connection**: server, game version, state, uptime and session, reconnects and disconnects, kicks,
  the last disconnect (while the bot is not in the game the banner below says it first);
- **Commands**: quick buttons, by default `!status`, `!home go`, `!stop`, `!guard on`, `!guard off`,
  `!eat`, `!equip`, `!inv` (no `!come`: it needs a player in the game; **edit buttons** changes them,
  Track AR), a command box with the **command palette** (any `!command`; the `!` is added when
  missing), the replies said while the command ran, and **Bot chat**: the last 30 lines the bot said
  (also replies that arrive later, such as `arrived at ...`; `(not sent to the game)` when the chat
  layer dropped one: not spawned or its 8 per 10 s limit);
- **Log**: the last 50 log lines (all loggers), filterable by level, module and text (Track AR);
- **Settings**: the `!set` table by group with switches, Reset, the mode selector and filters (Track
  AR, "Interaction" below; every row shows the default and where the value came from: default / file
  / startup / chat);
- **Help**: the command registry, the modes and the settings (Track AM), fetched when opened.

The map card is gone. Its successor is the map screen ("Map screen" below).

### When the bot is not connected

A banner across the top of the page (`#panel-link`, under the header) shows whenever the bot is not
in the game, and goes away by itself on the first poll after it spawned again; nothing to reload. It
comes from `state.link` (`panelLink` in `state.ts`, from `Connection.link`, the metrics' last
disconnect and the respawn controller) and the page's `linkView` (`menu.ts`, so the unit tests run
the same code):

| Phase | Banner | What still works |
|---|---|---|
| `connecting` (the first join, or before it) | **Connecting**, for how long, the last disconnect if any | `!status`, `!set`, `!mode`, `!help`, `!panel`, `!stop`, `!pause`, `!resume` |
| `reconnecting` (a session ended, the backoff runs) | **Disconnected: reconnecting** or **Kicked: reconnecting** (red), the last disconnect (kind, reason, how long ago), **next try in 12 s (attempt 3)** or **attempt 3 running**, since when | the same |
| `signin` (a Realm join waits for the Microsoft device code) | **Not signed in**, the code in large type, a link to the sign-in page, when the code expires | the same |
| `dead` (spawned, between the death and the respawn) | **Dead: respawning**, the cause, how long ago, **respawn in 2 s** (or: automatic respawn is off) | every command (they queue for after the respawn); no inventory or map actions |
| `offline` (closed for good: the bot is stopping) | **Offline**, since when, the last disconnect | the same as `connecting` |
| the panel does not answer (a poll failed: the bot process restarts or stopped) | **Panel not answering**, for how long; the red **stale** badge and the error stay in the header | nothing is sent; the page keeps polling every 2 s and comes back by itself |

While the banner shows, the inventory cells and the map are greyed (`body.is-offline`), a cell's or a
column's menu lists no command entries (only local ones such as a box's contents) and says why, the
quick buttons that need the game are disabled, and the command box does not send a command that
needs the game: it answers `not sent: Kicked: reconnecting. !status, !set, !help and !stop still
work.` (`offlineOk` in `menu.ts` is the list). The inventory line says `(last known)`: the cells keep
what the bot carried when it left. The banner is one column on a phone (rows wrap), and the spinner
stops with `prefers-reduced-motion`.

### Live updates

Decision 0061. Each new state, from the stream or a poll, renders into the nodes the server
rendered. A node is written only when what it shows changed:

- a text node when its text changed;
- a bar when its width changed;
- an inventory cell when its item, count, durability or contents changed (a signature per cell);
- the process list when the stack changed.

Nothing replaces the page's HTML. So there is no flicker, an open `<details>`, a half-typed command
or a setting being edited stays as it is, and the log keeps its scroll position.

**How the state arrives** (`client/transport.ts`):

| When | What the page does |
|---|---|
| visible tab, `EventSource` there | `GET /api/stream?topics=state`: a snapshot, then a delta about once a second while something changes, and 250 ms after each command; no polling |
| the stream refused (503: 8 streams open; 401), no state within 6 s (a proxy that buffers), or 3 drops in a row | polls `/api/state?lite=1` every 2 s; tries the stream again after 30 s, doubling per failure up to 8 min |
| no `EventSource` (an old browser) | polls every 2 s, as before |
| hidden tab (`document.hidden`) | closes the stream and polls every 10 s; visible again reopens the stream at once, resuming from the last id |

**Why a hidden tab polls instead of keeping the stream:** the server keeps no per-client throttle
state, a background tab does not hold one of the 8 stream slots, and phones suspend background tabs
anyway.

A dropped stream behaves like a failed poll: the **stale** badge and **Panel not answering** show
until the next state. `EventSource` reconnects by itself, with `Last-Event-ID`. A delta applies only
to a state from the same stream. A delta that does not apply, or comes before any snapshot, makes the
page reopen the stream without an id, which brings a fresh snapshot. A polled state also drops the
id.

Every 30th render logs its time in the browser's console, at level debug / verbose. Examples:
`panel: render 0.42 ms, state 9524 bytes`, and for a streamed state
`panel: render 0.10 ms, state 341 bytes (stream delta)`. Fallbacks log too:
`panel: stream off (refused); polling, next try in 30 s`.

## Interaction (Track AR)

**Everything is a chat command.** Every menu entry, switch, Reset, Stop, Pause / Resume, mode button
and quick button sends one `!command` to `POST /api/cmd`, exactly like the command box: the chat
handler parses it, checks the owner, logs `panel: !drop cobblestone 64 (as Steve)`, counts it and
replies. The panel has no other way to change anything, so what it can do is what the owner can type
in the game, and the log is the one audit trail. The reply of a menu action pops up at the bottom of
the screen for 5 s (wherever the page is scrolled) and also shows under the command box.

**Confirmations.** A destructive entry (red) only arms on the first tap: its label becomes `tap
again: Drop the stack (64)`, and a second tap within 4 s sends it; otherwise it disarms. Destructive
are: dropping a whole stack or all of an item, Set home here, Set shelter here, and a mode (whose
first tap shows what it would change). Drop 1, Select, Eat, Equip, the offhand, Walk here, the
waypoint, Reset, the switches, Stop and Pause send at once. The menu closes on Escape or a tap
elsewhere.

### Inventory menu

Tap (or right-click) a cell; the menu's title is the slot and the item with its durability or box
contents. What the menu model (`health/panel/menu.ts` `cellActions`) offers:

| Cell | Entries (command) |
|---|---|
| a hotbar slot that is not held, empty or not | **Select (hold slot n)** (`!select <0..8>`) |
| armour or an elytra in the inventory | **Wear this** (`!equip slot <n>`: exactly this piece, even when it is worse than the worn one; an elytra goes into the chest slot, **Wear this (chest slot)**; the piece it replaces goes into this cell's slot), **Wear the best armour** (`!equip`) |
| shield, totem of undying, arrows, fireworks, nautilus shell, maps | **To the offhand** (`!offhand <item>`) |
| food | **Eat (best food)** (`!eat`: the eater picks the food) |
| a shulker box | **Show contents** (local: the line under the grid) |
| any item | **Drop 1** (`!drop <item> 1`, stacks only), **Drop the stack (n)** / **Drop** (`!drop <item> <n>`, confirmed), **Drop all n item** when more than this stack is carried (`!drop <item>`, confirmed), **Unload now** (`!unload`) |
| the offhand | **Back into the inventory** (`!offhand clear`) |
| worn armour | nothing (no command takes one piece off; `!drop all` sheds everything) |

A piece worn with **Wear this** stays on: the survival kit's automatic armour pass skips that armour
slot while the chosen item is still worn (`ArmourController` pins, `docs/survival.md` "Armour worn by
hand"). **Wear the best armour** (`!equip`) forgets the choices; the flight kit's own elytra swap
(before a takeoff, the chestplate after the landing) ends the pin on the chest slot.

`!drop <item> <n>` drops that many of the item, smallest stacks and the main inventory first (the
survival kit's rule), so "the stack" is the cell's count, not necessarily that cell.

### Map screen

Decision 0062. The map screen has its own guide, [map.md](map.md). It covers the views, gestures,
layers (surface, classes, Y-slice), the shared painting (`client/paint.ts`, also behind `/map`), the
wire (`/api/map/tiles`, the `map` and `map-live` topics, `/api/map/slice`, `/tex/`), the overlays,
and the point and box actions. Every action shows its exact `!command` before Send, and the reply
appears under it. The guide also has the recipes "add an overlay" and "add a map action".

The afk task's waypoints and shelter still reach the map through `map/routes.ts` `liftTaskStatus`,
which lifts `nav.waypoints` and `night.shelter` into `/map.json` and `map-live`.

### Settings

The `!set` table is grouped like `!help settings` (safety, walking, work, food, other), one row per
setting: the name, where its value came from, the description; the control (a **switch** for on / off,
sent when flipped; a number box with the setting's min and max and a **set** button or Enter; a
**select** for word choices such as `guardWhileWalking` reach / near / all; a text box with the
allowed form, `x y z|none`, for the rest); the range, the default and **Reset** (`!set <key>
default`), shown only when the value differs (the row then has an accent bar). **Changed only** hides
the rows at their default; the search box matches the name, the description and the group. On top,
the **mode** (`careful`, `normal`, `bold` or `custom`, computed from the values like `!mode status`)
and a button per mode: the first tap shows what it would change (`careful changes fleeHealth 8 -> 12,
guardRadius 16 -> 8, ...; tap careful again to apply`), the second sends `!mode careful`.

### Commands and status

- **Command palette**: focusing the command box loads the command registry once (`GET /api/help`);
  typing filters it (name prefix first, then the name or the help containing the text), grouped front
  door / more, at most 12; a tap fills the box with `!name ` to add the arguments. Once a space is
  typed the list gets out of the way. Enter sends as before.
- **Quick buttons**: **edit buttons** opens a box with one command per line; **save** keeps the list
  in this browser (`localStorage` `bbpanel-quick`, at most 24 buttons; a blocked storage just means
  the defaults), **defaults** goes back to the server's list.
- **Status**: each user process in the stack has a **Stop** button (`!stop`, which ends every user
  command: there is no per-process stop; guard and night keep running); **Pause** (`!pause`) and
  **Resume** (`!resume`) are enabled by the state's `paused`, and `commands held (!pause)` shows while
  held.
- **Log**: a level filter (all, info and up, warnings and errors, errors), a module filter (every
  `[module]` seen so far) and a text filter, applied to the last 50 lines on every poll.

### The new commands

Two inventory actions had no command; they are ordinary owner commands (`chat/commands-panel.ts`,
`!help select`), usable in the game too:

| Command | What |
|---|---|
| `!select <0..8>` | hold the item in that hotbar slot (`mob_equipment` through the PvE controller's `Hotbar`), reply `selected hotbar slot 2: iron_sword x1` |
| `!offhand <item>` | move the first stack of that item (hotbar first) into the offhand: with the inventory screen open, `item_stack_request` `place` from `hotbar` / `inventory` slot n to `{ container_id: 'offhand' }` slot 1, the shield controller's verified request; an occupied offhand is emptied into a free slot first; reply `offhand: totem_of_undying` |
| `!offhand clear` | the offhand back into the first free slot (main inventory first): `place` from the offhand slot 1; reply `offhand: shield moved back into the inventory` |
| `!offhand` | what the offhand holds |

Both go through the survival kit's `StackRequests` (one inventory screen at a time with the kit's own
drops and armour moves; `busy` while the kit works). A shield moved out goes back by itself while the
bot is idle (the shield controller, [pve.md](pve.md) "Shield"); a totem stays.

### Not from the panel, and why

- **Crafting** is possible now (wave 11 Track AW, [crafting.md](crafting.md), decision 0045): `!craft
  <item> [n]` crafts through the normal screens (the inventory's 2 x 2 grid, or a crafting table the
  bot finds, places or makes) and `!compact [kind]` turns raw metals, ingots, gems, coal, redstone and
  lapis into storage blocks; `!unload` compacts by itself when a chest cannot take the load. The
  panel can offer it like every other action, as a chat command through `POST /api/cmd`: a `Craft...`
  entry on an inventory cell (`RecipeIndex.byOutput` on the task's `craftControlOf(task)` lists what
  the item makes, `canCraft` what the bot can make now with the shortfall for the label) sending
  `!craft <item> <n>`, and a `Compact` quick button sending `!compact`. Not built in this track: the
  menu entry itself (panel code is Track AR's).
- Taking off one worn armour piece, mining a clicked spot, build markers: no command does it.
- Moving stacks around (hotbar drag): no `!move` command; not needed for any action above.

## Push channel (`GET /api/stream`)

Decision 0061; the hub is `health/panel/stream.ts` (`StreamHub`), one per panel. The channel is
Server-Sent Events behind the same token and cookie as every route.

**What a client receives:**

- `retry: 2000`, then a `hello` event: `{"boot":"Xk3...","resumed":false,"topics":["state"],"hb":5000}`;
- then a message per topic, `event: <topic>`, `id: <boot>.<seq>`, `data: <JSON>`.

**Topic kinds:**

- **State topics** (`state`) send `{"snap": <value>}` on connect, then `{"d": [<ops>]}` deltas.
- **Event topics** pass each published value through as it is.

**The panel's own topics:**

| Topic | Kind | What |
|---|---|---|
| `state` | state | the lite state (what `/api/state?lite=1` answers) |
| `events` | event | every bot event as it is recorded (decision 0059, [events.md](events.md)): the stored record plus its display text, e.g. `{"id":412,"ts":1762300000000,"kind":"command.received","sev":"info","data":{"command":"set","text":"!set guardRadius 9","source":"panel","sender":"console"},"text":"!set guardRadius 9 from console (panel)"}`, 200 to 400 bytes |

`index.ts` subscribes to the event bus while the panel serves (`events.subscribe`) and unsubscribes in
`stop()`. A page that connects late asks `GET /api/events` once for what it missed, then follows the
topic. Event ids increase across restarts, so a gap shows. The page has no events UI yet (programme
step 5).

**Resuming.** One sequence numbers every message of every topic. A client that reconnects with
`Last-Event-ID` (or `?last=<id>`) gets what it missed from the replay ring (512 messages, 1 MiB),
and `hello.resumed` is true. An id from another boot, or one older than the ring, gets fresh
snapshots instead.

**Query.** `?topics=state,events` limits the stream to those topics (400 when none is registered).
Without it the stream carries every topic.

**Deltas** (`client/delta.ts`, the same code on both sides) are a list of ops on JSON paths:

| Op | Meaning | Example |
|---|---|---|
| `["s", path, value]` | set the key or array index at `path` (`[]`: the whole value) | `["s", ["inventory", "slots", 9, "count"], 63]` |
| `["d", path]` | delete the object key at `path` | `["d", ["self", "lastDeath"]]` |
| `["a", path, drop, tail]` | a ring that scrolled: drop `drop` items from the front, append `tail` | `["a", ["logs"], 1, ["... INFO  [move] arrived"]]` |

The diff writes each change in the shortest JSON form:

- one changed inventory cell is one `s` op;
- a scrolled log is one `a` op;
- anything else is replaced.

The hub computes each delta once per publish for every client. It sends a snapshot instead when the
delta would be longer.

**When the state is sent:**

- the state topic is sampled every second (`STATE_SAMPLE_MS`), only while a stream listens;
- a command from the panel pushes 250 ms after it runs;
- an unchanged state sends nothing.

**Limits:**

| What | Value | Beyond it |
|---|---|---|
| streams at once | 8 | 503 with `retry-after: 30` (the page polls instead) |
| socket buffer per client | 256 KiB unsent | the client is dropped (log line); it reconnects and resumes, and the others never wait for it |
| heartbeat | an `hb` event after 5 s of quiet | the page's watchdog: no state or heartbeat for 15 s and the page falls back to polling |

**Headers:** `cache-control: no-store, no-transform`, `x-accel-buffering: no` (so nginx does not
buffer the stream).

**Stopping.** `stop()` ends every stream, and a stopping hub answers 503.

`hub.stats()` gives these counters:

- clients, opened, refused, dropped, resumed and the sequence;
- per topic: published, snapshots, last and largest message and largest delta.

### Add a topic

Something new the page should hear about without polling (an event list, a job queue, map tiles,
notifications) is a topic. Nothing in the panel's files changes.

1. **Server.** In the module that owns the data, take `panel.hub` from `setupPanel`'s result, then
   register once and publish.
   - An event:
     ```ts
     const notes = panel.hub.topic('notes', { kind: 'event', budget: 2_000 });
     notes.publish({ ts: Date.now(), text: 'emptied the chest at 100 64 -50' });
     ```
   - A value the page mirrors:
     ```ts
     const jobs = panel.hub.topic('jobs', { kind: 'state', read: () => jobList(), sampleMs: 1000, budget: 8_000, deltaBudget: 1_000 });
     ```
     Then call `jobs.refresh()` after a change, or let `sampleMs` poll `read`. `jobs.publish(v)`
     also works.

   Topic names are `[a-z][a-z0-9-]*`. `hello`, `hb` and a name already registered throw.
2. **Fallback route.** If the data must also reach a page that cannot stream, add it with
   `panel.use((path, req, res) => ...)`. Routes added this way sit behind the panel's token, are
   tried after the panel's own routes and before the modules, and work before or after `start()`.
   Only `state` has a built-in polling fallback.
3. **Page.** In the card's module (`client/<card>.ts`, set up from `main.ts`), call
   `page.listen('notes', (data, id) => ...)` inside the setup (the same for the panel's own
   `events` topic). The transport adds the topic to
   `?topics=` and reopens a running stream, resuming from the last id. A listener that throws is
   logged and the stream goes on. A listener is called only while the page streams: a polling page
   needs step 2.
4. **Tests.**
   - A unit test publishes through a real hub. `panel-stream.test.ts` and `panel-server.test.ts`
     ("... a module adds a topic and a route") show the pattern with `openSse` from
     `test/unit/health/panel-sse.ts`.
   - A page test uses `runPage(html, { stream: true })` and `FakeEventSource.emit` from
     `panel-dom.ts`.

**Reviewer checklist** for a new topic:

- [ ] The payload is JSON with no secrets: no token, no sign-in data, no file paths of the machine.
      Everything on a topic reaches every page.
- [ ] It has a `budget` (and a `deltaBudget` for state). The numbers are in this file's "Budgets"
      table, or the reason they are not.
- [ ] It is published from one owning module. Nothing publishes on a topic another module owns.
- [ ] State topics are idempotent snapshots. Event topics tolerate a replay after a resume: the page
      may see an event twice after a lost ring, so events carry an id or timestamp.
- [ ] Sampling (`sampleMs`) is only for values without a change signal. It runs only while a stream
      listens, but `read` must still be cheap (well under 1 ms).
- [ ] The page side has a fallback, or the card says it needs the stream.
- [ ] There is a test on a real hub, and on the page with the fake EventSource.

## Browser modules

Decision 0061; `health/panel/assets.ts`. The page's script is the TypeScript files under
`health/panel/client/` plus `health/panel/shared.ts`.

**Serving.** At startup the bot strips their types once with Node's `module.stripTypeScriptTypes`,
keeps the results in memory, and serves them as native ES modules:

- **URL:** `GET /ui/<hash>/client/main.ts`. `<hash>` is 12 characters over every module, so a bot
  started with other code serves new URLs.
- **Relative imports** (`./menu.ts`, `../shared.ts`) resolve under the same prefix, as in the
  source tree.
- **Answer:** `text/javascript; charset=utf-8`, `cache-control: private, max-age=31536000,
  immutable`, an ETag (304 on `If-None-Match`), `x-content-type-options: nosniff`, and gzip when
  the browser accepts it.
- **The page** carries one `<script type="module" src=".../client/boot.ts">` and a
  `<link rel="modulepreload">` per module, so the browser fetches them in parallel on the first
  visit and from its cache afterwards.
- **Other hashes:** a module of another hash (an old tab after a restart) answers 404
  `another version of the page: reload it`.

**Rules,** checked at load (on a problem the panel logs it and does not start) and by
`panel-modules.test.ts`:

- A client module imports only `./<module>.ts` and `../shared.ts`. There is no Node module, no
  server module, no package and no CDN.
- `shared.ts` holds constants and wire types. Its only imports are `export type ... from`, which
  stripping erases.
- A type-only import is written `import type { X }`, or mixed with a value
  (`import { a, type X }`). Never write `import { type X }` alone: it strips to `import {} from`,
  which the browser would fetch.
- No dynamic `import()`.
- Only `boot.ts` reads browser globals (`document`, `window`, `fetch`, `EventSource`,
  `localStorage`...). It builds an `Env` and calls `start(env)` in `main.ts`, and every other module
  gets what it needs through that. This is why the tests run the real modules on a fake DOM.
- The client type-checks without the DOM lib, through its own small interfaces (`client/dom.ts`).
- The server imports only the pure modules: `client/delta.ts` (the stream computes deltas) and
  `client/menu.ts` (re-exported by `health/panel/menu.ts` for the tests and the e2e).
- A file with only types (`client/page.ts`) is not served.
- Every module is reachable from `boot.ts`. Each module stays under its byte budget.

**Adding a card** is one module, `client/<card>.ts`, exporting `setup<Card>(page)` that returns a
render function, plus one line in `main.ts` to call it and its render. The markup stays in `page.ts`.

## Budgets

`health/panel/budgets.ts` (`PANEL_BUDGETS`) has one budget per piece instead of one cap on the whole
page, so a new card raises the piece it lives in. Raise a number only with the reason written in
"Measured" below.

| Piece | Budget | Worst case (unit fixture) | Live (bds-core e2e) | Enforced by |
|---|---|---|---|---|
| `html`: `GET /` (structure, CSS, glyphs, the embedded lite state) | 120 000 | 116 431 (decision 0062: plus the map screen's markup and CSS) | 104.4 KB (bds-cache) | `panel-budgets`, `panel-menu`, `panel-core`, `panel-actions`, `panel-stream`, `panel-map` |
| `module`: one browser module, raw | 20 000 | 15 605 (`paint.ts`; `mapview.ts` 15 156) | the same | load at startup (refuses), `panel-budgets`, `panel-stream` |
| `modules`: all modules, raw | 170 000 (120 000 before decision 0062) | 159 909 (52 636 gzip; the map screen about 79 KB of it) | the same | `panel-budgets`, `panel-stream` |
| `snapshot`: a state snapshot (= the lite poll) | 24 000 | 19 569 | 7.6 to 12.5 KB | `panel-budgets`, `panel-stream`, a log warning once at run time |
| `delta`: one state delta on a busy second | 4 000 | 682 (14 ops) | 340 to 660 | `panel-budgets`, `panel-stream`, a log warning once at run time |
| `event`: one message on the `events` topic | 2 000 | - | 242 | `panel-stream`, a log warning once at run time |
| `mapMessage`: one `map` topic message (decision 0062) | 96 000 | 75 259 (21 synthetic worst-case tiles) | 1.0 KB (1 tile) to 39 KB (27 tiles) | `panel-budgets`, `map-live`, `panel-map`, a log warning once |
| `mapLive`: a `map-live` snapshot | 24 000 | 13 894 | - | `panel-budgets`, `map-live`, a log warning once |
| `mapLiveDelta`: a `map-live` delta on a busy second | 4 000 | 1 276 | - | `panel-budgets`, a log warning once |
| `mapFetch`: `GET /api/map/tiles` r=8, gzipped | 120 000 | 38 904 (smooth overworld; random art 596 004, only printed) | r=4 9.6 to 23.8 KB | `panel-budgets`, `map-live` |

To print the worst case:
`PANEL_MEASURE=1 pnpm --filter bot exec vitest run --project unit test/unit/health/panel-budgets.test.ts`.

## API

| Request | Answer |
|---|---|
| `GET /api/state` | `PanelState` JSON (below) |
| `GET /api/state?lite=1` | the same without what does not change while the bot runs: `commands` and `quick` left out, `settings` rows only `key`, `value`, `source`; `"lite": true` (what the page polls when it does not stream; Track AP) |
| `GET /api/stream[?topics=state,events][&last=<id>]` | decision 0061: Server-Sent Events ("Push channel"): `hello`, then per topic a snapshot and deltas (state) or each message (events), ids `<boot>.<seq>`, resume with `Last-Event-ID`; heartbeats `hb`; 400 no such topic, 503 at 8 streams (`retry-after: 30`) or stopping, 405 other methods |
| `GET /ui/<hash>/<path>.ts` | decision 0061: a browser module, type-stripped ("Browser modules"): `text/javascript`, immutable cache, ETag / 304, gzip; `HEAD` the same without the body; 404 another hash or no such module; 405 other methods |
| `GET /api/chests` | the remembered containers, nearest first: `[{"x":10,"y":-60,"z":4,"kind":"chest","label":"ores","stacks":12,"size":27,"top":[["coal",320],["iron_ore",40]],"unreachable":null,"readAt":1761753600000}]` (`[]` without a world cache; Track AP) |
| `GET /api/marks` | Track AR: what the panel's map draws beyond `/map.json`, within 256 blocks of the bot, nearest first, at most 200 each: `{"chests":[{"x":10,"y":-60,"z":4,"kind":"chest","label":"ores","unreachable":false}],"herds":[{"x":5.5,"y":-60,"z":5.5,"n":5,"kind":"cow","penned":true}]}` (empty lists without a world cache) |
| `GET /api/marks?cx&cz&r` | decision 0062: the same for a window (centre chunk, radius in chunks, at most 16), plus `blocks` from the cache's marks (`{"ore":[[x,y,z,"diamond_ore"]],"spawner":[...],"bed":[...],"station":[...],"farmland":[...],"forest":[[x,y,z,logs]]}`, nearest first, only the kinds present) and chest contents (`top`, `stacks`, `size`, `readAt`); [map.md](map.md) "Wire" |
| `GET /api/map/tiles?cid&cx&cz&r&pal[&since&win][&live=1]` | decision 0062: the compact tiles of a window (r up to 16), the palette entries from index `pal`, the window registered for the `map` topic; `live=1` adds the overlays ([map.md](map.md) "Wire") |
| `GET /api/map/slice?y&cx&cz&r&pal` | decision 0062: the Y-slice: the cache class of every cell at y and the block names of loaded columns (r up to 8); 400 without a numeric y |
| `GET /tex/<block>.png` | decision 0062: the block's 16 x 16 top face from the installed game's art (the same allowlist and cache as `/icons/`), or 404 and the map keeps the colour |
| `GET /icons/<name>.png` | the item's icon (`image/png`, 16 x 16 or 32 x 32), or 404 `{"error":"no icon for this item"}`; `HEAD` the same without the body; 405 other methods ("Item icons") |
| `POST /api/cmd` `{"text":"!wp set base"}` | 200 `{"command":"!wp set base","ok":true,"replies":["waypoint base set to 10 -60 20"]}`; 409 `ok:false` + `error` when there is no owner to run as; 400 bad body; 413 body over 4 KiB; 429 over 5 commands per second; 405 other methods |
| `GET /api/events`, `/api/events/summary`, `/api/events/kinds` | decision 0059: the bot's event history (filters, the 8-hour summary, the registry); mounted from `bot/src/events/routes.ts`, documented in [events.md](events.md) "Query API" |
| `GET /healthz`, `/metrics`, `/map`, `/map.json` | as before (runbook "Operations") |

`PanelState` (`v` 1; `bot/src/health/panel/state.ts`):

```jsonc
{
  "v": 1, "ts": 1761753600000,
  "bot": { "name": "AfkBot", "server": "127.0.0.1:19180 (raknet)", "task": "afk", "state": "spawned", "healthy": true, "gameVersion": "1.26.60" },
  "status": ["status: up 2m, session 2m, ..., task afk, behaviour idle, ...", "processes: idle"],
  "stack": [{ "name": "goto", "kind": "user", "priority": 40, "state": "active", "line": "walking to 18311 -60 17027", "etaS": null }],
  "paused": false,                      // Track AR: !pause holds the commands; null without the process manager
  "self": { "health": 20, "food": 20, "pos": { "x": 0.5, "y": -60, "z": 0.5 }, "dimension": "overworld", "timeOfDay": 6000, "phase": "day",
            "saturation": 5, "weather": "clear", "day": 12, "deaths": 1,
            "lastDeath": { "cause": "death.attack.mob", "ts": "2026-10-29T18:00:00.000Z", "messages": ["%entity.zombie.name"] } },
  "inventory": { ... },                 // below
  "icons": true,                        // wave 11: the server can answer /icons/<name>.png (false: the package is missing)
  "job": { "name": "get", "state": "active", "line": "getting 32 oak_log: 12/32", "etaS": 95 },
  "combat": { "fights": 14, "kills": 12, "retargets": 3, "flees": 1, "guardTriggers": 9, "hits": 21, "damageTaken": 37.5, "lastHit": { "damage": 3, "agoS": 42 } },
  "memory": { "chests": { "known": 9, "reachable": 8, "unreachable": 1, "read": 7 }, "herds": 4, "animals": 23, "forests": 6,
              "ores": 11, "oreKinds": { "iron_ore": 6, "coal_ore": 4, "diamond_ore": 1 }, "radius": 64, "ms": 0.55 },
  "planner": { "threads": 1, "running": true, "plans": 120, "interims": 14, "results": 118, "failed": 2, "forwardMs": 230.4, "maxForwardMs": 3.21, "starts": 1, "crashes": 0 },
  "conn": { "server": "127.0.0.1:19180 (raknet)", "version": "1.26.60", "state": "spawned", "uptimeS": 7380, "sessionS": 7300, "reconnects": 1, "disconnects": 1, "kicks": 0,
            "lastDisconnect": "2026-10-29T16:00:00.000Z closed: server restart" },
  "settings": [{ "key": "guardRadius", "kind": "number", "value": "16", "default": "16", "min": 2, "max": 64, "unit": "blocks", "source": "default", "description": "..." }],
  "logs": ["2026-10-29T18:52:53.123Z INFO  [health] panel: !wp set panel (as console)", "..."],
  "chat": [{ "ts": 1761753600000, "text": "waypoint panel set to 18304 -60 17024", "sent": true }],
  "commands": ["status", "pos", "quit", "help", "..."],
  "link": { "phase": "reconnecting", "state": "connecting", "since": 1761753597000, "retryAt": 1761753612000, "attempt": 3,
            "lastDisconnect": { "ts": "2026-10-29T16:00:00.000Z", "kind": "kick", "reason": "kicked_for_idle" },
            "signIn": null, "death": null },   // "When the bot is not connected"; phase "online" = no banner
  "quick": ["!status", "!home go", "!stop", "!guard on", "!guard off", "!eat", "!equip", "!inv"]
}
```

A source that throws gives its fallback (`null`, `[]`, `"unknown"`) instead of a 500. The Track AP
fields are additive (`v` stays 1); each is `null` when its source is missing or throws: `inventory`
without the world model (a task without walking), `combat` without the PvE controller, `memory`
without a world cache, `planner` without the navigator; `saturation`, `weather` until the server sent
them. `job` is the active user process, else the first user process (held or paused), else `null`.
`memory` is counted at most every 15 s (`MEMORY_TTL_MS`; it reads cached chunk summaries), so it can
be that old; `ms` is what the last count took.

`inventory` (`bot/src/health/panel/inventory.ts`):

```jsonc
{
  "slots": [                       // 36: 0..8 the hotbar, 9..35 the main inventory; null = empty
    { "name": "iron_sword", "count": 1, "icon": "sword", "colour": "#c9ccd1", "abbr": "ISw",
      "dur": { "left": 125, "max": 250, "pct": 50 } },               // tools, weapons, armour only
    { "name": "cobblestone", "count": 64, "icon": "block", "colour": "#8d8f93", "abbr": "Co" },
    { "name": "undyed_shulker_box", "count": 1, "icon": "box", "colour": "#...", "abbr": "USB",
      "box": { "known": true, "stacks": 3, "items": [["cobblestone", 128], ["iron_ingot", 10]], "more": 0 } },
    null, "..."
  ],
  "armour": [ { "name": "iron_helmet", ... }, null, null, null ],   // head, chest, legs, feet (window 120)
  "offhand": { "name": "shield", ... },                             // window 119 slot 0, or null
  "selected": 2,                   // the selected hotbar slot
  "armourPoints": 15,              // of 20, from the worn pieces
  "free": 14                       // empty slots of the 36
}
```

`icon` is one of the glyph classes above; `colour` is `#rrggbb`; `abbr` 1 to 3 letters. A shulker
box's `items` are its contents from the raw wire item's NBT `Items`, by kind, biggest first, at most
8 kinds (`more` counts the rest); `known: false` when the bot moved the box itself since the server
last sent the slot (the raw item is gone until the server sends it again).

## Commands from the panel

`POST /api/cmd` builds a chat line and hands it to `Chat.handle`: the same parsing, owner check,
logging (`!wp from Steve`), command events and metrics (`chat.run`) as a command typed in the game. It
runs **as the first owner**: the first name in `owners` (so `!come` / `!follow` without a name target
that player when online), else the first `xuid:` owner, else the server console when `consoleOwner`
is on; with no owner at all the panel answers 409. Every panel command is logged first:
`panel: !wp set panel (as Steve)`.

Replies are captured by wrapping the chat instance's `say` (everything the bot says goes through it),
so they also go to the game chat, exactly as when the owner typed the command there. The replies said
during the call come back in the response; later ones (`arrived at`, `kill zombie: 3/3 done`) appear
in `chat` with the next state (pushed, or the next poll).

## Auth (`panel/auth.ts`)

With a token, every request except `/healthz`:

| How | Use |
|---|---|
| `Authorization: Bearer <token>` | scripts, `curl` |
| `?token=<token>` | once in a browser: sets the `bbpanel` cookie (HttpOnly, SameSite=Strict, 30 days) and a GET is redirected (303) to the same URL without the token, so it leaves the address bar |
| `Cookie: bbpanel=<token>` | the browser afterwards |

Missing or wrong: 401 (`/` shows a small token form, the API answers JSON). Tokens are compared in
constant time (SHA-256 of both sides).

Without a token (loopback only) the `Host` header must be a loopback name (127.x, localhost, [::1]),
so a web page cannot reach the panel through DNS rebinding.

`POST` needs `content-type: application/json` and, when the browser sends an `Origin`, one equal to
`http://<Host>`: another site's page cannot send that without a CORS preflight, which the server never
answers. `/api/cmd` is limited to 5 commands per second (sliding window; 429 beyond).

**No credentials are shown or stored by the panel.** The token lives only in the config file (or the
environment) and the browser's cookie; the page never contains it, `!panel` never prints it, and log
lines are redacted before the ring stores them (`token=`, `Bearer`, `"token":`, device-code sign-in
codes become `***`). The bot account's sign-in tokens (prismarine-auth cache) are never read.

## Files

| File | What |
|---|---|
| `health/panel/index.ts` | `setupPanel` (wiring, `!panel`), `planPanel` (where it serves), `panelLine` (the owner a command runs as), `panelUrls`, `ChatTap` (the bot's replies); decision 0061: the stream hub and its `state` topic (`panel.hub`, `panel.stateTopic`), the push after a command, the route list other modules add to (`panel.use`) |
| `health/panel/auth.ts` | `checkRequest` (token, cookie, loopback Host, POST rules), `panelAuth` (the health server hook), `RateLimiter` |
| `health/panel/routes.ts` | `/`, `/api/state` (and `?lite=1`), `/api/help`, `/api/chests`, `/api/marks` (Track AR), `/api/cmd` (`/api/stream` and `/ui/<hash>/*` are mounted next to it by `index.ts`) |
| `health/panel/stream.ts` | decision 0061: `StreamHub` (topics, snapshots and deltas, the sequence and replay ring, heartbeats, the stream cap, slow clients, the sampler, `stats()`), `parseEventId` |
| `health/panel/assets.ts` | decision 0061: the browser modules: `loadClientModules` (strip and check), `ClientModules` (hash, URLs, the `/ui/<hash>/` route), `clientModules()` (once per process), `ENTRY_MODULE` |
| `health/panel/shared.ts` | decision 0061: constants and wire types shared by the server and the page (poll and stream timings, storage keys, icon classes, `StreamHello`, `export type` of the state shapes) |
| `health/panel/budgets.ts` | decision 0061: `PANEL_BUDGETS` ("Budgets") |
| `health/panel/state.ts` | `PanelState`, `buildPanelState`, `liteState`, quick commands, `buildPanelHelp` |
| `health/panel/inventory.ts` | Track AP: the `inventory` block: `buildInventory`, `iconClassOf`, `itemColour`, `itemAbbr`, `durabilityOf`, `boxContents` |
| `health/panel/memory.ts` | Track AP: the `memory` counts (`buildMemory`) and the chest list (`chestRows`) |
| `health/panel/glyphs.ts` | Track AP: the hand-drawn item glyphs (inline SVG symbols); the fallback of the icons |
| `health/panel/icons/book.ts` | wave 11: `IconBook.png(name)`: the rules (flat, block or none), the caches, the answer for `/icons/<name>.png` |
| `health/panel/icons/source.ts` | the asset folder of the `minecraft-assets` package (`ASSET_VERSION`), `FsAssets` (path allowlist) |
| `health/panel/icons/models.ts`, `render.ts` | the model's parent chain (`resolveModel`) and the `display.gui` renderer (`renderModel`: projection, shading, front-to-back compositing) |
| `health/panel/icons/names.ts`, `png.ts` | the Bedrock -> Java name aliases, the solid parents, the tints; the pngjs wrapper (decode, encode, first frame, tint, overlay) |
| `health/panel/client/boot.ts`, `main.ts`, `page.ts`, `dom.ts` | decision 0061: the entry (the only module reading browser globals); the wiring (`start(env)`: theme, the cards, render, stale marker); the shared `Page` object; the small DOM interfaces and helpers (`makeUi`, `nice`, `dur`, ...) |
| `health/panel/client/transport.ts`, `delta.ts` | decision 0061: how the state arrives (stream, fallback polling, hidden tab, `on(topic)`); the delta codec (also used by the server) |
| `health/panel/client/inventory.ts`, `cards.ts`, `logs.ts`, `settings.ts`, `link.ts`, `commands.ts`, `popup.ts`, `tables.ts` | the page's cards, one module each (until decision 0061 the one `client.ts` string; Track AP and AR behaviour unchanged): the cells and their menu; bot, vitals, status, stack, combat, memory, planner, connection, chat; the log and its filter; the settings controls and modes; the offline banner; the command box, quick buttons and palette; toast and menu; Help and the chest list |
| `health/panel/page.ts` | the page (`renderPanelPage`): structure, CSS (themes, responsive grid), the 41 inventory cells, the status blocks; Track AR: the grouped settings rows, the mode bar, the menu, toast, palette and map markup; decision 0062: the map screen markup and CSS (`mapScreenHtml`), the view switch before the first paint |
| `health/panel/client/menu.ts` (re-exported by `health/panel/menu.ts`) | Track AR: the menu model (`cellActions`, `settingActions`, `setCommand`, `settingVisible`, `modeOf`, `modeChanges`, `stackActions`, `paletteMatch`, `offlineOk`, `linkView`, `parseLog`, `logVisible`); a typed module since decision 0061 (it was the `MENU_JS` string): the page imports it, the server and the tests through `menu.ts` |
| `health/panel/client/paint.ts`, `tiles.ts`, `mapview.ts`, `mapinput.ts`, `maptex.ts`, `overlays.ts`, `mapsheet.ts`, `mapdefs.ts`; `health/map/live.ts` | decision 0062: the map screen (the painting shared with `/map`, the tile store, the view, gestures, textures, overlays, the action sheet, the registries; `MapLive`: the `map` and `map-live` topics, `/api/map/tiles`, `/api/map/slice`); one line each in [map.md](map.md) "Files" |
| `health/panel/marks.ts` | Track AR: `GET /api/marks` (`mapMarks`: chests and herds near the bot); decision 0062: a window (`marksWindow`), chest contents, the block marks (`blockMarks`) |
| `health/map/routes.ts` | Track AR: `liftTaskStatus` (the afk task's waypoints and shelter into `/map.json`) |
| `chat/commands-panel.ts` | Track AR: `!select`, `!offhand` (one line in `tasks/registry.ts`) |
| `health/panel/logRing.ts` | `LogRing`: the last log lines (wraps `console.error`, which every logger writes with), redaction |
| `connection/health.ts` | `host` option, `auth` hook (every path but `/healthz`), `use()` for routes of any method |
| `config/config.ts`, `resolve.ts`, `init.ts` | the `panel` block, `BEDROCKBOT_PANEL_TOKEN`, the generated token |

## Tests

```sh
pnpm --filter bot exec vitest run --project unit test/unit/health                       # token, cookie, rate limit, state shape, HTTP, config; Track AP: inventory, statuses, memory, payload, page markup, the script on a fake DOM
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e panel-core --silent=false     # bds-core (~15 s)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e panel-actions --silent=false  # Track AR, bds-core (~20 s)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e panel-stream --silent=false   # decision 0061, bds-core (~28 s)
PANEL_MEASURE=1 pnpm --filter bot exec vitest run --project unit test/unit/health/panel-budgets.test.ts  # print the worst-case budgets
```

Decision 0061 unit tests:

- `panel-delta.test.ts`: the delta ops, a cell as one op and a scrolled log as one op, the real state
  on a busy second, and 300 random edits that round-trip.
- `panel-stream.test.ts`, the hub over real HTTP:
  - names, kinds and ids;
  - hello, then a snapshot, then deltas; an unchanged value sends nothing; events pass through;
  - one sequence over every topic;
  - resuming with `Last-Event-ID` or `?last=`; another boot, or a gap the ring lost, gets a snapshot;
  - the sampler, heartbeats, the topic filter and 400;
  - the cap (503) and `close()`; a slow client dropped while the others go on.
- `panel-transport.test.ts`, the page's transport on the fake DOM with a fake `EventSource`:
  - the stream opens at once, and a snapshot and deltas render with no polling;
  - a command schedules no poll;
  - a delta before a snapshot, or one that does not apply, reopens the stream;
  - a drop shows the stale badge and **Panel not answering**, and a resumed delta clears them;
  - refused or 3 drops lead to polling, with retry and back-off;
  - the open and quiet watchdogs;
  - a hidden tab polls every 10 s and reopens with `&last=`;
  - `page.listen` adds a topic, and a throwing listener is contained;
  - without `EventSource` the page polls.
- `panel-modules.test.ts`, the guards in "Browser modules":
  - the import rules and `shared.ts` type-only exports;
  - no globals outside `boot.ts`;
  - the server imports only `delta.ts` and `menu.ts`;
  - every module is reachable from the entry, and types-only files are not served;
  - the loader refuses a Node import, a server import, `import { type X }` and `import()`.
- `panel-budgets.test.ts`: every piece of "Budgets" on the worst-case fixture.
- `panel-server.test.ts`:
  - the modules behind the token: 401, `text/javascript`, types stripped, the API paths present;
  - immutable cache, ETag, 304, `HEAD`, 404 for another hash;
  - the stream through the panel: 401, the panel's `events` topic (an event on the bus arrives with its text; `stop()` unsubscribes), a module's own topic (`jobs`) plus a `panel.use`
    route, a snapshot of the lite state, and `!set guardRadius 8` arriving as a delta within 1.5 s.
- `panel-page.test.ts` runs the real modules (`start(env)`) on the fake DOM (`panel-dom.ts`). It
  also checks that the page's only script is the entry module, with a modulepreload for every
  module.

`panel-stream` e2e (bds-core; `PANEL_E2E_PORT`, default a random port in 9940..9949). It runs the CLI
with `--walk --health-port <port>` and a token, then checks:

- the page under its budget, one entry module plus a modulepreload per module;
- every module 401 without the token; with it `text/javascript`, immutable, types stripped, gzip
  (the same code) and 304;
- `/api/stream` 401 without the token, then hello and a snapshot (time and size); 10 s idle (deltas,
  heartbeats, bytes per second), and the applied state equals `?lite=1`;
- `!set guardRadius 9` from the panel arriving as a delta (latency), and a truth `give` of 7 oak
  planks arriving as an inventory delta;
- a resume with `Last-Event-ID` replaying only deltas after a change made while away; the result
  equals a fresh snapshot, and another boot's id gets a snapshot;
- 8 streams open and the ninth 503 with `retry-after: 30`, while `?lite=1` still answers;
- `!quit` ending the streams and exiting 0.

Item icons unit tests (`panel-icons.test.ts`, with `minecraft-assets` really installed): the PNG
helpers; model resolution; the cube's three faces pinned pixel by pixel (top, left x 0.8, right x
0.6); front-to-back compositing; tints; `IconBook`'s rules on an in-memory asset set; about 65 real
names (blocks, tools, food, armour, potions, leaves, grass) all resolving at 16 and 32 px, grass
green, entity-rendered items undefined. `panel-server.test.ts`: `/icons/<name>.png` behind the token
(200, 404, 405, `state.icons`), and the panel without the package; `panel-page.test.ts`: the script
asks once per name, never for an empty cell or when `icons` is false, and falls back on a 404.

Track AR unit tests: `panel-menu.test.ts` (the menu model for every kind of cell, the map column,
settings, modes, processes, the palette and the log filter; `/api/marks`; `liftTaskStatus`; the
grouped settings markup; `!select` and `!offhand` against fakes: the request shapes, the model
before and after, a refusal), `panel-page.test.ts` (the script on the fake DOM: a tap opens the
menu, an action posts its command and toasts the reply, a drop needs a second tap and disarms after
4 s, the box shows its contents locally, Stop per user process and Pause / Resume by `paused`, Reset
and the switch and the two-tap mode, the changed-only and search filters, quick buttons kept in
storage with save and defaults, the log filters, the palette from `/api/help`), `panel-server.test.ts`
(`paused`, `/api/marks` behind the token). The map card's tests (its poll, its right-click menu, Walk
here and the waypoint prompt) became the map screen's tests in decision 0062; see [map.md](map.md)
"Tests". The fake-DOM harness (`panel-dom.ts`) opens on the cards unless a test stores the map view.

Offline banner unit tests: `panel-menu.test.ts` (`panelLink` for every phase, `linkView`'s titles and
rows, `offlineOk`, **Wear this** for armour and the elytra), `panel-page.test.ts` (the markup hides the
banner while online; reconnecting shows why and when, greys the cells, disables the quick buttons that
need the game, empties the cell menu but for local entries, refuses `!goto` and sends `!status`, and
the next poll with the bot spawned clears all of it; sign-in shows the code and the link; dead keeps
the commands; a failed poll shows **Panel not answering** until the next answer),
`connection-reconnect.test.ts` (`Connection.link`: since when, the scheduled retry and the attempt).

`panel-actions` (bds-core; `PANEL_ACTIONS_E2E_PORT`, default a random port in 9650..9659): the CLI with
`--walk --health-port <port>` and a token; every action is computed with the menu model from the live
`/api/state` or `/map.json` and posted as the page does: a cell's **Select** (the state's `selected`
and `!inv`'s `held`), **Drop the stack** (truth inventory 128 -> 64 and a 64 item entity), **To the
offhand** with a totem then **Back into the inventory**, then a shield (the state's `offhand`), the
map's **Walk here** 6 blocks east on the column's surface from the tile (truth position), **Set
waypoint here** (`!wp <name>` and the waypoint in `/map.json`), a setting's **Reset**, and the
**Stop** button of a running 30-block `!goto` (the stack empties, the bot stands short of the goal);
plus the page markers, the page under 160 KB (since decision 0061 under `PANEL_BUDGETS.html`) and the
poll under 24 KB.

Track AR, measured on bds-core (2026-10-30, two runs each green): the page 104.9 KB (panel-core's
loaded inventory: 109.6 KB; the unit test's worst case 116.6 KB, script 45.7 KB, glyphs 2.9 KB;
limit 160 KB), the poll (`?lite=1`) 5.1 KB fresh and 9.8 KB with panel-core's inventory (worst case
16.8 KB; limit 24 KB); `/api/marks` 24 bytes on a fresh cache. Select: `POST` 2.8 to 3.5 ms, the
state shows the new slot after about 230 ms; Drop the stack: the truth inventory 128 -> 64 after 0.8
s, the item entity 64; a totem into the offhand after 0.43 s; Walk here 5.1 to 6.0 blocks in 1.4 to
1.7 s; Stop: the stack empty 4 ms after the reply, the bot 4.2 of 30 blocks along.

`panel-core` (bds-core, udp 19180; `PANEL_E2E_PORT`, default a random port in 9640..9649): the CLI
with `--walk --health-port <port>` and `BEDROCKBOT_PANEL_TOKEN`; `/api/state` 401 without the token,
the status and stack with it; the page markers and the cookie flow; `!wp set panel` and `!wp panel`
from the panel; `!goto x y z` from the panel moves the bot (truth position, the `goto` process in the
stack while it walks, `arrived at` in the panel chat); the log tail shows `panel: !wp set panel (as
console)`; Track AP: with iron armour, an iron sword, 20 cobblestone stacks (truth `give`) and a shulker box
holding 2 cobblestone stacks and 10 iron ingots (placed with truth `set`, filled with vanilla
`replaceitem`, broken with `setblock ... destroy`, picked up) `/api/state` carries them in `inventory`
(every slot equal to truth `inv`, the armour worn in its slots with full durability, 15 armour
points, the box's contents), `?lite=1` is under 20 KB, the page has the 41-cell grid and every status
block and no external URL, and `!set guardRadius 20` from the panel shows in `settings` (source
`chat`); `!panel` prints the loopback URL; 7 parallel commands get 429s; `!quit` from the panel
exits 0.

Measured on bds-core (2026-10-29, Windows dev machine, other agents' suites running): `/api/state`
about 5.3 KB, median 0.7 to 0.9 ms, max under 2 ms over 20 requests; the page 23.5 KB; `!wp set
panel` answered in 3 to 4 ms; `!goto` 7 blocks away arrived after 1.8 to 2.0 s; `!quit` exit 0 after
about 0.6 s.

Track AP, measured on bds-core (2026-10-29/30, two runs): with 22 slots used, iron armour and the
box, `/api/state` 14.6 to 14.7 KB and the page's poll (`?lite=1`) 9.5 to 9.6 KB, median 0.7 to
0.8 ms over 10 requests; the `inventory` block 2.5 KB; the memory count 0.53 to 0.55 ms (fresh
cache); the page 67 KB (fresh bot: 62 KB). Worst case in the unit test (36 stacks with tools, 20
cobblestone stacks, 6 shulker boxes, one with 27 kinds, iron armour, a shield, 50 log lines of 120
characters, 30 chat lines): poll 16.5 KB (`settings` 1.7 KB instead of 6.4 KB), full state 22.2 KB,
inventory 4.2 KB, the page 75 KB (script 17 KB, glyphs 3 KB). Render time (the script on the unit
test's fake DOM, every one of the 36 cells changing on every poll): median 0.16 ms, max 1.8 ms over
50 polls; a browser adds layout and paint, which the console line (`panel: render ... ms`) shows.

### Measured (decision 0061)

**Live, on bds-core** (2026-11-05, Windows dev machine, other agents' BDS containers running).
Four green runs of `BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e panel-stream
--silent=false`, two before and two after merging the event store (decision 0059). The numbers are
from the last two:

| What | Value |
|---|---|
| page | 95.9 KB, down from 140 to 150 KB with the inline script |
| the 16 modules | 94.1 KB raw, 32.1 KB gzip; largest `map.ts` 14.5 / 4.8 KB, `menu.ts` 13.6 / 4.5 KB, `transport.ts` 8.1 / 2.6 KB |
| first snapshot | 7.6 KB, 2 ms after the request |
| idle, 10 s | 9 deltas, median 340 bytes, max 372 to 410 bytes (the clock, uptime, the status line, the log); 0 heartbeats, since the deltas keep the stream busy; about 315 bytes/s, where polling moved a 7 to 12 KB state every 2 s (3.5 to 6 KB/s) |
| `!set` from the panel to the delta on the page | 267 to 269 ms (630 to 660 bytes) |
| the same command on the `events` topic | 242 bytes (`!set guardRadius 9 from console (panel)`), also listed by `/api/events` |
| a truth `give` of 7 oak planks to the inventory delta | 730 to 740 ms (about 450 to 480 bytes: the cell, the clock, the status line) |
| resume after a 2.5 s gap with a change | 1 delta replayed, 680 bytes, instead of an 8.4 KB snapshot |
| cap | 8 streams open, the ninth 503 (`retry-after: 30`); `?lite=1` meanwhile in 1 ms |

The existing e2e still pass on the same container after the merge: `panel-core` (6 tests, port
9946) and `panel-actions` (8 tests, port 9947 or 9948). Two changes to them:

- their page caps now use `PANEL_BUDGETS.html`;
- panel-actions now expects **Drop the stack** to send `!drop slot <n>`. That has been the menu's
  command since `!drop slot` shipped; the test was stale.

**Worst-case unit fixture** (`PANEL_MEASURE=1 ... panel-budgets.test.ts`):

| What | Value |
|---|---|
| page | 108 328 bytes: CSS 11.7 KB, embedded state 19.5 KB, glyphs 7.2 KB, preload links 1.1 KB; the rest is the server-rendered structure |
| snapshot | 19 569 bytes |
| busy-second delta | 682 bytes, 14 ops: two cells, a scrolled log, a chat line, vitals, position, the clock, the stack line, uptime |
| delta with the whole inventory reversed and 5 log lines | 3 835 bytes |

**Startup.** Stripping and checking the modules takes 14 to 17 ms, once per process.

### Measured (decision 0062)

These numbers come from a live run on bds-cache, a generated world (2026-11-05, Windows dev machine,
other agents' BDS containers running). `panel-map` passed four runs in a row
(ports 9952 to 9954, then 9950), and [map.md](map.md) "Measured" has the payload table.

| What | Value |
|---|---|
| page | 104.4 KB, 23 modules (159.9 KB raw, 52.6 KB gzip; the map screen about 79 KB of it) |
| a block set by truth, to its tile on the `map` topic | 71 to 922 ms (the tick is 1 s) |
| `map` messages | 1 tile 1.0 KB; the first after a registration 25 tiles 35.7 KB |
| 10 s open, r=4, the bot standing | 12 `map` messages, 14.7 KB raw (2.4 KB gzip); the old poll would have moved 22.0 KB raw (7.1 KB gzip) |
| surface of 40 sampled columns against truth | 40 of 40 in every run |
| Y-slice of 2 304 cells at the platform and at a natural height | 2 304 of 2 304 in every run |
| Go here, 8 blocks | 1.9 to 2.2 s |
| box Clear, 6 dirt blocks | 9.7 to 9.9 s |

**The existing e2e on bds-cache.** These also pass on the same container:

- `panel-core` (6 tests), `panel-actions` (8) and `panel-stream` (6), with `CORE_BDS_PORT=19184
  CORE_BDS_CONTAINER=bds-cache CORE_FEET_Y=240`, ports 9955 to 9957;
- `cache-map` (1) and `cache-surface` (1), with `CACHE_HEALTH_PORT` 9958 / 9959.

Two changes to the older tests:

- panel-core's page marker is now `id="mapscreen"`;
- panel-actions accepts `blocks` in `/api/marks`.
