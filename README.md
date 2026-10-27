# BedrockBot

A Minecraft **Bedrock Edition** bot in TypeScript (Node 24) that joins a server as a normal network
client. It keeps an account online on a Realm, walks on its own physics and pathfinding (doors,
digging through, pillaring up), fights hostile mobs and flees when hurt, eats and wears armour, gathers
wood, farms, mines ore it has seen, remembers the world between runs, and takes chat commands from its
owners (plain commands, or natural language through a local model). Development and every automated
test run against **local Bedrock Dedicated Servers (BDS) in Docker, in offline mode**.

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
| Connection | RakNet and NetherNet, version gate, reconnect with backoff, kick log, packet recorder; Realm join with the device-code sign-in you do yourself | `bot/src/connection/`, docs/versions.md, docs/runbook.md "Realm join" |
| AFK on the Realm | 24 h stays verified, auto-reconnect, keepalive nudges, auto-respawn, home point, night shelter, health endpoint, update notifier; runs on a Mac under launchd (`deploy/mac/`) | `bot/src/tasks/afk.ts`, docs/runbook.md "Operations" |
| Movement | own Bedrock physics, A* with tick costs, surface preference, doors, dig-through and pillar-up moves, goals (nearest of, adjacent to, Y level, run away, surface), waypoints, blacklist of failed goals | `bot/src/skills/nav/`, docs/pathfinding.md, docs/waypoints.md |
| PvE | guard radius, fights with sword and knockback, creeper evasion, flee when hurt, follow / come / kill; all behaviours run on a process manager with priorities (flee > night > guard > your command > home) | `bot/src/tasks/pve.ts`, docs/pve.md, docs/processes.md |
| Survival | eats, wears the best armour, spares worn tools, keeps throwaway blocks, drops junk, avoids mobs and spawners when planning | `bot/src/skills/survival/`, docs/survival.md |
| World | chunks, block updates, entities, inventory; a persistent per-server cache the planner and finders use beyond the loaded area; `/map` on the health port | `bot/src/world/`, docs/world-model.md, docs/world-cache.md |
| Work | wood gathering, farming (harvest, replant, bone meal, chest), legit mining of ore it has seen | docs/wood.md, docs/farming.md, docs/mining.md |
| Natural language | `!do <text>` turns a sentence into a checked plan of the commands below (local Ollama; off until configured) | `bot/src/nl/`, docs/natural-language.md |
| RL | Phase 6 bridge and Gymnasium env, frozen; hand-written behaviours replaced the trained-policy plan | `bot/src/bridge/`, `rl/`, docs/rl.md |

Wave 7 (survival first) landed 2026-10-29/30: reachability-aware targeting and a creeper protocol, flee
that runs away before running home, eating and armour before long trips, sleeping in a bed, food
gathering and cooking, stairs and slabs in the planner, farm and mine on the process manager. Wave 8
in progress: planner in a worker thread, `!get` as the one front door with a stash step, food v2
(herds, pens, breeding). Landed from wave 8: the LAN control panel and a block registry that knows
every 1.26.60 block state.

## Chat commands

Owners (the `owners` list in the config file, or the BDS console) type these in chat; the prefix is `!`.
The bot answers in chat. Full reply texts and edge cases: docs/runbook.md "Chat commands".

**Where it goes**

| Command | What it does |
|---|---|
| `!come [name] [now]` | Walks to you (or the named player) and stays there, also beyond the entity range through the locator bar. Fights or flees on the way if it must. Eats first when food or health is below 14 (`coming (eating first)`); at night without a chestplate it refuses unless you add `now`. |
| `!follow [name]` | Follows you until `!stop`, sprinting to catch up, stopping 3 blocks away. |
| `!goto x y z` / `!goto <waypoint>` | Walks to a feet block or a saved waypoint. Doors are opened; digging through and pillaring up need `allowBreak` / `allowPlace` (see settings). |
| `!top` | Climbs out of a cave or pit to the nearest spot under the sky. |
| `!home` / `!home set [x y z]` / `!home go` / `!home clear` | The point it returns to after a respawn and at dawn. `set` without coordinates uses where it stands. |
| `!shelter` / `!shelter set [x y z]` / `!shelter clear` | Where it waits out the night (from time 12000 to 23000). |
| `!wp` / `!wp set <name> [x y z]` / `!wp del <name>` | Named waypoints per server; `death`, `home` and `spawn` are kept automatically. |

**Fighting and staying alive**

| Command | What it does |
|---|---|
| `!guard on` / `off` / `<radius>` / `!guard` | Fights hostile mobs within the radius of home (of itself without a home), picks up drops, walks back. |
| `!kill <type> [n]` | Kills up to n mobs of that type within 32 blocks, nearest first. Never players. |
| `!eat` | Eats the best food now. It also eats on its own when food drops below 18 or health is low. |
| `!sleep` / `!sleep on` / `off` / `status` | Goes to bed now (night only; a bed within 8 blocks of the shelter, home or itself, or the `bed` waypoint) and stays until morning. It also sleeps by itself at night when a bed is known; `!sleep off` stops that. Sleeping resets the phantom timer. |
| `!equip` | Puts on the best armour from its inventory. Also automatic. |
| `!health` | Health, food, deaths and the last death cause. |
| `!panel` | The control panel URLs (status, log, map, a command box) on the health port. |

**Work**

