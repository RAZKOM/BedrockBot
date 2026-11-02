# 0026: LAN control panel

Date: 2026-10-29. Status: accepted (Phase 7, wave 8 Track AE; extends the health endpoint of PLAN.md
task 5.4 and the debug map of [0015](0015-world-cache.md)). Server: BDS 1.26.60.6 (`bds-core`).
Details: [../panel.md](../panel.md).

## Context

The owner asked when the web UI and controller come into play. The bot runs 24 h on a Mac on the
owner's LAN; the health server already serves `/healthz`, `/metrics` and the debug map on 127.0.0.1,
and every control so far is a chat command, which needs the game open. The Mac may be offline from
the internet, the deployment must keep working with no config change, and the bot's main thread must
not be slowed (the physics loop runs every 50 ms).

## Decisions

1. **The panel lives on the health server.** One page at `/`, `GET /api/state`, `POST /api/cmd`,
   mounted with a new `HealthServer.use()` hook (routes of any method, asked before the built-in
   ones). No second web stack, no new dependency. `panel.port` defaults to `healthPort`; another port
   gives the panel its own server and leaves the health server exactly as it was.
2. **Commands go through `Chat.handle`.** The panel builds a chat line from the first owner (name, else
   XUID, else the console) and hands it to the chat layer, so parsing, the owner check, logging,
   command events and metrics are the ones the game uses; no second command path to keep in sync.
   Replies are captured by wrapping the chat instance's `say`, so they also go to the game chat (as
   if the owner had typed the command there) and asynchronous replies (`arrived at`) reach the page.
3. **Server-rendered page, polling, no assets.** The page is rendered from the current state, then
   polls every 2 s (a state build is a few closures; measured median under 1 ms). No build step, no
   CDN, no websocket. The map is the existing `/map` page in a frame, loaded only on demand.
4. **Token or loopback.** With `panel.token` every path except `/healthz` needs it (Bearer header, or
   `?token=` once, which sets an HttpOnly SameSite=Strict cookie and redirects the token out of the
   address bar). Without a token the panel refuses any interface but the loopback (logged, falls back
   to 127.0.0.1) and checks the Host header against DNS rebinding. POSTs need JSON and a same-origin
   Origin (no CSRF from other pages); `/api/cmd` is limited to 5 per second. `pnpm config:init`
   generates a random 24-character token and prints it once; `BEDROCKBOT_PANEL_TOKEN` overrides it.
5. **No credentials in the panel.** It never shows or stores the token or any sign-in secret; log
   lines are redacted before the ring keeps them. The log ring wraps `console.error` (every logger
   writes with it) instead of changing `log.ts`.
6. **LAN only, by documentation and default.** The default binds 127.0.0.1; the owner opts in with
   `panel.host` `0.0.0.0` plus a token. The docs say plainly: never port-forward it.

## Consequences

- Existing endpoints, ports and the Mac deployment are unchanged without a `panel` block; `/` used
  to be a 404 and is now the panel on 127.0.0.1.
- With the panel on the health port and a token, `/metrics` and `/map` need the token too; a local
  `curl /metrics` keeps working with a separate `panel.port` (documented in deploy/README.md).
- Panel commands show in the game chat like typed ones; the chat's 8 replies per 10 s limit applies,
  but the panel still shows dropped replies (`not sent to the game`).
- `!come` / `!follow` from the panel target the first owner by name (they need that player online).
- HTTP, not HTTPS: on a home LAN the token crosses the network in clear text. Acceptable for a LAN
  tool; anyone needing more uses an SSH tunnel to the loopback panel instead.
- One more `!command` (`!panel`) and a `panel` config block; `HealthServerOptions` gains `host` and
  `auth`.
