# Runbook

Everything runs against a **local BDS in Docker, offline mode**, except the Realm join, which only you
run ("Realm join (you do this)"). The default game version is 1.26.60 (BDS 1.26.60.6) since
2026-10-28 (docs/versions.md); 1.26.51 stays runnable as the rollback (`bds-dev51`,
`BOT_VERSION=1.26.51`). Commands run from the repository root unless noted.

Contents: [Quick start](#quick-start-fresh-clone-to-running-afk-bot) · [Servers](#servers) ·
[Bot](#bot) · [Tests](#tests) · [Realm join (you do this)](#realm-join-you-do-this) ·
[Operations](#operations)

## Quick start (fresh clone to running AFK bot)

Measured on 2026-10-29: the commands below took about 2 minutes on Windows 11 with warm caches, of
which BDS's first download and world creation was 110 s ("Quick-start timing" at the end of this
section); expect 5 to 10 minutes on a new machine including reading. Needs:

- **Node 24** (`.nvmrc`; `node --version` prints v24.x) and **pnpm** through corepack
  (`corepack enable` once; the repo pins pnpm 12 in `package.json`),
- **Docker Desktop** running (Linux containers),
- about 1 GB free disk (BDS download ~100 MB per server, node_modules ~400 MB),
- UDP port 19132 free on 127.0.0.1,
- a short clone path on Windows (e.g. `C:/code/BedrockBot`): pnpm's task-state files under
  `node_modules` fail beyond the 260-character path limit.

```sh
git clone <this repository> BedrockBot
cd BedrockBot
corepack enable                 # once per machine; provides the pinned pnpm
pnpm install                    # ~1 min on a fresh machine; applies patches/minecraft-data@3.117.0.patch
pnpm bds:up                     # bds-dev: BDS 1.26.60.6 on udp/19132; first run downloads BDS (~2 min)
pnpm config:init                # optional: writes %LOCALAPPDATA%\bedrockbot\config.json (~/.bedrockbot elsewhere)
pnpm bot:afk -- --health-port 9464
```

`pnpm bds:up` ends with `bds-dev: Server started (...) on udp/19132`. The bot logs
`spawned as AfkBot (runtime id 1)` within a few seconds and then a `nudge` line every 4 minutes. Check it
from a second terminal:

```sh
curl http://127.0.0.1:9464/healthz        # {"ok": true, "state": "spawned", ...}  (HTTP 200)
pnpm bds:cmd say !status                  # the bot answers in chat (visible to players; see Bot)
```

Stop with Ctrl+C (clean disconnect, exit 0). `pnpm bds:down` stops the server (the world in
`docker/data/dev` is kept).

What `pnpm config:init` writes: a commented JSON file outside the repository (it refuses a path inside
it). Edit `owners` to your gamertag so you can use chat commands; everything else has working defaults.
Values in it are overridden by command-line flags. The file never holds passwords or tokens. See
"Bot", "Configuration".

Troubleshooting: `Ping timed out` = the server is not up (`pnpm bds:up`, `pnpm bds:logs`);
`kicked: outdated_client` / exit code 3 = the bot and BDS speak different game versions (keep the
compose pin and `--version` in step, docs/versions.md); `EADDRINUSE` on the health port = pick another
`--health-port`.

### Quick-start timing

On 2026-10-29 the steps above were followed in a copy of the working tree (robocopy without
`node_modules`, `docker/data`, `.git` and the git-ignored folders, i.e. what a clone contains), with
the Docker image already pulled and the pnpm store warm. Deviations, because the real servers were
running on the same machine: the copy's `docker/compose.dev.yml` and the `dev` profile in
`scripts/bds.mjs` used container `bds-qs` on udp/19172 (19132 is bds-dev's, 19160-19167 bds-nn's), the
config file was written with `--path` to a temporary folder instead of %LOCALAPPDATA%, and its `port`
was edited to 19172 along with `owners`. A first attempt in a deeply nested temp folder failed with
`os error 3` from pnpm (`node_modules/.pnpm-task-run-state-v1/...` beyond the 260-character Windows
path limit): clone into a short path such as `C:/code/BedrockBot`.

| Step | Time |
|---|---|
| copy (stand-in for `git clone`, 6 MB) | < 1 s |
| `pnpm install` (warm store) | 7.9 s |
| `pnpm bds:up` (empty data folder: BDS 1.26.60.6 download + world creation) | 109.6 s |
| `pnpm config:init` + edit owners (scripted edit) | 0.6 s |
| `pnpm bot:afk -- --config ... --health-port 9475` to `spawned as AfkBot` | 3.0 s |
| **commands total** | **about 2 min 1 s** |

Then `/healthz` answered 200 `{"ok": true, "state": "spawned"}` and `say !status` from the console
reached the bot (`!status from console`). On a machine with a cold pnpm store and no image, add the
downloads of `pnpm install` (~1 to 2 min) and of `itzg/minecraft-bedrock-server:2026.10.2` (~1 min);
installing Node, pnpm and Docker Desktop is not included.

## Servers

Local BDS only: `itzg/minecraft-bedrock-server:2026.10.2`, BDS pinned to an exact build, RakNet (except
`bds-nn`), `ONLINE_MODE=false`, flat world, operator permissions, truth pack deployed (packs/truth).
Every test suite and long run has its own container so runs never share terrain or restarts. Each is
a `scripts/bds.mjs` profile; `--profile <name>` goes before or after the command, or
`BDS_CONTAINER=<container>` selects it (the e2e suites set it, so their `bds.mjs restart` restarts the
container under test).

| Profile | Container | Port | Compose file | BDS | Used by |
|---|---|---|---|---|---|
| `dev` (default) | bds-dev | udp/19132 | docker/compose.dev.yml | 1.26.60.6 | echo, chat, reconnect, keepalive e2e; the AFK CLI; quick start |
| `world` | bds-world | udp/19142 | docker/compose.world.yml (difficulty: image default) | 1.26.60.6 | world-* (BDS_WORLD_*) |
| `move` | bds-move | udp/19146 | docker/compose.move.yml (TICK_DISTANCE 10) | 1.26.60.6 | nav-*, skills-input (MOVE_BDS_* / PHYS_BDS_*); the nav v2 suites build in a random area per run (`MOVE_AREA=x,z` pins it, `MOVE_SEED` the course) |
| `dig` | bds-dig | udp/19148 | docker/compose.dig.yml | 1.26.60.6 | dig (DIG_BDS_*) |
| `wood` | bds-wood | udp/19150 | docker/compose.wood.yml | 1.26.60.6 | wood-* (gather-wood, Track H) |
| `soak` | bds-soak | udp/19152 | docker/compose.soak.yml (TICK_DISTANCE 10) | 1.26.60.6 | the 8 h AFK soak only (task 5.4); nothing else connects |
| `hard` | bds-hard | udp/19154 | docker/compose.hard.yml (TICK_DISTANCE 10; `BDS_HARD_DIFFICULTY`, default peaceful) | 1.26.60.6 | hard-* e2e: death/respawn, night safety (HARD_BDS_*) |
| `rl` | bds-rl | udp/19156 | docker/compose.rl.yml | 1.26.60.6 | RL bridge (Track J) |
| (no bds.mjs profile) | bds-act | udp/19158 | docker/compose.act.yml (TICK_DISTANCE 10): `docker compose -f docker/compose.act.yml up -d`, then `pnpm --filter @bedrockbot/truth-pack pack:deploy --data ../../docker/data/act --world act --restart bds-act` | 1.26.60.6 | act-* e2e: placing and using blocks, task 7.3 (ACT_BDS_*, docs/interaction.md) |
| `pve` | bds-pve | udp/19144 | docker/compose.pve.yml (TICK_DISTANCE 10; **difficulty normal**, `BDS_PVE_DIFFICULTY` overrides) | 1.26.60.6 | pve-* e2e: combat, guard, flee, follow, night (PVE_BDS_*; docs/pve.md) |
| `surv` | bds-surv | udp/19182 | docker/compose.surv.yml (TICK_DISTANCE 10; **difficulty normal**, `BDS_SURV_DIFFICULTY` overrides) | 1.26.60.6 | surv-* e2e: eating, armour, tool wear, keeper, avoidance, task 7.11 (SURV_BDS_*; docs/survival.md) |
| `core` | bds-core | udp/19180 | docker/compose.core.yml (TICK_DISTANCE 10; **difficulty normal**, `BDS_CORE_DIFFICULTY` overrides) | 1.26.60.6 | core-* e2e: process manager, runtime settings (CORE_BDS_*; docs/processes.md); also runs hard-* / pve-* as a regression check |
| `cache` | bds-cache | udp/19184 | docker/compose.cache.yml (TICK_DISTANCE 10; **generated DEFAULT world, `LEVEL_SEED` 7**, peaceful) | 1.26.60.6 | cache-* e2e: world cache and debug map, tasks 7.12 / 7.15 (CACHE_BDS_*; docs/world-cache.md). The suites set `gamerule falldamage false` and work in a random area 1 500 to 9 500 blocks out (`CACHE_AREA=x,z` pins it) |
| `farm` | bds-farm | udp/19186 | docker/compose.farm.yml (TICK_DISTANCE 10) | 1.26.60.6 | farm-*, mine-* e2e: farming and legit mining, tasks 7.13 / 7.14 (FARM_BDS_*; docs/farming.md, docs/mining.md) |
| `food` | bds-food | udp/19190 | docker/compose.food.yml (TICK_DISTANCE 10; **difficulty easy**) | 1.26.60.6 | food-* e2e: hunting, cooking, the food chore, task 7.16 (FOOD_BDS_*; docs/food.md) |
| `reg` | bds-reg | udp/19192 | docker/compose.reg.yml (peaceful) | 1.26.60.6 | world-registry e2e and the block palette dump (`node tools/bump-version/dump-palette.mjs --profile reg`), wave 8 Track AC (REG_BDS_*; docs/versions.md "Block states") |
| `gaunt` | bds-gaunt | udp/19188 | docker/compose.gaunt.yml (TICK_DISTANCE 10; **difficulty normal**, `BDS_GAUNT_DIFFICULTY` overrides) | 1.26.60.6 | gaunt-* e2e: flee v2, trip readiness, sleeping, the `!come` gauntlet; wave 7 Track W (GAUNT_BDS_*; docs/pve.md, docs/survival.md "Sleep") |
| `get` | bds-get | udp/19194 | docker/compose.get.yml (TICK_DISTANCE 10; flat, peaceful) | 1.26.60.6 | get-* e2e: `!get`, the stash step (shulker box, stash chest), wave 8 Track AD (GET_BDS_*; docs/get.md) |
| `build` | bds-build | udp/19200 | docker/compose.build.yml (TICK_DISTANCE 10; flat, peaceful; data seeded from an existing data folder) | 1.26.60.6 | build-* e2e: `!build` (fill, clear, materials, scaffolds, structure files), wave 9 Track AL (BUILD_BDS_*; docs/build.md) |
| `home` | bds-home | udp/19196 | docker/compose.home.yml (TICK_DISTANCE 10; flat, peaceful) | 1.26.60.6 | home-* e2e: chest memory, `!unload`, `!stock`, `!chests`, spare shulker boxes, wave 9 Track AG (HOME_BDS_*; docs/home.md) |
| `rl-N` | bds-rl-N | udp/19170+N | docker/compose.rl-n.yml (`N=1 docker compose -p bedrockbot-rl-1 -f docker/compose.rl-n.yml up -d`) | 1.26.60.6 | extra RL envs for SubprocVecEnv (rl/scripts/throughput.py); remove after use |

Per-track details: docs/world-model.md, docs/movement.md, docs/pathfinding.md, docs/digging.md, docs/wood.md (`--task gather`), docs/rl.md, docs/interaction.md (placing, doors), docs/waypoints.md (`!wp`, `!goto <name>`, `!top`), docs/farming.md and docs/mining.md (`!farm`, `!mine`), docs/pve.md, docs/survival.md (eating, armour, keeper, avoidance), docs/food.md (`!food`, `!cook`, the food chore), docs/get.md (`!get`, the stash step), docs/home.md (`!unload`, `!stock`, `!chests`, Track AG), docs/versions.md.
| `nn` | bds-nn | tcp+udp/19140, udp/19160-19167 (WebRTC), udp/7551 (discovery) | docker/compose.dev-nethernet.yml (NetherNet, TICK_DISTANCE 10) | 1.26.60.6 | `pnpm e2e:nn` |
| `dev51` | bds-dev51 | udp/19134 | docker/compose.dev51.yml (TICK_DISTANCE 10) | 1.26.51.1 | `pnpm e2e:51` (rollback to the previous version) |

Data folders are `docker/data/<profile>` (git-ignored; `nn` uses `docker/data/nn`). All are
peaceful except where noted. `bds-dev51` replaced `bds60` (the 1.26.60 trial server) on 2026-10-28; it
is not called `bds51` because tools/bump-version/run-bds.mjs uses that name on udp/19138.

```sh
pnpm bds:up                                 # start/recreate bds-dev, wait for "Server started." (~17 s; first run ~2 min)
pnpm bds:restart                            # docker restart bds-dev and wait (reconnect testing)
pnpm bds:down                               # stop and remove bds-dev (world kept)
pnpm bds:idle                               # print the effective player-idle-timeout
BDS_IDLE_TIMEOUT=1 pnpm bds:up              # recreate with a 1-minute idle kick (keepalive testing)
pnpm bds:cmd say !status                    # console command
pnpm bds:logs                               # follow the server log
pnpm pack:deploy                            # (re)deploy the truth pack into bds-dev, e.g. after wiping docker/data/dev
node scripts/bds.mjs --profile hard up      # any profile: up | down | restart | idle | cmd ... | logs | pack
node scripts/bds.mjs --profile hard pack    # deploy the truth pack into docker/data/hard and restart
BDS_HARD_DIFFICULTY=easy node scripts/bds.mjs --profile hard up   # recreate bds-hard on easy (mobs)
pnpm bds51:up                               # = node scripts/bds.mjs --profile dev51 up
pnpm bdsnn:up                               # = node scripts/bds.mjs --profile nn up
```

By hand: `docker compose -f docker/compose.<name>.yml up -d`, then
`pnpm --filter @bedrockbot/truth-pack pack:deploy --data ../../docker/data/<name> --world <level> --restart <container>`
(the path is relative to packs/truth). The full `BDS_E2E=1` e2e run needs every suite's server up; a
stopped one shows as "Ping timed out" in its suite.

`docker/compose.dev.yml` reads `PLAYER_IDLE_TIMEOUT` from `${BDS_IDLE_TIMEOUT:-0}` and `DIFFICULTY`
from `${BDS_DIFFICULTY:-peaceful}`; changing them makes `docker compose up -d` recreate the container,
the world in `docker/data/dev` is kept.

## Bot

```sh
pnpm bot:afk                                         # = pnpm --filter bot start -- --task afk
pnpm bot:afk -- --health-port 9464 --owner YourName  # with the health endpoint and a chat owner
pnpm --filter bot start -- --task afk --home 14,-60,-9 --shelter -30,-60,28   # walks: home and night shelter
pnpm --filter bot start -- --task afk --nudge-interval 30 --duration 300
pnpm --filter bot start -- --task echo               # print chat and position
pnpm --filter bot start -- --help                    # every option and every registered task
```

Relative paths on the command line (`--log-dir`, `--record`, `--config`, ...) are relative to the
directory you ran the command in (pnpm's `INIT_CWD`), not to `bot/`.

### Options

Every option except `--target`, `--config`, `--no-config`, `--duration`, `--exit-on-chat` and the
recording flags can also be set in the config file (next section); the flag wins.

| Option | Default | Meaning |
|---|---|---|
| `--task <name>` | `echo` | `afk` (stay online), `echo` (print chat), and whatever else is registered (`gather`, `rl`; `--help` lists them) |
| `--config <file>` / `--no-config` | see Configuration | config file to read / read none |
| `--nudge-interval <s>` | 240 | AFK keepalive: look-around + one-tick sneak toggle; 0 = never |
| `--heartbeat` | off | also send an idle `player_auth_input` every tick |
| `--home <x,y,z>` | none | feet block to walk back to after each respawn and at dawn (turns on walking) |
| `--shelter <x,y,z>` | none | night shelter: walk in at dusk (time of day 12000), leave at dawn (23000) (turns on walking) |
| `--walk` | off | walking without home/shelter, so `!home set` and `!shelter set` work |
| `--guard <radius>` | off | afk task: start with guard mode on (fight hostiles within the radius of home; `on` = radius 16); config `tasks.afk.guard` (docs/pve.md) |
| `--flee-health <h>` | 8 | afk task: below this health, with a hostile near, run to the shelter (else home); config `tasks.afk.fleeHealth` |
| `--chest <x,y,z>` | none | afk task: default chest for `!gather N` (walking only); config `tasks.afk.chest` |
| `--settings <file>` | `<config dir>/settings.json` | runtime settings file (`!set` writes it; env `BEDROCKBOT_SETTINGS`); with `--no-config` and no `--settings`: in memory only; refused inside the repository (docs/processes.md) |
| `--set <key=value>` | | a runtime setting at start-up, repeatable (`--set allowBreak=on`); wins over settings.json and config `settings` |
| `--respawn-delay <s>` | 2 | press respawn this long after dying; negative = stay on the death screen |
| `--owner <name or xuid:N>` | none | allowed to run chat commands (repeatable; env `BOT_OWNERS`; config `owners`) |
| `--no-console-owner` | | refuse commands typed into the server console |
| `--health-port <port>` | off | `GET /healthz` and `GET /metrics` on 127.0.0.1 (Operations) |
| `--update-check-hours <h>` | 24 on a Realm, else 0 | in-bot update check (Operations) |
| `--log-dir <dir>` | `bot/logs` | `disconnects.jsonl` and `metrics.json` (git-ignored) |
| `--metrics-interval <s>` | 60 | how often `metrics.json` is rewritten |
| `--no-reconnect` | | exit (code 1) instead of reconnecting |
| `--version <ver>` | `1.26.60` (env `BOT_VERSION`) | game version (through `patches/minecraft-data@3.117.0.patch`); `1.26.51` for the rollback server |
| `--host`, `--port` | 127.0.0.1, 19132 | the BDS to join |
| `--transport nethernet` | `raknet` | NetherNet with LAN signalling (local BDS); `--port` is then ignored |
| `--username <name>` | per task (`AfkBot`, `EchoBot`) | offline name |
| `--target realm` | `bds` | see "Realm join (you do this)"; only selectable on the command line |

Examples: `node src/index.ts --task echo --port 19134 --version 1.26.51` (bds-dev51, rollback),
`node src/index.ts --task echo --transport nethernet` (bds-nn), both run from `bot/`.

Exit codes: 0 on `!quit`, SIGINT/SIGTERM or `--duration`; 1 when the connection is lost for good
(or with `--no-reconnect`); 3 when the server and the bot speak different game versions (never
retried); 2 for bad arguments, a bad config or settings file, or a task option the task refuses
(one line, e.g. `error: guard radius must be 2..64, got 1` for `--guard 1`).

**Walking.** Without `--home`, `--shelter` or `--walk`, the AFK task sends its own inputs only for
nudges (as since Phase 1). With any of them it builds the movement stack (World, InputLoop, BotSkills,
the same as the nav e2e tests), the InputLoop sends one input per tick, and nudges go through it
(skipped while walking). Use walking where the terrain around the bot is simple; it has not run on the
Realm yet.

### Configuration

`--config <file>`, else env `BEDROCKBOT_CONFIG`, else `%LOCALAPPDATA%\bedrockbot\config.json` on
Windows (`~/.bedrockbot/config.json` elsewhere). A missing default file means "all defaults"; a missing
file named by `--config` or the env variable is an error. `--no-config` ignores the file (tests and the
soak use it). `pnpm config:init [--path <file>] [--force]` writes a commented example and refuses
paths inside the repository; `pnpm config:init --print` prints it.

Format: JSON with `//` and `/* */` comments, validated with zod (bot/src/config/config.ts; unknown
keys are errors, messages name the field). Relative paths in the file are relative to the file.

```jsonc
{
  "task": "afk",
  "host": "127.0.0.1", "port": 19132, "transport": "raknet",
  "realm": { "realmName": "Your Realm", "accountName": "bot", "record": true },  // used only with --target realm
  "owners": ["YourGamertag"],
  "nudgeInterval": 240, "home": [14, -60, -9], "shelter": [-30, -60, 28],
  "healthPort": 9464, "metricsInterval": 60, "updateCheckHours": 24,
  "tasks": { "gather": { } },  // free-form per-task options, read by that task
  "settings": { "allowBreak": false, "guardRadius": 16 },  // runtime settings at start-up (!set lists the keys; docs/processes.md)
  "nl": { "provider": "ollama", "url": "http://127.0.0.1:11434", "model": "qwen2.5:7b", "timeoutMs": 60000 }  // !do (docs/natural-language.md); default provider "none"
}
```

Precedence: command-line flag > config file > built-in default. Safety rules:

- `"target": "realm"` is refused in the file. Joining the Realm always takes `--target realm` on the
  command line (`pnpm bot:realm`), so neither a forgotten config nor a test run can go online.
- The Realm block holds names only (Realm name, the token-cache label, the token folder). Tokens stay
  in `realm.profilesFolder` (default `%LOCALAPPDATA%\bedrockbot\profiles`), which is refused when it
  resolves inside the repository, from the file or from the flag.
- The bot warns when it reads a config file with a Realm block from inside the repository.

### Chat commands

Typed in chat by an owner, or from the server console (`say !status`, `tell AfkBot !pos`).
Replies are player chat from the bot. Tier (Track AM, docs/ux.md): `front` commands are what `!help`
shows, `more` ones are in `!help all` / `!commands`; `!help <command>` gives the syntax, an example and
what the bot also does on its own.

| Command | Tier | Reply |
|---|---|---|
| `!status` | front | `status: up 1h02m, session 12m03s, reconnects 0, kicks 0, pos 0.50 -60.00 0.50, version 1.26.60, tick 14460, task afk, nudges 15, corrections 0, deaths 0` |
| `!pos` | more | `pos 0.50 -60.00 0.50` (feet) |
| `!health` | more | `health: health 20, food 20, deaths 1, last death.attack.generic, alive, healthy` |
| `!home [show]` / `!home set [x y z]` / `!home clear` | front | the home point (`set` without coordinates = where the bot stands); needs walking |
| `!shelter [show]` / `!shelter set [x y z]` / `!shelter clear` | more | the night shelter and its state (`day`, `going`, `sheltered`, `unreachable`, `gave_up`, `returning`); needs walking |
| `!quit` | more | `bye (quit by console)`, then a clean disconnect and exit 0 |
| `!help` | front | `front door: go: !follow (follow a player; default you), !come (...) \| work: !get (...) \| ...` (at most 3 messages, the last `more: !mode careful\|normal\|bold, !help settings, !help all, !help <command>`) |
| `!help all` / `!commands` | front / more | `all commands (35): go: follow come wp goto top; work: get gather farm mine food cook breed; ...` (every command by group, at most 4 messages) |
| `!help <command>` | front | `!cook: cook the raw food carried in ... [work, more]`, `example: !cook`, `also on its own: after every hunt ...`; `no command !x; !help all lists every command` |
| `!help settings` | front | `settings: mode normal (!mode careful\|normal\|bold); safety: fleeHealth 8, guardRadius 16, ...` (the settings by group with their values) |
| `!mode careful \| normal \| bold \| status` | more | `mode careful: fleeHealth 12, guardRadius 8, avoidMobRadius 8, avoidSpawnerRadius 16, allowBreak off, allowPlace off (was normal)`; `!mode status`: `mode careful (...)` or `mode custom (careful but fleeHealth 9 instead of 12) (...)` (docs/ux.md "Modes") |
| `!panel` | more | `panel: http://192.168.1.20:9464/ http://127.0.0.1:9464/ (token required: config panel.token)` or `panel: http://127.0.0.1:9464/ (this machine only; ...)` or `panel is off: set healthPort (or panel.port) ...`: the control panel URLs, never the token (Track AE, docs/panel.md) |
| `!follow [name]` | front | `following Steve`: follows the player (default: the sender; the console must name one) until `!stop`; needs walking |
| `!come [name] [now]` | front | `coming to Steve`, then `here (Steve)`: one walk to within 2 blocks of the player (also beyond the entity range, through the locator bar). Food or health below 14 and more than 16 blocks: `coming to Steve (eating first)`; at night without a chestplate refused unless `now` (docs/pve.md "Trip readiness"; `!follow` and `!kill` likewise) |
| `!sleep [on \| off \| status]` | more | `going to bed at x y z`, `sleeping (bed x y z)`, `good morning (slept 5 s)`: to bed now (night only; a bed within 8 of the shelter, home or the bot, or the `bed` waypoint); the bot also sleeps by itself at night (`!sleep off`); docs/survival.md "Sleep" |
| `!stop` | front | `stopped (was following Steve); guarding r=16`: stops every command (goto, follow, come, kill, gather) and what it pre-empted, plus a pending home return; guard and night keep running |
| `!pause` / `!resume` | more | `paused: walking to 10 -60 3 (!resume to continue)` / `resumed: walking to 10 -60 3`: hold the owner's commands where they are (guard, flee, night keep running), then continue |
| `!set` / `!set <key>` / `!set <key> <value\|default>` | more | runtime settings (allowBreak, allowPlace, closeDoors, sprint, guardRadius, fleeHealth, nudgeInterval, followDistance, ...): list, show one with bounds and description, change it live and save it to settings.json (`guardRadius = 8 (was 16)`); docs/processes.md. `plannerThreads` 1 (default) plans paths in a worker thread with 500 000-node / 2 s budgets, `!set plannerThreads 0` plans on the main thread as before (docs/pathfinding.md "Compute") |
| `!gather <n> [x y z]` / `!gather stop` / `!gather` | more | on the afk task with walking: gather n logs into the chest (else `--chest`, else keep them) as a command; a guard fight pauses and resumes it |
| `!guard [status]` / `on` / `off` / `<radius>` | front | `guard on, radius 16`: fight hostiles within the radius of home (of the bot without a home), pick up the drops, walk back home |
| `!kill <type> [n]` | more | `killing 3 zombie`, then `kill zombie: 3/3 done`: up to n mobs of that type within 32 blocks, nearest first. `!kill player` or any player's name: `refused: I never attack players (PvE only)` |
| `!goto <waypoint>` / `!goto x y z` `[now]` | more | `walking to base (10 -60 20)`, then `arrived at base (10 -60 20)` or `goto: unreachable`: a waypoint name first, else a feet block; needs walking (docs/waypoints.md). A trailing `now` (`walking to base (10 -60 20) now`) marks the walk urgent like `!come now`: the night process yields to it (Track AK) |
| `!wp [list]` / `!wp set <name> [x y z]` / `!wp del <name>` / `!wp <name>` | more | `waypoints (3): base 10 -60 20, death* 3 -60 -5, spawn* 0 ? 0`: this server's waypoints (`*` = automatic: `death`, `home`, `spawn`; `?` = no height known); `set` without coordinates = the bot's feet; `!wp set home` / `del home` also set / clear the home point |
| `!top` | more | `going up to the surface`, then `on the surface at 3.5 -59.0 7.5` or `top: unreachable`: out of a cave or a pit (the `surface` goal; pillars up with throwaway blocks such as cobblestone); needs walking |
| `!eat` | more | `ate bread: food 12 -> 17`: eat the best food now (`eat: no food`, `eat: not hungry (food 20)`) |
| `!equip` | more | `equip: wearing chest iron_chestplate`: the best armour from the inventory (`equip: nothing better (...)`) |
| `!inv` | more | `inv 12/36, held 0 iron_sword x1; armour head iron_helmet, ...; food 18 (best bread); throwaway 64 in hotbar; tools ...; items ...` |
| `!drop <item> [n]` / `!drop all` / `!drop items` | more | `dropped 10 stone`: n (default all) of an item; `all` empties the 36 inventory slots (worn armour stays on); `items` drops everything except food, armour, elytra, tools and weapons (anything with durability), totems, shulker boxes and ender chests, replying `dropped 120 items of 7 kinds`. The bot also eats, wears armour and drops junk by itself (docs/survival.md) |
| `!farm [radius]` / `!farm stop` / `!farm status` | more | `farming r=8 around 10 -60 3`: harvest mature crops, replant, bone meal, deposit into the nearest chest, re-check every minute until `!farm stop` or `!stop`; a user process (guard / flee / night pre-empt it, `!pause` holds it, `!status` lists it; Track Z) (docs/farming.md); needs walking |
| `!mine <block> [n]` / `!mine stop` / `!mine status` | more | `mining 8 coal_ore/deepslate_coal_ore`, then `mine coal_ore: 8/8 done` (or `no seen coal_ore left`): any ore the bot knows (loaded chunks and the world cache), tunnelling to it; with `!set mineSeenOnly on` only ore it has seen a face of (remembered across restarts); never next to lava or water; an unreachable ore is skipped after one plan; a user process like `!farm` (Track Z) (docs/mining.md); needs walking |
| `!do <text>` / `<botname>, <text>` / `@<botname> <text>` | front | `plan: goto home, then guard on (!yes to run, !no to drop)`: plain words to a plan of the commands above, made by a local model (`nl` config block, off by default; docs/natural-language.md). Unclear requests get a question (`I know no waypoint "castle" (known: home, spawn). Which one, or which x y z?`); `natural language is off (...)` without a provider |
| `!yes` / `!no` | more | run the waiting plan (within 60 s; steps one by one, each after the previous finished; `plan done (2 steps)`) / `plan dropped` (also drops the rest of a running plan). `!set nlConfirm off` runs plans without asking |
| `!food [n]` / `!food status` | more | `gathering 6 food items (cow 4+1 baby within 48; keeping 2 of each)`, then `food: 6/6 items from 2 cow; cooked 6 cooked_beef`: hunt cows, pigs, sheep, chickens, rabbits, mooshrooms within 48 blocks (adults only, never below `foodLeave` of a kind), pick up the drops, cook at the furnace near home when fuel is carried; a command (`!stop` ends it). With `autoFood` on the bot does this by itself by day when it carries fewer than `foodMin` hunger points (docs/food.md) |
| `!food [n] pen` / `!food herds` (Track AF) | more | nothing left within 48 blocks: the hunt walks to the nearest remembered herd within 200 blocks (`food: 4/4 items from 2 cow (1 walk to remembered herds)`); animals inside a fenced pen are taken only with `pen` or in the `chorePen` pen, never below 2 adults of a kind; `!food herds` lists the remembered herds (`food: 2 herd(s) remembered: 120 -60 4 (118 blocks, 3 min ago): cow 4 \| ...`) (docs/food.md "Herd memory", "Pens") |
| `!breed [type] [n]` (Track AF) | more | `breeding 1 cow pair`, then `breed: fed 1/1 cow pair, 1 baby so far`: feed n pairs (default 1, up to 8) of adults within 16 blocks with their food (cow / sheep / mooshroom wheat, pig carrot / potato / beetroot, chicken seeds, rabbit dandelion / carrot), walk out of the pen closing the gate, wait up to 10 s for the babies; `breed: no wheat for the cows (2 per pair)`, `breed: no two cows ready within 16 blocks (...)`. `!set autoBreed on` + `!set chorePen x y z`: a chore breeds that pen every 10 minutes while a kind has fewer than 8 adults (docs/food.md "Breeding") |
| `!get <item> [n]` / `!get stop` / `!get status` | front | `getting 16 oak_log: gathering wood` (then the replies of the command it runs): one front door for gather / mine / food / farm, the item decides (`wood`, `oak_log`, `coal`, `iron`, `diamonds`, `stone`, `dirt`, `sand`, `flint`, `beef`, `string`, `wheat`, ...; defaults 16 logs, 8 ore or blocks, 6 food, one round of a field); `get: I do not know how to get bread; I can get: ...` otherwise. When the inventory fills during mining, gathering or hunting the bot empties it into `stashChest`, the job's chest, or a carried shulker box (`stashShulker`), then drops junk; still full: the job ends `inventory full` (docs/get.md); needs walking |
| `!build fill\|clear\|replace\|wall\|floor\|pillar\|file ... [fetch]` / `!build materials [...]` / `!build status` / `!build stop` | front | `building fill 5x3x5 cobblestone: 75 to place`, then `build fill 5x3x5 cobblestone: done, 75 / 75 placed, 0 skipped in 56 s (80 blocks/min)`: builds from the inventory as a user process (bottom layer first, far side first, never standing in a cell it fills later; temporary scaffold blocks for cells it cannot reach or click, removed again; `buildScaffold`); the throwaway reserve is never built with; missing blocks: `build: ...; need 40 more cobblestone (add fetch to get them with !get first)`; structure files (`.mcstructure`, JSON layers) from `builds/` next to the config file (docs/build.md); needs walking |
| `!unload [all]` / `!stock [item]` / `!chests [scan | clear | label x y z <text>|none]`\| label x y z <text>]` (Track AG) | front (unload) / more | `unloading 8 stacks into 5 known containers`, then `unloaded: 128 coal -> chest 3 -60 -2, 176 cobblestone -> double chest -3 -60 -1, 32 dirt -> barrel 0 -60 -4; kept 16 cobblestone, 1 iron_pickaxe, 5 bread`: each stack goes to a chest that holds the item, else one labelled for it (`!chests label x y z ores`), else the emptiest unlabelled one; food, tools, armour, 16 throwaway blocks and one empty shulker box stay; chests full: an empty shulker box from the box chest is filled and stored there. `!stock coal` (`coal: 20 in chest 3 -60 -2`) and `!chests` answer from memory; `!chests scan` reads every container within `homeChestRadius` of home not read in the last 10 minutes. With `autoUnload` on (default) the bot unloads by itself when idle at home with more than 8 stacks (docs/home.md); needs walking |
| `!cook` | more | `cooking 4 beef`, then `cooked 4 cooked_beef in the furnace at 7 -60 3 (41 s, fuel 1 coal); food carried 32 points`: furnace or smoker within 16 blocks of home (`cook: no furnace or smoker within 16 blocks of home`, `cook: no fuel (...)`) |

`!status` names the active behaviour with walking: `behaviour idle`, `guarding r=16`, `following Steve`,
`fighting zombie`, `fleeing`, `walking to 10 -60 3`, `returning home`, `going to the shelter`,
`sheltered`, `gathering 3/8 logs`, `paused (...)`; with walking a second line shows the process stack
with ETAs: `processes: [active] walking to 10 -60 3, 31 blocks left, eta 6 s; [paused] gather 3/8 logs
(paused, 1 trees)`. PvE details: docs/pve.md; processes, priorities and settings: docs/processes.md. The afk task adds `blacklist <n>` (goals / logs / action cells the
navigator skips for now, docs/pathfinding.md "Blacklist") and `waypoints <n>` (docs/waypoints.md).

Everyone else is ignored (logged as "not an owner"). Truth-pack lines (`@truth ...`), json/system
messages and the bot's own echo are never parsed as commands.

### Death, respawn and home (task 5.1)

Every task can use the shared `RespawnController` (bot/src/tasks/respawn.ts; `ctx.respawn()` in a
TaskDefinition). It counts deaths (metrics `deaths` and `deaths.<cause>`), keeps the cause from
`death_info` (or `health_zero` when only health 0 was seen), presses respawn after `--respawn-delay`
and runs after-respawn hooks. The AFK task's hook walks back to `--home` (skipped while the night
shelter is wanted). Measured on bds-hard (`hard-respawn` e2e): respawn about 1.5 s after
`truth:kill`, back home 8 to 24 blocks away within 4 to 7 s.

### Night safety (task 5.2)

`WorldClock` (bot/src/tasks/night.ts) follows the world time; `NightSafety` walks to the shelter
when the time of day is in [12000, 23000) and the bot is more than 1 block (horizontally) from the
shelter block's centre, and back home at 23000. An unreachable shelter is logged
(`night: shelter unreachable (...); staying put, retry in 60 s`): the bot stays where the attempt
ended, retries after 60 s, at most 3 times per night, then gives up until the next dusk
(`night.unreachable` in the metrics). Measured on bds-hard (`hard-night` e2e): inside a hut 12.8 blocks
away 3.5 s after `truth:time night`; a sealed hut failed after 5.5 s (`unreachable`), with no second
attempt and no movement in the following 20 s. **On easy with zombies around**, the bot reached the
shelter in 4.4 s but the zombies followed it through the open doorway and killed it there: an open
shelter is not safe. Use a shelter the mobs cannot enter (the bot cannot open doors or place blocks
yet).

### Files

- `bot/logs/disconnects.jsonl`: one line per session end: `ts`, `username`, `server`,
  `gameVersion`, `reason`, `kind` (`kick`, `closed`, `error`, `ping`, `timeout`, `version`,
  `client`), `kick` (`{reason, message}` from the server's disconnect packet), `willReconnect`,
  `retryInMs`, `spawnedMs`.
- `bot/logs/metrics.json`: rewritten every `--metrics-interval` and on exit (Operations).
- `<config dir>/waypoints/<server id>.json` (afk task): the waypoints of one server, e.g.
  `%LOCALAPPDATA%\bedrockbot\waypoints\127.0.0.1_19132.json` or `realm-<name>.json`; in memory
  only with `--no-config` (docs/waypoints.md).

### Behaviour measured on BDS

1.26.51.1 (2026-10-28) unless noted; everything also held on 1.26.60.6.

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
- **Mobs**: on `easy` a standing AFK bot was killed at night on the flat world; bds-dev defaults to
  `DIFFICULTY=peaceful` (`BDS_DIFFICULTY` overrides). On the Realm, expect deaths: the bot presses
  respawn automatically.
- **Death and respawn (1.26.60.6, 2026-10-29)**: on death the server sends `death_info`
  (`cause: death.attack.generic`, `messages: [name]` for `kill`), `respawn` state 0 twice (at the death
  spot, then at y 32767) and `update_attributes` health 0. The handshake that works: client `respawn`
  state 2 → server `respawn` state 1 (spawn point, random within `spawnRadius` 10 of the world spawn) →
  client `respawn` state 2 and then `player_action respawn`. Sending `player_action respawn` together
  with the first state 2 (what the AFK task did before 2026-10-29) leaves the player dead on the server:
  a correction pulls the bot back to the death spot, and a later kill produces no death at all. Fixed
  in tasks/respawn.ts; any other code that presses respawn must use the same order.
- **World time (1.26.60.6)**: no `set_time` packets. The server sends `sync_world_clocks`:
  `initialize_registry` at login (clock `minecraft:overworld` with time and markers sunset 12000,
  night 13000, midnight 18000, sunrise 23000, day 1000, noon 6000), then `sync_state`
  `{clock_id, time, paused}` every 256 ticks (12.8 s) and right after `/time set`.
  `start_game.day_cycle_stop_time` holds the time at login; the `doDayLightCycle` rule arrives in
  `start_game.gamerules` and `game_rules_changed`.
- **Whispers**: `command_request` `/tell <name> <msg>` works from a non-operator offline player when
  `version` is the string `latest` and `origin.player_entity_id` is present (`'52'` is silently
  dropped); the target receives a `whisper` text packet.
- Player chat sent by the bot must use `category: 'authored'`; with `message_only` (the
  serializer default) BDS silently drops the connection.
- Relayed chat names carry a `§r` suffix (`source_name: "Steve§r"`); console `say` arrives as
  `announcement` from `Server` with message `[Server] <text>`, console `tell` as `whisper` from
  `Server`, `tellraw` as `json_whisper`, truth replies as `json`.
- `docker restart bds-dev`: BDS first sends every player `disconnect` with reason
  `host_disconnected` (empty message); the bot was back and spawned about 18 to 20 s after the
  restart started. A console `kick <name> <msg>` arrives as reason `kicked` with message
  `<msg>`; the bot is back within a few seconds.
- `disconnect()` returns before RakNet sends the packet; a process that exits right away leaves
  the session open and the next login with the same name fails. Use `disconnectAndFlush()`.
- bedrock-protocol 3.60.1 ignores the `viewDistance` createClient option; the Connection sets
  `client.viewDistance` itself (BDS answered a request of 4 with radius 5).
- Two clients that start their RakNet handshake at the same moment from one host: one of them
  sometimes times out ("Connect timed out"). Connect test clients one after another.
- NetherNet (bds-nn) and BDS 1.26.60.6: results, timings and quirks are in docs/versions.md. In
  short: everything above holds on both; NetherNet spawns about 1 s later; BDS needs one WebRTC UDP
  port per concurrent NetherNet client (`SERVER_UDP_PORTS` range), or a second client fails with
  `connecterror:9` and blocks all later joins until a restart.

## Tests

```sh
pnpm -r test                                   # unit tests (bot + truth pack)
pnpm lint
BDS_E2E=1 pnpm --filter bot test:e2e           # every e2e suite (each against its own server, see Servers)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e keepalive reconnect chat echo   # Phase 1 suites on bds-dev
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e hard                          # task 5.1/5.2 suites on bds-hard
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e act                           # task 7.3 suites on bds-act (ACT_BDS_HOST/PORT/CONTAINER, ACT_VERBOSE=1)
BDS_E2E=1 HARD_EASY=1 pnpm --filter bot exec vitest run --project e2e hard-night        # + the easy/zombie run
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e nav-                          # every nav suite on bds-move (v1 + v2, ~7 min; docs/pathfinding.md "Tests")
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e nav-goals nav-waypoints       # task 7.10: goal types, blacklist, waypoints / !top through the CLI (~2 min)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e pve                           # tasks 7.4-7.6 on bds-pve (normal; ~9 min with the night run)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e cache-                        # tasks 7.12 / 7.15 on bds-cache (world cache, debug map; ~5 min)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e farm- mine-                   # tasks 7.13 / 7.14 on bds-farm (FARM_BDS_HOST/PORT/CONTAINER, FARM_VERBOSE=1; docs/farming.md, docs/mining.md)
BDS_E2E=1 BDS_PVE_NIGHT=1 pnpm --filter bot exec vitest run --project e2e pve           # with the 5-minute night run (opt-in: flaky under load until 7.11 adds armour and food)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e surv-                         # task 7.11 on bds-surv (normal; ~2 min; docs/survival.md "Tests")
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e core --silent=false           # tasks 7.8/7.9 on bds-core: process manager, settings (~2 min; docs/processes.md)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e nl-core --silent=false        # task 7.18 on bds-core: !do / !yes / !no with a fake model (~25 s; docs/natural-language.md)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e panel-core --silent=false     # wave 8 Track AE on bds-core: the LAN control panel on a CLI bot (token, /api/state, /api/cmd, !panel; PANEL_E2E_PORT, default a random port in 9640..9649; docs/panel.md)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e ux-core --silent=false        # wave 9 Track AM on bds-core: !help formats, !mode, the welcome whisper, !do answers (docs/ux.md)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e world-registry --silent=false # wave 8 Track AC on bds-reg: 1.26.60 block states vs truth (~40 s; REG_BDS_HOST/PORT/CONTAINER; docs/versions.md)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e gaunt- --silent=false         # wave 7 Track W on bds-gaunt: flee v2, readiness, sleep, the gauntlet (GAUNT_BDS_*, GAUNT_RUNS=5, GAUNT_VERBOSE=1; docs/pve.md "Tests")
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e food- --silent=false        # task 7.16 + Track AF (herds, pens, breeding) on bds-food (easy; ~5 min; FOOD_BDS_HOST/PORT/CONTAINER, FOOD_VERBOSE=1; docs/food.md)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e food- --silent=false        # task 7.16 on bds-food (easy; ~2 min; FOOD_BDS_HOST/PORT/CONTAINER, FOOD_VERBOSE=1; docs/food.md)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e get- --silent=false         # wave 8 Track AD on bds-get: !get, the stash step (~2.5 min; GET_BDS_HOST/PORT/CONTAINER, GET_VERBOSE=1; docs/get.md)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e build- --silent=false       # wave 9 Track AL on bds-build: !build fill / clear / materials, scaffolds, .mcstructure + JSON files (~5 min; BUILD_BDS_HOST/PORT/CONTAINER, BUILD_VERBOSE=1; docs/build.md)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e home- --silent=false        # wave 9 Track AG on bds-home: chest memory, !unload, spare shulker boxes (~1.2 min; HOME_BDS_HOST/PORT/CONTAINER, HOME_VERBOSE=1; docs/home.md)
BDS_E2E=1 BDS_SOAK=1 pnpm --filter bot exec vitest run --project e2e test/e2e/keepalive.test.ts --silent=false
pnpm e2e:51                                    # whole e2e suite against bds-dev51 (BDS 1.26.51.1, game version 1.26.51: rollback)
pnpm e2e:nn                                    # whole e2e suite against bds-nn (NetherNet, 1.26.60)
FIXTURE_VERSION=1.26.51 pnpm --filter bot test # world unit tests on the 1.26.51 recordings (default 1.26.60)
cd bot && node scripts/e2e-profile.ts nn test/e2e/echo test/e2e/chat   # a subset
```

`scripts/e2e-profile.ts` points every suite (BDS_*, BDS_WORLD_*, PHYS_BDS_*, MOVE_BDS_*, DIG_BDS_*) at
one container and sets `BOT_VERSION` / `BDS_TRANSPORT` (read by `bot/test/e2e/env.ts`). Without it
each suite targets its own server at 1.26.60 over RakNet. The hard-* suites read `HARD_BDS_HOST`,
`HARD_BDS_PORT`, `HARD_BDS_CONTAINER` (default 127.0.0.1, 19154, bds-hard) and `HARD_VERBOSE=1`
prints the bot's log. The pve-* suites read `PVE_BDS_HOST`, `PVE_BDS_PORT`, `PVE_BDS_CONTAINER`
(default 127.0.0.1, 19144, bds-pve), `PVE_VERBOSE=1`, and for the night run `BDS_PVE_NIGHT=1` (opt-in),
`BDS_PVE_NIGHT_TICKS` (6000), `BDS_PVE_NIGHT_START` (16000). The surv-* suites read `SURV_BDS_HOST`,
`SURV_BDS_PORT`, `SURV_BDS_CONTAINER` (default 127.0.0.1, 19182, bds-surv) and `SURV_VERBOSE=1`. The core-* suites read `CORE_BDS_HOST`,
`CORE_BDS_PORT`, `CORE_BDS_CONTAINER` (default 127.0.0.1, 19180, bds-core) and `CORE_VERBOSE=1`; the
hard-* and pve-* suites run there too with `HARD_BDS_PORT=19180 HARD_BDS_CONTAINER=bds-core` /
`PVE_BDS_PORT=19180 PVE_BDS_CONTAINER=bds-core` (they set the difficulty they need). The profile containers need the truth pack (`node scripts/bds.mjs --profile <name> pack`). Fixtures:
`cd bot && pnpm record:fixture` and `BDS_E2E=1 WORLD_RECORD=1 pnpm exec vitest run --project e2e test/e2e/world-record.test.ts`
(1.26.60 on bds-dev / bds-world); for the old version
`node scripts/record-fixture.ts --version 1.26.51 --port 19134 --bds 1.26.51.1` and
`WORLD_RECORD=1 node scripts/e2e-profile.ts dev51 test/e2e/world-record.test.ts`.

The keepalive soak recreates bds-dev with `PLAYER_IDLE_TIMEOUT=1`, runs the AFK CLI with a 30 s nudge
for 3 minutes (no kick, no correction), runs it again with nudges off (a kick, if any, must be
`kicked_for_idle`; see "Behaviour measured on BDS"), then restores `PLAYER_IDLE_TIMEOUT=0`. If it is
interrupted, run `pnpm bds:up` to restore the default. The reconnect e2e restarts bds-dev, so do not
run it while someone else uses bds-dev.

Unit tests of the hardening code: `config`, `health`, `update` (on JSON captured from the live
sources, `bot/test/unit/fixtures/update/`), `tasks-respawn`, `tasks-night`, `tasks-registry`,
`afk`, `versionGate` (a fake server advertising another protocol, and `outdated_client`).

## Realm join (you do this)

PLAN.md tasks 1.6 and 1.7. Agents never run this: it signs in to a Microsoft account and connects
to a public service. **Verified on a real Realm on 2026-10-29** (game 1.26.60, commit 5a7aa68 plus
`patches/bedrock-protocol.patch`; numbers under "Measured on the Realm" below). Statements still
marked *unverified* come from reading bedrock-protocol's source, not from a measurement.

To keep the bot running on a Mac server as a launchd agent, see `deploy/mac/README.md` (set up on
`chat` on 2026-10-29; sign-in and loading the agent stay with you).

### Prerequisites (PLAN.md section 2 checklist)

1. **bedrock-protocol at or after PR #839**: done. `bot/package.json` pins the #839 merge commit
   `c9e1fbf21dc6abde8d89920996575791b79e66cf` (docs/decisions/0004-protocol-pin.md). Check with
   `pnpm --filter bot exec node -e "console.log(require('fs').readFileSync(require.resolve('bedrock-protocol/src/client/auth.js'),'utf8').includes('dns.promises.lookup'))"` (prints `true`).
2. **Game version equal to the Realm's**: a Realm runs the current release (26.60 = `1.26.60` on
   2026-10-28). `1.26.60` is the bot's default since 2026-10-28 (through
   `patches/minecraft-data@3.117.0.patch`, verified against BDS 1.26.60.6 on RakNet and NetherNet,
   docs/versions.md). There is no ping for a Realm, so the version gate cannot compare protocols before
   joining; a mismatch should show up as a kick (`outdated_client` / `outdated_server`, never retried,
   exit code 3) or as a Realms API error (*unverified which*). `pnpm update:check` (Operations) tells
   you when a newer game version is out; run the playbook (`tools/bump-version/playbook.md`) before
   rejoining.
3. **A separate Microsoft account that owns Minecraft Bedrock**, invited to your Realm and with the
   invite accepted (or use `--realm-invite <code>`). You sign in once through the device-code flow.
   The token cache lives outside the repo; the bot never sees a password.
4. **Keepalive**: the AFK task nudges every 240 s (`--nudge-interval`). Verified: 6 h 14 min on the
   Realm without a kick. The raw idle threshold (nudges off) is still unmeasured (community figure
   10 to 15 min, PLAN.md fact 8b); measuring it is optional (below).
5. **Reconnect**: on by default (backoff 1 s doubling to 60 s, 20 % jitter). Each attempt signs in
   from the cache and asks the Realms API for the join address again. Verified after a signalling
   service shutdown (back in 1 s) and after a kick (back in 9 s). *Unverified across a Realm restart
   and a game update.*
6. **Tell everyone who plays on the Realm** that a bot account is there.

### Commands

Put the Realm details into your config file once (`pnpm config:init`, then edit the `realm` block and
`owners`), so nothing private is typed on a command line:

```jsonc
"realm": { "realmName": "Your Realm", "accountName": "bot" },
"owners": ["YourGamertag"]
```

Then, from the repo root:

```sh
pnpm bot:realm                                  # = pnpm --filter bot start -- --task afk --target realm
pnpm bot:realm -- --health-port 9464            # plus the health endpoint
```

Without a config file the same works with flags:
`pnpm --filter bot start -- --task afk --target realm --realm-name "Your Realm" --account bot --owner YourGamertag`.

| Option (config key) | Meaning |
|---|---|
| `--realm-name <name>` (`realm.realmName`) | Realm as listed for the bot account (exact, else unique case-insensitive match). Or `--realm-invite <code or link>` (`realm.realmInvite`), or `--realm-id <id>` (`realm.realmId`); exactly one. A selector on the command line replaces the file's |
| `--account <label>` (`realm.accountName`) | cache key for the token files (any short label, e.g. `bot`); **not** the gamertag. The in-game name is the bot account's gamertag |
| `--profiles-folder <dir>` (`realm.profilesFolder`) | token cache; default `%LOCALAPPDATA%\bedrockbot\profiles` (`~/.bedrockbot/profiles` off Windows). Refused if it resolves inside the repo |
| `--owner <gamertag>` (`owners`) | who may use the chat commands in Realm chat (a Realm has no server console) |
| `--no-record` (`realm.record: false`) | turn the packet capture off (on by default for a Realm) |
| `--update-check-hours <h>` (`updateCheckHours`) | default 24 on a Realm: whispers the owners when a newer game version, BDS build or library appears |

Guard rails (exit code 2 before anything touches the network): `--host`, `--port`, `--username`,
`--transport raknet` and `--signalling lan` are refused with `--target realm`; so is a
profiles folder inside the repository (from the flag or the config file), a target without exactly
one Realm selector, and `"target": "realm"` in the config file. Realm options are built in
`bot/src/connection/realm.ts`: `offline: false`, `realms.pickRealm` (or `realmInvite` / `realmId`),
`authTitle` = Nintendo Switch title, `deviceType: 'Nintendo'`, `flow: 'live'` (bedrock-protocol's own
defaults), `profilesFolder`, `transport: 'nethernet'`, `nethernet: { signalling: 'services' }`.

**First run**: the bot logs `Microsoft sign-in needed: ... https://www.microsoft.com/link ...
<code>`. Open the page, enter the code and sign in **with the bot's account** within 15 minutes
(device codes expire; the attempt is abandoned after 15 min with `no Realm sign-in/join within
900000 ms` and retried). Token files then appear in the profiles folder and later runs do not
prompt (*refresh lifetime unverified*). To sign the bot out, stop it and delete that folder.

Stop with Ctrl+C or `!quit` from an owner (clean disconnect, exit 0).

### What to look for

- Log lines, in order: `config: <path>`, `realm target: realm "Your Realm" (nethernet/services),
  account "bot", token cache ...`, `recording packets to bot/logs/realm-<time>.jsonl.gz (login
  redacted)`, `joining realm ...`, then `spawned as <gamertag>`.
- `bot/logs/disconnects.jsonl`: one line per session end with `reason`, `kind`, the server's
  `kick` (`{reason, message}`) and `spawnedMs`. `bot/logs/metrics.json` (or `/metrics`): uptime,
  reconnects, kicks by reason, deaths.
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
  | `only "bds" is allowed in the config file` | put `--target realm` on the command line (`pnpm bot:realm`) |
  | `health endpoint on 127.0.0.1:<port> failed: listen EADDRINUSE` (exit 2 before joining) | another bot (e.g. a local soak) holds that `--health-port`; pick a free one |
  | `Signal connection closed unexpectedly (Unexpected server response: 404)` | the regional signalling host answers 404; the pnpm patch falls back to the default host by itself (below) |

  Run with `--log-level debug` for bedrock-protocol's connection log, and `DEBUG=minecraft-protocol,nethernet`
  for signalling and WebRTC details (prints no tokens as far as read; still keep it private).

### Measured on the Realm (2026-10-29, game 1.26.60)

Bot account BotAccount, Realm region SouthCentralUs, difficulty normal, owner commands from the
Realm chat. Run from a separate worktree (`git worktree add ../BedrockBot-realm <commit>`) so work
in the main tree cannot break a running stay.

- **Join**: `realms.pickRealm` found the Realm by name; the join record names the regional
  signalling host `signal-southcentralus.franchise.minecraft-services.net`, which resolves in DNS
  but answers HTTP 404 on `/ws/v1.0/messaging/connect`, so bedrock-protocol gave `Signal connection
  closed unexpectedly` five times and gave up. `patches/bedrock-protocol.patch` (pnpm
  `patchedDependencies`) retries once on the default host `signal.franchise.minecraft-services.net`
  and appends the WebSocket error to the message; with it the bot spawned about 10 s after sign-in.
  Token cache: device code entered once; every later run (including reconnects 8 h later) signed in
  from the cache without a prompt.
- **Survival**: the bot was killed by a zombie 7 s after its first spawn (world spawn is unlit).
  Respawn works with the 1.26.60 order (docs/versions.md); `--home` plus walking (on by default for
  Realm targets) brought it back over 170 blocks of real terrain, 0 corrections.
- **24 h stay** (`--task afk --home 100,64,-50 --health-port 9465 --duration 86400`, started
  06:41:55Z): at 14:15Z two sessions of 1 h 13 min and 6 h 14 min, 112 nudges, 0 corrections,
  0 deaths, 0 idle kicks. Session 1 ended with `Signal connection closed (1001): Signaling server
  instance is shutting down` (kind `error`): a signalling-service restart also ends the game
  session in bedrock-protocol; reconnect spawned again 1 s later. Session 2 ended with the owner
  kicking the bot on purpose (`kicked: kicked`); back in 9 s.
- **Capture size**: the Realm packet capture grows about 45 MB/h gzipped (chunks and entity moves),
  about 1 GB a day. Use `--no-record` for multi-day stays unless you need the packets.
- **Chat**: the client's profanity filter can mask digit runs as `####` in replies (`!pos`,
  `!home`); the server-side text is intact. Turn the filter off in the client settings if it matters.
- **Health port**: a bind failure is fatal (exit 2) so two bots never share one `/metrics`; the
  local soak used 9464, the Realm run 9465.

### Measuring the Realm idle kick (task 1.7, optional)

1. Join with nudges off: `pnpm bot:realm -- --nudge-interval 0` (the AFK task still sends one
   standing input right after spawn, like a real client). Do not move the bot from your own client.
2. Wait. When the kick comes, `disconnects.jsonl` records `kick.reason` (on BDS it was
   `kicked_for_idle` with an empty message), and `spawnedMs` is the idle time plus about one
   second. With `--no-reconnect` the bot exits 1 instead of rejoining.
3. If nothing happens within 30 minutes, record "no kick within 30 min".
4. Then run with the default 240 s nudge (or half the measured kick time, whichever is shorter)
   for at least twice the measured time: `metrics.json` must show `kicks.total` 0.

Write the result into PLAN.md fact 8b and this runbook.

### Known unknowns

- Whether the Realms API or the server rejects a wrong game version first, and with what message.
- Raw Realm idle-kick time and reason with nudges off; whether the client-side "press any button"
  AFK screen has a server-side counterpart. (With the 240 s nudge: no kick in 6 h 14 min.)
- Reconnect across a Realm restart and a game update, and your own client joining or leaving
  (a signalling-service restart and a kick are verified).
- How long the cached tokens stay valid before a new device code is needed (8 h verified).
- Whether `/tell` (update whispers) works for a non-operator on a Realm; the notifier also logs.
- Whether an established NetherNet session could survive a signalling-service restart (today
  bedrock-protocol ends it; reconnect covers it in about 1 s).

## Operations

### Health endpoint and metrics (task 5.4)

`--health-port <port>` (config `healthPort`) serves, on 127.0.0.1 only:

- `GET /healthz`: 200 `{"ok": true, "state": "spawned", "sessionUptimeS": ..}` while the bot is spawned
  and alive; 503 while connecting, reconnecting, on the death screen or closed.
- `GET /metrics`: 200 JSON = `summary` plus the full metrics snapshot. `summary` holds `healthy`,
  `state`, `uptimeS`, `sessionUptimeS`, `correctionsPerMin` (10-minute window), `reconnects`,
  `kicksByReason`, `deaths`, `nudges`, `logsPerHour` (from the task's status; `null` for tasks that
  gather nothing), `gameVersion`, `server`, `task`.

`metrics.json` (every `--metrics-interval` s and on exit) has the same snapshot: `uptimeS`, `session`,
`spawns`, `reconnects`, `disconnects`, `closesByKind`, `kicks.byReason`, `lastDisconnect`,
`counters` (`nudges`, `corrections`, `deaths`, `deaths.<cause>`, `home.returns`, `night.retreats`,
`night.unreachable`, `chat.run`, `update.checks`, ...), `rates` (`correctionsPerMin`,
`correctionsLastMin`, `deathsPerHour`, `reconnectsPerHour`), `position`, `taskStatus` (the task's
`status()`: AFK state, respawn, clock, night, home), `updateCheck` when the notifier runs.

```sh
curl -s http://127.0.0.1:9464/healthz
curl -s http://127.0.0.1:9464/metrics
```

### Debug map and world cache (tasks 7.12, 7.15)

With `--health-port`, a walking task (`--walk`, `--home`, `--shelter`, gather) also serves:

- `GET /map`: a page (no dependencies) that draws the remembered chunks top-down (colour by surface
  class, shade by height; chunks that are only remembered are dimmed, loaded ones outlined), the
  bot and its trail, the last goto's goal (and its path once the navigator report exposes one),
  entities (players, hostiles, passive mobs, items), home, shelter and waypoints when the task's
  status has them. Refreshes every second; drag to pan, wheel to zoom, "follow" re-centres.
- `GET /map.json?r=<chunks>&cx=&cz=&since=<rev>&win=<cx0,cz0,cx1,cz1>`: the data (schema in
  `bot/src/health/map/schema.ts`); with `since` / `win` only tiles that changed are sent.

The world cache lives in `<config dir>/cache/<server id>/` (default
`%LOCALAPPDATA%\bedrockbot\cache\` or `~/.bedrockbot/cache/`; env `BEDROCKBOT_CACHE_DIR` overrides the
root, `BEDROCKBOT_CACHE=0` turns it off). It is written every 30 s and on exit; deleting a server's
directory is always safe (the bot only forgets terrain). Inspect it with
`cd bot && node src/world/cache/cli.ts info|checksum <dir>` or `... chunk <dir> <cx> <cz>`.
Details: docs/world-cache.md.

```sh
curl -s "http://127.0.0.1:9464/map.json?r=4" | head -c 600
start http://127.0.0.1:9464/map            # Windows; open the URL in any browser
```

### LAN control panel (Track AE)

With `--health-port` (or `panel.port`) the same server also serves the control panel; details,
what it exposes and the safety rules: docs/panel.md.

| Item | Value |
|---|---|
| Page | `GET /`: status and process stack, health / food / position / dimension / time, the last 50 log lines, the bot's chat replies, quick buttons (`!status`, `!home go`, `!stop`, `!guard on/off`, `!eat`, `!equip`, `!inv`), a command box (any `!command`, run as the first owner), the `!set` table (editable), the map (`/map`) on demand |
| API | `GET /api/state` (JSON, polled every 2 s); `POST /api/cmd` `{"text":"!wp set base"}` -> `{"ok":true,"replies":[...]}`, 5 per second (429 beyond) |
| Config | `panel.host` (default `127.0.0.1`; `0.0.0.0` = the LAN, needs the token), `panel.port` (default `healthPort`; another port keeps `/metrics` token-free on 127.0.0.1), `panel.token` (`pnpm config:init` writes a random 24-character one and prints it once; env `BEDROCKBOT_PANEL_TOKEN` wins) |
| Auth | with a token every path except `/healthz` needs it: `Authorization: Bearer <token>`, or `/?token=<token>` once in the browser (sets an HttpOnly cookie, redirects to `/`). Without a token: 127.0.0.1 only; a LAN host is refused with `panel: refusing to serve on 0.0.0.0 without panel.token; serving on 127.0.0.1 only ...` |
| Never | port-forward it or expose it beyond the LAN; it can make the bot walk, fight and quit |

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9464/api/state | head -c 400
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"text":"!status"}' http://127.0.0.1:9464/api/cmd
```

### Soak (task 5.4)

The 8 h soak runs on its own server (bds-soak, peaceful, idle timeout 0), so the reconnect tests'
`docker restart bds-dev` cannot disturb it:

```sh
node scripts/bds.mjs --profile soak up
pnpm --filter bot start -- --no-config --task afk --port 19152 --username SoakBot --duration 28800 --health-port 9464 --log-dir bot/logs/soak > bot/logs/soak/soak-console.log 2>&1
```

Windows, detached (what was run on 2026-10-29):

```powershell
Start-Process cmd.exe -WindowStyle Hidden -ArgumentList '/c', 'cd /d <repo> && pnpm --filter bot start -- --no-config --task afk --port 19152 --username SoakBot --duration 28800 --health-port 9464 --log-dir bot/logs/soak > "<repo>\bot\logs\soak\soak-console.log" 2>&1'
```

Pass: exit 0 after 28800 s (`exiting (duration 28800 s elapsed)` in the console log), `metrics.json`
complete with `uptimeS` ≈ 28800, `kicks.total` 0, `reconnects` 0 on an undisturbed server,
`/healthz` 200 throughout, no `ERROR` lines.

### Update check (task 5.3)

```sh
pnpm update:check                 # one line per item; NEWER lines and "update available: ..." when something is newer
pnpm update:check --json --out bot/logs/update-check.json
pnpm update:check --fail-on-update   # exit 10 when something is newer (pnpm itself reports it as exit code 1)
```

It compares the pins (game version 1.26.60, BDS build from docker/compose.dev.yml, the installed
bedrock-protocol and minecraft-data) with the npm registry (`/latest`, what `npm view <pkg> version`
reads), minecraft-data master's `bedrock/common/protocolVersions.json` (newest game version with
protocol data) and the BDS links API (newest BDS release and preview). Previews are listed as info
only. It never changes a pin: on `NEWER`, follow `tools/bump-version/playbook.md`.

Inside the bot: `--update-check-hours 24` (default on a Realm target) runs the same check 60 s after
start and then every 24 h, logs it, adds `updateCheck` to the metrics and whispers each new finding
once to the named owners (`/tell`).

Daily on Windows without the bot (Task Scheduler):

```powershell
schtasks /Create /SC DAILY /ST 09:00 /TN "BedrockBot update check" /TR "cmd /c cd /d <repo> && pnpm update:check --out bot\logs\update-check.json >> bot\logs\update-check.log 2>&1"
```

### Version gate

The Connection refuses to log in when the server advertises a protocol other than the requested
version's (`kind: version` close, exit code 3, never retried), and stops reconnecting when the server
answers `outdated_client` / `outdated_server` (or `play_status failed_client/failed_spawn`). Unit:
`versionGate`, `connection-reconnect`; e2e: `reconnect` ("version gate refuses, no retry").
