# Bedrock Bot and RL Environment: Technical Plan

Date: 2026-10-28. Status: research and feasibility spikes complete; no production code written.
All facts below were checked on 2026-10-28 unless marked *unverified*. Spike code lives in `spikes/` and is throwaway.

**Verdict: GO, with four architecture changes** (section 2). Spikes A, B and C all passed on a local BDS, plus three extra spikes (NetherNet transport, SimulatedPlayer on BDS, running ahead of bedrock-protocol releases on BDS 1.26.60) that de-risk the biggest unknowns.

**Your priorities (2026-10-28)**: the Realm is the main target; well over 10 h/week is available with AI agents doing most of the implementation; any language is fine. The plan is therefore Realm-first, Phase 1 ends with a 7-day Realm soak, and Phases 2 and 3 run as parallel tracks against the interfaces in section 4.

---

## 1. Verified facts

| # | Item | Finding | Version checked | Source | Date |
|---|---|---|---|---|---|
| 1a | Current Bedrock release | **26.60** (internal `1.26.60`), released 2026-10-27, protocol **2225**. Preview 26.70.22 (protocol 2239). Mojang now brands releases "26.xx"; internals and BDS keep `1.26.xx`. | 1.26.60 | [changelog](https://feedback.minecraft.net/hc/en-us/articles/49852828563853), [wiki](https://minecraft.wiki/w/Bedrock_Edition_26.60) | 10-28 |
| 1b | Current BDS | **1.26.60.6** stable, 1.26.70.22 preview. Zips are plain `curl`-able; current links from the official links API. Previous build 1.26.51.1 is still downloadable. | 1.26.60.6 | [links API](https://net-secondary.web.minecraft-services.net/api/v1.0/download/links) | 10-28 |
| 1c | BDS in Docker on Windows 11 | **Works** via Docker Desktop (WSL2) with `itzg/minecraft-bedrock-server` (image 2026.10.2, maintained, pushed 2026-10-27). Verified both RakNet (UDP) and NetherNet (TCP 19132 + UDP + 7551 discovery) through Docker NAT. One idle instance: about 350 MB RAM and 1.6 % of one core. | image 2026.10.2 / BDS 1.26.51.1 | [repo](https://github.com/itzg/docker-minecraft-bedrock-server), spike log | 10-28 |
| 1d | BDS transport | Since 26.50 **NetherNet (WebRTC) is the default** and RakNet is deprecated; 26.60 prints a "TRANSPORT TYPE ERROR" banner when `transport=raknet`, but RakNet **still accepts connections** on 1.26.51.1 and 1.26.60.6 (verified: 1.26.60.6 answered a 1.26.51 client with `outdated_client`, so the listener works). Expect removal in a future release. | 1.26.60.6 | [26.50 changelog](https://feedback.minecraft.net/hc/en-us/articles/48826825649933), spike | 10-28 |
| 1e | BDS allow-list + offline | BDS **refuses to start** with `allow-list=true` and `online-mode=false` (the itzg default is allow-list on). Set `ALLOW_LIST=false` for local offline testing. | 1.26.51.1 | spike log | 10-28 |
| 2a | bedrock-protocol latest | **3.60.1** (2026-09-22), supports game versions 1.16.201 to **1.26.51** (protocol 2193). 1.26.60 not yet supported (tracking issue opened 2026-10-27). | 3.60.1 | [npm](https://www.npmjs.com/package/bedrock-protocol), [options.js](https://github.com/PrismarineJS/bedrock-protocol/blob/master/src/options.js) | 10-28 |
| 2b | bedrock-protocol update lag | Last 11 game releases: **1 to 11 days, median about 4 days** after the Bedrock release (1.26.51 released 09-15, supported 09-22; 1.26.40 08-04 to 08-08; 1.21.130 12-09 to 12-20). | 3.50 to 3.60 | [HISTORY.md](https://github.com/PrismarineJS/bedrock-protocol/blob/master/HISTORY.md), [protocolVersions.json](https://github.com/PrismarineJS/minecraft-data/blob/master/data/bedrock/common/protocolVersions.json) | 10-28 |
| 2c | bedrock-protocol Realms | Supported via `createClient({ realms: { realmId / realmInvite / pickRealm } })`. Realms moved to NetherNet in 26.10; the NetherNet client landed in 3.60.0; a regional signalling DNS bug (#832) is fixed on master by PR #839 (2026-10-23) but is **not in any npm release yet**. Auth is the prismarine-auth device-code flow; tokens are cached in `profilesFolder`. *End-to-end Realm join unverified (out of scope by your constraints).* | 3.60.1 / master | [API.md](https://github.com/PrismarineJS/bedrock-protocol/blob/master/docs/API.md), [#832](https://github.com/PrismarineJS/bedrock-protocol/issues/832), [#717](https://github.com/PrismarineJS/bedrock-protocol/issues/717) | 10-28 |
| 2d | bedrock-protocol NetherNet LAN | **Verified**: `transport: 'nethernet'`, `signalling: 'lan'` joined a NetherNet-mode BDS 1.26.51 in Docker (discovery ping on UDP 7551, WebRTC via werift), spawned in 2.9 s. | 3.60.1 | `spikes/spikeNN.js` | 10-28 |
| 2e | bedrock-protocol RakNet backends | `raknet-native` works (prebuilt binary, Node 24). `jsp-raknet` (pure JS) timed out against BDS. | 3.60.1 | `spikes/spikeA2.js` | 10-28 |
| 2f | bedrock-protocol client features | No physics, no position tracking, no spawn handshake: it only auto-sends `set_local_player_as_initialized`. The bot must answer `respawn` (state 1 with state 2) and send `serverbound_loading_screen` acks before the server simulates it. Verified: without these the server ignores every `player_auth_input`. | 3.60.1 | [client.js](https://github.com/PrismarineJS/bedrock-protocol/blob/master/src/client.js), spike C | 10-28 |
| 2g | Running ahead of bedrock-protocol releases | **Verified (spike E)**: bedrock-protocol 3.60.1 joined **BDS 1.26.60.6** after copying minecraft-data master's `bedrock/1.26.60/protocol.json` (merged upstream 2026-10-28, one day after the game release) into the npm package and adding a `data.js` entry. Chunks decoded, walking accepted, corrections received. The upstream 1.26.51 bump (PR #823) was 3 lines (README, `minecraft-data` dependency, `CURRENT_VERSION`). A same-day fork bump is realistic whenever an update changes only packet shapes; updates that change login or auth code (as 1.26.10 and 1.26.40 did) still need real library work. | 3.60.1 + minecraft-data master | [PR #823](https://github.com/PrismarineJS/bedrock-protocol/pull/823), [minecraft-data PR #1340](https://github.com/PrismarineJS/minecraft-data/pull/1340), `spikes/spikeE.js` | 10-28 |
| 3a | minecraft-data Bedrock coverage | npm 3.117.0 ends at `bedrock/1.26.51`; **master** gained `bedrock/1.26.60/protocol.json` on 2026-10-28 (PR #1340, auto-generated by the project's `bedrock-version-bump` workflow, branch `bedrock_1_26_60`). `tools/bump-version` turns that into a pnpm patch. **Block and item data gap**: for 1.26.40 to 1.26.60, `blocks`, `blockStates`, `items` and `blockCollisionShapes` all point at the **1.26.30** data, so blocks added since 26.30 are unknown (prismarine-chunk falls back to air). 2026-10-28: the bot's default moved to 1.26.60 (through the patch; block data still 1.26.30). | 3.117.0 | [dataPaths.json](https://github.com/PrismarineJS/minecraft-data/blob/master/data/dataPaths.json) | 10-28 |
| 3b | prismarine-chunk | 1.41.0 has **no table entry for Bedrock 1.26** and throws. PR #338 (open since 2026-09-22) maps 1.26 to the 1.18 implementation. **Verified workaround**: `require('prismarine-chunk/src/bedrock/1.18/chunk')(registry)` decodes 1.26.51 subchunks correctly (v9 subchunks, hashed runtime IDs). | 1.41.0 | [PR #338](https://github.com/PrismarineJS/prismarine-chunk/pull/338), spike B | 10-28 |
| 3c | prismarine-registry | `handleStartGame` expects `itemstates` inside `start_game`; in 1.26.x they arrive in a separate **`item_registry`** packet (2076 items). Verified workaround: pass `{ ...startGame, itemstates }` taken from that packet. 16 913 block states loaded; hashed IDs resolved. | latest | spike B | 10-28 |
| 3d | Chunk delivery mode | BDS sends `level_chunk` with `sub_chunk_count: 0` and a `highest_subchunk_count`; the client must send `subchunk_request` (origin y = -4 in the overworld) and decode `subchunk` entries (`success` or `success_all_air`). Verified. | BDS 1.26.51.1 | spike B | 10-28 |
| 4 | mineflayer-for-bedrock | **The original repo is gone** (GitHub 404; npm `bedrockflayer` never published). A copy exists at airscro/mineflayer-for-bedrock: 4 commits in one day (2026-04-14), 0 stars, no LICENSE file (package.json says MIT), pinned to the bedrock-protocol 3.55 era, unverified physics. **Recommendation: ignore as a base, read for ideas only.** Better reference: **LiteLDev/bedboo** (LGPL-3.0, created 2026-10-18, BDS 1.26.51 + bedrock-protocol 3.60.1, Bedrock physics forked from prismarine-physics, runs mineflayer-pathfinder, Docker BDS e2e tests, not on npm, needs Node 24). | n/a | [airscro copy](https://github.com/airscro/mineflayer-for-bedrock), [bedboo](https://github.com/LiteLDev/bedboo) | 10-28 |
| 5a | Script API stable modules on BDS | `@minecraft/server` **2.11.0** stable (2.10.0 is what BDS 1.26.51 loads), `@minecraft/server-ui` 2.3.0 stable. `server-gametest`, `server-net`, `server-admin`, `debug-utilities`, `diagnostics` are **beta-only** and need the Beta APIs experiment. `server-net` and `server-admin` are BDS-only; `server-net` must be added to `config/<uuid>/permissions.json`. | 2.11.0 | [Learn: scripting on BDS](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/scripting), [module page](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/minecraft-server) | 10-28 |
| 5b | SimulatedPlayer on BDS | **Available and verified**: `@minecraft/server-gametest 1.0.0-beta` `spawnSimulatedPlayer()` works on BDS 1.26.51.1 with no client attached; `navigateToLocation` returned a full 11-node path and walked it; `breakBlock` broke a block. Beta APIs were enabled **without a client** by setting `experiments.gametest=1` (plus `experiments_ever_used`, `saved_with_toggled_experiments`) in `level.dat` with prismarine-nbt (`spikes/editlevel.js`). Not documented as supported by Mojang; it is beta. | gametest 1.0.0-beta | [SimulatedPlayer](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-gametest/simulatedplayer), [wiki.bedrock.dev experiments](https://wiki.bedrock.dev/nbt/enabling-experiments), spike D | 10-28 |
| 5c | Script API chat events | `chatSend` events are **beta-only**. Stable alternative verified: `/scriptevent ns:id msg` from the console or an operator, received via `system.afterEvents.scriptEventReceive`; `world.sendMessage` reaches the bot as a `text` packet of type `json` (rawtext). | 2.10.0 | [changelog](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/changelog), spike B | 10-28 |
| 5d | Script API push-out and tick rate | `@minecraft/server-net` (beta, BDS-only) has outbound `http.request` and `websocket.connect`; **no inbound listener**. The `/wsserver` command is a client feature, not usable from BDS. No tick-rate control exists (`/tick` is Java-only); BDS runs at 20 TPS wall clock. | server-net 1.0.0-beta | [server-net](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-net/minecraft-server-net), [/tick](https://minecraft.wiki/w/Commands/tick) | 10-28 |
| 6a | Movement model | Server-authoritative with rewind is the **only** mode since 1.21.70 (`server-authoritative-movement` key removed). The client sends `player_auth_input` every tick; the server simulates from the **input flags**, compares with the client's predicted position, accepts if within `player-position-acceptance-threshold` (0.5 blocks), otherwise sends `correct_player_move_prediction` (position, delta, on_ground, tick) and the client rewinds. | 1.26.51 | [Mojang movement overview](https://mojang.github.io/bedrock-protocol-docs/guides/player-movement-overview/), [anti-cheat guide](https://mojang.github.io/bedrock-protocol-docs/guides/anti-cheat-server/), [1.21.70 notes](https://minecraft.wiki/w/Bedrock_Edition_1.21.70) | 10-28 |
| 6b | `player_auth_input` encoding | In minecraft-data 1.26.51 `input_data` is an **array of flag names** (wire: varint count + zigzag32 per flag), matching Mojang's docs (`array<int32>`) and bedboo. Position is the **eye position** (feet + 1.62). Field order: pitch, yaw, position, move_vector, head_yaw, input_data, input_mode, play_mode, interaction_model, interact_rotation, tick, delta, optional transaction / item_stack_request / block_action / vehicle, analogue_move_vector, camera_orientation, raw_move_vector. | 1.26.51 | [packet doc](https://mojang.github.io/bedrock-protocol-docs/latest/packets/player-auth-input-packet/), spike C | 10-28 |
| 6c | Movement tolerance | **Verified**: walking 0.2 blocks per tick for 6 ticks with the `up` flag and `move_vector z=1` was accepted exactly (server position 1.700). Jumping 3 blocks in one tick with no input flags produced one `correct_player_move_prediction` back to the last valid position and no kick. **Follow-up from `tools/bump-version/verify.mjs`**: a constant 0.2 blocks/tick walk is corrected twice over 20 ticks (server reached z 4.539 vs client 4.3), so even flat-ground walking needs the real acceleration model; `v += 0.098; z += v; v *= 0.546` per tick (settling at 0.2159) gives zero corrections over 20 ticks on both 1.26.51 and 1.26.60. Current server keys: `server-authoritative-movement-strict`, `player-position-acceptance-threshold=0.5`, `player-movement-action-direction-threshold=0.85`; the old score/distance/duration keys are gone. | BDS 1.26.51.1 | spike C, `server.properties` | 10-28 |
| 7a | Block breaking packets | Server-authoritative breaking is on (`start_game.server_authoritative_block_breaking`). Block actions ride inside `player_auth_input.block_action` with the `block_action` flag: `start_break` (0), `continue_break` (27) each tick, `predict_break` (26) on the predicted tick, then `stop_break` (2) or `abort_break` (1). The server answers with `update_block`, `level_event` crack/destroy, and `add_item_actor` for the drop; pickup is automatic on overlap and announced by `take_item_actor` plus `inventory_slot` / `inventory_content`. | 1.26.51 | [Mojang block-breaking guide](https://mojang.github.io/bedrock-protocol-docs/guides/block-breaking-overview/), [dragonfly handler](https://github.com/df-mc/dragonfly/blob/master/server/session/handler_player_action.go) | 10-28 |
| 7b | Break time | ticks = ceil(1 / (speed / hardness / 30)) when the tool can harvest. Tool multipliers: hand 1, wood 2, stone 4, copper 5, iron 6, diamond 8, netherite 9, gold 12; Efficiency adds level² + 1; divide by 5 under water without Aqua Affinity and by 5 while airborne. Oak log (hardness 2): hand 60, wooden axe 30, stone 15, iron 10, diamond 8, netherite 7, gold 5 ticks. Survival adds a fixed 250 ms delay between breaks. | wiki (26.x) | [Breaking](https://minecraft.wiki/w/Breaking), [build-action rate](https://mojang.github.io/bedrock-protocol-docs/guides/build-action-simulation-rate/) | 10-28 |
| 8a | BDS idle kick | `player-idle-timeout=30` minutes **by default**; 0 disables (itzg: `PLAYER_IDLE_TIMEOUT`). | 1.26.60.6 | `bedrock_server_how_to.html` in the zip | 10-28 |
| 8b | Realms idle kick | No official doc. Community reports (2019 thread with Mojang status "Not planned", comments through 2026) say about **15 minutes** idle; a 2026 client-side "press any button" AFK screen also exists. *Unverified; plan for 10 to 15 minutes.* A small movement every few minutes should be enough. **Measured 2026-10-29**: with the default 240 s nudge the bot stayed 6 h 14 min on the Realm without a kick (ended by a deliberate kick); the raw idle threshold with nudges off was not measured (optional, runbook "Measuring the Realm idle kick"). | n/a | [feedback thread](https://feedback.minecraft.net/hc/en-us/community/posts/360041863252) | 10-28 |
| 8c | Rules | The EULA and Usage Guidelines contain no bot or automation language; tools and plug-ins are allowed as long as they do not look official. Nothing Realms-specific found. Not legal advice. | current | [EULA](https://www.minecraft.net/en-us/eula), [Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines) | 10-28 |
| 9 | Prior art | No Bedrock-specific RL environment or paper found (2023 to 2026). Useful: bedboo (above); deepslate-bedrock/prismarine-bedrock (PoC, auth-input notes); nootbook011/MineToring (chunk parsing); oomph-ac/oomph (Go, server-side movement simulation); df-mc/dragonfly (Go server: break times, transactions); GeyserMC (canonical translators: `BedrockPlayerAuthInputTranslator`, `BlockBreakHandler`); brandendm/BedrockSyntheticPlayer (Script API A* for SimulatedPlayer); NhanAZ/BedrockDebugProxy (packet capture); CraftGround and Craftium (RL env designs to copy, Java/Luanti). Avoid: bedrocktool (world ripping), any "AFK on public servers" bots. | n/a | links above and in section 11 | 10-28 |

**Machine detected**: Windows 11 Home, Ryzen 9 9950X3D (16 cores / 32 threads), 61.6 GB RAM, RTX 5090, 635 GB free on C:, Docker Desktop 29.4.3 with a 30 GB / 32 CPU WSL2 VM, Node 24.22.1, Python 3.13.9, Git 2.52. The 30 GB WSL2 cap is the practical limit for parallel BDS; raise it in `.wslconfig` for Phase 6.

### Spike results (all on BDS 1.26.51.1, offline, flat world, Docker Desktop)

| Spike | What | Result |
|---|---|---|
| A | Minimal bedrock-protocol client prints chat and position | **Pass.** First attempt timed out because the image now defaults to NetherNet; `TRANSPORT=raknet` fixed it. Console `say` arrived as `text` type `announcement`. Sessions stable for 25 s. One early run closed 50 ms after spawn and did not reproduce in six later runs. |
| B | Decode a block from the wire and compare with Script API truth | **Pass.** bedrock, dirt, grass_block, air and a placed oak_log all matched `dimension.getBlock()`; `update_block` resolved to `oak_log` through hashed runtime IDs. Needed the prismarine-chunk 1.18 bypass and the `item_registry` fix. |
| C | Move one block with `player_auth_input` | **Pass.** 6 ticks × 0.2 blocks accepted exactly (truth 1.700); a 3-block jump without inputs was corrected, not kicked. Required the respawn handshake first; without it the server ignored all input. |
| D (extra) | SimulatedPlayer on BDS without a client | **Pass.** level.dat edit enabled Beta APIs ("Experiment(s) active: gtst"); spawn, navigate (full path, 11 nodes), breakBlock all worked. |
| NN (extra) | NetherNet from bedrock-protocol to Docker BDS | **Pass.** Discovery, join and spawn in 2.9 s. |
| 60 (extra) | BDS 1.26.60.6 on RakNet with a 1.26.51 client | RakNet listener alive; `outdated_client` as expected. |
| E (extra) | BDS 1.26.60.6 with bedrock-protocol 3.60.1 + patched-in 1.26.60 protocol data | **Pass.** Login, spawn, subchunk decode (bedrock / grass_block / air), a 6-tick walk accepted, console `tp` produced `move_player` plus a correction every 6 ticks while the script kept sending a stale position (the documented 5-tick minimum correction delay). |

Rerun instructions are in `spikes/README.md`.

---

## 2. Architecture: go/no-go

**GO.** The four-layer Node/TypeScript bot, BDS in Docker, Script API pack and Python Gymnasium side all hold up. Four changes:

1. **Transport is NetherNet-first with RakNet as the dev fallback.** Realms have been NetherNet-only since 26.10 and BDS defaults to it since 26.50. bedrock-protocol handles both. The Connection layer exposes `transport`, and the Realm join needs the services-signalling fix that is only on bedrock-protocol master today. Use RakNet on local BDS for fast iteration until it is removed, and run one NetherNet BDS profile weekly so that path never rots.
2. **Own thin world model on top of Prismarine parts, not on prismarine-chunk's public loader.** The three Prismarine gaps (no 1.26 chunk table entry, `item_registry` packet, block data frozen at 26.30) are small and verified, but they mean the bot should wrap subchunk decoding and the registry behind its own `World` interface with a per-version shim module, so an upstream fix or a fork swap touches one file.
3. **Bedrock physics is the critical path and should not be written from scratch first.** The server simulates from input flags, so a position without plausible flags is rejected and flags without a matching position are corrected. Evaluate bedboo's Bedrock physics fork (LGPL-3.0, use as a dependency, do not vendor) in a Phase 3 spike before deciding to write our own. Treat corrections as truth and re-plan; never fight them.
4. **The Realm is always on the newest game version, so plan to run ahead of bedrock-protocol releases.** Keep an own fork of bedrock-protocol (and a `minecraft-data` overlay) with a scripted version-bump playbook, verified in spike E: for shape-only updates the bot is back within hours of minecraft-data's auto-generated protocol file landing (one day after release for 26.60); for updates that touch login or auth, expect the usual 1 to 11 day upstream lag or do the fix yourself and send it upstream. A version gate on connect and a notifier remain mandatory.

### Realm readiness checklist (Phase 1 exit gate)

1. bedrock-protocol pinned to a commit at or after PR #839 (merged 2026-10-23; Realms NetherNet signalling fallback), or to the release that contains it.
2. Game version support equal to the live Realm version (fork bump via the playbook when upstream lags).
3. Sign-in done by you through the device-code flow once; the token cache lives outside the repo (`profilesFolder`), and the bot never sees a password.
4. Keepalive that defeats the Realm idle kick (community figure 10 to 15 min; measure the real one by letting the bot get kicked once and logging the reason).
5. Reconnect across Realm restarts, game updates and your own client joining or leaving.
6. Everyone who plays on the Realm told that a bot account is there.

Kept as proposed: four layers with downward-only dependencies; BDS in Docker; Script API pack for truth and resets (stable `@minecraft/server` 2.x only, Beta APIs only on a separate "lab" world); Gymnasium + SB3 PPO; WebSocket + JSON bridge (ZeroMQ is not needed at 20 ticks/s times tens of envs).

One deliberate option for Phase 6: a SimulatedPlayer backend for the RL env (in-process on BDS, free vanilla pathfinding, no network client). It is **not** the same actuator as the network bot, so the baseline comparison must use the network bot. Keep the env backend pluggable and decide after Phase 6 task 3.

---

## 3. Repo layout

```
BedrockBot/
  PLAN.md
  package.json              pnpm workspace root
  bot/                      TypeScript, Node 24, ESM
    src/connection/         createClient wrapper, transports, auth hook (human-run only), reconnect, packet recorder
    src/world/              registry shim, chunk store (subchunk requests), blocks, entities, inventory, version-shims/
    src/skills/             physics, pathfinder (A*), move, dig, collect, container, look
    src/tasks/              afk, gather-wood, rl-agent
    src/bridge/             WebSocket server, message schema (zod), replay
    src/index.ts            CLI: bot --task afk --target bds|realm
    test/unit/              pure logic (pathfinder, break time, chunk decode fixtures)
    test/e2e/               needs Docker BDS; truth-pack assertions
  packs/truth/              behavior pack: ground truth, resets, structures (stable @minecraft/server only)
  packs/lab/                behavior pack: SimulatedPlayer experiments (Beta APIs), optional
  rl/                       Python 3.12+ (uv): gymnasium env, SB3 scripts, eval, pyproject.toml
  docker/                   compose files per profile (dev-raknet, dev-nethernet, rl-N), bds.env templates, tools/enable-experiments.js
  worlds/                   saved test worlds and .mcstructure files (forest, hill, cave, chest-room)
  fixtures/                 recorded packet captures (.jsonl) per game version
  spikes/                   throwaway experiments (this session's code), never imported
  docs/                     prior-art.md, packets.md, decisions/ (ADRs), runbook.md
```

---

## 4. Interfaces

### 4.1 Connection

```ts
export type Transport = 'raknet' | 'nethernet';
export type ConnectTarget =
  | { kind: 'bds'; host: string; port: number; transport: Transport; offline: true }
  | { kind: 'realm'; realmInvite?: string; realmId?: string; profilesFolder: string }; // sign-in done by the human, never by code

export interface Connection {
  connect(target: ConnectTarget): Promise<void>;
  disconnect(reason?: string): void;
  readonly state: 'idle' | 'connecting' | 'spawned' | 'closed';
  readonly gameVersion: string;            // from ping / start_game
  readonly runtimeId: bigint;
  on<K extends keyof InboundPackets>(name: K, fn: (p: InboundPackets[K]) => void): void;
  queue<K extends keyof OutboundPackets>(name: K, p: OutboundPackets[K]): void; // batched per tick
  onTick(fn: (tick: bigint) => void): void; // 20 Hz driver owned by Connection
  recorder?: PacketRecorder;               // jsonl capture for replay
}
```

Responsibilities: version gate (refuse if `gameVersion` is not in the supported list), the spawn handshake (`respawn` state 2, loading-screen acks), latency replies, reconnect with backoff, keepalive hook.

### 4.2 World model

```ts
export interface Vec3 { x: number; y: number; z: number }
export interface BlockInfo { name: string; stateId: number; states: Record<string, unknown>; hardness: number; solid: boolean; boxes: Box[] }

export interface World {
  blockAt(p: Vec3): BlockInfo | undefined;            // undefined = chunk not loaded
  isLoaded(cx: number, cz: number): boolean;
  find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: { origin: Vec3; radius: number; max: number }): Vec3[];
  entities: ReadonlyMap<bigint, EntityInfo>;          // players, mobs, item drops
  self: { pos: Vec3; vel: Vec3; onGround: boolean; yaw: number; pitch: number; health: number; food: number; gameMode: string };
  inventory: { slots: (ItemStack | null)[]; selected: number; window(id: number): ContainerView | undefined };
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): void;
  onCorrection(fn: (c: { pos: Vec3; delta: Vec3; onGround: boolean; tick: bigint }) => void): void;
}
```

### 4.3 Skills

```ts
export type SkillResult =
  | { ok: true }
  | { ok: false; reason: 'unreachable' | 'timeout' | 'corrected' | 'interrupted' | 'no_tool' | string };

export type Goal =
  | { type: 'block'; p: Vec3 }
  | { type: 'near'; p: Vec3; r: number }
  | { type: 'xz'; x: number; z: number };

export interface Skills {
  lookAt(p: Vec3): Promise<void>;
  goto(goal: Goal, opts?: { timeoutTicks?: number; replanOnCorrection?: boolean }): Promise<SkillResult>; // A* + physics-driven input
  dig(p: Vec3, opts?: { tool?: 'best' | number }): Promise<SkillResult>;        // start/continue/predict/stop inside player_auth_input
  collect(radius: number, timeoutTicks: number): Promise<SkillResult>;         // walk over item entities
  openContainer(p: Vec3): Promise<ContainerView>;
  deposit(view: ContainerView, filter: (i: ItemStack) => boolean): Promise<SkillResult>; // item_stack_request moves
  cancel(): void;
}
```

### 4.4 Tasks

```ts
export interface Task {
  name: string;
  start(ctx: { world: World; skills: Skills; chat: Chat; log: Logger }): Promise<void>;
  stop(): void;
  status(): Record<string, unknown>;
}
// AfkTask:        keepalive wiggle every N minutes, chat commands !status !pos !quit, reconnect policy
// GatherWoodTask: state machine find-tree -> goto -> dig column -> collect -> (inventory full) -> goto chest -> deposit
// RlAgentTask:    executes actions from the bridge, publishes an observation after each action
```

### 4.5 Bot to Python message schema (WebSocket, JSON, one env per connection)

```jsonc
// Python -> bot
{ "t": "reset", "id": 1, "scenario": "forest_small", "seed": 7 }
{ "t": "step",  "id": 2, "action": { "kind": "goto_nearest", "block": "oak_log" } }
//   other kinds: {"kind":"dig_facing"}, {"kind":"collect"}, {"kind":"noop"},
//   later raw:   {"kind":"input","flags":["up"],"yaw":90}
{ "t": "close", "id": 3 }

// bot -> Python
{ "t": "obs", "id": 2, "tick": 12345,
  "obs": {
    "grid": [ /* 9x9x5 block class ids, flat, x-major */ ],
    "self": { "pos": [0.5, -60.0, 1.7], "yaw": 0, "health": 20, "food": 16, "on_ground": true },
    "inventory": { "oak_log": 3, "oak_sapling": 1 },
    "nearest_log": { "dx": 3.0, "dy": 1.0, "dz": -2.0, "dist": 3.7 },
    "last_skill": { "ok": true }
  },
  "reward_signals": { "logs_delta": 1, "died": false, "ticks_used": 35 },
  "done": false,
  "info": { "corrections": 0 } }
{ "t": "error", "id": 2, "message": "unreachable" }
```

Reset is executed by the truth pack: Python calls the bot, the bot (an operator on BDS) sends `/scriptevent rl:reset forest_small 7`, the pack places the structure, clears and teleports the player, and answers with a rawtext `text` message the bot parses. Ground-truth observations (optional during training) travel the same way.

---

## 5. Phase breakdown

Each task is sized for one agent session of 2 to 3 hours with a human review at the end. "Done when" tests are automated unless marked manual.

**Tracks.** Phase 0 first. Then three tracks in parallel, each owned by a separate agent session working against the interfaces in section 4: Track A = Phase 1 (connection, Realm), Track B = Phase 2 (world model), Track C = Phase 3 tasks 3.1 and 3.2 (input loop and physics spike, which only need a stubbed world on the flat test world). Phase 3.3 onward needs Track B. Phases 4, 5 and 6 follow. With this parallelism and your time budget a realistic calendar is: Phase 0 in days, Realm soak started within the first two weeks, wood gathering working in roughly 4 to 6 weeks, RL training runs by week 8. The schedule risk is Phase 3 physics, not hours.

### Phase 0: Setup (prerequisite: none)

| # | Task | Done when |
|---|---|---|
| 0.1 | `git init`, pnpm workspace, `bot/` TS project (strict tsconfig, vitest, eslint), `.gitignore` covering `spikes/bds-*` | `pnpm -r test` runs an empty suite green |
| 0.2 | `docker/compose.dev.yml`: BDS pinned `1.26.51.1`, RakNet, offline, `ALLOW_LIST=false`, `PLAYER_IDLE_TIMEOUT=0`, flat world, truth pack mounted; scripts `bds:up`, `bds:down`, `bds:cmd` | `pnpm bds:up` reaches "Server started" in under 90 s and `bds:cmd say hi` shows in the log |
| 0.3 | Port spike A into `bot/src/connection` as `Connection` with version gate and spawn handshake; CLI `bot --task echo` | e2e: connect, receive a console `say`, exit 0 within 10 s |
| 0.4 | Truth pack skeleton in `packs/truth` (stable API; `/scriptevent truth:*` commands block, pos, set, fill, tp, give, clear, ping) and `pnpm pack:deploy` | e2e: `truth:ping` round-trips through the bot |
| 0.5 | Packet recorder (jsonl with tick and direction) and a `fixtures/` capture of login plus 10 s idle | fixture committed; a unit test replays it through the deserializer without error |

### Phase 1: AFK bot (prerequisite: Phase 0)

*2026-10-29: 1.6 passed. First Realm join 2026-10-29 at 06:00Z (bot account BotAccount on the Realm, game 1.26.60, worktree at commit 17ee000; needed the signalling-host fallback in `patches/bedrock-protocol.patch`, docs/runbook.md "Measured on the Realm"). The 24 h run started 06:41:55Z; at 14:15Z: 2 sessions of 1 h 13 min and 6 h 14 min, 112 nudges, 0 corrections, 0 deaths, 0 idle kicks; reconnected in 1 s after the signalling service shut down (code 1001) and in 9 s after a deliberate kick. 1.7 partly done: idle kick defeated with the 240 s nudge (raw threshold not measured by choice), reconnect across a service restart and a kick verified; still to observe during the 7-day gate (counted from 2026-10-29 06:42Z): your client joining and leaving, a Realm restart, a game update.*

| # | Task | Done when |
|---|---|---|
| 1.1 | Reconnect with exponential backoff and jitter; log every `kick` / `disconnect` reason to a file | e2e: `docker restart` while connected; bot is back within 60 s; the log line is asserted |
| 1.2 | Chat: parse `text` (chat, json rawtext, announcement); commands `!status`, `!pos`, `!quit`; owner allow-list by name or XUID | e2e: `say !status` from the console produces a reply packet |
| 1.3 | Keepalive: tiny look or sneak toggle every 4 min via `player_auth_input`, configurable | 30 min soak on BDS with `player-idle-timeout=5`: not kicked |
| 1.4 | NetherNet profile (`compose.dev-nethernet.yml`) and the same e2e suite on it | the Phase 1 e2e suite passes on both transports |
| 1.5 | Fork + version-bump playbook: fork bedrock-protocol, pin to a commit after PR #839; `tools/bump-version.mjs` fetches minecraft-data master's `bedrock/<ver>/protocol.json`, patches the `minecraft-data` package (`data.js`, `dataPaths.json`, `protocolVersions.json`) or uses a pnpm patch, bumps `CURRENT_VERSION`, runs the fixture replay tests, then runs the e2e suite against a BDS of that version (spike E, scripted) | CI job: playbook takes the repo from 1.26.51 to 1.26.60 and the e2e suite passes against BDS 1.26.60.6 |
| 1.6 | **Realm join (gate)**: `--target realm` profile using `realms.pickRealm`, device-code sign-in done by you, `profilesFolder` outside the repo; packet recorder on; log every kick reason | manual: bot joins your Realm, answers `!status`, stays 24 h; `docs/runbook.md` records the exact commit and game version |
| 1.7 | Realm hardening: measure the real idle kick once (let it happen, read the reason), tune keepalive, reconnect across Realm restarts, your client joining and leaving, and a game update (use the playbook) | 7 consecutive days on the Realm with downtime only during a game update, metrics file complete |

### Phase 2: World model (prerequisite: Phase 0)

| # | Task | Done when |
|---|---|---|
| 2.1 | Registry shim: `item_registry` + hashed block IDs; `version-shims/1.26.51.ts`; log unknown hashes with counts | unit: 5 known hashes resolve to names; `oak_log` round-trips |
| 2.2 | Chunk store: `level_chunk` + `subchunk_request` flow, column cache, unload by distance | e2e vs truth pack: 200 random positions within 48 blocks match `truth:block` 100 % |
| 2.3 | Block updates (`update_block`, `update_subchunk_blocks`) and block entities | e2e: `truth:set` 20 blocks, all visible within 2 ticks |
| 2.4 | Entities: `add_player`, `add_entity`, `add_item_actor`, `move_entity_delta`, `set_entity_motion`, `remove_entity` | e2e: an item from `truth:spawnitem` appears within 0.5 blocks of truth |
| 2.5 | Inventory: `inventory_content`, `inventory_slot`, `player_hotbar`, `mobequipment` | e2e: `truth:give oak_log 5` shows 5 logs in the model |
| 2.6 | `find()` with a per-chunk index for log, leaf and chest classes | unit: scanning 100 k blocks of the fixture world takes under 5 ms |

### Phase 3: Movement and pathfinding (prerequisite: Phase 2). The hard phase.

| # | Task | Done when |
|---|---|---|
| 3.1 | Input loop: 20 Hz driver, tick counter, flags builder, eye-offset position, correction handling with `handled_teleport` | e2e: the spike C scenario as a test (6-tick walk with no corrections; teleport attempt corrected) |
| 3.2 | **Spike**: bedboo physics as a dependency versus an own minimal sim (gravity 0.08, drag 0.98, air inertia 0.91, ground friction 0.6, step 0.5625, AABB 0.6 × 1.8, jump 0.42). Walk a 100-block flat line and a 1-block staircase with each | decision recorded in `docs/decisions/0003-physics.md`; chosen engine shows 0 corrections on flat ground and at most 2 on the staircase |
| 3.3 | Flat-ground walking, turning towards targets, sprint | e2e: reach 10 random points within 30 blocks on the flat world; mean corrections under 0.1 per block |
| 3.4 | Jump up 1, drop up to 3, step logic, refuse water | e2e `worlds/hill`: climb a 10-high staircase and descend a 3-block drop |
| 3.5 | A* over the block grid (costs: walk 1, jump 2, drop 1 to 3, avoid water, lava, leaves; digging off by default), incremental replanning on correction or block change | unit: 1 000 random paths on the fixture world in under 50 ms each; e2e: a 100-block goal over hills reached in under 60 s |
| 3.6 | Stuck detection and recovery (no progress for 40 ticks: replan; 3 failures: give up) | e2e: a wall placed mid-path by `truth:set`; the bot reroutes |

### Phase 4: Wood gathering (prerequisite: Phase 3)

| # | Task | Done when |
|---|---|---|
| 4.1 | Break-time table from minecraft-data hardness and tool tiers; `dig()` with block actions in `player_auth_input`; waits for `update_block` or times out at 1.5 × expected | e2e: break grass, dirt and oak_log by hand and with each axe; measured ticks within +2 of the table |
| 4.2 | Tool selection and hotbar slot switching | e2e: with a stone axe in slot 3, a log breaks in 15 ticks |
| 4.3 | Tree model: log column plus leaves detection, break from the bottom, optional pillar-up | e2e `worlds/forest`: fell 5 oak trees with no floating logs left below y + 6 |
| 4.4 | `collect()` drop pickup; inventory-full detection | e2e: after felling, inventory log count equals logs broken |
| 4.5 | Chest: open via `inventory_transaction`, move stacks via `item_stack_request`, close | e2e `worlds/chest-room`: 10 logs end in the chest per the truth pack |
| 4.6 | GatherWood state machine and the `!gather N` chat command | e2e: 64 logs in the chest in under 15 min on `worlds/forest`, unattended |

### Phase 5: Hardening (prerequisite: Phase 4)

*2026-10-29: 5.1 to 5.5 done on BDS 1.26.60.6 (commit 4725481): respawn + home return 4.7 to 7 s after a kill; shelter reached in under 4.2 s (an open doorway is not mob-safe); update notifier live-checked; health endpoint; config file outside the repo; quick start from a fresh copy in 2 min. 8 h soak on bds-soak passed 2026-10-29 (05:10 to 13:10Z, 119 nudges, 0 corrections, 0 deaths, 0 reconnects, clean exit, metrics.json complete). Respawn, home return and reconnect also verified on the Realm the same day (Phase 1 note).*

| # | Task | Done when |
|---|---|---|
| 5.1 | Death and respawn (`respawn` states, `set_health`), return to the chest | e2e: `truth:kill`; bot respawns and resumes |
| 5.2 | Night safety: retreat to a marked shelter at dusk, resume at dawn (`set_time` tracking) | e2e with `truth:time night`: bot is inside the shelter within 60 s |
| 5.3 | Version gate and update notifier (daily `npm view` plus the BDS links API; log or ping when a new game version appears) | unit: the gate refuses a fake `outdated_client` server; manual: notifier fires |
| 5.4 | Health endpoint and metrics (uptime, corrections per minute, logs per hour, reconnects) | 8 h soak on BDS; metrics file complete; no crash |
| 5.5 | Config file and secrets outside the repo; README runbook | manual: fresh clone to a running AFK bot in under 15 min following the runbook |

### Phase 6: RL environment (prerequisites: Phase 4 and task 5.3)

*2026-10-29: 6.1 to 6.3 (single env) done, commit 1ca228a. **Frozen here by decision** (section 10, question 10): a trained policy would be brittle to terrain and give none of the behaviours that make the bot useful on the Realm. The env stays as an optional lab; 6.3 multi-env, 6.4, 6.5 and 6.6 are not planned. Phase 7 replaces them.*

| # | Task | Done when |
|---|---|---|
| 6.1 | `rl:reset` in the truth pack: place a `.mcstructure`, clear inventory, teleport, set time and weather, return the seed | e2e: 20 consecutive resets each under 2 s with identical block checksums |
| 6.2 | Bridge (`bot/src/bridge`): WebSocket server, zod schema, `RlAgentTask` executing high-level actions, observation builder | contract test: a Python client script runs 100 random steps |
| 6.3 | `rl/` Gymnasium env (`BedrockWoodEnv-v0`), `check_env` passes, `SubprocVecEnv` of N envs each on its own BDS port (compose `rl-N` profile); measure steps/s, RAM and CPU per instance | `check_env` green; 8 envs × 200 steps complete; numbers recorded in `rl/results/throughput.json` |
| 6.4 | Scripted baseline evaluator: run `GatherWoodTask` on the same scenarios; record logs per 2 400 ticks and ticks to 16 logs | `rl/results/baseline.json` |
| 6.5 | PPO on "break the nearest log" (high-level actions), 8 envs, 1 M steps; then "gather 8 logs" | learning curve beats a random policy by more than 3 × on logs per episode; report versus baseline |
| 6.6 | Optional: SimulatedPlayer backend for the same env for fast reward and observation iteration | the contract test passes with the alternate backend |

### Phase 7: Usability, Baritone-style (prerequisite: Phase 5; replaces 6.4 to 6.6)

*Decision 2026-10-29: hand-written skills instead of RL. Model: Baritone (A* where every move costs ticks, breaking and placing are part of the moves, nothing is a one-way trap, segments planned ahead, per-move stuck timeouts, goals composed around entities). **No PvP, ever.** PvE yes, so the Realm can run on normal difficulty with the bot alive. Root cause of "walks into caves": drops of up to 3 blocks cost 1 per block while climbing more than 1.25 blocks is impossible and there is no surface preference, so downhill holes are the cheapest route and have no way back.*

| # | Task | Done when |
|---|---|---|
| 7.1 | Navigation v2: tick-based move costs from the physics (walk, sprint, jump, fall), a sky-access / underground penalty and an irreversible-drop penalty so routes stay on the surface, segment planning with plan-ahead (no 250 ms stall; unloaded chunks end a segment instead of failing), per-move stuck timeouts from the move's own cost estimate, retreat to the last safe node after a failed segment | e2e on bds-move: hill with a cave mouth on the straight line (path never below the surface), 3-deep pit on the line (never entered), 200-block cross-country goto with 0 corrections and no stall over 100 ms per tick; nav-sim unit tests for each rule |
| 7.2 | Dig-through and pillar-up moves: `digCost` from block hardness and the held tool, Baritone's safety rules (never break a block next to lava or water, under gravel or sand, or the block under the feet except on purpose), pillar-up by placing a throwaway block under the feet while jumping; both behind injected actions (`dig`, `place`) and off by default (`allowBreak`, `allowPlace`, `throwawayItems`) | e2e: 1-block wall crossed by digging when allowed and walked around when not; 4-block cliff climbed by pillaring with cobblestone in the hotbar; a goto that ends in a 3-deep pit gets out by pillaring |
| 7.3 | Interaction skills: `place(pos, face, item)` through `inventory_transaction` item_use (truth-verified), `useBlock(pos)` for doors, fence gates, trapdoors, buttons and levers; the planner treats closed doors and gates as passable with an open action and closes them behind when `closeDoors` is set; neighbour-aware fence and wall collision shapes | e2e: 16 blocks placed where asked, a 3-high pillar built under the feet, a door and a gate walked through (opened, closed behind), a fence line never collided with |
| 7.4 | PvE: hostile classification from `entity_type`, target selection (nearest hostile within `guardRadius`, prefer whoever hit us after a `set_health` drop), approach with a `near` goal, attack through `inventory_transaction` item_use_on_entity on a 10-tick cadence while facing the target, best weapon from the hotbar, retreat home or to the shelter under `fleeHealth`; guard mode (kill hostiles within N blocks of home, then resume what was interrupted); pick up the drops afterwards | e2e on a normal-difficulty server: 3 summoned zombies killed without dying; a skeleton killed; a full night at home survived with guard on; flee triggers at low health |
| 7.5 | Follow and come: `near` goal on a tracked player or entity, recomputed when the target moves more than 2 blocks, sprint to catch up, stop within 3 blocks, survives the target leaving view (last known position, then wait) | e2e: follows a summoned mob for 100 blocks staying within 4 blocks; `!come` reaches the caller within 60 s |
| 7.6 | One bot, every command on the hardened AFK task: `!follow <name>`, `!come`, `!stop`, `!guard on\|off\|<radius>`, `!kill <type> [n]`, `!gather N [x y z]` folded in with `--chest`, `!mine <block> N`; `!status` names the active behaviour; guard and night shelter cooperate | e2e: each command from chat on bds-hard; Realm checklist run by you on normal difficulty |
| 7.7 | Movement variety, per item: swimming, ladders and vines, diagonal ascend / descend, sprint-jump, parkour gaps, sneaking at edges, scaffolding, water-bucket fall save | per item, 0 corrections on its course |

*2026-10-29, after wave 5 (7.1 to 7.6 landed): the backlog below comes from your Baritone list, in the order worth building. Already in place and not repeated: the hazard list in `terrain/classify.ts` (lava, fire, magma, campfires, cactus, sweet berry bush, wither rose, cobweb, powder snow, dripstone, portals), fall-damage-aware drops (max 3 blocks), reach checks for dig / place / attack with the measured server limits, the right tool per block in the Digger, and moving tools from the inventory to the hotbar. A planner worker thread is not needed yet: v2 slices the search and measured at most 9.9 ms per tick on the 200-block course; revisit only if a cache-backed long search breaks that.*

*2026-10-29, wave 6 landed (commits 07b5f0b survival kit, cff1a91 process manager + settings, d2958f1 goals / blacklist / waypoints, ce8faa4 world cache + debug map, 4d83d74 farming + legit mining): 7.8 to 7.15 done on BDS 1.26.60.6. Measured: zombie hits 3.0 -> 1.38 health with full iron armour; eating 2.5 s from the main inventory; guard pre-empts a gather in 61 ms and the gather resumes in about 4 s; a 300-block plan into cached, unloaded terrain in 32 to 88 ms; a 9 by 9 wheat field cycled in 72 s with 0 trampling; 8 exposed coal ore mined, 4 buried ones never targeted. Decisions taken at merge: night outranks user commands once a shelter is set; a new command cancels a pending home return; the survival kit shares the afk task's Containers. Open from the agents: eating while walking is avoided (no slowdown in the client physics), flee does not use the runAway goal yet, the gather task does not yet walk to cached (remembered) forests, PlaceSkill occasionally gets `rejected` right after a harvest (the farmer retries), the ore memory is RAM-only, pickaxes in the main inventory are not used by the Digger, the night e2e stays opt-in until re-measured with armour and food.*

*2026-10-29, wave 7 (survival first) partly landed: 7.18 natural-language front end (4620328, `!do` / `!yes` / `!no`, Ollama provider behind an interface, fake provider in tests), 7.16 food gathering (844aaae, `!food`, `!cook`, furnace slots 0 input / 1 fuel / 2 output verified, auto chore at priority 30, `autoFood` off on the Realm bot until the owner enables it), combat that keeps the bot alive (bf898af: reachability-aware targeting, flying mobs only within reach, creeper hit-and-run with 25 of 25 duels unharmed, creeper fuse lights at 2.8 to 3.3 blocks and goes out at 6.7 to 7.3, explosion 31 ticks after the trigger, archers rushed, weapon and pickaxe pulled from the main inventory). Same day fixes from the Realm: extinguished campfires walkable (9430f97), README command reference, `!drop all` / `!drop items`, interrupted walks stay quiet. Realm facts: 8 deaths on 2026-10-29 before the fixes (arrows, creepers, melee, 2 by a player); phantoms every night until the bot sleeps; the owner's house is reached by a staircase (96 62 -45 to 99 64 -45, door 101 64 -46, home 100 64 -50) that the planner could not climb. Still running: flee v2 + trip readiness + sleep (W), farm / mine on the process manager with `mineSeenOnly` default false (Z, owner decision: digging for unseen ore is fine on their own Realm), stairs and partial blocks (AA). Open after this wave: a stash step (shulker box or ender chest) when the inventory fills during mining, gathering and food runs; breeding; chores beyond 48 blocks; a protocol bump when the Realm moves to 1.26.61.*

*2026-10-30, wave 7 fully landed: V combat (bf898af), AA stairs and partial blocks (dc0e2d0: 1.26.60 stairs carry a new `minecraft:corner` state the registry did not know, so every staircase was a wall; stairs are walked, not jumped, cost 1 tick; the owner's staircase is climbed in one plan with 0 corrections on the Realm), Z farm and mine as processes with ore memory and remembered forests (a7d0d1e, `mineSeenOnly` off: digging for unseen ore), W survival policy (841ef74: flee v2 runs away to 16 blocks first and goes home only when the threat is not in the way, hysteresis to fleeHealth + 6 for 60 s, a lone melee mob is duelled when the bot can take 3 more hits, hand-steered sprint before the first plan; trip readiness eats and equips before walks over 16 blocks, night without a chestplate refused unless `now`; `!sleep` and auto-sleep in a bed, verified: sleep window [12542, 23459), refusals noSleep / notSafe / obstructed / tooFar, asleep = player_flags 2, wake = animate wake_up; the locator bar tracks players beyond about 75 blocks; gauntlet 15 of 15 runs alive on bds-gaunt). Wave 8 started the same night: AE LAN control panel (620a1b4, docs/panel.md; on the Mac bound to the Tailscale address with a token), AC block registry from a BDS palette dump (3c7b2b8, 0 unknown runtime ids on 1.26.60, re-dump per BDS build); still running: AB planner worker thread, AD `!get` + stash, AF food v2.*

*2026-10-30, wave 8 landed (9cb3d49): AB planner in a worker thread (500 000 nodes / 2 s main plans, interim answers spliced in, `plannerThreads` 0 for the old in-thread planning; a 262-block route behind walls that was `unreachable` in-thread is one plan; physics tick max 1 to 6 ms while planning, forwarding about 20 MB per worker start at 55 ms of main-thread time), AC block registry from a BDS palette dump (`bot/data/block-palette/1.26.60.json`, 1480 types / 23 941 network states, 0 unknown runtime ids on the Realm; re-dump per BDS build with `node tools/bump-version/dump-palette.mjs --profile reg`), AD `!get <item> [n]` as the one front door (catalog -> gather / mine / food / kill / farm) and the stash step (chest from `stashChest`, else the emptiest carried shulker box placed, filled through slot type `shulker`, broken and picked up with its contents, else junk only dropped with 16 throwaway blocks kept; the job ends `inventory full` otherwise), AE LAN control panel (on the Mac bound to the Tailscale address with a token), AF food v2 (herd marks in `herds.json` up to 200 blocks, pen detection spares farm animals unless `chorePen` or `!food n pen`, `!breed`, `autoBreed` chore; feeding = inventory_transaction item_use_on_entity interact, calf 3 s after the second feed). Merge fixes: one text setting kind (block positions floor decimals), the flee cooldown no longer blocks a hard trigger with the threat within 6 blocks away from home (gaunt-flee ring 2 fought in place for 5 s at 7 health). Open: unpacking full boxes at home, `!explore` / branch mining when no ore is known, collect gives up on drops in 1-wide tunnel holes under load (get-stash once lost 4 coal), `!breed` not in the NL schema, poplar doors use the generic door shape, fence arms not from the connection states, in-thread budgets unchanged with `plannerThreads 0`, 1.26.61 palette and protocol when the Realm moves.*

*2026-10-30, wave 9 landed (edd6c63): AK small fixes (palette door / fence shapes, `!goto now`, NL breed / drop / panel, sleeping pose slot), AM UX (front door `!help` in at most 4 messages, `!help all` / `<command>` / `settings`, `!mode careful|normal|bold`, welcome whisper per version, NL `answer` step, hints, panel Help tab), AL builder (`!build fill/clear/replace/wall/floor/pillar/file`, 80 blocks/min placing, 40 clearing, scaffolds, `.mcstructure` + JSON layers), AG home logistics (chest memory in chests.json, `!unload` decision table, spare shulker boxes, `!stock`, `!chests`, barrel slot type 58), AN containers by walking distance (probe plans, `homeChestWalk`, unreachable memory, `!chests unreachable`), AH combat v3 (re-targeting in reach: 1 vs 6 hits when a second mob comes from behind, 14 vs 9 side by side; crowd rule; shield = sneak, offhand placement needs the inventory screen), AJ movement variety (swim 8.6 ticks/block, ladders and vines 5, 1- and 2-block gaps 20/20, edge sneak), AI `!explore` (cells by cache gain) and branch mining (staircase to the ore level, 16-long branches every 3; seed 7: 4.4 iron per 100 tunnel blocks at Y 16), AO guard targets must be path-reachable (a zombie behind glass cost a 60 s fight on the Realm; now a 300 ms probe, 30 s ignore, `guardWhileWalking near`; gauntlet 5/5 in 80 s mean vs 117), AP panel inventory and statuses. Realm-driven hotfixes the same night: item frames passable (the planner saw chest-front frames as walls), chest walks to the probe's stand cell, `!drop all` sheds armour and offhand, `!chests clear`, protectRadius 48 + built blocks never dug + digPenalty 60 after `!mine` dug through the owner's house, empty / full box sorting. Open: `!bring <item>` (stored items to the player), Elytra / Nether / End wave, underwater travel, fewer kills on walks with `near`, the astar p99 benchmark flakes under agent load, 1.26.61 bump when the Realm moves.*

*2026-10-30, wave 10 landed (b19a91a), the overnight wave from the owner's Realm reports: AQ mining v3 (a cheap probe before every approach; direct tunnels planned on the world model with flat, up, diagonal-down and spiral steps under the break rules; vertical shafts with the owner's safety rules (known solid below, no liquid in the column or 1 to 2 below, no dripstone within 3 below, no gravity block above, a guaranteed way back) when they save 8 or more blocks; vein mining of the whole group with every drop; produce sweeps for mine, wood and food; several kinds per trip: `!mine iron_ore 8 coal_ore 16`, `!get ores 32`; measured: an ore 4 under the floor in 10.6 s where it was unreachable, 7-block diamond vein 9 s and 7/7 drops, three ores in one trip 106 blocks walked vs 152 for three jobs), AR interactive panel (menus on cells, map and settings through chat commands, `!select`, `!offhand`, map canvas), AS `!bring <item> [n] [to <player>|home]` (stored items by the chest memory to the owner; `!get` hints at the stock and still makes new ones), AT dimensions (the client must answer the server's dimension_change_ack or every input is ignored; chunk / entity / grid resets; `!nether` / `!overworld` through known portals with paired waypoints; per-dimension waypoints; no night, sleep, home or surface outside the overworld; lava proximity cost; fire escape; piglin rules; End drop limit). Same night: the goto timeout became a no-progress budget (a 1400-block walk had timed out after 1120 blocks), the collector reaches drops from any cell the pickup reach covers and the hole walk clears two blocks of head room (diamonds and coal had been left in holes), `!drop all` sheds armour and offhand, `protectRadius` 48 and built blocks never dug after `!mine` went through the owner's house, `digPenalty` 60, item frames passable, chest walks to the probe's stand cell, box sorting by fullness. Open after wave 10: Elytra flight (a Fable-grade physics track; glide flags unverified), crafting from the panel (packets unverified), a hand-over step at the end of `!bring`, underwater travel, portal building, `guardWhileWalking near` leaves distant skeletons alone, the astar p99 benchmark flakes under agent load, 1.26.61 when the Realm moves.*

*2026-10-30, wave 11 landing in parts (through 09e8e61 so far), from the owner's Realm session: AU Elytra flight (`!fly` / `!land`, glide needs the `start_gliding` input flag plus a jump press, FlightProcess above flee, the fireworks shulker never given away, autoFly for `!goto` / `!come` over `flyMin`; decision 0042), the Baritone port under LGPL in `nav/baritone/` and `mine/baritone/` (BA partial-path bests `h + g/k`, BB one rule set for stand / walk-through / break ported from MovementHelper, BE the executor's off-path / overrun checks, BC the moves that dig: traverse, ascend, descend, dig-down, pillar with breaks over our costs and the owner's rules, plus the sneak-through move for 1.5-high gaps; decision 0043), AW crafting on BDS (ItemStackRequest `craft_recipe`, 2x2 and table, give-back and drop paths; `!unload` compacts raw ore into blocks when a chest is full; decision 0045), AV boxing (`bot_loot` keep-boxes, full chests boxed into spare shulkers, produce-first packing and one re-pack; decision 0044), `!get` caps 9216 for mining, job drops swept (sand), the lost mine job (pause during a sweep), the chest-hole and dirt-path doorway planner off-by-one. In flight: AU2 Elytra v2 (roof refusal, rocket economy, descent circles, fly-then-walk, `!fly` to tier `more`), BD MineProcess (`mineMode baritone`, "mine until n" as one job). Open after wave 11: follower aim runaway, `!stop` in the air leaves the chestplate off, `allowGravityAbove` needs landed falling blocks in the model, 1.26.61.*

*2026-10-31, chat style (decision 0050, docs/chat-style.md): the long-list replies (`!help`, `!set`) were one packed blob per message. `bot/src/chat/style.ts` is now the one place that builds `§` codes (tones, `colorize` for one-liners, `Doc` for multi-line blocks packed to 440 characters), `help-rich.ts` generates the help and settings blocks from the registered metadata (`SETTING_GROUPS` covers every setting, guarded), `!colors` shows the client what to expect, and `chatColor` / `chatLines` / `chatVia` (all off in code) switch it on. `chatVia me | say | tellraw` sends replies as `/me` (`* Bot text`, no operator needed), `/say` (`[Bot] text`) or `/tellraw @a` (no prefix) with a fallback to chat on a refusal and a retest on a switch, a restart and `!colors`; titled blocks are framed with `====` rules and page numbers. Measured on BDS 1.26.60.6: `§` and newlines relayed, **limits are UTF-8 bytes** (a `§` is 2): chat 503 relayed / 515 dropped silently, a command 505 delivered / 511 disconnects; a non-operator's `/tellraw @a` and `/say` are refused, `/me` works; `@a` in `/me` and `/say` is expanded. Open: the Realm's operator status and how the owner's client draws it (`!colors`), converting `!inv`, `!stock`, `!chests`, `!wp`, `!status`.*

| # | Task | Done when |
|---|---|---|
| 7.8 | **Process manager**: one active process at a time (goto, follow, guard, flee, night, gather, mine, farm, build), priorities, pre-emption and resume, replacing the ad hoc guard / night cooperation; `!pause`, `!resume`, a real `!stop`; `!status` shows the process stack and an ETA | unit: a scripted pre-emption scenario; e2e: guard interrupts a gather and the gather resumes where it was |
| 7.9 | **Runtime settings**: `!set <key> <value>` and `!set` (list), persisted to a settings file in the config dir and loaded on start; covers the planner flags (`allowBreak`, `allowPlace`, `closeDoors`, avoid radii), combat (`guardRadius`, `fleeHealth`), keepalive, follow distance | unit + chat e2e; a changed setting survives a restart |
| 7.10 | **Goals, blacklist, waypoints**: composite "any of" goals (nearest of 10 logs), get-to-block (stand adjacent, for interaction), Y-level, run-away-from (flee uses it), surface (`!top`); a blacklist of goals and blocks that failed N times; named waypoints plus automatic ones for death, bed and home, `!wp set|list|del`, `!goto <waypoint>` | e2e: `!goto` a waypoint; an unreachable log is skipped after 3 failures instead of looping |
| 7.11 | **Survival kit**: eat when food is below 18 or health is low (best food in the inventory), equip the best armour from the inventory, avoid nearly broken tools, keep throwaway blocks stocked, drop junk when full; mob and spawner avoidance radii as planner cost | e2e on bds-surv: a starving bot eats; armour is worn; a path bends around a spawner and a boxed zombie |
| 7.12 | **Persistent world cache**: compressed per-chunk summary (air / solid / water / avoid, column tops) on disk per server, used by the planner beyond the loaded area and by the finders (trees, chests) across restarts | e2e: goto 300 blocks into cached but unloaded terrain; the forest is remembered after a restart |
| 7.13 | **Farming**: harvest mature crops, replant, bone meal, collect, `!farm [radius]` | e2e: a 9 by 9 wheat field cycled twice |
| 7.14 | **Legit mining**: `!mine <block> N` targets only blocks the bot has seen (exposed faces), tunnels legitimately, uses the world cache for ore memory | e2e: 8 coal ore in a cave wall mined, buried ore ignored |
| 7.15 | **Debug map**: a page on the health endpoint with a top-down map of cached chunks, the planned path, entities and the bot; ETA in `!status` | manual; used by agents when debugging navigation |
| 7.16 | **Food gathering**: kill passive mobs or harvest, cook if a furnace is at home | e2e done 2026-10-29 (844aaae) |
| 7.17 | Later: `!tunnel`, `!explore`, builder (fill, clear, replace, `.mcstructure` layer by layer with material lists), Nether and End (dimension change, portals, nether hazards), Elytra flight and mending repair by XP. Elytra flight: wave 11 Track AU (`!fly`, `!land`, autoFly for `!come` / `!goto`, the flight kit; docs/flight.md, decision 0042); mending by XP still open | per item |
| 7.18 | **Natural-language front end** (after 7.8 and 7.10): `!do <text>` and owner chat addressed to the bot are translated by a local model (Ollama on the Mac, provider behind an interface) into a validated plan of existing commands via schema-constrained JSON output (zod), with the bot status, waypoints and command reference in the prompt; the bot replies with the plan and runs it on a yes; the model never controls movement, only picks commands; owners only, whitelist only | e2e with a fake provider: 20 phrasings map to the right plans, 3 ambiguous ones produce a question; manual with Ollama on the server done 2026-10-29 (4620328) |

---

## 6. Testing strategy

- **Ground truth via the truth pack** (stable Script API only, no experiments, so it loads on any BDS world): `truth:block`, `truth:pos`, `truth:inv`, `truth:set` / `fill`, `truth:tp`, `truth:give` / `clear`, `truth:time`, `truth:kill`, `truth:spawnitem`, `truth:checksum x1 y1 z1 x2 y2 z2`. Every e2e test asserts bot state against these. Replies are rawtext JSON over `text`; one helper parses them.
- **Saved worlds and structures**: `worlds/flat`, `forest`, `hill`, `cave`, `chest-room` as `.mcstructure` files placed by `truth:place` or `rl:reset` into the flat world, so every test starts from identical blocks without copying world folders. Keep one `.mcworld` with Beta APIs enabled for `packs/lab`.
- **Packet recording and replay**: `PacketRecorder` writes jsonl (direction, tick, name, params with BigInt as strings). `fixtures/<version>/` holds login, chunk and movement captures. Unit tests feed them through the deserializer and the world model; this doubles as the breaking-change detector for new library versions.
- **Unit tests**: pathfinder costs and heuristics, break-time table, chunk decode, flag builder, schema validation.
- **e2e tests** (vitest, tag `@bds`): spin up compose, run, tear down; both transports weekly.
- **Soak runs**: 30 min after Phase 1, 8 h after Phase 5, overnight before any Realm deployment, with metrics exported.
- **Realm**: manual checklist only, never automated; join only versions that passed the BDS soak.

---

## 7. Version and update strategy

| What | Pin | Why |
|---|---|---|
| BDS | exact build (`1.26.60.6` now; `1.26.51.1` kept as the rollback server `bds-dev51`) in compose; never `LATEST` | must equal the bot's default game version (bedrock-protocol plus the minecraft-data patch) |
| bedrock-protocol, minecraft-data, prismarine-* | exact versions, lockfile committed; bedrock-protocol may be a git commit pin when a fix is needed (Realms #839) | upgrade as one set |
| `@minecraft/server` | the stable version shipped with the pinned BDS (`2.10.0`, loads on 1.26.51.1 and 1.26.60.6) | truth pack must load without experiments |
| Docker image | `itzg/minecraft-bedrock-server:2026.10.2` | entrypoint defaults changed recently (NetherNet) |
| Node | 24 LTS, `.nvmrc` | raknet-native prebuilds |

Detecting a breaking update: (1) a daily job logs `npm view bedrock-protocol version` and the BDS links API; (2) the bot's version gate refuses to join when the server protocol is unknown and reports it; (3) fixture replay tests fail on schema changes. Upgrading: bump the set on a branch, pull the new BDS, re-record fixtures, run unit and e2e on both transports, 30 min soak, merge, and only then use it on the Realm. Keep the previous BDS zip cached (itzg `VERSION=PREVIOUS` also works) to bisect.

2026-10-28: the default game version moved from 1.26.51 to 1.26.60 (BDS 1.26.60.6) as one set (docs/versions.md); 1.26.51 stays runnable as the rollback (`BOT_VERSION=1.26.51`, `pnpm e2e:51` against `bds-dev51`).

---

## 8. Risks (likelihood × impact, each 1 to 5)

| Risk | L | I | Score | Mitigation | Early spike |
|---|---|---|---|---|---|
| Physics mismatch causes constant corrections on anything but flat ground (slopes, water, leaves) | 4 | 4 | 16 | Use bedboo's engine or port prismarine-physics with Bedrock constants; treat corrections as truth; conservative paths at first (no gap jumps) | 3.2 staircase spike |
| Realm join over NetherNet via bedrock-protocol fails from your region or account setup | 3 | 5 | 15 | Pin to the master commit with PR #839 (merged, unreleased); if it still fails, debug signalling with the packet recorder and upstream the fix; BDS work continues meanwhile | 1.6, first thing: ping plus one join attempt with you signing in, as soon as 1.5 gives 1.26.60 support |
| Game updates break the bot; the Realm is always on the newest version | 5 | 2 | 10 | Own fork plus the version-bump playbook (hours for shape-only updates, verified in spike E); version gate, notifier, fixtures; send bumps upstream | done (spike E); 1.5 scripts it |
| An update changes login, auth or encryption code paths, not just packet shapes (happened in 1.26.10 and 1.26.40) | 2 | 4 | 8 | Watch bedrock-protocol issues on release day; packet recorder diff against the previous version; fix in the fork and upstream it | 1.5 playbook includes a login-stage diff |
| RL too slow at 20 TPS to learn anything in your hours | 3 | 3 | 9 | High-level actions first (each step spans many ticks), short episodes, 8 to 16 BDS, SimulatedPlayer backend for fast iteration | 6.3 throughput measurement |
| Block data stale (26.30) in minecraft-data: new blocks decode as air | 3 | 3 | 9 | Only matters for new block types; override map in the registry shim; contribute `blocks.json` upstream if it bites | 2.1 logs unknown hashes |
| Server-authoritative block breaking rejects our timing (early `predict_break`) | 3 | 3 | 9 | Follow Mojang's documented order; measure `update_block` latency; add 2 ticks of slack | 4.1 |
| Account or Realm policy action against a bot account | 2 | 4 | 8 | Separate account, own Realm only, tell co-players, no advantage, human does all sign-ins, no credentials in the repo | n/a |
| RakNet removed from BDS before the project is done | 3 | 2 | 6 | NetherNet path already verified; keep a NetherNet profile in weekly tests | done (spike NN) |
| Beta-API dependence (SimulatedPlayer, server-net) breaks between previews | 3 | 2 | 6 | Beta APIs only in `packs/lab`; the truth pack stays stable-only | done (spike D) |
| Docker Desktop NAT breaks WebRTC for many parallel NetherNet instances | 2 | 2 | 4 | RakNet for RL profiles; host networking if needed | 6.3 |
| One-off early disconnect seen in spike A | 2 | 2 | 4 | Reconnect logic covers it; keep packet logs to catch it | 1.1 |

---

## 9. RL design draft

- **Agent and actuator**: the network bot (the same code as Phases 1 to 5). Ground truth and resets come from the truth pack; observations come from the bot's own world model so what is learned transfers to the Realm.
- **Observation** (Dict, normalised): `grid` 9 × 9 × 5 block class ids around the feet (classes: air, solid, log, leaves, water, lava, item_drop, other, unknown; embed or one-hot), `self` [yaw sin and cos, on_ground, health / 20, food / 20], `nearest_log` [dx, dy, dz, dist, visible], `inventory` [logs / 64, has_axe], `last_skill_ok`. Later: a 16 × 16 × 8 grid. Never pixels.
- **Action space v1** (Discrete, high level; each runs as a Skill and returns when it finishes or after 100 ticks): `noop`, `goto_nearest_log`, `dig_facing_block`, `collect_drops`, `turn_left`, `turn_right`, `step_forward`, `jump_forward`. **v2** (task 6.5 onward): MultiDiscrete raw inputs [move in {none, forward, back, left, right}, jump, yaw delta in {−30, −10, 0, 10, 30}] at a 4-tick frame skip.
- **Reward**: +1 per log entering the inventory, −0.01 per decision step, −1 on death, +0.1 the first time a log is within reach (shaping; remove later). Reward-hacking watch: count inventory deltas only, so re-picking dropped logs does not pay.
- **Reset**: `rl:reset <scenario> <seed>` places a seeded `.mcstructure` forest (10 variants), clears inventory, gives the configured tool, teleports to the start, sets time to day and weather to clear. Target under 2 s.
- **Episode**: 200 decision steps or 2 400 ticks (2 min), whichever comes first; terminate on 16 logs.
- **Scale**: one BDS per env. Measured 350 MB idle; plan on 700 MB and half a core each with a moving player (*unverified until 6.3*). With the 30 GB WSL2 VM: 16 envs comfortably, 24 if you raise the cap; 32 threads is the other ceiling. 16 envs × 20 TPS is about 320 ticks/s, or 3 to 6 decision steps/s per env with v1 actions, so 1 M decision steps take 1 to 2 days: run overnight. The RTX 5090 is not the bottleneck; a PPO MLP is fine on CPU or GPU.
- **Baseline and success**: `GatherWoodTask` on the same 10 scenarios × 5 seeds; metrics are logs per 2 400 ticks and ticks to 16 logs. "Beats the baseline" means a higher mean logs per episode with non-overlapping 95 % confidence intervals over 50 episodes, same tool and start. Realistic expectation: v1 actions match the baseline at best (they are the baseline's own skills); the interesting result is v2 raw actions reaching a meaningful fraction of the baseline, which is a real finding for a home project.

---

## 10. Open questions for you, with recommended answers

1. **Does the Realm need to work in Phase 1?** Answered 2026-10-28: yes, the Realm is the main target. Phase 1 now ends with a 7-day Realm soak (tasks 1.6 and 1.7), and the fork playbook (1.5) exists so the bot is not hostage to upstream release timing.
2. **Pin bedrock-protocol to a master commit for the Realms fix, or wait for 3.61?** Recommended, given the Realm priority: fork now and pin to a commit after PR #839; rebase the fork on each upstream release.
3. **Use bedboo's LGPL physics engine as a dependency?** Recommended: yes, if the 3.2 spike shows it walks stairs without corrections; LGPL is fine as a dependency in a personal project. Otherwise port prismarine-physics with the Bedrock constants listed in 3.2.
4. **RakNet or NetherNet for local development?** Recommended: RakNet for speed and simpler Docker ports now, NetherNet in a weekly test run, switch when RakNet is removed.
5. **Should the RL env drive the network bot or a SimulatedPlayer?** Recommended: the network bot for anything that counts; SimulatedPlayer as an optional fast backend after 6.3 if throughput is the problem.
6. **How many hours per week, and how comfortable are you with TypeScript?** Answered 2026-10-28: well over 10 h/week, agents do most of the implementation, any language is fine. The phase tables keep their task granularity because it maps to one agent session each; the tracks paragraph in section 5 gives the parallel schedule. Keep strict TypeScript and the e2e gates: they are what lets agents work unsupervised.
7. **Raise the WSL2 memory cap?** Recommended: set `memory=48GB` in `%UserProfile%\.wslconfig` before Phase 6, leaving 14 GB for Windows.
8. **Replant saplings and repair tools?** Recommended: replant (cheap, keeps the forest), skip repair for now.
9. **When to buy the second account?** Recommended: when task 1.5 is done and the Realm's game version is supported, so the first sign-in goes straight into a join attempt. That is likely within the first two weeks.

10. **RL or hand-written skills for the useful behaviours?** Answered 2026-10-29: hand-written, Baritone-style (Phase 7). RL is frozen at 6.3 single env. PvE is in scope (the Realm goes back to normal difficulty); PvP stays out for good.

---

## 11. Prior-art links

bedboo https://github.com/LiteLDev/bedboo · prismarine-bedrock https://github.com/deepslate-bedrock/prismarine-bedrock · MineToring https://github.com/nootbook011/MineToring · oomph https://github.com/oomph-ac/oomph · dragonfly https://github.com/df-mc/dragonfly · gophertunnel https://github.com/Sandertv/gophertunnel · Geyser https://github.com/GeyserMC/Geyser · Mojang protocol docs https://mojang.github.io/bedrock-protocol-docs/ · BedrockSyntheticPlayer https://github.com/brandendm/BedrockSyntheticPlayer · Understudy / Canopy https://github.com/ForestOfLight/Canopy · BedrockDebugProxy https://github.com/NhanAZ/BedrockDebugProxy · CraftGround https://github.com/yhs0602/CraftGround · Craftium https://github.com/mikelma/craftium · itzg image https://github.com/itzg/docker-minecraft-bedrock-server · bedrock-samples releases https://github.com/Mojang/bedrock-samples/releases
