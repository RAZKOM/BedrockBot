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

Each track's e2e suite has its own server so runs never share terrain or restarts. All use the
bds-dev settings (BDS 1.26.51.1 unless noted, RakNet, offline, flat, peaceful, operator):

| Container | Port | Compose file | Used by |
|---|---|---|---|
| bds-dev | 19132 | docker/compose.dev.yml | echo, chat, reconnect, keepalive, AFK CLI |
| bds-world | 19142 | (docker run, see docs/world-model.md) | world-* (BDS_WORLD_*) |
| bds-move | 19146 | docker/compose.move.yml (TICK_DISTANCE 10) | nav-*, skills-input (MOVE_BDS_* / PHYS_BDS_*) |
| bds-dig | 19148 | docker/compose.dig.yml | dig (DIG_BDS_*) |
| bds60 | 19134 | docker/compose.dev60.yml (BDS 1.26.60.6) | `pnpm e2e:60` |
| bds-nn | 19140 | docker/compose.dev-nethernet.yml (NetherNet) | `pnpm e2e:nn` |

Start one with `docker compose -f docker/compose.<name>.yml up -d`, then deploy the truth pack:
`pnpm --filter @bedrockbot/truth-pack pack:deploy --data docker/data/<name> --world <level> --restart <container>`.
The full `BDS_E2E=1` e2e run needs bds-dev, bds-world, bds-move and bds-dig up; a stopped one shows
as "Ping timed out" in its suite.

`docker/compose.dev.yml` reads `PLAYER_IDLE_TIMEOUT` from `${BDS_IDLE_TIMEOUT:-0}`; changing it makes
`docker compose up -d` recreate the container, the world in `docker/data/dev` is kept.

Two more profiles run beside bds-dev (same settings: offline, flat world `dev`, peaceful, no idle
kick; `scripts/bds.mjs` takes `--profile <name>` before or after the command):

| Profile | Container | Compose file | BDS | Transport | Ports | Data |
|---|---|---|---|---|---|---|
| `dev` (default) | `bds-dev` | `docker/compose.dev.yml` | 1.26.51.1 | RakNet | udp/19132 | `docker/data/dev` |
| `dev60` | `bds60` | `docker/compose.dev60.yml` | 1.26.60.6 | RakNet | udp/19134 | `docker/data/dev60` |
| `nn` | `bds-nn` | `docker/compose.dev-nethernet.yml` | 1.26.51.1 | NetherNet (LAN) | tcp+udp/19140, udp/19160-19167 (WebRTC), udp/7551 (discovery) | `docker/data/nn` |

```sh
pnpm bds60:up                               # = node scripts/bds.mjs --profile dev60 up
pnpm bdsnn:up                               # = node scripts/bds.mjs --profile nn up
node scripts/bds.mjs --profile dev60 pack   # deploy the truth pack into docker/data/dev60 and restart
node scripts/bds.mjs --profile nn cmd say hi
```

`BDS_CONTAINER=<container>` selects the profile too (the e2e suite sets it, so its
`bds.mjs restart` restarts the container under test, not bds-dev).

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
| `--version <ver>` | `1.26.51` (env `BOT_VERSION`) | game version; `1.26.60` works through `patches/minecraft-data@3.117.0.patch` |
| `--transport nethernet` | `raknet` | NetherNet with LAN signalling (local BDS); `--port` is then ignored |
| `--target realm` | `bds` | see "Realm join (you do this)" below |

