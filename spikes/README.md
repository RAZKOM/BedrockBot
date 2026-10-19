# Spikes (throwaway, 2026-10-28)

Not production code. Everything here targets BDS 1.26.51.1 (the newest version bedrock-protocol 3.60.1 supports), offline mode, flat world, Docker Desktop on Windows 11.

## Containers used

```sh
# RakNet dev server (spikes A, B, C, D) on UDP 19132
docker run -d --name bds-spike -e EULA=TRUE -e VERSION=1.26.51.1 -e TRANSPORT=raknet \
  -e ONLINE_MODE=false -e ALLOW_LIST=false -e PLAYER_IDLE_TIMEOUT=0 -e ALLOW_CHEATS=true \
  -e LEVEL_TYPE=FLAT -e LEVEL_NAME=spike -e DEFAULT_PLAYER_PERMISSION_LEVEL=operator \
  -p 19132:19132/udp -v "$(pwd -W)/bds-data:/data" itzg/minecraft-bedrock-server

# NetherNet server (spike NN) on TCP+UDP 19140, discovery on UDP 7551
docker run -d --name bds-nn -e EULA=TRUE -e VERSION=1.26.51.1 -e TRANSPORT=nethernet \
  -e ONLINE_MODE=false -e ALLOW_LIST=false -e PLAYER_IDLE_TIMEOUT=0 -e LEVEL_TYPE=FLAT -e LEVEL_NAME=nn \
  -e SERVER_PORT=19140 -e SERVER_UDP_PORTS=19140 \
  -p 19140:19140/tcp -p 19140:19140/udp -p 7551:7551/udp -v "$(pwd -W)/bds-nn:/data" itzg/minecraft-bedrock-server

docker exec bds-spike send-command say hello      # server console commands
```

Gotchas found: `allow-list=true` + `online-mode=false` makes BDS exit; the image defaults to NetherNet since 2026.10.0 so a RakNet client times out unless `TRANSPORT=raknet`; `VERSION` needs the full 4-part build number.

## Scripts

| File | Purpose | Result |
|---|---|---|
| `spikeA.js`, `spikeA2.js`, `spikeA3.js` | Spike A: connect, print chat/position, packet counts, chunk packet shapes | pass (raknet-native; jsp-raknet times out) |
| `pack/spike_pack/` | Script API pack: `/scriptevent spike:block|set|pos|ping|sim|simnav|simbreak` answering via `world.sendMessage` | loads on BDS 1.26.51 (`@minecraft/server 2.10.0`) |
| `spikeB.js`, `spikeB2.js` | Spike B: `subchunk_request` + decode with prismarine-chunk's 1.18 implementation + prismarine-registry (fed from `item_registry`), compare with truth | pass: all 5 probes match |
| `spikeC.js`, `spikeC2.js` | Spike C: respawn handshake, loading-screen acks, 20 Hz `player_auth_input`, walk 6 ticks, then an illegal 3-block jump | pass: walk accepted exactly, jump corrected |
| `editlevel.js` | Enable Beta APIs (`experiments.gametest=1`) in a BDS `level.dat` without a client | works ("Experiment(s) active: gtst") |
| `spikeD.js` | SimulatedPlayer via `@minecraft/server-gametest` beta: spawn, navigateToLocation, breakBlock | pass |
| `spikeNN.js` | bedrock-protocol NetherNet LAN join through Docker NAT | pass (spawn in 2.9 s) |
| `spike60.js` | BDS 1.26.60.6 + RakNet with a 1.26.51 client | `outdated_client` (listener alive) |
| `spikeE.js` | BDS 1.26.60.6 (container `bds60`, UDP 19134) with bedrock-protocol 3.60.1 and minecraft-data patched with master's `bedrock/1.26.60/{protocol,version}.json`, `common/protocolVersions.json`, `dataPaths.json`, plus a cloned `1.26.60` entry in `node_modules/minecraft-data/data.js` | pass: login, chunk decode, walk, corrections |

Note: `node_modules/minecraft-data` in this folder is hand-patched for 1.26.60 (see spikeE row); reinstall to get a clean 3.117.0.

Run any script with `node <file>` while the matching container is up. `bds-data/`, `bds-nn/`, `bds60/` are server data folders and are git-ignored.
