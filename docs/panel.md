# LAN control panel (`bot/src/health/panel`)

Phase 7, wave 8 Track AE. Decision record: [decisions/0026-lan-control-panel.md](decisions/0026-lan-control-panel.md).
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

Server-rendered from the current state, then a little inline script polls `/api/state` every 2 s.
No build step, no external assets (the machine may be offline from the internet); works at phone
width.

- header: bot name, connection state, server, task, game version; a green / red dot = `/healthz`;
- **Status**: the `!status` reply (status line, process line) and the process stack (state, name,
  kind, priority, line, ETA);
- **Bot**: health, food, position, dimension, time of day (with day / dusk / night / dawn);
- **Commands**: quick buttons `!status`, `!home go`, `!stop`, `!guard on`, `!guard off`, `!eat`,
  `!equip`, `!inv` (no `!come`: it needs a player in the game), a command box (any `!command`; the
  `!` is added when missing; the command names complete from `!help`'s list), the replies said while
  the command ran, and **Bot chat**: the last 30 lines the bot said (also replies that arrive later,
  such as `arrived at ...`; `(not sent to the game)` when the chat layer dropped one: not spawned or
  its 8 per 10 s limit);
- **Log**: the last 50 log lines (all loggers);
- **Settings**: the `!set` table (value, range, default, where the value came from: default / file /
  startup / chat), editable: "set" sends `!set <key> <value>` through the command box path;
- **Map**: the debug map (`/map`) in a frame, loaded only while the section is open (it polls every
  second), plus a link to the full page.

## API

| Request | Answer |
|---|---|
| `GET /api/state` | `PanelState` JSON (below) |
| `POST /api/cmd` `{"text":"!wp set base"}` | 200 `{"command":"!wp set base","ok":true,"replies":["waypoint base set to 10 -60 20"]}`; 409 `ok:false` + `error` when there is no owner to run as; 400 bad body; 413 body over 4 KiB; 429 over 5 commands per second; 405 other methods |
| `GET /healthz`, `/metrics`, `/map`, `/map.json` | as before (runbook "Operations") |

`PanelState` (`v` 1; `bot/src/health/panel/state.ts`):

```jsonc
{
  "v": 1, "ts": 1761753600000,
  "bot": { "name": "AfkBot", "server": "127.0.0.1:19180 (raknet)", "task": "afk", "state": "spawned", "healthy": true, "gameVersion": "1.26.60" },
  "status": ["status: up 2m, session 2m, ..., task afk, behaviour idle, ...", "processes: idle"],
  "stack": [{ "name": "goto", "kind": "user", "priority": 40, "state": "active", "line": "walking to 18311 -60 17027", "etaS": null }],
  "self": { "health": 20, "food": 20, "pos": { "x": 0.5, "y": -60, "z": 0.5 }, "dimension": "overworld", "timeOfDay": 6000, "phase": "day" },
  "settings": [{ "key": "guardRadius", "kind": "number", "value": "16", "default": "16", "min": 2, "max": 64, "unit": "blocks", "source": "default", "description": "..." }],
  "logs": ["2026-10-29T18:52:53.123Z INFO  [health] panel: !wp set panel (as console)", "..."],
  "chat": [{ "ts": 1761753600000, "text": "waypoint panel set to 18304 -60 17024", "sent": true }],
  "commands": ["status", "pos", "quit", "help", "..."],
  "quick": ["!status", "!home go", "!stop", "!guard on", "!guard off", "!eat", "!equip", "!inv"]
}
```

A source that throws gives its fallback (`null`, `[]`, `"unknown"`) instead of a 500.

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
| `health/panel/routes.ts` | `/`, `/api/state`, `/api/cmd` |
| `health/panel/state.ts` | `PanelState`, `buildPanelState`, quick commands |
| `health/panel/page.ts` | the page (`renderPanelPage`) |
| `health/panel/logRing.ts` | `LogRing`: the last log lines (wraps `console.error`, which every logger writes with), redaction |
| `connection/health.ts` | `host` option, `auth` hook (every path but `/healthz`), `use()` for routes of any method |
| `config/config.ts`, `resolve.ts`, `init.ts` | the `panel` block, `BEDROCKBOT_PANEL_TOKEN`, the generated token |

## Tests

```sh
pnpm --filter bot exec vitest run --project unit test/unit/health                       # token, cookie, rate limit, state shape, HTTP, config
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e panel-core --silent=false     # bds-core (~15 s)
```

`panel-core` (bds-core, udp 19180; `PANEL_E2E_PORT`, default a random port in 9640..9649): the CLI
with `--walk --health-port <port>` and `BEDROCKBOT_PANEL_TOKEN`; `/api/state` 401 without the token,
the status and stack with it; the page markers and the cookie flow; `!wp set panel` and `!wp panel`
from the panel; `!goto x y z` from the panel moves the bot (truth position, the `goto` process in the
stack while it walks, `arrived at` in the panel chat); the log tail shows `panel: !wp set panel (as
console)`; `!panel` prints the loopback URL; 7 parallel commands get 429s; `!quit` from the panel
exits 0.

Measured on bds-core (2026-10-29, Windows dev machine, other agents' suites running): `/api/state`
about 5.3 KB, median 0.7 to 0.9 ms, max under 2 ms over 20 requests; the page 23.5 KB; `!wp set
panel` answered in 3 to 4 ms; `!goto` 7 blocks away arrived after 1.8 to 2.0 s; `!quit` exit 0 after
about 0.6 s.
