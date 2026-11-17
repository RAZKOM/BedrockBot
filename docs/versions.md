# Game versions and transports

State on 2026-11-16 (PLAN.md tasks 1.4 and 1.5). **The default everywhere is game version 1.26.60
(protocol 2225) over RakNet** since the flip on 2026-10-28 (section "Default flipped to 1.26.60" below).
The test servers run BDS 1.26.65.1, which speaks the same protocol, since 2026-11-16 (section "1.26.65 and
the npm releases" below). NetherNet is selectable and verified. 1.26.51 stays runnable as the rollback
(`BOT_VERSION=1.26.51`, server `bds-dev51`, `pnpm e2e:51`, `FIXTURE_VERSION=1.26.51` for the world unit tests).
Since Track U2 (2026-11-16) the block and item data is minecraft-data 3.119.0's 1.26.60 (section "minecraft-data
3.119.0"), and a bot with no pinned version also speaks 1.26.70 (protocol 2259, the preview) to a server that
takes it (sections "One build, two protocols" and "1.26.70 preview").

## Stack

| Piece | Pin | Notes |
|---|---|---|
| bedrock-protocol | npm 3.61.0 (= the former git pin `c9e1fbf2`, i.e. 3.60.1 + #834 + #839, plus #842: 1.26.60 support) | docs/decisions/0004-protocol-pin.md; `patches/bedrock-protocol.patch`: the signalling fallback, and (Track U2) speaking minecraft-data entries marked `beta` (1.26.70) |
| minecraft-data | 3.119.0 + `patches/minecraft-data@3.119.0.patch` | the bot's block and item data is `bedrock_1.26.60` (1480 blocks, 23 960 states, 2080 items) since 2026-11-16, [decision 0094](decisions/0094-one-block-data-key.md) (section "minecraft-data 3.119.0" below); the patch holds the local protocol fixes (`filtered_custom_name`) and 1.26.70's protocol data, derived (`tools/bump-version/derive/1.26.70.mjs`, `releaseType: 'beta'`, section "1.26.70 preview"). 3.118.0 before, [decision 0093](decisions/0093-protocol-bumps-keep-the-block-data.md) |
| World version shims | `bot/src/world/version-shims/1.26.51.ts`, `1.26.60.ts`, `1.26.70.ts` | 1.26.60 = 1.26.51 (schema-diff: only trailing fields in level_chunk, start_game, add_player, add_entity). Each names where its block states come from: 1.26.60 and 1.26.70 a BDS palette dump, 1.26.51 minecraft-data's own 1.26.51 states |
| nethernet | 1.1.2 + `patches/nethernet@1.1.2.patch` | LAN discovery accepts the type-3 packets of the 1.26.70 previews (section "1.26.70 preview") |
| Fixtures | `fixtures/1.26.51/`, `fixtures/1.26.60/` (`login-idle`, `world-chunks`) | `bot/test/unit/fixture-replay.test.ts` replays both versions; the world unit tests (`test/unit/world/helpers.ts`) use `fixtures/1.26.60` unless `FIXTURE_VERSION=1.26.51` |
| Truth pack | `@minecraft/server` 2.10.0 | loads on BDS 1.26.51.1, 1.26.60.6 and 1.26.65.1 (log: `[truth] pack 0.1.0 loaded`) |

## Servers

Since 2026-10-28 (all compose files, all with the truth pack; fresh worlds except bds-dev, which took
over bds60's 1.26.60.6 world). Every compose file pins BDS 1.26.65.1 since 2026-11-16 (1.26.60.6 before;
a container picks the new build up when it is next created, and BDS upgrades its world in place):

| Container | BDS | Transport | Port | Compose file | Game version for the bot |
|---|---|---|---|---|---|
| `bds-dev` | 1.26.65.1 | RakNet | udp/19132 | docker/compose.dev.yml | 1.26.60 (default) |
| `bds-world` | 1.26.65.1 | RakNet | udp/19142 | docker/compose.world.yml (was a `docker run`) | 1.26.60 |
| `bds-move` | 1.26.65.1 | RakNet | udp/19146 | docker/compose.move.yml | 1.26.60 |
| `bds-dig` | 1.26.65.1 | RakNet | udp/19148 | docker/compose.dig.yml | 1.26.60 |
| `bds-nn` | 1.26.65.1 | NetherNet, LAN signalling | tcp+udp/19140, udp/19160-19167, udp/7551 | docker/compose.dev-nethernet.yml | 1.26.60 |
| `bds-dev51` | 1.26.51.1 | RakNet | udp/19134 | docker/compose.dev51.yml | 1.26.51 (rollback) |

Both builds print a "TRANSPORT TYPE ERROR" banner for `TRANSPORT=raknet` and still accept RakNet.
`bds60` (docker/compose.dev60.yml) is gone: its port went to `bds-dev51` and its data folder to
`bds-dev`; the old bds-dev 1.26.51 data moved to `docker/data/dev51` (its world was then replaced by a
fresh one, see below). `bds-phys` (udp/19144, `docker run`, 1.26.51.1) is stopped and no longer a
default e2e target (skills-input defaults to bds-move).

How to start them and run the suites: docs/runbook.md ("Server", "Tests").

## 1.26.65 and the npm releases (Track U1, 2026-11-16)

The update check reported `bds_release 1.26.60.6 -> 1.26.65.1, bedrock_protocol 3.60.1 -> 3.61.0, minecraft_data
3.117.0 -> 3.119.0`. These are two separate things: a new game release, and npm releases (both of 2026-10-29) that
catch up with 1.26.60, which the bot already spoke through a patch.

**1.26.65 is protocol 2225, the protocol of 1.26.60.** Evidence:

- The pong of BDS 1.26.65.1 (links API release build on 2026-11-16): `version 1.26.65, protocol 2225`
  (`verify.mjs`, `report.server`).
- Mojang's protocol docs: the 1.26.65 commit (`b0c990c8`, 2026-11-16) stamps every packet file with
  `x-protocol-version 2225`. Compared with the 1.26.60 commit (`0879ab5c`) and the 1.26.62 one (`f8d1496b`), not one
  file differs. 1.26.61 and 1.26.62 are 2225 as well. The 1.26.70 previews are 2259.
- No "Support Minecraft 1.26.65" issue on bedrock-protocol (nor for 1.26.61 or 1.26.62) and no 1.26.65 folder on
  minecraft-data master: with no new protocol there is nothing for upstream to add.
- The block palette BDS 1.26.65.1 sends is byte for byte the 1.26.60.6 one (`dump-palette.mjs`, 1480 types, 23 941
  network states, 1473 verified by placement; only the header's version and date differ). No new palette file.

A server or Realm on 1.26.65 accepts a client that speaks 1.26.60: bedrock-protocol checks only the protocol number,
and the version gate (`checkVersion`) compares numbers too. The bot's `!status`, disconnect log and panel show the
version the server advertises (`1.26.65`), so two e2e cases that expected the requested version (chat `!status`,
reconnect's disconnect record) now expect the server's.

**What the bot ran, before and after the bump** (local BDS, RakNet, offline, one container per build: 1.26.65.1 and
1.26.60.6, flat world, cheats, operator, truth pack):

| Check | main (git pin, 3.117.0 + patch) on 1.26.65.1 | on 1.26.60.6 | bump (3.61.0, 3.118.0 + fix) on 1.26.65.1 | on 1.26.60.6 |
|---|---|---|---|---|
| `verify.mjs 1.26.60 --deps self`: login, spawn, registry (16 913 states, 2080 items), subchunk, 20-tick walk | ok, 0 corrections | ok, 0 corrections | ok, 0 corrections, 0 decode errors | ok, 0 corrections, 0 decode errors |
| e2e echo, chat, chat-style, reconnect, keepalive, world-chunks, world-updates, world-entities, skills-input (37 tests) | 32 passed, 3 failed: 2 version assertions (fixed), the tick window | 32 passed, 3 failed: the tick window, echo's first tick | 34 passed, 1 failed: the tick window | 32 passed, 3 failed: the tick window, echo's first tick |
| e2e read-errors with both boxes named (`P1_BOTHNAMED=1`): every swap answered, no packet unreadable; the injected loss resynced | 2 of 2 | 2 of 2 | 2 of 2 | 2 of 2 |
| e2e pve-combat: 3 summoned zombies killed with an iron sword, no death | 1 of 1 | 1 of 1 | 1 of 1 | 1 of 1 |
| e2e test-inv (presets, restores, the boxes, the refusals) | 13 of 13 | 13 of 13 | 13 of 13 | 13 of 13 |

The failures that are not versions: reconnect's `assertNoDuplicates` counts 43 or 44 ticks in a 2 s window where
it allows 36 to 42, and echo reads `conn.tick` 0 right after the spawn. Both fail on this PC with either stack on
either build (with the bump also with the two files run alone: reconnect each time, echo once), so they are not
version effects; they are open as test timing.

**The npm releases.** bedrock-protocol 3.61.0 is the bot's git pin (`c9e1fbf2`: #834, #839) plus #842 (README,
`CURRENT_VERSION = '1.26.60'`); `patches/bedrock-protocol.patch` applies to it unchanged. minecraft-data has two:

| Release | What it changes for the bot |
|---|---|
| 3.118.0 (PR #1340) | adds bedrock 1.26.60's protocol. Every table the bot loads (`bedrock_1.26.60`, `bedrock_1.26.51`, `bedrock_1.26.30`: blocks, states, items, shapes, materials, recipes, ...) is the same as 3.117.0 with the bot's patch; the only difference is `filtered_custom_name`, still a plain string upstream |
| 3.119.0 (PR #1335) | regenerates the bedrock block and item data of every version: for 1.26.60 1480 blocks, 23 960 states, 2080 items (was 1356, 16 913, 1933, the 1.26.30 tables); `bedrock_1.26.51` moves to its own tables (22 091 states). The 1.26.30 files change too: all 1356 blocks (hardness of 59, materials of 328, harvest tools of 502, bounding boxes of 26: obsidian 50 -> 35, ladder `block` -> `empty`, iron ore `incorrect_for_wooden_tool` -> `mineable/pickaxe`), all 1933 items (stack sizes of 431, display names of 259), one collision shape. It still reads `filtered_custom_name` as a plain string |

So the bump is bedrock-protocol 3.61.0 and minecraft-data 3.118.0 with a patch that holds the
`filtered_custom_name` fix alone (776 bytes, `node make-patch.mjs 1.26.60 --mcdata-ref 9c97fe50...`; the unit test
`item-stack-response-names` passes with the Realm's bytes). It changes no data the bot uses. 3.119.0 is a move of
the world model to new block data (state ids, collision shapes, dig times, stack sizes, item names for search) and
waits for a change of its own ([decision 0093](decisions/0093-protocol-bumps-keep-the-block-data.md)). The unit test
`bot/test/unit/world/data-pin.test.ts` fingerprints those tables, so a dependency bump that brings new block data
fails the suite. The update check keeps listing minecraft-data 3.119.0 as newer until then.

Found on the way:

- Regenerating the old patch from minecraft-data master (`make-patch.mjs 1.26.60`) no longer gives the committed
  patch: master's 1.26.60 now points at the new block data, so the patch would have carried 23 960 states, and the
  diff writer overflowed the call stack on files of that size (fixed: `lib/gitdiff.mjs`). From commit `9c97fe50`
  it gives the committed patch (the fix's JSON formatted on four lines instead of one).
- `make-patch.mjs` could not build a patch for a release that already ships the version; it now applies only the
  local fixes to such a version (`--package-version` builds for another release than the pin).
- `dump-palette.mjs --version 1.26.65` could not connect (no 1.26.65 in minecraft-data); `--speak 1.26.60` connects
  with the protocol's name and names the file after `--version`. The dump leaves its probe strip at x, z -16..15,
  y -60: `verify.mjs` then fails at `chunk` on that server (unknown runtime ids under the spawn), with the old
  stack as well. Dump on bds-reg, or verify first.
- The version gate's refusal named the oldest version as the newest (`newest supported: 1.16.201`); it now names
  the one with the highest protocol.

**Does the Realm need the bump?** No, not now and not when it moves to 1.26.65: the bot as it was speaks 2225 and
played on BDS 1.26.65.1 (the table). The bumped bot plays on 1.26.60.6 as before, so it joins a Realm still on
1.26.60 too. The Realm reports `*` as its version, so the bot cannot tell which build it runs; it does not need to.
The next protocol change is 1.26.70 (2259 in the previews): that needs a real bump (playbook step 1, upstream
minecraft-data data), and its minecraft-data entry will point at new block data, so the guard test above decides
whether the bump patches the block keys back to the measured tables or waits for the block data move.

## minecraft-data 3.119.0: the block data move (Track U2, 2026-11-16)

[Decision 0094](decisions/0094-one-block-data-key.md). minecraft-data 3.119.0 regenerated the bedrock block and item
data. The bot now reads one key for all of it, `bedrock_1.26.60` (`bot/src/data/blockData.ts`, `BLOCK_DATA_KEY`):

- the world registry's state ids;
- collision shapes (`skills/terrain/shapes.ts`);
- mining data (`data/mining.ts`);
- stack sizes (`skills/container/chest.ts`);
- item names (`skills/home/search.ts`).

Up to 3.118.0 these read two keys, `bedrock_1.26.60` and `bedrock_1.26.51`. That was harmless while both pointed at
the 1.26.30 tables. In 3.119.0 each key has tables of its own, so the shapes would have been looked up by another
key's state ids. A game version's block states come from its palette: the BDS dump for 1.26.60, and minecraft-data's
own `bedrock_1.26.51` states for 1.26.51 (`paletteFromData`). States the block data lacks get process-wide ids above
its 23 960 (registry.ts `EXT`).

**How to see what a data bump changes for the bot.** Dump the bot's view of every palette state and every item
before and after, then diff:

```sh
node bot/scripts/data-view.ts dump 1.26.60 1.26.60 before.json --items 1.26.60   # palette, game version, out, items of fixtures/1.26.60
node bot/scripts/data-view.ts diff before.json after.json diff.json
```

Per state the view records:
- the name the registry resolves, and whether the state is a block data state, palette-only or unknown;
- hardness and collision boxes;
- the terrain class (top, floor, liquid, danger, climbable, ...);
- mining data, and break ticks with 12 tools.

Per item it records the registry name, stack size and display name. The diff groups changes by field and block.

**What 3.119.0 changes for the bot** (3.118.0 against 3.119.0, the 23 941 states and 2080 items BDS 1.26.65.1
sends):

| | 3.118.0 | 3.119.0 |
|---|---|---|
| palette states that are block data states | 16 277 (7 664 palette-only, borrowing a relative) | 23 941 (0 palette-only) |
| block data states BDS never sends | 0 | 19 (chalkboard directions 4 to 15, a sculk sensor phase, a creaking heart state) |
| server items the item table knows | 1933 of 2080 | 2080 of 2080 |
| collision boxes | | 64 blocks differ: fences, panes and bars per arm (the terrain layer draws their arms itself, `connectedBoxes`); end portal frame with an eye 1 -> 0.8125; straw_bed 0.5625 -> 0.25; icicle, ice_crystal, red_shrub, shelf_mushroom own shapes instead of full cubes |
| terrain class | | 7 blocks: the six above and chorus_plant with an up arm (0.875 -> 1) |
| hardness | | 158 blocks: obsidian and crying obsidian 50 -> 35; wool stairs and slabs 2 -> 0.8 and concrete ones 2 -> 1.8 (they borrowed oak's); the poplar set its own; air 0 -> -1 and unknown -1 -> 0 (kept at 0 and -1, `HARDNESS_FIXES`); education and legacy blocks |
| break ticks | | 182 blocks (2633 states) |
| harvest tools | keys were Java-style ids from 939, decoded by arithmetic | keys are the version's own item ids (iron_pickaxe 299): decoded by item name; the same requirements |
| stack sizes | | 3 items a player holds: armor_stand 16 -> 64, board and ice_bomb 1 -> 16; 428 block-only names (lit furnaces, wall signs, double slabs) 1 -> 64; 23 items the old table lacked (cushions 16, poplar boats 1, ...) |
| display names | 1058 of the 1126 items found in BDS's `en_US.lang` match it | 1235 of 1249 match; 260 names changed ("Unlit Redstone Torch" -> "Redstone Torch", "Lime Candle Cake" -> "Cake with Lime Candle"), 147 items named for the first time |

**Checked on BDS 1.26.65.1** (RakNet, flat world, truth pack; the bot on 1.26.60):

| Check | Result |
|---|---|
| e2e dig, the changed blocks against the table: obsidian and crying obsidian with a diamond pickaxe, white wool slab by hand, white concrete slab with a wooden pickaxe, poplar log with a stone axe, stone with a wooden pickaxe, iron ore with a stone pickaxe | 132 / 131, 24, 26, 14, 23, 23 ticks against 132, 132, 24, 27, 15, 23, 23: all within the suite's -1 / +2. Obsidian is 35 (it would be 188 ticks at 50) |
| e2e dig, the 20 earlier cases (grass, dirt, oak log by hand and each axe, tool choice) | 20 of 20 |
| e2e data-truth: stack sizes, `truth:itemmax` for every item type the server registers | 1623 compared, 0 differ (armor_stand is 64) |
| e2e data-truth: standing heights, an armor stand dropped on each block whose class changed and on controls | 14 of 14 at the bot's height: end portal frame 0.8125 with and without the eye, straw_bed 0.25, ice_crystal 0.4375, icicle 0.6875, shelf_mushroom 0.6875, red_shrub 0 (no collision), stone 1, wool slab 0.5, oak fence 1.5, bed 0.5625, ladder 0 under the stand, chorus plant 0.875 (the server recomputes its arms from the neighbours, so an up arm cannot be stood on) |
| e2e world-registry: every block type placed, and the strip | 0 unknown runtime ids |
| `verify.mjs 1.26.60 --deps self` | pass: login, spawn, subchunk, 20-tick walk with 0 corrections, 0 decode errors |
| e2e nav-stairs, nav-fence, nav-water, nav-ladder, nav-flat | 31 of 31 |
| e2e chat, keepalive, world-chunks, world-entities, world-updates | passed |
| e2e reconnect | passed in 1 run of 3 with this track. Without this track's connection changes, 1 run failed the same way. The failures are all one check: the ticks counted around a console say read 43 against a limit of 42. The window is 2 s plus the `docker exec` that sends the say (about 165 ms on the PC, which blocks the event loop), so 43 is the expected count. The reconnects themselves came back each time |
| e2e echo | its first case failed in 2 of 5 runs. Without this track's connection changes it failed in 3 of 4 on the same server. The case reads `conn.tick` as soon as the chat line arrives, and that is 0 when the packet is handled before the first 50 ms tick (the `docker exec` that sends the say blocks the event loop) |
| e2e pve-combat, the zombie fight | 2 of 2 |
| e2e read-errors with both boxes named (`P1_BOTHNAMED=1`) | 2 of 2, no unreadable packet |
| e2e test-inv | 13 of 13 |
| display names against `resource_packs/vanilla/texts/en_US.lang` of the same server | see the table above; the 14 that differ are aggregate names (`planks`, `fence`, `stonebrick`, `monster_egg`, ...) |

3.119.0 agreed with the server wherever it was measured, so the bot applies no Bedrock correction to it.
`HARDNESS_FIXES` holds the bot's own meanings, not corrections.

**Fixes the move needed in the bot:**
- Generated test worlds: the block data's fences carry connection states whose default is a lone post, so
  `blockInfoOf('oak_fence')` lost its neighbour-derived arms. It now drops connection states that were not asked for
  (`GENERATED_CONNECT_BASE`).
- `resolveNewerState` (Track AA's stairs table) also holds the corner states the block data now has. It is only a
  backstop for a registry that reports a stairs id as unknown.
- `docs/storage.md`'s generated tables count the poplar items (wood 69 -> 75, logs 25 -> 27, planks 12 -> 13).

**The guard.** `bot/test/unit/world/data-pin.test.ts` pins `bedrock_1.26.60`'s counts (1480 blocks, 23 960 states,
2080 items) and the fingerprints of its blocks, states, items, shapes and materials. It also checks that every
module reads `BLOCK_DATA_KEY`. On the next bump that changes them:
1. diff the view;
2. rerun `data-truth` and `dig` on a server of the new build;
3. update the fingerprints in the same change.

The test also checks that every `NEWER_ITEM_STACKS` entry (stack sizes measured for items newer than the block
data, section "1.26.70 preview") is still missing from the block data, so an entry is dropped once a move brings
the item.

## One build, two protocols (Track U2, 2026-11-16)

[Decision 0095](decisions/0095-one-build-two-protocols.md). A bot with no pinned version speaks, per session,
whichever of its versions the server takes. One deploy covers a Realm on 1.26.60 (protocol 2225) and the same
Realm after it moves to 1.26.70 (2259), with no config change and no redeploy on release day.

**Which versions.**
- `--version`, `BOT_VERSION` and the config file's `version` unset or `auto`: the candidates are the preferred
  version (`DEFAULT_VERSION`, 1.26.60), then every other version that has a world shim and that bedrock-protocol
  speaks, newest first. Today that is 1.26.60, 1.26.70, 1.26.51 (`config/resolve.ts` `autoVersions`).
- A pinned version is the only candidate and behaves exactly as before.

**Which one a session speaks** (`connection/versionGate.ts` `pickVersion`, `Connection.sessionVersion`):
- A server that answers a ping (BDS over RakNet, the NetherNet LAN discovery response) gets the candidate with the
  protocol it advertises. When no candidate has that protocol, the connect is refused before login.
- A Realm, which has no ping, gets the version that last spawned, else the preferred one. If the server refuses
  that version terminally, the next candidate not refused yet is tried 1 s later (`VERSION_RETRY_MS`, not a
  reconnect: no backoff, and also with reconnect off). The refused set is cleared on every spawn. When every
  candidate has been refused, the connect fails as it did before.
- Terminal refusals measured on local BDS (2026-11-16):
  - 2225 against BDS 1.26.70.24: play_status `failed_client`, then the kick `outdated_client`;
  - 2259 against BDS 1.26.65.1: play_status `failed_spawn`, then `outdated_server`.
- The world model follows the session: `tasks/mobility.ts` builds the World with `version: () =>
  conn.sessionVersion`, and the registry reads it at every start_game. It picks that version's palette. State
  ids keep their meaning across sessions, because the block data is one key and palette-only states have
  process-wide ids (decision 0094).
- The log names the version only when it is not the configured one: `speaking 1.26.70 (protocol 2259; refused:
  1.26.60)`, then `spawned as ... speaking 1.26.70`.

**Measured:**

| Case | Result |
|---|---|
| `auto` against BDS 1.26.65.1 (RakNet) and BDS 1.26.70.24 (NetherNet) | spawned on 1.26.60 and on 1.26.70; 0 unknown runtime ids; chat came back |
| `auto` with the ping protocol removed (a Realm's case): BDS 1.26.70.24 | refused 1.26.60 (`outdated_client`), spawned on 1.26.70 about 2.3 s later |
| the same against BDS 1.26.65.1 | spawned on 1.26.60 at once |
| `auto` against `--version 1.26.60` on BDS 1.26.65.1, the packets the bot sends | the same 13 packets in the same order; the only difference was the runtime id the server assigned (inputs compared with their varying fields masked) |
| the CLI (`node src/index.ts --no-config`, no `--version`) against both servers | exit 0 |

**Switch and rollback.** Nothing changes on release day if the deployed bot has no pinned version. A pin (config
`version`, `BOT_VERSION`, a `--version` in the service definition) turns this off: remove it, or set `auto`. To
force one version, pin it: `--version 1.26.70`, or `--version 1.26.60` for exactly the behaviour before this track.

## 1.26.70 preview (Track U2, 2026-11-16)

BDS 1.26.70.24, a preview build (`run-bds.mjs 1.26.70.24 --preview --transport nethernet`), speaks protocol 2259.
minecraft-data has no 1.26.70 yet. Mojang's bedrock-protocol-docs, gophertunnel and CloudburstMC have its packets.

**Protocol data.** `tools/bump-version/derive/1.26.70.mjs` derives it from 1.26.60's by 22 named edits.
`make-patch.mjs --derive` writes them into `patches/minecraft-data@3.119.0.patch` with `releaseType: 'beta'`, and
`derive-protocol.test.ts` fails when the recipe and the patch drift apart. A hunk in
`patches/bedrock-protocol.patch` lets bedrock-protocol speak beta entries. The changes from 2225 to 2259:
- fields added to existing packets: text `queue`, command_output's per-message `raw_message`, transfer's server
  transfer settings, play_sound's start delay and attach options, structure_block_update, network_settings'
  `sctp_recovery_profile`, start_game's managed chat info, and others;
- the resource pack stack's editor flag is now a type byte;
- the data store packets were rewritten;
- new packets 0x169 to 0x16f (chat, online music, armour visibility, virtual containers); 0xa6 and 0xa7 removed.

The bot sends no packet whose layout changed. Two items rest on one source each, because no such packet was seen:
the data store's variant indices (read as varints) and MusicPlaybackState (a string, as Mojang's docs have it).

**NetherNet only.** The preview does not answer RakNet. LAN discovery on udp/7551 wraps its CONNECTRESPONSE in a
packet of type 3 that nethernet 1.1.2 dropped; `patches/nethernet@1.1.2.patch` unwraps it (tools/bump-version
playbook, "NetherNet-only servers").

**Block states.** `bot/data/block-palette/1.26.70.json` was dumped from the preview:
- 1507 types and 25 028 states, against 1.26.60's 1480 and 23 941;
- 1139 of its states are not in the block data (`bedrock_1.26.60`) and get process-wide ids above it;
- 28 new block types:
  - calcite: stairs, slab and wall, calcite_pillar, and the polished_calcite and polished_calcite_bricks sets;
  - packed ice: packed_ice_bricks with its stairs, slab and wall, chiseled_packed_ice;
  - snow: snow_bricks with its stairs, slab and wall;
  - brittle_ice and chiseled_soulshale;
- disc_press is gone;
- scaffolding gained `bottom`, and both repeaters gained `locked`.

How the new blocks look to the bot:
- New walls borrow cobblestone_wall's state with the same connections (`shapeDonor`), so they are 1.5 high.
- New stairs and slabs borrow oak's.
- Other new blocks are full solid cubes. The digger refuses them (`unknown_block`), because the mining data is
  read by name from the block data.
- Two new items do not stack to 64: ice_ball 16 and music_disc_flurry 1 (`NEWER_ITEM_STACKS`, measured by
  `truth:itemmax`).

**Checked on BDS 1.26.70.24** (NetherNet LAN, flat world, truth pack; the bot on 1.26.70 through
`e2e-profile.ts custom`):

| Check | Result |
|---|---|
| `verify.mjs 1.26.70 --deps self --transport nethernet --chunk 3,3` | pass: login 2.0 s, spawn 3.1 s, subchunk, 20-tick walk with 0 corrections, 0 decode errors; the server lists 2109 items (BDS 1.26.65.1: 2080) |
| e2e echo, chat, keepalive, world-chunks, world-updates, world-entities, skills-input | passed |
| e2e world-registry: one of every block type the server registers, and the strip | 0 unknown runtime ids (the strip skips disc_press, which 1.26.70 removed) |
| e2e nav-stairs, nav-fence, nav-water, nav-ladder, nav-flat | 31 of 31 |
| e2e dig: the earlier cases and the 7 blocks whose data changed | all passed; obsidian 131 ticks, white wool slab 23, white concrete slab 26, poplar log 14, stone 22, iron ore 22 (the table's 132, 24, 27, 15, 23, 23) |
| e2e data-truth: stack sizes | 1651 item types compared, 0 differ (2 before `NEWER_ITEM_STACKS`) |
| e2e data-truth: standing heights | 24 of 24: the 14 of 1.26.65.1, and 10 new blocks (snow_bricks, brittle_ice, polished_calcite, calcite_pillar, chiseled_soulshale, chiseled_packed_ice 1; calcite_wall and polished_calcite_brick_wall 1.5; packed_ice_brick_slab 0.5; snow_brick_stairs 1) |
| e2e pve-combat, the zombie fight | 2 of 2 |
| e2e read-errors with both boxes named (`P1_BOTHNAMED=1`) | 2 of 2, no unreadable packet |
| e2e test-inv | 13 of 13 |
| e2e reconnect | the bot came back after `docker restart` (30 s) and after a kick (3.3 to 3.5 s), and the refusal case passed. The tick count of the duplicate check read 43 or 44 against a limit of 42 in 2 runs, the same as on BDS 1.26.65.1 (see above) |

**What is not proven on 2259.** The music and data store packets (none seen); a Realm on 1.26.70; NetherNet with
services signalling (the Realm path) on 2259; an ack for the type-3 packets (none of four tried stopped the
copies; a spawn works without one). The release may change the protocol number: then the 1.26.70 attempt is
refused too, and the data is derived again for the release or taken from minecraft-data's branch (playbook, "A
preview's protocol").

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

## Packets the bot cannot read

Track P1 ([decision 0092](decisions/0092-packets-the-bot-cannot-read.md)). bedrock-protocol drops a packet it cannot
parse: `Client.readPacket` catches the error, emits `error` and reads on. Nothing else learns what the packet said, and
before this track nothing kept its bytes. The log showed only `Read error for undefined : Missing characters in
string, found size is 69 expected size was 241`, with no packet name. On a Realm (2026-11-16, three cases) the error
came 0 to 160 ms after the bot asked to swap two shulker boxes. 2 s later (StackRequests' 40-tick timeout) the swap was
"refused (timeout)". That timing points at the swap's own item_stack_response. The survival kit then rolled back a swap
the server had done, and its model of the inventory stayed wrong. Rocket deposits in the same sessions worked.

**The capture** (`bot/src/connection/readErrors.ts`, on by default, no setting). The Connection wraps the client's
`readPacket` and `handle` / `onDecryptedPacket`, so on an `error` it knows whether a parse was running and which bytes
were being parsed. For a failed parse it:

- writes one JSON file to `<logDir>/read-errors/read-error-<time>-<n>-<name>.json`. The file holds the packet id (the
  low 10 bits of the first varint), its name from minecraft-data, its length, the error and its stack, the bytes
  (base64), the game version, start_game's `game_version` (`serverVersion`: a live server may run a newer patch than
  the protocol data), the transport, the session and the tick. It also holds the batch the packet came in: each
  packet's declared length, the failed one's index, how many bytes the batch was short, and the batch itself up to
  512 KiB.
- caps the files at 20 and at 4 MiB in total, counting files that earlier runs left. When the size cap would be
  passed, the batch is dropped first. The login packet is never written (it carries the account's chain).
- logs one WARN line: `unreadable packet 148 item_stack_response (51 bytes): <error>; bytes saved to <file>`.
- leaves the session's end reason alone. Before, the first read error became the end reason of a close that came
  minutes later for another cause ("connection lost (error: Read error ...)").

**What the test servers do.** None of these reproduced it: BDS 1.26.60.6 over RakNet, 1.26.60.6 and 1.26.63.1 over
NetherNet (WebRTC, as on a Realm), and the Realm's boxes rebuilt with a structure (a box named `bot_loot` of mixed loot
with enchanted and damaged gear, a box of rockets of Flight 1 to 3 with explosions, two boxes both named, the third
case's slots: main 17 and hotbar 3). Across 34 swaps on 2026-11-16 every response was read and every swap was
answered. BDS answers a swap of two boxes in 39 to 51 bytes. The Realm's error needs at least 70 bytes left in the
packet, so the Realm sent something longer or shaped differently. The protocol data is the same in minecraft-data
3.117.0 (patched) and 3.119.0, and bedrock-protocol 3.61.0 changes nothing in this packet, so a version bump is not
the fix. The decode waits for a Realm capture.

**The resync after a lost packet** (`bot/src/world/resync.ts`, always on). When a packet is lost, the model may hold a
slot the server changed. The rules:

1. A lost packet that can change the inventory marks the model *unsure*. These are item_stack_response,
   inventory_content / _slot / _transaction, player_hotbar, mob_equipment, mob_armor_equipment, container_open / _close,
   update_equipment, and any id without a name. The bot then asks the server for the whole inventory with an
   `inventory_mismatch` inventory transaction, the vanilla client's own request. BDS answers within one tick with
   inventory_content for the inventory, armour, offhand and ui windows and a player_hotbar (90 ms on RakNet, 64 ms on
   NetherNet).
2. The next full inventory_content of window 0 makes the model sure again. Until then StackRequests and Containers wait
   for it (up to 3 s) before they build a request, because a request built on a stale slot is refused or moves the
   wrong stack.
3. A request that ended without its response after a loss ends `lost` as soon as the server's inventory is back,
   without waiting for the 40-tick timeout. The kit's exchange then judges by that inventory: a swap the server did is
   done (`hotbar: the swap of slots a and b got no response (a packet was lost); the server's inventory shows it done`).
   Other callers roll back as before, and the inventory is asked for again one tick later, so the server's own content
   undoes a wrong rollback.
4. If no inventory comes in 3 s, the bot asks again, at most 3 times. After that the model is used as it is (WARN),
   so a server that never answers cannot block the inventory for good.

Measured with an injected parse failure of the swap's response (e2e `read-errors`, 2026-11-16). Without the rule, the
swap was "refused (timeout)" after 2.2 s and the model still disagreed with the server 6 s later. With it, the swap was
ok in 473 ms (RakNet) and 303 ms (NetherNet), and the model matched the server 657 ms and 499 ms after the request.

**The packet, decoded** (the Realm capture of 2026-11-16, 79 bytes). The slot field `filtered_custom_name` of
item_stack_response is an optional string: a bool, then the string when the bool is 1. minecraft-data (3.117.0 and
3.119.0 alike) reads it as a plain string. A Realm filters item names, so for a named item it sends `01` and the
filtered name; the plain-string reader took the `01` as a length of 1 and lost its place. BDS sends a single `00`
(absent), which a plain string reads the same way as an empty one, so a test server never shows it. The swap of two
named boxes is that case (`bot_fireworks` and `bot_loot`); rocket deposits carry no name and were read. The fix is one
line of the protocol data, `["option", "string"]`, in the minecraft-data patch (`patches/minecraft-data@3.118.0.patch`
from 2026-11-16, where it was the whole patch; `patches/minecraft-data@3.119.0.patch` since Track U2), and
`tools/bump-version/make-patch.mjs` applies it to every version it builds (`localFixes`) until upstream reads the field
that way. The unit test `bot/test/unit/item-stack-response-names.test.ts` parses the Realm's bytes and the BDS shape
and writes both back byte for byte. The same Realm session answered the resync's `inventory_mismatch` in 86 and
103 ms, and the swap was judged done from the server's inventory. The Realm reports `*` as the `game_version` of
start_game, so `serverVersion` tells nothing there.

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
Then minecraft-data's bedrock block states stopped at 1.26.30; 1.26.60 changed and added states, and every
runtime id the registry cannot resolve is a solid `unknown` block to the planner. The world registry
now builds its runtime-id table from a palette dumped from BDS itself. Since [decision 0094](decisions/0094-one-block-data-key.md)
the block data is minecraft-data 3.119.0's `bedrock_1.26.60`, which holds every state of the 1.26.60 dump; the
numbers and state ids below are those of the 1.26.30 tables, and the palette matters again for the next version
(1.26.70) and for 1.26.51.

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
| palette-only states (state ids from 16 913 up) | 7 664 (0 since decision 0094) |
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
