# Game versions and transports

State on 2026-10-28 (PLAN.md tasks 1.4 and 1.5). **The default everywhere is 1.26.60 (BDS
1.26.60.6) over RakNet** since the flip on 2026-10-28 (section "Default flipped to 1.26.60" below);
NetherNet is selectable and verified. 1.26.51 stays runnable as the rollback (`BOT_VERSION=1.26.51`,
server `bds-dev51`, `pnpm e2e:51`, `FIXTURE_VERSION=1.26.51` for the world unit tests).

## Stack

| Piece | Pin | Notes |
|---|---|---|
| bedrock-protocol | git `PrismarineJS/bedrock-protocol#c9e1fbf2` (= 3.60.1 + #834 + #839) | docs/decisions/0004-protocol-pin.md |
| minecraft-data | 3.117.0 + `patches/minecraft-data@3.117.0.patch` | the patch adds bedrock 1.26.60 (protocol 2225); made by `tools/bump-version/make-patch.mjs 1.26.60` |
| World version shims | `bot/src/world/version-shims/1.26.51.ts`, `1.26.60.ts` | 1.26.60 = 1.26.51 (schema-diff: only trailing fields in level_chunk, start_game, add_player, add_entity; block/item data still 1.26.30 upstream) |
| Fixtures | `fixtures/1.26.51/`, `fixtures/1.26.60/` (`login-idle`, `world-chunks`) | `bot/test/unit/fixture-replay.test.ts` replays both versions; the world unit tests (`test/unit/world/helpers.ts`) use `fixtures/1.26.60` unless `FIXTURE_VERSION=1.26.51` |
| Truth pack | `@minecraft/server` 2.10.0 | loads on BDS 1.26.51.1 and 1.26.60.6 (log: `[truth] pack 0.1.0 loaded`) |

## Servers

Since 2026-10-28 (all compose files, all with the truth pack; fresh worlds except bds-dev, which took
over bds60's 1.26.60.6 world):

| Container | BDS | Transport | Port | Compose file | Game version for the bot |
|---|---|---|---|---|---|
| `bds-dev` | 1.26.60.6 | RakNet | udp/19132 | docker/compose.dev.yml | 1.26.60 (default) |
| `bds-world` | 1.26.60.6 | RakNet | udp/19142 | docker/compose.world.yml (was a `docker run`) | 1.26.60 |
| `bds-move` | 1.26.60.6 | RakNet | udp/19146 | docker/compose.move.yml | 1.26.60 |
| `bds-dig` | 1.26.60.6 | RakNet | udp/19148 | docker/compose.dig.yml | 1.26.60 |
| `bds-nn` | 1.26.60.6 | NetherNet, LAN signalling | tcp+udp/19140, udp/19160-19167, udp/7551 | docker/compose.dev-nethernet.yml | 1.26.60 |
| `bds-dev51` | 1.26.51.1 | RakNet | udp/19134 | docker/compose.dev51.yml | 1.26.51 (rollback) |

Both builds print a "TRANSPORT TYPE ERROR" banner for `TRANSPORT=raknet` and still accept RakNet.
`bds60` (docker/compose.dev60.yml) is gone: its port went to `bds-dev51` and its data folder to
`bds-dev`; the old bds-dev 1.26.51 data moved to `docker/data/dev51` (its world was then replaced by a
fresh one, see below). `bds-phys` (udp/19144, `docker run`, 1.26.51.1) is stopped and no longer a
default e2e target (skills-input defaults to bds-move).

How to start them and run the suites: docs/runbook.md ("Server", "Tests").

## e2e results before the flip (2026-10-28, bedrock-protocol pinned to c9e1fbf2)

Durations in ms from vitest's verbose reporter. bds-dev ran with the defaults
(`BDS_E2E=1 vitest run --project e2e test/e2e/{echo,chat,reconnect,keepalive}`); bds60 and bds-nn
ran every listed suite through `bot/scripts/e2e-profile.ts`, all suites against the one container.

| Test | bds-dev 1.26.51 RakNet | bds60 1.26.60 RakNet | bds-nn 1.26.51 NetherNet |
|---|---|---|---|
| echo: spawn at y -60, console say within 10 s | pass 2018 | pass 2017 | pass 3055 |
| echo: CLI prints the say, exits 0 | pass 2376 | pass 2440 | pass 3330 |
| chat: `say !status` reply seen by another player | pass 231 | pass 200 | pass 174 |
| chat: `tell !pos`, `say !help` | pass 507 | pass 398 | pass 288 |
| chat: owner allow-list | pass 2142 | pass 2159 | pass 2045 |
| chat: ignores `@truth` lines | pass 719 | pass 642 | pass 642 |
| chat: CLI `say !quit` exits 0 | pass 5754 | pass 5804 | pass 7997 |
| reconnect: back after `docker restart` | pass 22987 (back in 18.3 s) | pass 27713 (23.7 s) | pass 23593 (18.5 s) |
| reconnect: console kick, reason logged | pass 7117 (2.6 s)¹ | pass 7152 (2.7 s) | pass 8650 (3.4 s) |
| reconnect: version gate refuses, no retry | pass 1285 | pass 1287 | pass 1017 |
| keepalive: nudges keep position, no correction | pass 15498 | pass 15475 | pass 16556 |
| keepalive soak (2 tests, `BDS_SOAK=1`) | skipped | skipped | skipped |
| world-updates: 20 truth:set within 2 ticks | n/a² | pass 4472 | pass 3897 |
| world-updates: 5x5x5 fill, checksum = truth | n/a² | pass 494 | pass 502 |
| world-entities: spawnitem tracked and removed | n/a² | pass 1984 | pass 1944 |
| world-entities: give 5 logs = truth:inv | n/a² | pass 966 | pass 900 |
| world-chunks: flat layers within 48 blocks | n/a² | pass 435 | pass 447 |
| world-chunks: 200 random blocks = truth, 100 % | n/a² | pass 994 | pass 927 |
| world-chunks: unloaded columns undefined | n/a² | pass 0 | pass 0 |
| skills-input (a) idle 60 ticks | n/a² | pass 3952 | pass 3939 |
| skills-input spike C 6-tick walk | n/a² | pass 3136 | pass 3050 |
| skills-input (b) walk 100 ticks, truth within 0.05 | n/a² | pass 7802 | pass 7750 |
| skills-input (c) turn and walk | n/a² | pass 5453 | pass 5400 |
| skills-input (d) 3-block jump corrected once | n/a² | pass 3904 | pass 3799 |
| skills-input (e) jump in place | n/a² | pass 2987 | pass 2850 |
| world-record (`WORLD_RECORD=1`) | skipped | pass (recorded fixtures/1.26.60/world-chunks) | skipped |

¹ The first default run failed this test because another agent restarted bds-dev in the middle of
it (two E2EKick sessions in the server log); the rerun on a quiet bds-dev passed.
² bds-world and bds-phys (the default targets of these suites) were stopped by their owners during
this run; the same code paths passed against bds60 and bds-nn.

NetherNet differences: spawn takes about 1 s longer (WebRTC negotiation after LAN discovery; echo
3.0 s vs 2.0 s), a kick-reconnect 3.4 s vs 2.6 s; once spawned, packet timing is the same (world,
movement and chat numbers match RakNet). Reconnect across `docker restart` works on NetherNet
(18.5 s, same as RakNet).

## NetherNet quirks found

- **bedrock-protocol with `skipPing` needs the network id.** `createClient({ transport:
  'nethernet', skipPing: true })` without `nethernet.networkId` throws `Invalid nethernet.networkId`.
  The Connection now passes the id from its own discovery ping (`ServerInfo.networkId`), and lets
  bedrock-protocol discover by itself when the ping had none. Before this, `--transport nethernet`
  could not connect at all (the spike used createClient's own ping).
- **BDS needs one WebRTC UDP port per concurrent client.** With `SERVER_UDP_PORTS=19140` (one port,
  the old draft compose file) a second simultaneous client got an SDP answer without any ICE
  candidate and failed after 5 s with `connecterror:9` (InactivityTimeout, raised by the werift
  client). After that failure every new client failed the same way until BDS restarted, even one at
  a time. Sequential clients were fine. Fixed with `SERVER_UDP_PORTS=19160-19167` published 1:1.
  *Unverified*: how long BDS would keep the leaked port without a restart.
- The NetherNet LAN advertisement of BDS 1.26.51.1 carries the protocol (2193), so the version gate
  works on NetherNet too.
- Discovery uses UDP 7551 on the host; only one NetherNet BDS per host is reachable that way.

## Default flipped to 1.26.60 (2026-10-28)

Applied as one change set from the list below (kept as the template for the next bump). Gates, in
order, all green:

| Gate | Result |
|---|---|
| `pnpm -r test` | bot 30 files / 266 tests passed, truth pack 9 passed (also green with `FIXTURE_VERSION=1.26.51`) |
| `pnpm lint` | clean (eslint + tsc) |
| `BDS_E2E=1 pnpm --filter bot test:e2e` (bds-dev, bds-world, bds-move, bds-dig at 1.26.60.6) | 14 files passed, 1 skipped (world-record); 49 passed, 3 skipped, 459 s; same counts as the 1.26.51 baseline |
| `pnpm e2e:nn` (bds-nn 1.26.60.6, NetherNet; now also nav-* and dig on bds-nn) | 14 files passed, 1 skipped; 49 passed, 3 skipped, 476 s |
| rollback: `node scripts/e2e-profile.ts dev51 test/e2e/echo test/e2e/chat test/e2e/world-chunks` | 10 passed (after a fresh world, see below) |
| 30 min AFK soak on bds-dev (`--task afk --duration 1800`) | green: spawned once as AfkBot at 02:15:05Z, 7 nudges, 0 corrections, 0 kicks, 0 reconnects, 0 warnings; exit 0 after 1800 s (disconnects.jsonl: spawnedMs 1800007, kind client) |
| 8 h AFK soak on bds-soak (`--task afk --duration 28800 --health-port 9464`, 2026-10-29 05:10 to 13:10Z) | green: 119 nudges, 0 corrections, 0 kicks, 0 reconnects, 0 deaths; exit 0, `bot/logs/soak/metrics.json` complete |
| Realm (1.26.60, 2026-10-29) | joined and stayed; see docs/runbook.md "Measured on the Realm" |

Differences seen on 1.26.60 compared with 1.26.51:

- `item_registry` has 2080 entries instead of 2076: new `disc_press`, `frostbite_spawn_egg`, `icicle`,
  `ice_crystal`. Block data is still 1.26.30 (minecraft-data), so new blocks such as icicles would show
  up as unknown runtime ids (solid "unknown" in the world model) if they ever appear; none occur in the
  flat test worlds (0 unknown runtime ids in fixtures/1.26.60/world-chunks).
- Nothing else seen: dig break ticks are within 1 tick of the 1.26.51 table in docs/digging.md (same
  formula values; server reach still accepted at 9.85 and ignored at 10.24), skills-input has 0
  corrections, nav, chat, reconnect (test 28.2 s incl. the restart) and the world checks pass with the
  same assertions as on 1.26.51.

Rollback check note: the first dev51 run failed `world-chunks` "flat-world layers" at (-35, -61, 4):
the reused 1.26.51 world (the old bds-dev world) really has dirt there (`testforblock` on the server
says so; the 200-position truth comparison in the same run passed 100 %). World state left by earlier
runs, not a version effect; with a fresh `docker/data/dev51/worlds/dev` all 10 tests passed.

The list below was written before the flip ("currently" means 1.26.51 at that time):

1. `docker/compose.dev.yml`: `VERSION: "1.26.51.1"` -> `VERSION: "1.26.60.6"` (and its comment
   "3.60.1 -> 1.26.51" -> "the minecraft-data patch -> 1.26.60"). Optionally the same in
   `docker/compose.dig.yml` and `docker/compose.move.yml`, and `BDS_NN_VERSION:-1.26.51.1` ->
   `1.26.60.6` in `docker/compose.dev-nethernet.yml` (plus `nn` in `bot/scripts/e2e-profile.ts`:
   `version: '1.26.60', build: '1.26.60.6'`). Then `pnpm bds:up` (BDS upgrades the world in place).
2. `bot/src/index.ts`: `const DEFAULT_VERSION = '1.26.51';` -> `'1.26.60'`.
3. `bot/test/e2e/env.ts`: `process.env.BOT_VERSION ?? '1.26.51'` -> `?? '1.26.60'`, and
   `bot/test/e2e/world-record.test.ts`: `BDS_BUILD ?? '1.26.51.1'` -> `?? '1.26.60.6'`.
4. `bot/src/world/version-shims/index.ts`: `SHIMS = [shim_1_26_51, shim_1_26_60]` ->
   `[shim_1_26_60, shim_1_26_51]` (SHIMS[0] is the fallback for unknown versions), and in
   `bot/test/unit/world/registry.test.ts` the fallback test expects `'1.26.60'`.
5. `bot/src/world/registry.ts` (`opts.version ?? '1.26.51'`) and the doc comment in
   `bot/src/world/index.ts`: `'1.26.60'`. `bot/src/data/mining.ts` and
   `bot/src/skills/terrain/shapes.ts` load `bedrock_1.26.51` data: block/item data is identical
   (both point at 1.26.30), so they can stay or move to `bedrock_1.26.60`.
6. Fixtures: point `bot/test/unit/world/helpers.ts` (`fixtures/1.26.51/`, `createDeserializer('1.26.51')`)
   at `1.26.60`, or parametrize it like `fixture-replay.test.ts`; check the hashed runtime ids in
   `registry.test.ts` against `fixtures/1.26.60/world-chunks.jsonl.gz`.
7. Tests written by other tracks that hard-code `version: '1.26.51'` and RakNet
   (`bot/test/e2e/dig-truth.ts`, `move-truth.ts`, `nav-*`): import `E2E_VERSION` / `bdsTarget`
   from `bot/test/e2e/env.ts` so they follow the default.
8. `bot/scripts/record-fixture.ts` defaults (`version`, `bds`).
9. Docs: docs/runbook.md ("BDS 1.26.51.1" mentions, chat `!status` example), PLAN.md section 7
   (BDS pin row), this file.
10. Run `pnpm -r test`, `pnpm lint`, the default e2e suite on bds-dev, `pnpm e2e:nn`, and a 30 min
    soak before using it on the Realm (PLAN.md section 7).

Unit tests that use `'1.26.51'` as sample data (connection fakes, chat, metrics, versionGate,
realm) do not need to change.

## Behaviour differences found after the flip (2026-10-29, Phase 5 on BDS 1.26.60.6)

- **Respawn order.** Sending `player_action respawn` together with the first client `respawn` state 2
  (before the server's state 1) leaves the player dead on 1.26.60.6: a correction pulls the bot back
  to the death point and a later `kill` produces no death. Working order: client `respawn` state 2 →
  server `respawn` state 1 → client `respawn` state 2 + `player_action respawn`
  (`bot/src/tasks/respawn.ts`). The old order worked on 1.26.51.1.
- **World time.** 1.26.60 sends no `set_time` packets. Time arrives through `sync_world_clocks`
  (`initialize_registry` at login, then `sync_state` every 12.8 s and right after `/time set`);
  `WorldClock` in `bot/src/tasks/night.ts` handles both.
- **Whispers.** `command_request` `/tell` works only with `version: 'latest'`; with `'52'` it is
  silently dropped.
