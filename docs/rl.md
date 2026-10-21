# RL environment (PLAN.md Phase 6: tasks 6.1 to 6.3)

```
Python (rl/, Gymnasium BedrockWoodEnv-v0)
   |  WebSocket, JSON, one env per connection (ws://127.0.0.1:<bridge-port>)
bot --task rl (bot/src/tasks/rlAgent.ts, bot/src/bridge/*)
   |  RakNet, the same network bot as Phases 1 to 5 (observations from its own world model)
   |  /scriptevent rl:reset ... (command_request as an operator)  ->  '@truth {json}' reply
BDS bds-rl (docker/compose.rl.yml, udp/19156) + truth pack (packs/truth/src/rl.ts)
```

## Run it

```sh
node scripts/bds.mjs --profile rl up          # bds-rl (BDS 1.26.60.6, RakNet, flat, peaceful, operator)
node scripts/bds.mjs --profile rl pack        # deploy the truth pack (with rl:*) and restart
cd bot && node src/index.ts --task rl --port 19156 --bridge-port 8765 --username RlBot --no-config
#   optional: --arena-origin x,z (default 0,0), --log-dir <dir>

cd rl && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m pytest                       # unit tests against a fake bridge
.venv/Scripts/python scripts/contract_test.py        # 100 random steps against the live bot -> results/contract.json
.venv/Scripts/python scripts/check_env.py            # check_env + 3 random episodes -> results/check_env.json, throughput.json
```

```python
import gymnasium as gym, bedrockbot_env
env = gym.make("BedrockWoodEnv-v0", url="ws://127.0.0.1:8765")
obs, info = env.reset(seed=0)
obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
```

e2e (Node): `BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e rl-` (rl-reset: task 6.1, rl-bridge:
task 6.2). Env: `RL_BDS_HOST`, `RL_BDS_PORT`, `RL_BDS_CONTAINER` (127.0.0.1, 19156, bds-rl), `RL_VERBOSE=1`.
Each run uses its own arena origin (a random cell 1024+ blocks from spawn), so a bot left at 0,0 for
Python does not interfere.

## Reset: `rl:reset` (task 6.1)

`/scriptevent rl:reset [#id] <scenario> <seed> [origin=x,z] [tool=item] [player=name] [verify=1]`, sent by the
bot itself (`command_request`, `bot/src/bridge/commands.ts`; the bot is an operator on bds-rl) or from the
console. The truth pack (`packs/truth/src/rl.ts`, pure generator in `rl-layout.ts`):

1. plans the arena from (scenario, seed): grass floor at y -61 (dirt below), air up to y -49, a 4-high
   barrier ring, oak trees (trunk 4 to 6, persistent leaves, dirt under each trunk), the start column clear;
2. builds it with `fillBlocks` / `setType` (about 3 to 6 ms), removes item / xp / arrow entities in the box;
3. clears the player's inventory and armour, puts the tool (default `stone_axe`) in hotbar slot 0 and selects
   it, restores health, teleports to the start (arena centre, feet y -60, yaw 0 = facing +z);
4. sets the time to day and the weather to clear, and replies
   `@truth {"truth":{"cmd":"rl:reset","id":..,"ok":true,"data":{scenario, seed, origin, box:{min,max},
   start, yaw, tool, player, trees, logs, checksum, removedEntities, buildMs, waitedTicks}}}`.

`checksum` is the truth:checksum (FNV-1a over typeIds, y-z-x order) of `box` the plan produces;
`verify=1` also reads the box back and adds `worldChecksum`. It does not depend on the origin.
If the arena chunks are not loaded (first reset at a new origin), the player is teleported first and the
build waits for them (`waitedTicks`, up to 400). `rl:plan` returns the plan (trees, box, checksum) without
building; `rl:help` lists the commands and scenarios.