Examples: `node src/index.ts --task echo --port 19134 --version 1.26.60` (bds60),
`node src/index.ts --task echo --transport nethernet` (bds-nn), both run from `bot/`.

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
pnpm e2e:60                                    # whole e2e suite against bds60 (BDS 1.26.60.6, game version 1.26.60)
pnpm e2e:nn                                    # whole e2e suite against bds-nn (NetherNet)
cd bot && node scripts/e2e-profile.ts nn test/e2e/echo test/e2e/chat   # a subset
```

`scripts/e2e-profile.ts` points every suite (BDS_*, BDS_WORLD_*, PHYS_BDS_*) at one container and
sets `BOT_VERSION` / `BDS_TRANSPORT` (read by `bot/test/e2e/env.ts`). Without it the suite targets
bds-dev, bds-world and bds-phys at 1.26.51 over RakNet, as before. The profile containers need
the truth pack (`node scripts/bds.mjs --profile <name> pack`). Fixtures for another version:
`cd bot && node scripts/record-fixture.ts --version 1.26.60 --port 19134 --bds 1.26.60.6` and
`WORLD_RECORD=1 node scripts/e2e-profile.ts dev60 test/e2e/world-record.test.ts`.

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
- NetherNet (bds-nn) and BDS 1.26.60.6 (bds60): results, timings and quirks are in
  docs/versions.md. In short: everything above holds on both; NetherNet spawns about 1 s later;
  BDS needs one WebRTC UDP port per concurrent NetherNet client (`SERVER_UDP_PORTS` range), or a
  second client fails with `connecterror:9` and blocks all later joins until a restart.

## Realm join (you do this)

PLAN.md tasks 1.6 and 1.7. Agents never run this: it signs in to a Microsoft account and connects
to a public service. The code path exists and is unit-tested with fakes only; **no Realm join has
been tried yet**, so everything below that is not marked "verified" is expected behaviour from
reading bedrock-protocol's source, not a measurement.

### Prerequisites (PLAN.md section 2 checklist)

1. **bedrock-protocol at or after PR #839**: done. `bot/package.json` pins the #839 merge commit
   `c9e1fbf21dc6abde8d89920996575791b79e66cf` (docs/decisions/0004-protocol-pin.md). Check with
   `pnpm --filter bot exec node -e "console.log(require('fs').readFileSync(require.resolve('bedrock-protocol/src/client/auth.js'),'utf8').includes('dns.promises.lookup'))"` (prints `true`).
2. **Game version equal to the Realm's**: a Realm runs the current release (26.60 = `1.26.60` on
   2026-10-28). Pass `--version 1.26.60` (works today through `patches/minecraft-data@3.117.0.patch`,
   verified against BDS 1.26.60.6) or flip the default first (docs/versions.md). There is no ping
   for a Realm, so the version gate cannot compare protocols before joining; a mismatch should show
   up as a kick (`outdated_client` / `outdated_server`, never retried, exit code 3) or as a Realms
   API error (*unverified which*). After a game update, run the playbook
   (`tools/bump-version/playbook.md`) before rejoining.
3. **A separate Microsoft account that owns Minecraft Bedrock**, invited to your Realm and with the
   invite accepted (or use `--realm-invite <code>`). You sign in once through the device-code flow.
   The token cache lives outside the repo; the bot never sees a password.
4. **Keepalive**: the AFK task nudges every 240 s (`--nudge-interval`). The Realm idle kick is
   unknown (community figure 10 to 15 min, PLAN.md fact 8b); measure it once (below).
5. **Reconnect**: on by default (backoff 1 s doubling to 60 s, 20 % jitter). Each attempt signs in
   from the cache and asks the Realms API for the join address again. *Unverified across Realm
   restarts and game updates.*
6. **Tell everyone who plays on the Realm** that a bot account is there.

### Commands

From the repo root, after `pnpm install`:

```sh
cd bot
node src/index.ts --task afk --target realm --realm-name "Your Realm" --account bot --version 1.26.60 --owner YourGamertag
```

| Option | Meaning |
|---|---|
| `--realm-name <name>` | Realm as listed for the bot account (exact, else unique case-insensitive match). Or `--realm-invite <code or link>`, or `--realm-id <id>` (exactly one) |
| `--account <label>` | cache key for the token files (any short label, e.g. `bot`); **not** the gamertag. The in-game name is the bot account's gamertag |
| `--profiles-folder <dir>` | token cache; default `%LOCALAPPDATA%\bedrockbot\profiles` (`~/.bedrockbot/profiles` off Windows). Refused if it resolves inside the repo |
| `--owner <gamertag>` | who may use `!status`, `!pos`, `!quit` in Realm chat (a Realm has no server console) |
| `--no-record` | turn the packet capture off (on by default for a Realm) |

Guard rails (exit code 2 before anything touches the network): `--host`, `--port`, `--username`,
`--transport raknet` and `--signalling lan` are refused with `--target realm`; so is a
`--profiles-folder` inside the repository, and a target without exactly one Realm selector.
Realm options are built in `bot/src/connection/realm.ts`: `offline: false`, `realms.pickRealm`
(or `realmInvite` / `realmId`), `authTitle` = Nintendo Switch title, `deviceType: 'Nintendo'`,
`flow: 'live'` (bedrock-protocol's own defaults), `profilesFolder`, `transport: 'nethernet'`,
`nethernet: { signalling: 'services' }`.

**First run**: the bot logs `Microsoft sign-in needed: ... https://www.microsoft.com/link ...
<code>`. Open the page, enter the code and sign in **with the bot's account** within 15 minutes
(device codes expire; the attempt is abandoned after 15 min with `no Realm sign-in/join within
900000 ms` and retried). Token files then appear in the profiles folder and later runs do not
prompt (*refresh lifetime unverified*). To sign the bot out, stop it and delete that folder.

Stop with Ctrl+C or `!quit` from an owner (clean disconnect, exit 0).

### What to look for

- Log lines, in order: `realm target: realm "Your Realm" (nethernet/services), account "bot",
  token cache ...`, `recording packets to bot/logs/realm-<time>.jsonl.gz (login redacted)`,
  `joining realm ...`, then `spawned as <gamertag>`.
- `bot/logs/disconnects.jsonl`: one line per session end with `reason`, `kind`, the server's
  `kick` (`{reason, message}`) and `spawnedMs`. `bot/logs/metrics.json`: uptime, reconnects, kicks
  by reason.
- `bot/logs/realm-*.jsonl.gz`: every packet; the `login` packet (identity chain and tokens) is
  replaced by `[redacted]` and stores no bytes (unit-tested). It still contains gamertags, XUIDs and
  chat of everyone on the Realm: keep it private (bot/logs is git-ignored) and delete it when done.
- Expected failure messages and their first suspects:

  | Message | Suspect |
  |---|---|
  | `no Realm called "..." for this account (Realms: ...)` | name typo, or the invite is not accepted |
  | `Couldn't find a Realm to connect to` | the account is not owner or member |
  | `getaddrinfo ENOTFOUND signal-...` | the #839 fix is missing (wrong bedrock-protocol) |
  | `Signalling connection timed out` | services signalling WebSocket blocked, or token problem |
  | `connecterror:<n>` | NetherNet/WebRTC negotiation failed (codes in `nethernet/src/signalling.js`; 9 = InactivityTimeout, 37 = identity not allowed) |
  | `kicked: outdated_client` / `outdated_server` | game version mismatch (prerequisite 2) |
  | `no Realm sign-in/join within ...` | device code not entered in time, or the Realms API hung |

  Run with `--log-level debug` for bedrock-protocol's connection log, and `DEBUG=minecraft-protocol,nethernet`
  for signalling and WebRTC details (prints no tokens as far as read; still keep it private).

