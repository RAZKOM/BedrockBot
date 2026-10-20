# Runbook

## Phase 1 on BDS

Local BDS only (container `bds-dev`, RakNet on udp/19132, offline mode, flat world, truth pack
deployed). Commands run from the repo root unless noted.

### Server

```sh
pnpm bds:up                         # start/recreate bds-dev, wait for "Server started." (~17 s)
pnpm bds:restart                    # docker restart bds-dev and wait (reconnect testing)
pnpm bds:idle                       # print the effective player-idle-timeout
BDS_IDLE_TIMEOUT=1 pnpm bds:up      # recreate with a 1-minute idle kick (keepalive testing)
pnpm bds:up                         # recreate with the default PLAYER_IDLE_TIMEOUT=0 again
pnpm bds:cmd say !status            # console command
pnpm pack:deploy                    # (re)deploy the truth pack, e.g. after wiping docker/data/dev
```

`docker/compose.dev.yml` reads `PLAYER_IDLE_TIMEOUT` from `${BDS_IDLE_TIMEOUT:-0}`; changing it makes
`docker compose up -d` recreate the container, the world in `docker/data/dev` is kept.

### Bot

```sh
pnpm bot:afk                                         # = pnpm --filter bot start -- --task afk
pnpm --filter bot start -- --task afk --nudge-interval 30 --duration 300
pnpm --filter bot start -- --task echo               # print chat and position
pnpm --filter bot start -- --help
```

| Option | Default | Meaning |
|---|---|---|
| `--task afk` | `echo` | stay online, nudge every `--nudge-interval` s |
| `--nudge-interval <s>` | 240 | look-around + one-tick sneak toggle; 0 = never |
| `--heartbeat` | off | also send an idle `player_auth_input` every tick |
| `--owner <name or xuid:N>` | none | allowed to run chat commands (repeatable; env `BOT_OWNERS`) |
| `--no-console-owner` | | refuse commands typed into the server console |
| `--log-dir <dir>` | `bot/logs` | `disconnects.jsonl` and `metrics.json` (git-ignored) |
| `--metrics-interval <s>` | 60 | how often `metrics.json` is rewritten |
| `--no-reconnect` | | exit (code 1) instead of reconnecting |

Exit codes: 0 on `!quit`, SIGINT/SIGTERM or `--duration`; 1 when the connection is lost for good
(or with `--no-reconnect`); 3 when the server and the bot speak different game versions (never
retried); 2 for bad arguments.

### Chat commands

Typed in chat by an owner, or from the server console (`say !status`, `tell AfkBot !pos`).
Replies are player chat from the bot.

| Command | Reply |
|---|---|
| `!status` | `status: up 1h02m, session 12m03s, reconnects 0, kicks 0, pos 0.50 -60.00 0.50, version 1.26.51, tick 14460, task afk, nudges 15, corrections 0` |
| `!pos` | `pos 0.50 -60.00 0.50` (feet) |
| `!quit` | `bye (quit by console)`, then a clean disconnect and exit 0 |
| `!help` | `commands: !status !pos !quit !help` |

Everyone else is ignored (logged as "not an owner"). Truth-pack lines (`@truth ...`), json/system
messages and the bot's own echo are never parsed as commands.

### Files

