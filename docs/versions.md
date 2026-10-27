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

## Block states

Since wave 8 (Track AC, 2026-10-29; [decision 0024](decisions/0024-block-registry-from-bds-palette.md)).
minecraft-data's bedrock block states stop at 1.26.30; 1.26.60 changed and added states, and every
runtime id the registry cannot resolve is a solid `unknown` block to the planner. The world registry
now builds its runtime-id table from a palette dumped from BDS itself.

**Re-dump for a new BDS** (one command; the container needs the truth pack: `node scripts/bds.mjs --profile reg pack`):

```sh
node tools/bump-version/dump-palette.mjs --profile reg            # bds-reg, writes bot/data/block-palette/<version>.json
node tools/bump-version/dump-palette.mjs --container bds-x --port 19999 --version 1.26.61   # any local BDS
```

The game version defaults to the container's `VERSION` without its 4th part (1.26.60.6 → 1.26.60).
For a new version (1.26.61): re-dump into `1.26.61.json`, set `blockPalette: '1.26.61'` in its version
shim (`bot/src/world/version-shims/`), run `pnpm --filter bot test` (registry-palette) and the
world-registry e2e. A version without a file falls back to minecraft-data's states (with a warning
when the shim names a missing file).

**Where:** `bot/data/block-palette/<version>.json`, loaded by `bot/src/world/version-shims/palette.ts`
(compact format 1: interned strings; per block the sorted state names with their NBT tag and values,
the default permutation and the valid combinations as mixed-radix indices; one block per line, so a
re-dump diffs per block; writer `tools/bump-version/lib/palette-format.mjs`).

**How the dump works** (about 26 s on bds-reg): `truth:palette` (packs/truth/src/palette.ts) enumerates
`BlockTypes.getAll()`, the states of each default permutation, every combination of the states'
`BlockStates` valid values, and `BlockPermutation.resolve` (combinations that throw are skipped: 0 on
1.26.60.6). The Script API view is not the network view: it also reports flattened-away **legacy
states** that the hash leaves out (`color` on 159 types such as every `*_stained_glass_pane` and
concrete powder, `top_slot_bit` on 114 slabs next to the real `minecraft:vertical_half`, `direction`
on 52 doors and others next to `minecraft:cardinal_direction`, `wall_block_type` on the 14 walls,
`wood_type`, `stone_slab_type*`, `coral_color`, `dead_bit`, ...: 39 state names). So the dumper also
places the default permutation of every type (`truth:palettestrip`, 256 per batch, 2 blocks apart),
reads the runtime ids the server sends for them, and per type drops the smallest state subset whose
hash matches a seen id. 1473 of 1480 types are verified that way; the 7 the probe cannot hold in place
(air, bubble_column, flowing_water, flowing_lava, soul_fire, unknown, and pink_concrete_powder, whose
cell held something else by the time it was read) drop the states the verified types mostly drop (`color` on
pink_concrete_powder); the e2e below places them again.

**Numbers (BDS 1.26.60.6):**

| | |
|---|---|
| block types | 1480 (minecraft-data 1.26.30: 1356, all of them still present) |
| permutations (network) | 23 941 (Script API: 66 053 with the legacy states) |
| equal to a minecraft-data state (keep its state id) | 16 277 |
| palette-only states (state ids from 16 913 up) | 7 664 |
| file | 95 109 bytes (JSON) |
| load | 9 to 13 ms (read + expand); hashing all states 26 ms once per process (own FNV over the NBT bytes, `fastBlockHash`, equal to `blockHash` on every state); registry build 50 ms warm, the same as without the palette (prismarine dominates) |

What changed since 1.26.30 (palette vs minecraft-data, by state names):

| Change | Blocks |
|---|---|
| `+minecraft:corner` (none, inner_left, inner_right, outer_left, outer_right) | all 64 stairs |
| `+minecraft:connection_east/north/south/west` | 57: every fence (not gates), glass pane, hard glass pane, iron and copper bars, trip_wire |
| `+minecraft:connection_*` incl. up (fire) / up and down (chorus_plant) | fire, chorus_plant |
| `+redstone_east/north/south/west` (none, side, up) | redstone_wire (1296 states, was 16) |
| new block types | 124: the poplar wood set (planks, log, wood, stripped, 3 leaves, stairs, slab, door, trapdoor, fence, gate, button, plate, signs, shelf, sapling), stairs / slab / double slab of every wool and concrete colour, icicle, ice_crystal, disc_press, shelf_mushroom, red_shrub, straw_bed |

Palette-only states take hardness and collision boxes (minecraft-data blockCollisionShapes) from the
closest minecraft-data state of the same block, or of a shape donor by name suffix for new blocks
(`_stairs` → oak_stairs, `_slab` → oak_slab, `_door` → wooden_door, `_fence` → oak_fence, `_planks` →
oak_planks, ...; palette.ts `shapeDonor`). icicle, ice_crystal, disc_press, shelf_mushroom and red_shrub
have no donor: full solid cubes, as unknown ids were, but with their real names.

