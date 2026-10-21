# rl/: Gymnasium env over the BedrockBot RL bridge

`BedrockWoodEnv-v0` (PLAN.md tasks 6.2 and 6.3): each step is one high-level action (action space v1)
executed by the real network bot on a local BDS. Protocol, observation, reward and reset: [../docs/rl.md](../docs/rl.md).

## Setup (Windows; use `.venv/bin/python` elsewhere)

```sh
cd rl
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m pytest              # fake bridge, no server needed
```

## Against the live bot

```sh
node scripts/bds.mjs --profile rl up && node scripts/bds.mjs --profile rl pack      # from the repo root
cd bot && node src/index.ts --task rl --port 19156 --bridge-port 8765 --username RlBot --no-config
rl/.venv/Scripts/python rl/scripts/contract_test.py --steps 100     # -> rl/results/contract.json
rl/.venv/Scripts/python rl/scripts/check_env.py --episodes 3        # -> rl/results/check_env.json, throughput.json
```

## Layout

| Path | What |
|---|---|
| `bedrockbot_env/client.py` | `BridgeClient` (websocket-client, blocking), `validate_obs_message`, `ACTIONS_V1` |
| `bedrockbot_env/env.py` | `BedrockWoodEnv` (registered as `BedrockWoodEnv-v0` on import of `bedrockbot_env`) |
| `scripts/contract_test.py` | N random steps, every message schema-checked; steps/s, ticks per action, corrections, rewards |
| `scripts/check_env.py` | `gymnasium.utils.env_checker.check_env` live, random policy episodes, docker stats of the BDS |
| `tests/` | pytest with a fake bridge (`tests/fake_bridge.py`, a `websockets` server in a thread) |
| `results/` | JSON outputs of the scripts |

One env per bot and one bot per BDS. Several envs = several `bds-rl`-like containers, one bot each
(`--port`, `--bridge-port`), and `SubprocVecEnv` over `BedrockWoodEnv(url=...)` with one URL per env.