| scenario | interior | trees | notes |
|---|---|---|---|
| `forest_small` | 24 x 24 | 6 to 9 | default; 10 variants = seeds 0..9 in the env |
| `forest` | 40 x 40 | 14 to 20 | |
| `single_tree` | 16 x 16 | 1 | trunk 2 to 4 blocks from the start |

The bridge's reset then waits until the bot's own model matches: teleport adopted by the input loop,
`World.checksum(box) == checksum`, the inventory model holding just the tool, standing on the ground.

Measured (rl-reset e2e, 2026-10-29): 20 consecutive resets 77 to 184 ms from sending the scriptevent to the
parsed reply (mean 150 ms; warm-up at a fresh origin 246 ms); identical truth checksums per seed, four
different seeds give four different checksums; arena unchanged 20 s later. Full bridge reset (reply plus
model sync) 300 to 450 ms.

Lesson: grass under an opaque block (a trunk) turns into dirt on a random tick, so a freshly built arena
changed its checksum a few seconds later; the generator now puts dirt under every trunk, as vanilla does.

## Message schema (PLAN.md 4.5, extended additively)

Python -> bot: `{"t":"reset","id":1,"scenario":"forest_small","seed":7,"options":{"origin":[x,z],"tool":"iron_axe"}}`
(`scenario` default `forest_small`, `seed` default 0, `options` optional), `{"t":"step","id":2,"action":{"kind":...}}`,
`{"t":"close","id":3}`. `id`: non-negative integer, echoed in the reply.

Action kinds: the 4.5 names `goto_nearest` (`block`: a block name or `log`, default `log`), `dig_facing`,
`collect`, `noop`, and the section 9 v1 names `goto_nearest_log`, `dig_facing_block`, `collect_drops`,
`turn_left`, `turn_right`, `step_forward`, `jump_forward`. Replies name the v1 kind. Discrete index order =
`ACTIONS_V1` (bot/src/bridge/schema.ts, rl/bedrockbot_env/client.py): noop, goto_nearest_log,
dig_facing_block, collect_drops, turn_left, turn_right, step_forward, jump_forward.

Bot -> Python:

```jsonc
{ "t": "hello", "protocol": 1, "actions": [...], "grid": {"shape":[9,9,5], "order":"x,z,y ...", "y_min":-1, "classes":[...]},
  "episode": {"max_steps":200, "max_ticks":2400, "target_logs":16, "action_ticks":100}, "bot": "RlBot" }   // on connect
{ "t": "obs", "id": 2, "tick": 12345,
  "obs": {
    "grid": [ /* 405 class ids */ ],
    "self": { "pos": [0.5, -60.0, 1.7], "yaw": 0, "pitch": 0, "health": 20, "food": 20, "on_ground": true },
    "inventory": { "stone_axe": 1, "oak_log": 3 },
    "nearest_log": { "dx": 3.0, "dy": 0.5, "dz": -2.0, "dist": 3.6, "in_reach": true },   // or null
    "last_skill": { "ok": false, "reason": "no_block", "action": "dig_facing_block", "ticks": 1 } },
  "reward_signals": { "logs_delta": 1, "died": false, "ticks_used": 35, "log_in_reach": true },
  "done": false, "terminated": false, "truncated": false,
  "info": { "corrections": 0, "episode_corrections": 0, "step": 12, "episode_ticks": 140, "logs": 3,
            "first_log_in_reach": false, "reason": "logs|died|steps|ticks", "target": [x, y, z],
            "reset": {...rl:reset data, reply_ms, sync_ms}, "reset_ms": 312 } }
{ "t": "error", "id": 2, "message": "..." }    // protocol problems only: bad message, step before reset or after done, failed reset
{ "t": "closed", "id": 3 }
```

Additions to 4.5: `hello`, `closed`, reset `options`, `terminated`/`truncated` (Gymnasium) beside `done`,
`self.pitch`, `nearest_log.in_reach`, `last_skill.{action,reason,ticks}`, `reward_signals.log_in_reach`,
the `info` fields above. A failed action is not an `error`: it is `last_skill.ok = false` with a reason
(`no_log`, `no_block`, `unreachable`, `unbreakable`, `timeout`, `blocked`, ...).

