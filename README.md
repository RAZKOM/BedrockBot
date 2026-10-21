# BedrockBot

A Minecraft **Bedrock Edition** bot in TypeScript (Node 24) that joins a server as a normal network
client: it stays online on a Realm as an AFK account, walks and digs on its own physics and
pathfinding, gathers wood, and serves as the actuator of a reinforcement-learning environment
(Python, Gymnasium) over a WebSocket bridge. Development and every automated test run against
**local Bedrock Dedicated Servers (BDS) in Docker, in offline mode**.

The plan, verified facts, phases and risks are in [PLAN.md](PLAN.md); how to run everything is in
[docs/runbook.md](docs/runbook.md).

## Ground rules

- **Local BDS only for development and tests**, `online-mode=false`, flat worlds, never a public
  server.
- **The Realm join is done by you, never by an agent or a test.** Only `--target realm` on the
  command line selects it (a config file cannot); the Microsoft sign-in is a device code you enter
  yourself; tokens live in a cache folder outside the repository, and the bot never sees a password.
  Use a separate account, your own Realm, and tell everyone who plays there.
- **No credentials, tokens or Realm details in the repository.** Settings live in a config file
  outside it (`pnpm config:init`); `bot/logs/` (packet captures with chat and names) is git-ignored.
- **Exact pins** for BDS, bedrock-protocol, minecraft-data and the Docker image; updates go through
  the version-bump playbook (`tools/bump-version/playbook.md`), never `LATEST`.

## Quick start

Node 24, `corepack enable`, Docker Desktop running, UDP 19132 free; clone into a short path.

```sh
pnpm install
pnpm bds:up                          # local BDS 1.26.60.6 on udp/19132 (first run ~2 min)
pnpm bot:afk -- --health-port 9464   # "spawned as AfkBot"; curl http://127.0.0.1:9464/healthz
```

Details, the optional config file, chat commands and troubleshooting: docs/runbook.md "Quick start".
The Realm: docs/runbook.md "Realm join (you do this)".

## Where things stand (2026-10-29)

| Area | State | Where |
|---|---|---|
| Connection | RakNet and NetherNet, version gate, reconnect with backoff, kick log, packet recorder | `bot/src/connection/`, docs/versions.md |
| AFK | keepalive nudges, chat commands, auto-respawn with death causes, home point, night shelter, health endpoint, metrics, update notifier | `bot/src/tasks/afk.ts`, docs/runbook.md "Bot", "Operations" |
| World model | chunks and subchunks, block updates, entities, inventory | `bot/src/world/`, docs/world-model.md |
| Movement | own Bedrock physics, input loop with corrections, A* pathfinding | `bot/src/skills/`, docs/movement.md, docs/pathfinding.md |
| Wood gathering | Phase 4 task `gather` (fell trees, collect logs, chest); status in the doc | `bot/src/tasks/gatherWood.ts`, docs/wood.md |
| RL | Phase 6 task `rl`: WebSocket bridge and Gymnasium env; status in the doc | `bot/src/bridge/`, `rl/`, docs/rl.md |
| Realm | code path and guard rails, unit-tested with fakes; **never joined yet** | `bot/src/connection/realm.ts` |

## Repository layout

```
BedrockBot/
  PLAN.md                    plan, verified facts, phases, risks
  README.md                  this file
  package.json               pnpm workspace root: bds:*, bot:afk, bot:realm, config:init, update:check, test, lint
  .nvmrc                     Node 24
  bot/                       the bot (TypeScript, ESM, Node runs .ts directly)
    src/index.ts             CLI: bot --task afk|echo|gather|rl [--target bds|realm] (docs/runbook.md "Bot")
    src/config/              config file (zod), CLI merge, config:init
    src/connection/          Connection (createClient wrapper, version gate, reconnect), Realm options and
                             guard rails, metrics, health endpoint, disconnect log, packet recorder
    src/chat/                chat parsing, owner allow-list, !commands
    src/world/               registry shim, chunk store, block updates, entities, inventory, version-shims/
    src/skills/              input loop and physics, pathfinder (A*), dig, collect, containers
    src/tasks/               task registry; afk, echo, gather-wood, rl-agent; shared respawn, night safety, movement stack
    src/bridge/              WebSocket server and message schema for the RL env
    src/update/              update notifier (pnpm update:check)
    test/unit/               pure logic and fixture replays (vitest project "unit")
    test/e2e/                against the Docker BDS servers, with the truth pack (BDS_E2E=1)
    scripts/                 fixture recording, e2e profile runner
  packs/truth/               behavior pack: ground truth and world control for tests (stable @minecraft/server only)
  rl/                        Python Gymnasium env, scripts, tests
  docker/                    one compose file per BDS (dev, world, move, dig, wood, soak, hard, rl, nn, dev51); data/ is git-ignored
  scripts/bds.mjs            start, stop, restart, console, logs, truth-pack deploy per server profile
  tools/bump-version/        version-bump playbook and tooling (patch minecraft-data ahead of releases)
  tools/physics-spike/       Phase 3 physics spike
  patches/                   pnpm patch adding bedrock 1.26.60 to minecraft-data 3.117.0
  fixtures/                  recorded packet captures per game version (1.26.51, 1.26.60)
  worlds/                    test structures
  spikes/                    throwaway feasibility experiments, never imported
  docs/                      runbook, versions, world model, movement, pathfinding, digging, wood, rl, decisions/ (ADRs)
```

## Tests

```sh
pnpm -r test && pnpm lint                                   # unit tests and lint
BDS_E2E=1 pnpm --filter bot test:e2e                        # e2e against the local servers (docs/runbook.md "Tests")
```