### Measuring the Realm idle kick (task 1.7)

1. Join with nudges off: `--task afk --nudge-interval 0` (the AFK task still sends one standing
   input right after spawn, like a real client). Do not move the bot from your own client.
2. Wait. When the kick comes, `disconnects.jsonl` records `kick.reason` (on BDS it was
   `kicked_for_idle` with an empty message), and `spawnedMs` is the idle time plus about one
   second. With `--no-reconnect` the bot exits 1 instead of rejoining.
3. If nothing happens within 30 minutes, record "no kick within 30 min".
4. Then run with the default 240 s nudge (or half the measured kick time, whichever is shorter)
   for at least twice the measured time: `metrics.json` must show `kicks.total` 0.

Write the result into PLAN.md fact 8b and this runbook.

### Known unknowns

- Whether the Realms API or the server rejects a wrong game version first, and with what message.
- The services-signalling path (JSON-RPC WebSocket, TURN credentials, werift through your NAT) has
  never run in this project; only LAN signalling against BDS is verified.
- The #839 DNS fallback is verified with stubbed DNS only.
- Realm idle-kick time and reason; whether the client-side "press any button" AFK screen has a
  server-side counterpart.
- Reconnect across a Realm restart, a game update, and your own client joining or leaving.
- How long the cached tokens stay valid before a new device code is needed.