- **grid**: 9 x 9 x 5 around the feet block, world axes (not rotated with the yaw), flat x-major:
  index `(ix * 9 + iz) * 5 + iy`, `dx = ix - 4`, `dz = iz - 4`, `dy = iy - 1` (feet - 1 .. feet + 3).
  Classes: 0 air, 1 solid, 2 log (natural `*_log`), 3 leaves, 4 water, 5 lava, 6 item_drop (an item
  entity in an otherwise passable cell), 7 other (non-solid: flowers, grass), 8 unknown (not loaded).
- **nearest_log**: nearest natural log within 48 blocks of the feet (block centre minus feet); `in_reach`
  = eye-to-block distance <= 5.
- Every outbound message is validated with zod before it is sent (`BridgeServer.schemaErrors`).

## Actions (bot/src/bridge/actions.ts)

Each runs to completion or is cancelled after 100 ticks; one at a time (goto and dig both steer yaw/pitch).

| action | what | typical ticks |
|---|---|---|
| noop | wait 10 ticks | 10 |
| goto_nearest_log | path (A*, no sprint) to within 3 blocks of the nearest log, then look at its centre | 2 to 25 |
| dig_facing_block | ray from the eye along the view, reach 5: dig the first non-air, non-liquid block (best tool) | 1 (nothing) / 17 (log, stone axe) |
| collect_drops | `Skills.collect(8, ticks left)` | 1 to 45 |
| turn_left / turn_right | yaw -45 / +45 (Bedrock yaw grows clockwise from above), pitch 0 | 2 |
| step_forward | hold forward until moved 1 block or blocked, then stop and settle | 13 |
| jump_forward | forward + one jump (climbs a 1-block step), stop on landing | 11 to 19 |

## Episode and reward

- `logs_delta`: natural logs entering the inventory, from inventory deltas only, against a high-water mark
  (a log that leaves the inventory and is picked up again does not pay twice).
- Terminated on 16 logs or a death (`died`), truncated at 200 steps or 2400 ticks.
- Python reward (rl/bedrockbot_env/env.py): +1 per log, -0.01 per step, -1 on death, +0.1 the first time a
  log is in reach in an episode (not paid when one is in reach at the reset, which is usual in forest_small).
- Gymnasium observation: `grid` MultiDiscrete(405 x 9), `self` [sin yaw, cos yaw, on_ground, health/20,
  food/20], `nearest_log` [dx, dy, dz, dist (/48), present, in_reach], `inventory` [logs/64, has_axe],
  `last_skill_ok`.

## Measured (2026-10-29, Windows 11, Docker Desktop, one env)

See `rl/results/*.json`. Contract test (100 random steps, Python): 0 schema errors, 2.4 to 2.9 steps/s,
7 to 8.4 mean ticks per action, 0 corrections. check_env passes against the live bot; random policy
3 x 200 steps: about 2.9 steps/s, 3 to 5 logs per episode, 0 corrections; bds-rl used about 5 % CPU and
353 MiB during the run. A step is tick-bound (wall time per step = ticks / 20 + about 30 ms), so steps/s
per env is about 20 / mean ticks per action.

Multi-env (`rl/scripts/throughput.py`, `docker/compose.rl-n.yml`; optional part of 6.3): 4 envs (bds-rl plus
bds-rl-1..3 on udp/19171-19173, one bot each, bridge ports 8765-8768), SubprocVecEnv, 200 random steps per
env: 5.56 steps/s in total (1.39 per env: the vector env steps in lockstep, so every step waits for the
slowest of the four actions), 2 corrections in 800 steps, each BDS about 4.7 % CPU and 326 to 357 MiB.
The extra containers were removed afterwards. Not measured: 8 envs (PLAN.md 6.3 asks for 8; capped at 4
extra containers in this session).