- `bot/logs/disconnects.jsonl`: one line per session end: `ts`, `username`, `server`,
  `gameVersion`, `reason`, `kind` (`kick`, `closed`, `error`, `ping`, `timeout`, `version`,
  `client`), `kick` (`{reason, message}` from the server's disconnect packet), `willReconnect`,
  `retryInMs`, `spawnedMs`.
- `bot/logs/metrics.json`: rewritten every minute and on exit: uptime, session uptime, spawns,
  reconnects, disconnects by kind, kicks by reason, last disconnect, counters (`nudges`,
  `corrections`, `deaths`, `chat.run`, `chat.denied`), position.

### Tests

```sh
pnpm -r test                                   # unit tests
pnpm lint
BDS_E2E=1 pnpm --filter bot test:e2e           # e2e incl. reconnect (docker restart bds-dev), chat, AFK nudge
BDS_E2E=1 BDS_SOAK=1 pnpm --filter bot exec vitest run --project e2e test/e2e/keepalive.test.ts --silent=false
```

The soak recreates bds-dev with `PLAYER_IDLE_TIMEOUT=1`, runs the AFK CLI with a 30 s nudge for
3 minutes (no kick, no correction), runs it again with nudges off (a kick, if any, must be
`kicked_for_idle`; see below), then restores
`PLAYER_IDLE_TIMEOUT=0`. If it is interrupted, run `pnpm bds:up` to restore the default.
The reconnect e2e restarts bds-dev, so do not run it while someone else uses bds-dev.

### Behaviour measured on BDS 1.26.51.1 (2026-10-28)

- **Idle kick reason**: `disconnect` packet with reason `kicked_for_idle`,
  `hide_disconnect_reason: false` and an **empty message**; the bot logs `kicked: kicked_for_idle`
  and `kicks.byReason` counts it as `kicked_for_idle`. Seen once: with `player-idle-timeout=1`,
  a client that sent 5 standing inputs right after spawn and then nothing was kicked 63 s later.
- **The idle kick did not reproduce.** In 15+ later attempts (same probe and name pattern, 1/2/5
  initial inputs, airborne/sneak/look/gravity variants, another player sending identical or
  rotating inputs, joins, console commands, operator and de-opped players, easy and peaceful,
  container recreated and restarted, one client idle for 20 minutes) nobody was kicked. A client
  that never sends `player_auth_input` was never kicked either (5.5 min), and identical idle
  inputs (every tick or every 30 s) never led to a kick. The trigger of the one kick is unknown.
  Consequences: BDS cannot currently prove that the nudge defeats an idle kick; the soak checks
  that nudges cause no kick and no correction, and its control run accepts "no kick" unless
  `BDS_IDLE_CONTROL_STRICT=1`. The real Realm kick must be measured in task 1.7 (fact 8b).
  The AFK task sends one standing "settle" input after each spawn, as a real client would, and
  keeps nudging regardless.
- **Mobs**: on `easy` a standing AFK bot was killed at night on the flat world; bds-dev now
  defaults to `DIFFICULTY=peaceful` (`BDS_DIFFICULTY` overrides). On the Realm, expect deaths:
  the AFK task presses respawn automatically.
- Player chat sent by the bot must use `category: 'authored'`; with `message_only` (the
  serializer default) BDS silently drops the connection.
- Relayed chat names carry a `§r` suffix (`source_name: "Steve§r"`); console `say` arrives as
  `announcement` from `Server` with message `[Server] <text>`, console `tell` as `whisper` from
  `Server`, `tellraw` as `json_whisper`, truth replies as `json`.
- `docker restart bds-dev`: BDS first sends every player `disconnect` with reason
  `host_disconnected` (empty message); the bot was back and spawned about 18 to 20 s after the
  restart started. A console `kick <name> <msg>` arrives as reason `kicked` with message
  `<msg>`; the bot is back within a few seconds.
- Death (e.g. `kill AfkBot`): the server sends `respawn` state 0; the AFK task answers with
  `respawn` state 2 plus `player_action respawn` after 2 s, then the normal state 1/2 handshake.
  BDS may follow up with one `correct_player_move_prediction` to the real respawn point; the task
  adopts it.
- `disconnect()` returns before RakNet sends the packet; a process that exits right away leaves
  the session open and the next login with the same name fails. Use `disconnectAndFlush()`.
- bedrock-protocol 3.60.1 ignores the `viewDistance` createClient option; the Connection sets
  `client.viewDistance` itself (BDS answered a request of 4 with radius 5).
- Two clients that start their RakNet handshake at the same moment from one host: one of them
  sometimes times out ("Connect timed out"). Connect test clients one after another.
