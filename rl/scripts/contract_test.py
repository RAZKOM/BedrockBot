"""Contract test (PLAN.md task 6.2): N random v1 steps against the live bot, every message validated.

  node bot/src/index.ts --task rl --port 19156 --bridge-port 8765      (bot on bds-rl)
  rl/.venv/Scripts/python rl/scripts/contract_test.py [--steps 100] [--url ws://127.0.0.1:8765]

Resets whenever an episode ends. Prints and writes rl/results/contract.json: steps/s, mean ticks per
action (overall and per action), corrections, the reward distribution, last_skill failures by reason.
Exit code 1 on any schema or bridge error.
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import random
import statistics
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from bedrockbot_env.client import ACTIONS_V1, BridgeClient  # noqa: E402

RESULTS = pathlib.Path(__file__).resolve().parents[1] / "results"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8765")
    ap.add_argument("--steps", type=int, default=100)
    ap.add_argument("--scenario", default="forest_small")
    ap.add_argument("--seed", type=int, default=0, help="seed of the random action sequence and the first forest")
    ap.add_argument("--out", default=str(RESULTS / "contract.json"))
    args = ap.parse_args()
    rng = random.Random(args.seed)
    c = BridgeClient(args.url)
    resets: list[dict] = []
    t_start = time.perf_counter()

    def reset(n: int) -> dict:
        t0 = time.perf_counter()
        m = c.reset(args.scenario, (args.seed + n) % 10)
        resets.append({"seed": (args.seed + n) % 10, "wall_ms": round((time.perf_counter() - t0) * 1000), "bot_ms": m["info"].get("reset_ms"), "checksum": m["info"]["reset"]["checksum"]})
        return m

    reset(0)
    ticks: list[int] = []
    per_action: dict[str, list[int]] = collections.defaultdict(list)
    fails: collections.Counter[str] = collections.Counter()
    rewards: list[float] = []
    logs_delta: collections.Counter[int] = collections.Counter()
    corrections = 0
    deaths = 0
    episodes_done = 0
    step_wall = 0.0
    for i in range(args.steps):
        a = rng.randrange(len(ACTIONS_V1))
        t0 = time.perf_counter()
        m = c.step(a)  # validates the schema, raises on error
        step_wall += time.perf_counter() - t0
        rs = m["reward_signals"]
        ls = m["obs"]["last_skill"]
        ticks.append(rs["ticks_used"])
        per_action[ACTIONS_V1[a]].append(rs["ticks_used"])
        if not ls["ok"]:
            fails[f"{ACTIONS_V1[a]}:{ls.get('reason', '?')}"] += 1
        corrections += m["info"]["corrections"]
        deaths += 1 if rs["died"] else 0
        logs_delta[rs["logs_delta"]] += 1
        rewards.append(rs["logs_delta"] - 0.01 - (1.0 if rs["died"] else 0.0))
        if m["done"]:
            episodes_done += 1
            if i < args.steps - 1:
                reset(episodes_done)
    total = time.perf_counter() - t_start
    c.close()
    res = {
        "steps": args.steps,
        "schema_errors": 0,
        "wall_s": round(total, 2),
        "steps_per_s": round(args.steps / step_wall, 3),
        "steps_per_s_incl_resets": round(args.steps / total, 3),
        "mean_ticks_per_action": round(statistics.mean(ticks), 2),
        "median_ticks_per_action": statistics.median(ticks),
        "max_ticks_per_action": max(ticks),
        "ticks_per_action_by_kind": {k: {"n": len(v), "mean": round(statistics.mean(v), 1), "max": max(v)} for k, v in sorted(per_action.items())},
        "corrections": corrections,
        "deaths": deaths,
        "episodes_done": episodes_done,
        "logs_delta_histogram": {str(k): v for k, v in sorted(logs_delta.items())},
        "reward": {"sum": round(sum(rewards), 3), "mean": round(statistics.mean(rewards), 4), "min": min(rewards), "max": max(rewards)},
        "skill_failures": dict(fails.most_common()),
        "resets": resets,
    }
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, indent=2) + "\n")
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
