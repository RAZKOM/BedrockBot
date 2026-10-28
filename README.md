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
The bot answers in chat. Full reply texts and edge cases: docs/runbook.md "Chat commands". In the
game, `!help` lists the front door, `!help all` every command, `!help <command>` one in depth with an
example and what the bot also does on its own (docs/ux.md).

### Front door

The nine commands an owner needs; the bot cooks, eats, wears armour, sleeps, hunts for food and makes
room in its inventory by itself.

| Command | What it does |
|---|---|
| `!come [name] [now]` | Walks to you (or the named player) and stays there, also beyond the entity range through the locator bar. Fights or flees on the way if it must. Eats first when food or health is below 14 (`coming (eating first)`); at night without a chestplate it refuses unless you add `now`. |
| `!follow [name]` | Follows you until `!stop`, sprinting to catch up, stopping 3 blocks away. |
| `!home` / `!home set [x y z]` / `!home go` / `!home clear` | The point it returns to after a respawn and at dawn. `set` without coordinates uses where it stands. |
| `!get <item> [n]` / `!get stop` / `!get status` | The one front door for work: `!get 20 oak_log`, `!get coal 4`, `!get stone 32`, `!get beef`, `!get wheat`. It picks gathering, mining, hunting or farming by itself. When the inventory fills it empties it into the `stashChest` setting, the job's chest, or a shulker box it carries (placed, filled, picked up again), then drops junk. It makes new things and never takes from your chests. |
| `!build fill x1 y1 z1 x2 y2 z2 <block>` / `clear` / `replace ... <from> <to>` / `wall x1 y z1 x2 z2 <h> <block>` / `floor` / `pillar x y z <h> <block>` / `file <name> [x y z] [90]` / `materials` / `status` / `stop` | Builds from the bot's own inventory, bottom layer first and never walling itself in; temporary scaffold blocks for what it cannot reach, removed again. `!build materials wall ...` says what is missing (`need 40 more cobblestone`); add `fetch` to get it with `!get` first. Structure files (`.mcstructure` or a JSON layer format) go in `builds/` next to the config file (docs/build.md). |
| `!unload [all]` / `!stock [item]` / `!chests [scan \| unreachable \| clear \| label x y z <text>]` | Home logistics: the bot remembers the chests, barrels and shulker boxes within `homeChestRadius` (16) of home and what is in them. `!unload` puts what it carries away (with the same item, else in a chest labelled for it, else the emptiest chest; keeps food, tools, armour, 16 blocks to build with); when the chests are full it fills a spare shulker box from the chest that holds empty ones. `!stock coal` says where the coal is, `!chests label x y z ores` names a chest. It only goes to containers it can walk to within `homeChestWalk` (32) blocks (`0`: radius only), remembers the ones it cannot reach (`!chests unreachable`), and reads at most 64 per scan. It also unloads by itself when idle at home (`autoUnload`). Wave 11 (Track AV): when the chest for an item is full it boxes that chest's stacks into a spare empty shulker box and puts the box back there; boxes you name `bot_loot` (setting `keepBoxName`) are the bot's own: kept, never stored or dropped by `!drop all`, filled first by the stash step, emptied at `!unload`; `!boxes` lists the spares and the named boxes. |
| `!bring <item> [n] [to <player>\|home]` | Brings things already stored in the chests at home to you (`!bring torch 64`, `!bring diamonds`, `!bring coal home`): what it carries counts first, then the nearest chests by what it remembers; a full shulker box comes along only when that is the only source. `!get` makes new things and never takes from chests; when the chests already hold enough, `!get` says so and names `!bring` (`getSuggestsBring`). |
| `!guard on` / `off` / `<radius>` / `!guard` | Fights hostile mobs within the radius of home (of itself without a home), picks up drops, walks back. |
| `!stop` | Cancels every command (goto, follow, come, kill, gather, farm, mine) and a pending home return. Guard and night keep running. |
| `!status` | Uptime, position, and the process stack: what runs now, what is paused behind it, with an ETA for walks. |
| `!do <text>` then `!yes` / `!no` | Natural language: `!do walk home then guard` is turned into a plan of the commands above by a local model, shown as one line, and run on `!yes`; a question (`!do can you cook?`) gets a one-line answer and runs nothing. Needs `nl.provider` in the config and Ollama on the machine. Also answers chat addressed to it (`BotName, come here`). |
| `!help` / `!help all` / `!help <command>` / `!help settings` | The front door; every command by group; one command with its example and automatic behaviour; the settings with their values. `!commands` = `!help all`. |

### More

**Where it goes**

| Command | What it does |
|---|---|
| `!goto x y z` / `!goto <waypoint>` `[now]` | Walks to a feet block or a saved waypoint. Doors are opened; digging through and pillaring up need `allowBreak` / `allowPlace` (see settings). `now`: the night shelter waits for the walk, like `!come now`. |
| `!top` | Climbs out of a cave or pit to the nearest spot under the sky. |
| `!shelter` / `!shelter set [x y z]` / `!shelter clear` | Where it waits out the night (from time 12000 to 23000). |
| `!wp` / `!wp set <name> [x y z]` / `!wp del <name>` | Named waypoints per server; `death`, `home` and `spawn` are kept automatically. |

**Fighting and staying alive**