| Command | What it does |
|---|---|
| `!gather <n> [x y z]` / `!gather stop` | Fells trees for n logs within 48 blocks (of the given point), puts them in the configured chest or keeps them. Says `no trees within 48 blocks` when none are loaded nearby: give it a point near a forest. |
| `!mine <block> [n]` / `!mine stop` / `!mine status` | Mines ore it has actually seen the face of (no x-ray), digging its way there, e.g. `!mine coal_ore 8`. Ore next to water or lava is skipped. |
| `!farm [radius]` / `!farm stop` / `!farm status` | Harvests mature crops around it, replants, uses bone meal, deposits into the nearest chest. |
| `!inv` / `!drop <item> [n]` / `!drop all` / `!drop items` | Inventory summary; drop one item, everything, or everything except food, armour, elytra, tools and weapons. |

**Controlling what runs**

| Command | What it does |
|---|---|
| `!status` | Uptime, position, and the process stack: what runs now, what is paused behind it, with an ETA for walks. |
| `!pause` / `!resume` | Hold the current command where it stands and continue later. Guard, flee and night keep working. |
| `!stop` | Cancels every command (goto, follow, come, kill, gather, farm, mine) and a pending home return. Guard and night keep running. |
| `!set` / `!set <key>` / `!set <key> <value>` | Runtime settings, saved next to the config file and kept across restarts: `allowBreak` and `allowPlace` (digging through and pillaring up on walks, off by default), `closeDoors`, `sprint`, `guardRadius`, `fleeHealth` (flee below this health, 8), `followDistance`, `avoidMobRadius`, `avoidSpawnerRadius`, `toolWearLimit`, `throwawayMin`, `useBoneMeal`, `mineTunnelLen`, `nudgeInterval`, `nlConfirm`, `plannerThreads` (1: plan paths in a worker thread; 0: on the main thread). `!set <key> default` resets one. |
| `!do <text>` then `!yes` / `!no` | Natural language: `!do walk home then guard` is turned into a plan of the commands above by a local model, shown as one line, and run on `!yes`. Needs `nl.provider` in the config and Ollama on the machine. Also answers chat addressed to it (`BotName, come here`). |
| `!pos` / `!quit` / `!help` | Feet position; clean disconnect; the command list. |
| `!panel` | The control panel's URL(s): a web page with status, log, map, settings and a command box, for your phone or another machine on your LAN (`panel` config block; docs/panel.md). No token in chat. |

Priorities when things overlap: fleeing at low health beats everything; the night shelter beats your
commands once one is set; a guard fight beats your command only while the mob is in reach; your command
resumes afterwards; a pending home return is dropped by any new command.

## Repository layout

```
BedrockBot/
  PLAN.md                    plan, verified facts, phases, risks
  README.md                  this file
  package.json               pnpm workspace root: bds:*, bot:afk, bot:realm, config:init, update:check, deploy:mac, test, lint
  deploy/mac/                launchd agent, update script and notes for running the Realm bot on a Mac
  .nvmrc                     Node 24
  bot/                       the bot (TypeScript, ESM, Node runs .ts directly)
    src/index.ts             CLI: bot --task afk|echo|gather|rl [--target bds|realm] (docs/runbook.md "Bot")
    src/config/              config file (zod), CLI merge, config:init
    src/connection/          Connection (createClient wrapper, version gate, reconnect), Realm options and
                             guard rails, metrics, health endpoint, disconnect log, packet recorder
    src/chat/                chat parsing, owner allow-list, !commands
    src/world/               registry shim, chunk store, block updates, entities, inventory, version-shims/
    src/skills/              input loop and physics, nav (A*, goals, blacklist), dig, place, interact, combat, survival, farm, mine, collect, containers
    src/tasks/               task registry; afk (with pve, process manager, settings), echo, gather-wood, rl-agent; respawn, night
    src/nl/                  natural-language front end: providers (Ollama, fake), plan schema, executor
    src/bridge/              WebSocket server and message schema for the RL env
    src/update/              update notifier (pnpm update:check)
    test/unit/               pure logic and fixture replays (vitest project "unit")
    test/e2e/                against the Docker BDS servers, with the truth pack (BDS_E2E=1)
    scripts/                 fixture recording, e2e profile runner
  packs/truth/               behavior pack: ground truth and world control for tests (stable @minecraft/server only)
  rl/                        Python Gymnasium env, scripts, tests
  docker/                    one compose file per BDS server profile (dev, world, move, dig, wood, soak, hard, rl, nn, act, core, surv, cache, farm, pve ...); data/ is git-ignored
  scripts/bds.mjs            start, stop, restart, console, logs, truth-pack deploy per server profile
  tools/bump-version/        version-bump playbook and tooling (patch minecraft-data ahead of releases)
  tools/physics-spike/       Phase 3 physics spike
  patches/                   pnpm patch adding bedrock 1.26.60 to minecraft-data 3.117.0
  fixtures/                  recorded packet captures per game version (1.26.51, 1.26.60)
  worlds/                    test structures
  spikes/                    throwaway feasibility experiments, never imported
  docs/                      runbook, pathfinding, processes, pve, survival, waypoints, world-cache, farming, mining, natural-language, rl, decisions/ (ADRs)
```

## Tests

```sh
pnpm -r test && pnpm lint                                   # unit tests and lint
BDS_E2E=1 pnpm --filter bot test:e2e                        # e2e against the local servers (docs/runbook.md "Tests")
```
