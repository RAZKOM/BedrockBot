"""Multi-env throughput (PLAN.md task 6.3, optional part): SubprocVecEnv over N running bots.

Each env needs its own BDS and bot, e.g. bds-rl + bds-rl-1..3 (docker/compose.rl-n.yml) and
  node bot/src/index.ts --task rl --port <bds port> --bridge-port <8765 + i> --username RlBot<i>
then:
  rl/.venv/Scripts/python rl/scripts/throughput.py --urls ws://127.0.0.1:8765,ws://127.0.0.1:8766 \
      --containers bds-rl,bds-rl-1 --steps 200
Random actions, `--steps` vector steps (each env does that many steps, auto-reset on episode end).
Merges {"multi_env": ...} into rl/results/throughput.json.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import statistics
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
from stable_baselines3.common.vec_env import SubprocVecEnv  # noqa: E402

from check_env import DockerStats  # noqa: E402

RESULTS = pathlib.Path(__file__).resolve().parents[1] / "results"


def make_env(url: str, seed_offset: int):
    def _f():
        from bedrockbot_env import BedrockWoodEnv

        return BedrockWoodEnv(url=url, seed_offset=seed_offset)

    return _f


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--urls", required=True)
    ap.add_argument("--containers", required=True)
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    urls = args.urls.split(",")
    containers = args.containers.split(",")
    n = len(urls)
    stats = {c: DockerStats(c, every=3.0) for c in containers}
    venv = SubprocVecEnv([make_env(u, 0) for u in urls], start_method="spawn")
    venv.seed(args.seed)
    t0 = time.perf_counter()
    venv.reset()
    reset_s = time.perf_counter() - t0
    for s in stats.values():
        s.start()
    rng = np.random.default_rng(args.seed)
    logs = [0] * n
    episodes = 0
    corrections = 0
    t1 = time.perf_counter()
    for _ in range(args.steps):
        _, rewards, dones, infos = venv.step(rng.integers(0, 8, size=n))
        for i, info in enumerate(infos):
            logs[i] += int(info.get("reward_signals", {}).get("logs_delta", 0))
            corrections += int(info.get("corrections", 0))
            if dones[i]:
                episodes += 1
    wall = time.perf_counter() - t1
    for s in stats.values():
        s.stop_ev.set()
    for s in stats.values():
        s.join(timeout=60)
    venv.close()
    per = {c: s.summary() for c, s in stats.items()}
    cpu = [v["cpu_pct_mean"] for v in per.values() if "cpu_pct_mean" in v]
    mem = [v["mem_mib_mean"] for v in per.values() if "mem_mib_mean" in v]
    res = {
        "envs": n,
        "steps_per_env": args.steps,
        "total_steps": n * args.steps,
        "wall_s": round(wall, 1),
        "initial_reset_s": round(reset_s, 2),
        "steps_per_s_total": round(n * args.steps / wall, 2),
        "steps_per_s_per_env": round(args.steps / wall, 3),
        "episodes_ended": episodes,
        "logs_per_env": logs,
        "corrections": corrections,
        "bds_per_instance": per,
        "bds_cpu_pct_mean_per_instance": round(statistics.mean(cpu), 1) if cpu else None,
        "bds_mem_mib_mean_per_instance": round(statistics.mean(mem), 1) if mem else None,
        "note": "SubprocVecEnv steps all envs in lockstep, so each vector step waits for the slowest action",
    }
    out = RESULTS / "throughput.json"
    data = json.loads(out.read_text()) if out.exists() else {}
    data["multi_env"] = res
    out.write_text(json.dumps(data, indent=2) + "\n")
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
