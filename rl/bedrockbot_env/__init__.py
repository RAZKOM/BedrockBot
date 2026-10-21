"""BedrockBot RL environment: Gymnasium env over the bot's WebSocket bridge (docs/rl.md)."""

from gymnasium.envs.registration import register

from .client import ACTIONS_V1, GRID_CLASSES, GRID_SHAPE, GRID_SIZE, BridgeClient, BridgeError, SchemaError, validate_obs_message
from .env import BedrockWoodEnv

ENV_ID = "BedrockWoodEnv-v0"

register(id=ENV_ID, entry_point="bedrockbot_env.env:BedrockWoodEnv")

__all__ = [
    "ACTIONS_V1",
    "ENV_ID",
    "GRID_CLASSES",
    "GRID_SHAPE",
    "GRID_SIZE",
    "BedrockWoodEnv",
    "BridgeClient",
    "BridgeError",
    "SchemaError",
    "validate_obs_message",
]
