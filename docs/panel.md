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

Server-rendered (the structure, the settings table and the current state as JSON), then an inline
script (`client.ts`) fills every node from that JSON at once and from `/api/state?lite=1` every
2 s. No build step, no external assets: no CDN, no web fonts (the system font), no image files in the
page (the item glyphs are inline SVG; the real icons are requests to the panel itself, "Item icons"
below); the machine may be offline from the internet.

### Layout

Dark by default; the **light / dark** button in the header switches and remembers the choice in the
browser (`localStorage` `bbpanel-theme`; every storage access is in try/catch, so a private window
or blocked storage just means the choice is not kept). Without a stored choice the browser's
`prefers-color-scheme: light` gives the light theme. A tiny script in `<head>` sets the theme before
the first paint (no dark flash on a light phone).

The cards sit in a grid: **one column on a phone** (under 760 px wide; the order is inventory, bot,
status, commands, combat, memory, planner, connection, log, settings, help, map), **two columns** on
a tablet or a small laptop window, **three** from 1200 px (inventory, bot and status side by side on
the first row). Settings, help and map always span the full width. Nothing is wider than the screen
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
- **Help**: the command registry, the modes and the settings (Track AM), fetched when opened;
- **Map**: the panel's own map (Track AR; it was the `/map` page in a frame), drawn only while the
  section is open, plus a link to the full debug page.

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

