# LAN control panel (`bot/src/health/panel`)

Phase 7, wave 8 Track AE; the graphical inventory, the status blocks and the responsive layout are
wave 9 Track AP. Decision records: [decisions/0026-lan-control-panel.md](decisions/0026-lan-control-panel.md),
[decisions/0037-panel-inventory-and-statuses.md](decisions/0037-panel-inventory-and-statuses.md).
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
2 s. No build step, no external assets: no CDN, no web fonts (the system font), no image files (the
item glyphs are inline SVG); the machine may be offline from the internet.

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

Each cell is drawn, not textured: a hand-drawn 16 x 16 glyph for the item's class (`sword`,
`pickaxe`, `axe`, `shovel`, `hoe`, `bow`, `shield`, `helmet`, `chestplate`, `leggings`, `boots`,
`food`, `block`, `ore`, `box`, `bucket`, `torch`, else a plain rounded `item` tile) in the item's
colour (the material's colour for iron / gold / diamond / netherite / wood / stone / leather / ... ,
else a colour from an FNV-1a hash of the name, so the same item has the same colour everywhere), a
2 to 3 letter abbreviation in the corner (`Co` cobblestone, `ISw` iron sword, `USB` undyed shulker
box), the count when above 1, and a **durability bar** (green above 50 %, yellow above 20 %, red
below) on tools, weapons and armour (NBT `Damage` against the durability tables of
`skills/survival/tools.ts`). Hovering shows the full name, count, durability and box contents;
**tapping a cell** shows them in the line under the grid (tap again to close). Empty armour slots
show a diagonal stroke.

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
  the last disconnect;
- **Commands**: quick buttons `!status`, `!home go`, `!stop`, `!guard on`, `!guard off`, `!eat`,
  `!equip`, `!inv` (no `!come`: it needs a player in the game), a command box (any `!command`; the
  `!` is added when missing; the command names complete from `!help`'s list), the replies said while
  the command ran, and **Bot chat**: the last 30 lines the bot said (also replies that arrive later,
  such as `arrived at ...`; `(not sent to the game)` when the chat layer dropped one: not spawned or
  its 8 per 10 s limit);
- **Log**: the last 50 log lines (all loggers);
- **Settings**: the `!set` table (value, range, default, where the value came from: default / file /
  startup / chat), editable: "set" sends `!set <key> <value>` through the command box path;
- **Help**: the command registry, the modes and the settings (Track AM), fetched when opened;
- **Map**: the debug map (`/map`) in a frame, loaded only while the section is open (it polls every
  second), plus a link to the full page.

### Live updates

Every poll renders into the nodes the server rendered: a text node is written only when its text
changed, a bar only when its width changed, an inventory cell only when its item, count, durability
or contents changed (a signature per cell), the process list only when the stack changed. Nothing
replaces the page's HTML, so there is no flicker, an open `<details>`, a half-typed command or a
setting being edited stay as they are, and the log keeps its scroll position. Polls run every 2 s
while the tab is visible and every 10 s while it is hidden (`document.hidden`); coming back polls at
once. Every 30th render logs its time in the browser's console (`panel: render 0.42 ms, state 9524
bytes`, level debug / verbose).

## API

| Request | Answer |
|---|---|
| `GET /api/state` | `PanelState` JSON (below) |
| `GET /api/state?lite=1` | the same without what does not change while the bot runs: `commands` and `quick` left out, `settings` rows only `key`, `value`, `source`; `"lite": true` (what the page polls; Track AP) |
| `GET /api/chests` | the remembered containers, nearest first: `[{"x":10,"y":-60,"z":4,"kind":"chest","label":"ores","stacks":12,"size":27,"top":[["coal",320],["iron_ore",40]],"unreachable":null,"readAt":1761753600000}]` (`[]` without a world cache; Track AP) |
| `POST /api/cmd` `{"text":"!wp set base"}` | 200 `{"command":"!wp set base","ok":true,"replies":["waypoint base set to 10 -60 20"]}`; 409 `ok:false` + `error` when there is no owner to run as; 400 bad body; 413 body over 4 KiB; 429 over 5 commands per second; 405 other methods |
| `GET /healthz`, `/metrics`, `/map`, `/map.json` | as before (runbook "Operations") |

`PanelState` (`v` 1; `bot/src/health/panel/state.ts`):

```jsonc
{
  "v": 1, "ts": 1761753600000,
  "bot": { "name": "AfkBot", "server": "127.0.0.1:19180 (raknet)", "task": "afk", "state": "spawned", "healthy": true, "gameVersion": "1.26.60" },
  "status": ["status: up 2m, session 2m, ..., task afk, behaviour idle, ...", "processes: idle"],
  "stack": [{ "name": "goto", "kind": "user", "priority": 40, "state": "active", "line": "walking to 18311 -60 17027", "etaS": null }],
  "self": { "health": 20, "food": 20, "pos": { "x": 0.5, "y": -60, "z": 0.5 }, "dimension": "overworld", "timeOfDay": 6000, "phase": "day",
            "saturation": 5, "weather": "clear", "day": 12, "deaths": 1,
            "lastDeath": { "cause": "death.attack.mob", "ts": "2026-10-29T18:00:00.000Z", "messages": ["%entity.zombie.name"] } },
  "inventory": { ... },                 // below
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
| `health/panel/routes.ts` | `/`, `/api/state` (and `?lite=1`), `/api/help`, `/api/chests`, `/api/cmd` |
| `health/panel/state.ts` | `PanelState`, `buildPanelState`, `liteState`, quick commands, `buildPanelHelp` |
| `health/panel/inventory.ts` | Track AP: the `inventory` block: `buildInventory`, `iconClassOf`, `itemColour`, `itemAbbr`, `durabilityOf`, `boxContents` |
| `health/panel/memory.ts` | Track AP: the `memory` counts (`buildMemory`) and the chest list (`chestRows`) |
| `health/panel/glyphs.ts` | Track AP: the hand-drawn item glyphs (inline SVG symbols) |
| `health/panel/client.ts` | Track AP: the page script (render into existing nodes, stale marker, hidden-tab back-off, theme, commands, Help, chest list) |
| `health/panel/page.ts` | the page (`renderPanelPage`): structure, CSS (themes, responsive grid), the 41 inventory cells, the status blocks |
| `health/panel/logRing.ts` | `LogRing`: the last log lines (wraps `console.error`, which every logger writes with), redaction |
| `connection/health.ts` | `host` option, `auth` hook (every path but `/healthz`), `use()` for routes of any method |
| `config/config.ts`, `resolve.ts`, `init.ts` | the `panel` block, `BEDROCKBOT_PANEL_TOKEN`, the generated token |

## Tests

```sh
pnpm --filter bot exec vitest run --project unit test/unit/health                       # token, cookie, rate limit, state shape, HTTP, config; Track AP: inventory, statuses, memory, payload, page markup, the script on a fake DOM
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e panel-core --silent=false     # bds-core (~15 s)
```

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
