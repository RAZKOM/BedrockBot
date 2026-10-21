"""Gymnasium env ``BedrockWoodEnv-v0`` (PLAN.md task 6.3, section 9) over the bot's RL bridge.

Observation (Dict):
  grid          MultiDiscrete(405 x 9): 9 x 9 x 5 block classes around the feet, flat, x-major
                (index = (ix * 9 + iz) * 5 + iy; dx = ix - 4, dz = iz - 4, dy = iy - 1); classes
                air, solid, log, leaves, water, lava, item_drop, other, unknown
  self          Box(5): sin(yaw), cos(yaw), on_ground, health / 20, food / 20
  nearest_log   Box(6): dx, dy, dz, dist (each / 48, clipped to [-1, 1]), present, in_reach
  inventory     Box(2): logs / 64, has_axe
  last_skill_ok Box(1): 1 if the last action succeeded
Action: Discrete(8), action space v1 (client.ACTIONS_V1).
Reward: +1 per log entering the inventory (bot-side high-water mark: re-picking dropped logs does not
pay), -0.01 per step, -1 on death, +0.1 the first time per episode a log is within reach (shaping).
Episode: the bot terminates on 16 logs or death and truncates at 200 steps or 2400 ticks.

The scenario seed of each reset is drawn from ``np_random`` (``variants`` forests per scenario), so
``reset(seed=s)`` is reproducible; ``options={"scenario_seed": n}`` picks one directly.
"""

from __future__ import annotations

import math
from typing import Any, Callable

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .client import ACTIONS_V1, GRID_CLASSES, GRID_SIZE, BridgeClient

LOG_NORM = 48.0


def is_log(name: str) -> bool:
    return name.endswith("_log") and not name.startswith("stripped_")


def log_count(inventory: dict[str, int]) -> int:
    return sum(v for k, v in inventory.items() if is_log(k))


class BedrockWoodEnv(gym.Env[dict[str, np.ndarray], np.int64]):
    metadata = {"render_modes": []}

    def __init__(
        self,
        url: str = "ws://127.0.0.1:8765",
        scenario: str = "forest_small",
        variants: int = 10,
        seed_offset: int = 0,
        origin: tuple[int, int] | None = None,
        tool: str | None = None,
        step_penalty: float = 0.01,
        death_penalty: float = 1.0,
        reach_bonus: float = 0.1,
        timeout: float = 120.0,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        super().__init__()
        self.url = url
        self.scenario = scenario
        self.variants = int(variants)
        self.seed_offset = int(seed_offset)
        self.origin = origin
        self.tool = tool
        self.step_penalty = step_penalty
        self.death_penalty = death_penalty
        self.reach_bonus = reach_bonus
        self._factory = client_factory or (lambda: BridgeClient(url, timeout=timeout))
        self._client: Any = None
        self._reached = False
        self._needs_reset = True
        self.last_message: dict[str, Any] | None = None
        self.action_space = spaces.Discrete(len(ACTIONS_V1))
        self.observation_space = spaces.Dict(
            {
                "grid": spaces.MultiDiscrete(np.full(GRID_SIZE, len(GRID_CLASSES), dtype=np.int64)),
                "self": spaces.Box(-1.0, 1.0, shape=(5,), dtype=np.float32),
                "nearest_log": spaces.Box(-1.0, 1.0, shape=(6,), dtype=np.float32),
                "inventory": spaces.Box(0.0, 1.0, shape=(2,), dtype=np.float32),
                "last_skill_ok": spaces.Box(0.0, 1.0, shape=(1,), dtype=np.float32),
            }
        )

    # ---- helpers -------------------------------------------------------------------------------

    @property
    def client(self) -> Any:
        if self._client is None:
            self._client = self._factory()
        return self._client

    @staticmethod
    def encode(obs: dict[str, Any]) -> dict[str, np.ndarray]:
        s = obs["self"]
        yaw = math.radians(float(s["yaw"]))
        nl = obs.get("nearest_log")
        if nl:
            near = [nl["dx"] / LOG_NORM, nl["dy"] / LOG_NORM, nl["dz"] / LOG_NORM, nl["dist"] / LOG_NORM, 1.0, 1.0 if nl["in_reach"] else 0.0]
        else:
            near = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        inv = obs["inventory"]
        has_axe = any(k.endswith("_axe") for k in inv)
        return {
            "grid": np.asarray(obs["grid"], dtype=np.int64),
            "self": np.clip(
                np.array([math.sin(yaw), math.cos(yaw), 1.0 if s["on_ground"] else 0.0, s["health"] / 20.0, s["food"] / 20.0], dtype=np.float32), -1.0, 1.0
            ),
            "nearest_log": np.clip(np.array(near, dtype=np.float32), -1.0, 1.0),
            "inventory": np.clip(np.array([log_count(inv) / 64.0, 1.0 if has_axe else 0.0], dtype=np.float32), 0.0, 1.0),
            "last_skill_ok": np.array([1.0 if obs["last_skill"]["ok"] else 0.0], dtype=np.float32),
        }

    @staticmethod
    def _info(m: dict[str, Any]) -> dict[str, Any]:
        info = dict(m.get("info", {}))
        info["last_skill"] = m["obs"]["last_skill"]
        info["reward_signals"] = m["reward_signals"]
        return info

    # ---- Gymnasium API ---------------------------------------------------------------------------

    def reset(self, *, seed: int | None = None, options: dict[str, Any] | None = None) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        super().reset(seed=seed)
        options = options or {}
        scenario = str(options.get("scenario", self.scenario))
        if "scenario_seed" in options:
            sseed = int(options["scenario_seed"])
        else:
            sseed = self.seed_offset + int(self.np_random.integers(0, self.variants))
        m = self.client.reset(scenario=scenario, seed=sseed, origin=options.get("origin", self.origin), tool=options.get("tool", self.tool))
        self.last_message = m
        self._reached = bool(m["reward_signals"]["log_in_reach"])
        self._needs_reset = False
        info = self._info(m)
        info["scenario"] = scenario
        info["scenario_seed"] = sseed
        return self.encode(m["obs"]), info

    def step(self, action: Any) -> tuple[dict[str, np.ndarray], float, bool, bool, dict[str, Any]]:
        if self._needs_reset:
            raise RuntimeError("call reset() before step() (and after an episode ended)")
        a = int(action)
        if not self.action_space.contains(np.int64(a)):
            raise ValueError(f"invalid action {action!r}")
        m = self.client.step(a)
        self.last_message = m
        rs = m["reward_signals"]
        reward = float(rs["logs_delta"]) - self.step_penalty
        if rs["died"]:
            reward -= self.death_penalty
        if rs["log_in_reach"] and not self._reached:
            self._reached = True
            reward += self.reach_bonus
        terminated = bool(m["terminated"])
        truncated = bool(m["truncated"])
        if terminated or truncated:
            self._needs_reset = True
        return self.encode(m["obs"]), reward, terminated, truncated, self._info(m)

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.close()
            finally:
                self._client = None
        super().close()