Every poll renders into the nodes the server rendered: a text node is written only when its text
changed, a bar only when its width changed, an inventory cell only when its item, count, durability
or contents changed (a signature per cell), the process list only when the stack changed. Nothing
replaces the page's HTML, so there is no flicker, an open `<details>`, a half-typed command or a
setting being edited stay as they are, and the log keeps its scroll position. Polls run every 2 s
while the tab is visible and every 10 s while it is hidden (`document.hidden`); coming back polls at
once. Every 30th render logs its time in the browser's console (`panel: render 0.42 ms, state 9524
bytes`, level debug / verbose).

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

### Map

The **Map** section draws its own canvas (it no longer frames `/map`): `/map.json` every 2 s while
the section is open (the tiles as before, the bot as an arrow by its yaw, the trail, the current path
and goal), and every 10 s `GET /api/marks` for the remembered chests and herds. A legend names the
colours: bot, path / goal, home (square), shelter (square), waypoints (diamonds), chests, herds,
hostiles, players. **Follow bot** (on by default) keeps the bot centred; dragging turns it off; `+` /
`-` or the wheel zoom; the radius select sets the window (4 to 16 chunks). Hovering (or tapping) shows
what is under the pointer: the nearest marker within 10 px with its name (`waypoint base`, `chest
"ores"`, `herd: 5 cow (penned)`), else the column (`18310 17280: solid at y -61 (remembered)`).

**Right-click or long-press** (550 ms) a column for its menu (`mapActions`):

| Entry | Command |
|---|---|
| Walk here | `!goto x y z`, y = the column's surface + 1 from the tile (`Walk here (height unknown)` uses the bot's y for a column the cache never saw) |
| Set home here | `!home set x y z` (confirmed) |
| Set shelter here | `!shelter set x y z` (confirmed) |
| Set waypoint here... | asks for a name in the menu (1..32 of a-z 0-9 _ -), then `!wp set <name> x y z` |

Mine here and build markers are not offered: `!get <ore> n` is not positional and there is no
marker command. The map's waypoints and shelter now really show: the map routes lift the afk task's
`nav.waypoints` and `night.shelter` into `/map.json`'s `waypoints` / `shelter` (`map/routes.ts`
`liftTaskStatus`; before, the JSON had none for the afk task).

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

## API

| Request | Answer |
|---|---|
| `GET /api/state` | `PanelState` JSON (below) |
| `GET /api/state?lite=1` | the same without what does not change while the bot runs: `commands` and `quick` left out, `settings` rows only `key`, `value`, `source`; `"lite": true` (what the page polls; Track AP) |
| `GET /api/chests` | the remembered containers, nearest first: `[{"x":10,"y":-60,"z":4,"kind":"chest","label":"ores","stacks":12,"size":27,"top":[["coal",320],["iron_ore",40]],"unreachable":null,"readAt":1761753600000}]` (`[]` without a world cache; Track AP) |
| `GET /api/marks` | Track AR: what the panel's map draws beyond `/map.json`, within 256 blocks of the bot, nearest first, at most 200 each: `{"chests":[{"x":10,"y":-60,"z":4,"kind":"chest","label":"ores","unreachable":false}],"herds":[{"x":5.5,"y":-60,"z":5.5,"n":5,"kind":"cow","penned":true}]}` (empty lists without a world cache) |
| `GET /icons/<name>.png` | the item's icon (`image/png`, 16 x 16 or 32 x 32), or 404 `{"error":"no icon for this item"}`; `HEAD` the same without the body; 405 other methods ("Item icons") |
| `POST /api/cmd` `{"text":"!wp set base"}` | 200 `{"command":"!wp set base","ok":true,"replies":["waypoint base set to 10 -60 20"]}`; 409 `ok:false` + `error` when there is no owner to run as; 400 bad body; 413 body over 4 KiB; 429 over 5 commands per second; 405 other methods |
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
in `chat` on the next poll.

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
| `health/panel/index.ts` | `setupPanel` (wiring, `!panel`), `planPanel` (where it serves), `panelLine` (the owner a command runs as), `panelUrls`, `ChatTap` (the bot's replies) |
| `health/panel/auth.ts` | `checkRequest` (token, cookie, loopback Host, POST rules), `panelAuth` (the health server hook), `RateLimiter` |
| `health/panel/routes.ts` | `/`, `/api/state` (and `?lite=1`), `/api/help`, `/api/chests`, `/api/marks` (Track AR), `/api/cmd` |
| `health/panel/state.ts` | `PanelState`, `buildPanelState`, `liteState`, quick commands, `buildPanelHelp` |
| `health/panel/inventory.ts` | Track AP: the `inventory` block: `buildInventory`, `iconClassOf`, `itemColour`, `itemAbbr`, `durabilityOf`, `boxContents` |
| `health/panel/memory.ts` | Track AP: the `memory` counts (`buildMemory`) and the chest list (`chestRows`) |
| `health/panel/glyphs.ts` | Track AP: the hand-drawn item glyphs (inline SVG symbols); the fallback of the icons |
| `health/panel/icons/book.ts` | wave 11: `IconBook.png(name)`: the rules (flat, block or none), the caches, the answer for `/icons/<name>.png` |
| `health/panel/icons/source.ts` | the asset folder of the `minecraft-assets` package (`ASSET_VERSION`), `FsAssets` (path allowlist) |
| `health/panel/icons/models.ts`, `render.ts` | the model's parent chain (`resolveModel`) and the `display.gui` renderer (`renderModel`: projection, shading, front-to-back compositing) |
| `health/panel/icons/names.ts`, `png.ts` | the Bedrock -> Java name aliases, the solid parents, the tints; the pngjs wrapper (decode, encode, first frame, tint, overlay) |
| `health/panel/client.ts` | Track AP: the page script (render into existing nodes, stale marker, hidden-tab back-off, theme, commands, Help, chest list); Track AR: the menus and confirmations, the settings controls and mode selector, the palette, the quick-button editor, Stop / Pause / Resume, the log filter, the map canvas |
| `health/panel/page.ts` | the page (`renderPanelPage`): structure, CSS (themes, responsive grid), the 41 inventory cells, the status blocks; Track AR: the grouped settings rows, the mode bar, the menu, toast, palette and map markup |
| `health/panel/menu.ts` | Track AR: the menu model as plain JavaScript (`MENU_JS`: `cellActions`, `mapActions`, `settingActions`, `setCommand`, `settingVisible`, `modeOf`, `modeChanges`, `stackActions`, `paletteMatch`, `logVisible`), embedded in the page and evaluated for the server and the tests |
| `health/panel/marks.ts` | Track AR: `GET /api/marks` (`mapMarks`: chests and herds near the bot) |
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
```

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
storage with save and defaults, the log filters, the palette from `/api/help`, the map's poll, its
right-click menu, Walk here on the surface and the waypoint name prompt), `panel-server.test.ts`
(`paused`, `/api/marks` behind the token).

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
plus the page markers, the page under 160 KB and the poll under 24 KB.

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
