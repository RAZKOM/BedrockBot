"""PLAN.md task 6.3 (single env): Gymnasium's check_env against the live bot, then a random policy
for N episodes, with docker stats of the BDS container sampled during the run.

  node bot/src/index.ts --task rl --port 19156 --bridge-port 8765      (bot on bds-rl)
  rl/.venv/Scripts/python rl/scripts/check_env.py [--episodes 3] [--container bds-rl]

Writes rl/results/check_env.json and rl/results/throughput.json.
"""

from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import platform
import statistics
import subprocess
import sys
import threading
import time
import traceback
import warnings

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import gymnasium as gym  # noqa: E402
from gymnasium.utils.env_checker import check_env  # noqa: E402

import bedrockbot_env  # noqa: E402,F401
from bedrockbot_env import ENV_ID, BedrockWoodEnv  # noqa: E402

RESULTS = pathlib.Path(__file__).resolve().parents[1] / "results"


def parse_size(s: str) -> float:
    """'512.3MiB' -> MiB."""
    s = s.strip()
    units = {"B": 1 / 2**20, "KiB": 1 / 1024, "MiB": 1.0, "GiB": 1024.0, "kB": 1000 / 2**20, "MB": 1e6 / 2**20, "GB": 1e9 / 2**20}
    for u in sorted(units, key=len, reverse=True):
        if s.endswith(u):
            return float(s[: -len(u)]) * units[u]
    return float(s)


class DockerStats(threading.Thread):
    def __init__(self, container: str, every: float = 2.0) -> None:
        super().__init__(daemon=True)
        self.container = container
        self.every = every
        self.samples: list[dict[str, float]] = []
        self.stop_ev = threading.Event()
        self.error: str | None = None

    def sample(self) -> dict[str, float] | None:
        r = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{json .}}", self.container], capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            self.error = r.stderr.strip()
            return None
        d = json.loads(r.stdout.strip().splitlines()[0])
        return {"cpu_pct": float(d["CPUPerc"].rstrip("%")), "mem_mib": parse_size(d["MemUsage"].split("/")[0])}

    def run(self) -> None:
        while not self.stop_ev.is_set():
            try:
                s = self.sample()
                if s:
                    self.samples.append(s)
            except Exception as e:  # noqa: BLE001
                self.error = str(e)
            self.stop_ev.wait(self.every)

    def summary(self) -> dict[str, float | int | None]:
        if not self.samples:
            return {"samples": 0, "error": self.error}
        cpu = [s["cpu_pct"] for s in self.samples]
        mem = [s["mem_mib"] for s in self.samples]
        return {"samples": len(self.samples), "cpu_pct_mean": round(statistics.mean(cpu), 1), "cpu_pct_max": round(max(cpu), 1), "mem_mib_mean": round(statistics.mean(mem), 1), "mem_mib_max": round(max(mem), 1)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8765")
    ap.add_argument("--episodes", type=int, default=3)
    ap.add_argument("--container", default="bds-rl")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    RESULTS.mkdir(parents=True, exist_ok=True)

    # 1. check_env on the raw env (and once through gym.make, which adds the passive checker).
    env = BedrockWoodEnv(url=args.url)
    t0 = time.perf_counter()
    check: dict[str, object] = {"env_id": ENV_ID, "gymnasium": gym.__version__}
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            check_env(env, skip_render_check=True)
            check["passed"] = True
        except Exception as e:  # noqa: BLE001
            check["passed"] = False
            check["error"] = f"{type(e).__name__}: {e}"
            check["traceback"] = traceback.format_exc()
    check["warnings"] = sorted({str(w.message) for w in caught})
    check["seconds"] = round(time.perf_counter() - t0, 1)
    env.close()
    print(json.dumps({k: v for k, v in check.items() if k != "traceback"}, indent=2))
    (RESULTS / "check_env.json").write_text(json.dumps(check, indent=2) + "\n")
    if not check["passed"]:
        print(check.get("traceback", ""))
        return 1

    # 2. Random policy, N episodes, BDS resource use sampled meanwhile.
    stats = DockerStats(args.container)
    idle = stats.sample()
    env = gym.make(ENV_ID, url=args.url)
    env.action_space.seed(args.seed)
    stats.start()
    episodes = []
    total_steps = 0
    t_run = time.perf_counter()
    step_time = 0.0
    reset_times = []
    for ep in range(args.episodes):
        tr = time.perf_counter()
        _, info = env.reset(seed=args.seed + ep)
        scenario_seed = info.get("scenario_seed")
        reset_times.append(time.perf_counter() - tr)
        ret = 0.0
        steps = 0
        logs = 0
        ticks = 0
        corrections = 0
        reason = None
        while True:
            ts = time.perf_counter()
            _, r, term, trunc, info = env.step(env.action_space.sample())
            step_time += time.perf_counter() - ts
            ret += r
            steps += 1
            logs = info.get("logs", logs)
            ticks = info.get("episode_ticks", ticks)
            corrections += info.get("corrections", 0)
            if term or trunc:
                reason = info.get("reason")
                break
        total_steps += steps
        episodes.append({"episode": ep, "scenario_seed": scenario_seed, "steps": steps, "return": round(ret, 3), "logs": logs, "ticks": ticks, "corrections": corrections, "end": reason})
        print(json.dumps(episodes[-1]))
    wall = time.perf_counter() - t_run
    stats.stop_ev.set()
    stats.join(timeout=60)
    env.close()
    out = {
        "date": datetime.datetime.now().isoformat(timespec="seconds"),
        "host": {"platform": platform.platform(), "python": platform.python_version()},
        "setup": "1 env: BedrockWoodEnv-v0 -> bot (node, --task rl) -> bds-rl (BDS 1.26.60.6, RakNet, Docker Desktop/WSL2); random policy, forest_small",
        "check_env": "passed",
        "episodes": episodes,
        "total_steps": total_steps,
        "wall_s": round(wall, 1),
        "steps_per_s": round(total_steps / step_time, 3),
        "steps_per_s_incl_resets": round(total_steps / wall, 3),
        "mean_reset_s": round(statistics.mean(reset_times), 3),
        "ticks_per_s_game": 20,
        "bds": {"container": args.container, "idle_before": idle, "during_run": stats.summary()},
    }
    (RESULTS / "throughput.json").write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
