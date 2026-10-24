# Waypoints, `!goto <waypoint>` and `!top` (`bot/src/waypoints`, `bot/src/chat/commands-nav.ts`)

PLAN.md task 7.10 (Track R). Decision record:
[decisions/0013-goals-blacklist-waypoints.md](decisions/0013-goals-blacklist-waypoints.md). The goal
types and the failure blacklist behind `!top` and the gather are in [pathfinding.md](pathfinding.md)
("Goals", "Blacklist").

```sh
cd bot
node src/index.ts --task afk --walk --port 19146          # then, as an owner or from the console:
#   !wp set base            (here)       !wp set mine 120 12 -40
#   !wp                     (list)       !wp del mine
#   !goto base              (a waypoint) !goto 10 -60 20   (a feet block)
#   !top                    (out of a cave or a pit, pillaring with cobblestone / dirt if it has some)
```

## Commands (afk task)

| Command | Reply |
|---|---|
| `!wp` / `!wp list` | `waypoints (4): base 10 -60 20, death* 3 -60 -5, here 1 -60 2, spawn* 0 ? 0` (`*` automatic, `?` no height) or `no waypoints yet (!wp set <name>)` |
| `!wp set <name> [x y z]` | `waypoint base set to 10 -60 20`; without coordinates the bot's feet block; `!wp set home ...` also sets the home point (`(home point too)`) |
| `!wp del <name>` | `waypoint base deleted`; `!wp del home` also clears the home point |
| `!wp <name>` | `waypoint death (auto): 3 -60 -5, set 2026-10-29T17:15:24.559Z` |
| `!goto <waypoint>` | `walking to base (10 -60 20)`, then `arrived at base (10 -60 20)` or `goto: <reason>`; a waypoint without a height walks to its column |
| `!goto x y z` | as before (`walking to 10 -60 20`, `arrived at 10 -60 20`) |
| `!top` | `going up to the surface`, then `on the surface at 3.5 -59.0 7.5` or `top: unreachable` |
| `!status` | ends with `blacklist <n>, waypoints <n>` |

Names are case-insensitive, 1 to 32 of `a-z 0-9 _ -`. Walks (`!goto`, `!top`) go through the PvE
layer like `!home go`: a guard fight interrupts them and they resume afterwards; timeouts 6000 ticks
(`!goto`) and 2400 (`!top`). Without the movement stack (`--walk`, `--home`, `--shelter` or `--target
realm`) `!goto` and `!top` answer `... needs a task that can walk (...)`; `!wp` still works (the
position comes from the task).

`!top` runs the `surface` goal with `allowPlace`: the bot walks out of a cave to open sky, or pillars up
out of a pit with throwaway blocks (cobblestone, dirt, cobbled deepslate, netherrack, stone ...,
`DEFAULT_THROWAWAY`). For that the afk task now attaches the packet source and the PvE hotbar to its
skills (the PlaceSkill and UseSkill need them), which also makes the navigator's door moves work in
the afk task.

## Storage

- **File**: `<config dir>/waypoints/<server id>.json`; the config dir is the directory of the config
  file as `index.ts` locates it (`--config`, `BEDROCKBOT_CONFIG`, else `%LOCALAPPDATA%\bedrockbot` on
  Windows, `~/.bedrockbot` elsewhere; the file itself need not exist). `--no-config`: in memory only
  (every e2e CLI run uses it, so tests never write into your config dir; the waypoint e2e passes its
  own temp config file instead).
- **Server id**: from the connection target, CLI values first, then the config file, then the
  defaults: `<host>_<port>` for a BDS (`127.0.0.1_19132`), `realm-<name>` for a Realm by name
  (`realm-id-<id>`, `realm-invite-<code>` otherwise); anything but `A-Z a-z 0-9 . _ -` becomes `_`.