BDS sends `minecraft:unknown` as runtime id **-2** (not its hash); the registry maps -2 to the unknown block.

**Verification** (`bot/test/unit/world/registry-palette.test.ts`; `bot/test/e2e/world-registry.test.ts`
on bds-reg): every palette state resolves to its own name and states; every runtime id of
`fixtures/1.26.60/world-chunks` resolves (0 unknown); one of every block type placed on bds-reg (1488
cells incl. door halves) resolves to the truth name with 0 unknown runtime ids; the strip below
resolves to the truth name and states, 0 mismatches. Track AA's stairs special case in the terrain
layer (`resolveNewerState`) is now redundant (no stairs id is unknown any more; the unit test checks
both give the same boxes); it stays in place.

The e2e strip, 2026-10-29 (one row per group, adjacent cells, so stairs corners and connections are the
server's own; identical rows merged; "palette" = a state minecraft-data does not have; every row: model
name and states = truth):

| block | states | runtime id | state id |
|---|---|---|---|
| oak_stairs | corner=none upside_down_bit=0 weirdo_direction=0 | -122484237 | 20175 (palette) |
| oak_stairs | corner=inner_left upside_down_bit=0 weirdo_direction=1 | 766941358 | 20177 (palette) |
| oak_stairs | corner=none upside_down_bit=0 weirdo_direction=2 | 465409 | 20193 (palette) |
| oak_stairs | corner=none upside_down_bit=0 weirdo_direction=3 | 61940232 | 20194 (palette) |
| oak_stairs | corner=inner_left upside_down_bit=0 weirdo_direction=0 | 705466535 | 20176 (palette) |
| oak_stairs | corner=outer_right upside_down_bit=0 weirdo_direction=0 | 357105324 | 20207 (palette) |
| stone_brick_stairs | corner=none upside_down_bit=0 weirdo_direction=0 | 965355805 | 23511 (palette) |
| stone_brick_stairs | corner=inner_left upside_down_bit=0 weirdo_direction=1 | -1339212908 | 23513 (palette) |
| stone_brick_stairs | corner=none upside_down_bit=0 weirdo_direction=2 | 842406159 | 23529 (palette) |
| stone_brick_stairs | corner=none upside_down_bit=0 weirdo_direction=3 | 903880982 | 23530 (palette) |
| stone_brick_stairs | corner=inner_left upside_down_bit=0 weirdo_direction=0 | -1400687731 | 23512 (palette) |
| cut_copper_stairs | corner=none upside_down_bit=0 weirdo_direction=0 | -374636541 | 17865 (palette) |
| cut_copper_stairs | corner=inner_left upside_down_bit=0 weirdo_direction=1 | -544235170 | 17867 (palette) |
| cut_copper_stairs | corner=none upside_down_bit=0 weirdo_direction=2 | -251686895 | 17883 (palette) |
| cut_copper_stairs | corner=none upside_down_bit=0 weirdo_direction=3 | -190212072 | 17884 (palette) |
| cut_copper_stairs | corner=inner_left upside_down_bit=0 weirdo_direction=0 | -605709993 | 17866 (palette) |
| cut_copper_stairs | corner=none upside_down_bit=1 weirdo_direction=3 | 384954925 | 17888 (palette) |
| white_wool_stairs | corner=none upside_down_bit=0 weirdo_direction=0 | 1191707346 | 24429 (palette) |
| white_wool_stairs | corner=inner_left upside_down_bit=0 weirdo_direction=1 | 733564343 | 24431 (palette) |
| white_wool_stairs | corner=none upside_down_bit=0 weirdo_direction=2 | 1314656992 | 24447 (palette) |
| white_wool_stairs | corner=none upside_down_bit=0 weirdo_direction=3 | 1253182169 | 24448 (palette) |
| white_wool_stairs | corner=inner_left upside_down_bit=0 weirdo_direction=0 | 795039166 | 24430 (palette) |
| white_concrete_stairs | corner=inner_right upside_down_bit=1 weirdo_direction=1 | 1162845150 | 24383 (palette) |
| oak_slab | vertical_half=bottom | -1547796892 | 6722 |
| oak_slab | vertical_half=top | 1728771929 | 6723 |
| oak_double_slab | vertical_half=bottom | 173263259 | 5345 |
| white_wool_slab | vertical_half=bottom | 1990068687 | 24427 (palette) |
| white_wool_slab | vertical_half=top | -311756528 | 24428 (palette) |
| white_wool_double_slab | vertical_half=bottom | -1221361390 | 24425 (palette) |
| poplar_slab | vertical_half=top | -1960025921 | 21416 (palette) |
| black_wool_slab | vertical_half=bottom | -496896735 | 17223 (palette) |
| cut_copper_slab | vertical_half=top | -99196711 | 9067 |
| wooden_door (lower / upper) | door_hinge_bit=0 cardinal_direction=south open_bit=0 upper_block_bit=0 / 1 | 650702320 / 1706008891 | 5492 / 5500 |
| poplar_door (lower / upper) | door_hinge_bit=1 cardinal_direction=east open_bit=1 upper_block_bit=0 / 1 | -1089404795 / -2144711366 | 20929 / 20930 (palette) |
| iron_door (lower / upper) | door_hinge_bit=0 cardinal_direction=north open_bit=0 upper_block_bit=0 / 1 | 1609016616 / -1630644109 | 6997 / 7005 |
| copper_door (lower / upper) | door_hinge_bit=1 cardinal_direction=west open_bit=0 upper_block_bit=0 / 1 | -1374303423 / 1865357302 | 11684 / 11692 |
| trapdoor | direction=0 open_bit=1 upside_down_bit=0 | -1673099720 | 1290 |
| poplar_trapdoor | direction=2 open_bit=0 upside_down_bit=0 | -1829628697 | 21481 (palette) |
| iron_trapdoor | direction=0 open_bit=0 upside_down_bit=1 | 1081251492 | 1894 |
| copper_trapdoor | direction=0 open_bit=0 upside_down_bit=0 | 826714304 | 11032 |
| fence_gate | in_wall_bit=0 cardinal_direction=south open_bit=0 | -1873042880 | 286 |
| poplar_fence_gate | in_wall_bit=0 cardinal_direction=south open_bit=1 | 2010117891 | 20966 (palette) |
| cobblestone_wall | east=short north=none south=none west=none post=1 | 1604075163 | 3997 |
| cobblestone_wall (x2) | east=short north=none south=none west=short post=0 | 1146933355 | 4050 |
| blackstone_wall | east=none north=none south=none west=short post=1 | -746116502 | 6200 |
| oak_fence | connection_east=1, others 0 | -574604076 | 20167 (palette) |
| oak_fence | connection_east=1 connection_west=1 | 480702495 | 20168 (palette) |
| oak_fence | connection_west=1, others 0 | -629848190 | 20160 (palette) |
| nether_brick_fence | all connections 0 | 446961403 | 20063 (palette) |
| poplar_fence | all connections 0 | -535511961 | 20945 (palette) |
| glass_pane | connection_east=1, others 0 | 723880213 | 18845 (palette) |
| glass_pane (x2) | connection_east=1 connection_west=1 | -331426358 | 18846 (palette) |
| red_stained_glass_pane | connection_east=1 connection_west=1 | 1769262805 | 21900 (palette) |
| iron_bars | connection_east=1 connection_west=1 | 686455481 | 19408 (palette) |
| copper_bars | connection_west=1, others 0 | -1822166287 | 17794 (palette) |
| redstone_wire (x2) | redstone_east=side redstone_west=side north=none south=none signal=0 | -161133073 | 22384 (palette) |
| redstone_wire | all none, signal=0 | 1399972871 | 21951 (palette) |
| candle | candles=2 lit=1 | -857350126 | 14956 |
| white_candle | candles=0 lit=0 | 1754953123 | 9173 |
| candle_cake | lit=0 | -281139171 | 15161 |
| copper_block | | -593390456 | 7826 |
| exposed_copper | | 600140015 | 2222 |
| waxed_oxidized_copper | | -1317255528 | 15119 |
| copper_bulb | lit=1 powered_bit=0 | 1229100855 | 6893 |
| copper_grate | | 596285486 | 1963 |
| copper_chest | cardinal_direction=north | -327497521 | 5485 |
| copper_lantern | hanging=0 | 639828303 | 16872 |
| lightning_rod | facing_direction=0 powered_bit=0 | 1504023697 | 3973 |
| poplar_planks | | 1414931100 | 21364 (palette) |
| poplar_log | pillar_axis=x | -663707234 | 21362 (palette) |
| stripped_poplar_wood | pillar_axis=y | 303175278 | 23610 (palette) |
| orange_poplar_leaves | persistent_bit=0 update_bit=0 | -1018857853 | 20259 (palette) |
| poplar_sapling | age_bit=0 | -67767387 | 21381 (palette) |
| red_shrub | | 1319997426 | 21890 (palette) |
| disc_press | cardinal_direction=south | -1559215611 | 18225 (palette) |
| ice_crystal | block_face=up | 1179756793 | 19373 (palette) |
| icicle | attached_bit=0 dripstone_thickness=tip hanging=1 | -1905243028 | 19379 (palette) |
| poplar_shelf | cardinal_direction=south powered_bit=0 powered_shelf_type=0 | 1343894540 | 21383 (palette) |

95 placements, 98 non-air cells (4 upper door halves; shelf_mushroom popped off the grass), 69 of them
palette-only states. Explicitly set stairs corners are reshaped by the server from the neighbours (an
isolated staircase is `none`); the strip still shows inner_left, inner_right and outer_right, and the
unit test covers all 5 corners of every stairs block by hash.