| Command | What it does |
|---|---|
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
| `!mine <block> [n]` / `!mine stop` / `!mine status` | Mines ore it has actually seen the face of (no x-ray), digging its way there, e.g. `!mine coal_ore 8`. Ore next to water or lava is skipped. With nothing known it explores (branch mining) and keeps going until n. It plans every known ore in one search (Baritone's MineProcess, `mineMode baritone`, the default; `!set mineMode v3` for the old planner; docs/mining.md "Mining v4"). <!-- Track BD --> |
| `!fly <x y z> \| <waypoint> \| <player> \| home` / `!fly stop` / `!land` (in `!help all`) | Flies there with the elytra and firework rockets and lands on the spot (a 3x3 platform high up is the design target: the approach comes in low, pulls up to bleed the speed and settles on the centre; one go-around when it misses). `!come` and `!goto` fly by themselves over `flyMin` blocks (`autoFly`): they land on the nearest landable cell near the goal and walk the rest (`flying 980 blocks to 23 blocks from ..., then walking`), and under a roof (indoors, underground) they walk to open sky first; `!fly` itself refuses under a roof (`fly: no open sky here (roof at y 72, 3 blocks up); walk outside first`). It climbs once to the height the glide needs and fires a rocket only when the glide would fall short (a 1490-block flight: 9 to 10 rockets instead of 17), comes down in a circle that fits the ground around the target when it arrives high, and keeps its flight kit (the elytra, the rockets, a shulker box of rockets) through every drop, stash and unload, refills the hotbar from the box, and asks for more when the box is empty or the elytra is nearly worn out (docs/flight.md). <!-- Track AU, AU2 --> |
| `!nether` / `!overworld` / `!portal` | Goes through the nearest nether portal it knows into the Nether and back through the paired one (it remembers both ends as the `portal` / `nether_portal` waypoints; it does not build portals). In the Nether it keeps away from lava, never stands on magma, walks out of fire, skips the night shelter and beds, and `!top` says there is no surface. `!portal` shows where it is and both portals. <!-- Track AT --> |
| `!explore [radius]` / `!explore stop` / `!explore status` | Walks the land around home (default 128 blocks, `exploreRadius`) where it has not looked yet, so it remembers ores, forests, animals and chests there. When `!mine` knows no ore of the kind, it now digs a staircase down to that ore's best depth and branch-mines (`mineBranchY`), then comes back up. <!-- Track AI --> |
| `!farm [radius]` / `!farm stop` / `!farm status` | Harvests mature crops around it, replants, uses bone meal, deposits into the nearest chest. |
| `!food [n] [pen]` / `!food status` / `!food herds` | Hunts cows, pigs, sheep, chickens and rabbits for n food items within 48 blocks, then walks to herds it remembers up to 200 blocks away; never below `foodLeave` wild adults of a kind; animals inside a fenced pen only with `pen` (or in the `chorePen` pen), never below 2 adults. <!-- Track AF --> |
| `!breed [type] [n]` | Feeds n pairs (default 1) of adult animals within 16 blocks: cows, sheep, mooshrooms wheat; pigs carrot, potato or beetroot; chickens seeds; rabbits dandelion or carrot. With `!set autoBreed on` it breeds the `chorePen` pen every 10 minutes up to 8 adults. <!-- Track AF --> |
| `!craft <item> [n]` / `!compact [kind]` | Crafts through the normal screens, as a player does: the inventory's 2x2 grid, or a crafting table (one within reach, else it places the one it carries and picks it up again; with planks it makes one). `!compact` turns raw iron / copper / gold, ingots, gems, coal, redstone and lapis into storage blocks (9 -> 1); `!unload` does that by itself when a chest cannot take the load (`compactOnUnload`). Tools, armour, food and the flight kit are never ingredients; `craftReserve` keeps counts back (docs/crafting.md). <!-- Track AW --> |
| `!inv` / `!drop <item> [n]` / `!drop all` / `!drop items` | Inventory summary; drop one item, everything (worn armour and the offhand too), or everything except food, armour, elytra, tools and weapons. |

**Controlling what runs**

| Command | What it does |
|---|---|
| `!pause` / `!resume` | Hold the current command where it stands and continue later. Guard, flee and night keep working. |
| `!mode careful` / `normal` / `bold` / `status` | Several safety settings at once (`fleeHealth`, `guardRadius`, `avoidMobRadius`, `avoidSpawnerRadius`, `allowBreak`, `allowPlace`; table in docs/ux.md); `status` says which one the settings match, or `custom`. |
| `!set` / `!set <key>` / `!set <key> <value>` | Runtime settings, saved next to the config file and kept across restarts: `allowBreak` and `allowPlace` (digging through and pillaring up on walks, off by default), `closeDoors`, `sprint`, `guardRadius`, `fleeHealth` (flee below this health, 8), `followDistance`, `avoidMobRadius`, `avoidSpawnerRadius`, `toolWearLimit`, `throwawayMin`, `useBoneMeal`, `mineTunnelLen`, `nudgeInterval`, `nlConfirm`, `plannerThreads` (1: plan paths in a worker thread; 0: on the main thread), `protectRadius` (no digging within this distance of home, 48; built blocks are never dug anywhere), `digPenalty` (ticks per dug block, 60: walking wins unless the detour is long), `stashChest` (`x y z` or `none`) and `stashShulker` (on), `autoBreed`, `chorePen`, `mineSeenOnly`, `mineMode` (`v3` or `baritone`), `autoFood`, `foodMin`, `foodLeave`. `!set <key> default` resets one. |
| `!pos` / `!quit` | Feet position; clean disconnect. |
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