- **Format**: `{ "version": 1, "server": "127.0.0.1_19146", "waypoints": { "base": { "x": 10, "y":
  -60, "z": 20, "auto": false, "at": "<ISO time>" } } }`. `y` is `null` when unknown. Written on every
  change (temp file + rename); an unchanged automatic waypoint is not rewritten. A file that does not
  parse is renamed to `<file>.bad` and the store starts empty.
- **Restart**: a new process reads the file at task creation (before the connection), so every
  waypoint, including `death` and a bed `spawn`, survives a restart.

## Automatic waypoints

| Name | Set from |
|---|---|
| `death` | the death event of tasks/respawn.ts: the last known feet block before the death |
| `spawn` | `set_spawn_position` with a usable position: the player's spawn point (a bed, `/spawnpoint`) when `spawn_type` is `player`, else `world_position`. BDS 1.26.60.6 sends one at every join with all coordinates -2^31 (fixtures/1.26.60/login-idle), which is ignored; until a usable one arrives the world spawn from `start_game.spawn_position` is used, but only when there is no `spawn` waypoint yet (a stored bed spawn wins after a restart). Its y is 32767 on BDS ("find the ground"): stored as `null`, `!goto spawn` walks to the column. `BlockCoordinates.y` is unsigned on the wire (2^32 - 60 means -60) and is converted |
| `home` | follows the home point: `--home` at start, `!home set` / `!home clear`, `!wp set home` / `!wp del home`. Not read back into the home point after a restart (that stays `--home` / the config file) |

## Measured (bds-move, BDS 1.26.60.6, 2026-10-29, `nav-waypoints` e2e, 2 runs)

| Step | Result |
|---|---|
| `!wp set base x y z`, `!wp set here`, `!wp` | replies as above; the list had `spawn* 0 ? 0` (start_game world spawn) |
| `!goto base` (12 blocks east, 8 north) | `arrived at base` after 3.8 s, truth within 0.1 of the block centre |
| `!top` from a 4-deep 1 x 1 shaft (16 cobblestone) | `on the surface` after 3.5 s: feet -63 -> -59 (3 blocks placed, a jump onto the rim) |
| `/spawnpoint <bot> x y z` | the spawn waypoint moved to x y z (a `set_spawn_position` with `spawn_type` player) |
| killed by `truth:kill` | the death waypoint at the feet block of the death |
| `!quit`, new process, same config dir | `waypoints (4): base, death*, here, spawn*` unchanged; `!goto base` arrived after 6.4 to 6.5 s; `!status` ended with `blacklist 0, waypoints 4` |

## Tests

| Test | What |
|---|---|
| `bot/test/unit/waypoints.test.ts` | store (set / list / delete, names, persistence across instances, broken file), server id and file location, `set_spawn_position` / `start_game` parsing, death and spawn events, the chat commands (`!wp`, `!goto <waypoint>` winning over the coordinate-only `!goto`, `!top`, no walking, home), the afk wiring (home follows, `!status` parts, hotbar attach) |
| `bot/test/e2e/nav-waypoints.test.ts` | the CLI on bds-move: `!wp set`, `!goto <waypoint>`, the spawn waypoint, `!top` from a 4-deep shaft, `/spawnpoint`, a death, a restart with the same config dir, `!status` |

```sh
cd bot
BDS_E2E=1 pnpm exec vitest run --project e2e test/e2e/nav-waypoints --silent=false   # ~50 s on bds-move
```

Env as for the nav suites (`MOVE_BDS_HOST`, `MOVE_BDS_PORT`, `MOVE_BDS_CONTAINER`, `MOVE_AREA`,
`MOVE_VERBOSE=1` also prints the CLI's log).

## Implementation notes

- chat/commands.ts (the coordinate-only `!goto`) is registered by index.ts after the task is created
  and would replace the waypoint-aware one; commands-nav.ts re-registers its `!goto` from a chat line
  listener before every `!goto` line is dispatched, so the order of registration does not matter.
- The PvE layer's `walk` is typed for the basic goals (`Goal`); `!top` hands it the `surface` goal
  with a cast (it passes the goal to `skills.goto` unchanged).
