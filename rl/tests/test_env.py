from __future__ import annotations

import copy

import gymnasium as gym
import numpy as np
import pytest
from gymnasium.utils.env_checker import check_env

import bedrockbot_env  # noqa: F401  (registers BedrockWoodEnv-v0)
from bedrockbot_env import ACTIONS_V1, BedrockWoodEnv, BridgeClient, BridgeError, SchemaError, validate_obs_message

from .fake_bridge import FakeBridge


@pytest.fixture
def bridge():
    with FakeBridge() as fb:
        yield fb


def test_client_hello_reset_step_close(bridge: FakeBridge) -> None:
    c = BridgeClient(bridge.url, timeout=10)
    assert c.hello["actions"] == list(ACTIONS_V1)
    m = c.reset("forest_small", 3, origin=(10, 20))
    assert m["t"] == "obs" and m["info"]["reset"]["seed"] == 3
    assert bridge.received[0] == {"t": "reset", "scenario": "forest_small", "seed": 3, "options": {"origin": [10, 20]}, "id": 1}
    s = c.step(1)
    assert s["obs"]["last_skill"]["action"] == "goto_nearest_log"
    assert bridge.received[1]["action"] == {"kind": "goto_nearest_log"}
    c.close()
    assert bridge.received[-1]["t"] == "close"


def test_client_errors(bridge: FakeBridge) -> None:
    c = BridgeClient(bridge.url, timeout=10)
    with pytest.raises(BridgeError, match="no episode"):
        c.step(0)
    with pytest.raises(BridgeError, match="unloaded_chunk"):
        c.reset("forest_small", 13)
    with pytest.raises(BridgeError, match="unknown action kind"):
        c.reset("forest_small", 1)
        c.step({"kind": "fly"})
    c.close()


def test_second_client_is_refused(bridge: FakeBridge) -> None:
    c = BridgeClient(bridge.url, timeout=10)
    with pytest.raises(BridgeError, match="busy"):
        BridgeClient(bridge.url, timeout=10)
    c.close()


def _obs_msg() -> dict:
    from .fake_bridge import FakeState

    return FakeState().obs(1, {"ok": True}, 0, False, 0, False, False)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda m: m["obs"].__setitem__("grid", [0] * 404),
        lambda m: m["obs"]["grid"].__setitem__(0, 9),
        lambda m: m["obs"]["self"].__setitem__("on_ground", 1),
        lambda m: m["obs"]["self"].__setitem__("pos", [0, 0]),
        lambda m: m["obs"]["inventory"].__setitem__("oak_log", -1),
        lambda m: m["reward_signals"].__setitem__("logs_delta", 0.5),
        lambda m: m.__setitem__("done", True),
        lambda m: m["obs"].__setitem__("nearest_log", {"dx": 1}),
        lambda m: m["info"].pop("corrections"),
    ],
)
def test_schema_rejects(mutate) -> None:
    m = _obs_msg()
    validate_obs_message(copy.deepcopy(m))
    mutate(m)
    with pytest.raises(SchemaError):
        validate_obs_message(m)


def test_check_env_passes_on_fake(bridge: FakeBridge) -> None:
    env = BedrockWoodEnv(url=bridge.url)
    check_env(env, skip_render_check=True)
    env.close()


def test_registered_and_spaces(bridge: FakeBridge) -> None:
    env = gym.make("BedrockWoodEnv-v0", url=bridge.url)
    obs, info = env.reset(seed=5)
    assert env.observation_space.contains(obs)
    assert 0 <= info["scenario_seed"] < 10
    assert obs["grid"].shape == (405,) and obs["grid"].dtype == np.int64
    env.close()


def test_rewards_and_termination(bridge: FakeBridge) -> None:
    bridge.state.target_logs = 2
    env = BedrockWoodEnv(url=bridge.url)
    env.reset(options={"scenario_seed": 1})
    _, r, term, trunc, _ = env.step(1)  # goto: first log in reach
    assert r == pytest.approx(-0.01 + 0.1)
    _, r, *_ = env.step(1)  # in reach again: no second bonus
    assert r == pytest.approx(-0.01)
    env.step(2)
    env.step(2)
    _, r, term, trunc, info = env.step(3)  # pick up 2 logs -> terminate (target 2)
    assert r == pytest.approx(2 - 0.01)
    assert term and not trunc and info["logs"] == 2
    with pytest.raises(RuntimeError, match="reset"):
        env.step(0)
    env.close()


def test_death_penalty(bridge: FakeBridge) -> None:
    env = BedrockWoodEnv(url=bridge.url)
    env.reset(options={"scenario_seed": 666})
    _, r, term, _, info = env.step(0)
    assert term and info["reward_signals"]["died"]
    assert r == pytest.approx(-0.01 - 1.0)
    env.close()


def test_truncation(bridge: FakeBridge) -> None:
    bridge.state.max_steps = 3
    env = BedrockWoodEnv(url=bridge.url)
    env.reset(seed=0)
    for _ in range(2):
        assert env.step(0)[3] is False
    assert env.step(0)[3] is True
    env.close()


def test_seeded_reset_is_reproducible(bridge: FakeBridge) -> None:
    env = BedrockWoodEnv(url=bridge.url, variants=1000)
    seeds = []
    for _ in range(2):
        env.reset(seed=42)
        seeds.append(bridge.received[-1]["seed"])
    env.reset(seed=43)
    assert seeds[0] == seeds[1]
    env.close()
