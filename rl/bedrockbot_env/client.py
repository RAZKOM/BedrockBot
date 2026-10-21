"""WebSocket JSON client for the bot's RL bridge (PLAN.md section 4.5, docs/rl.md).

One env per connection: the bot (``node bot/src/index.ts --task rl --bridge-port 8765``) accepts one
client at a time, sends a ``hello`` first and answers every ``reset`` / ``step`` / ``close`` with one
message carrying the same ``id`` (``obs``, ``error`` or ``closed``).
"""

from __future__ import annotations

import json
import math
from typing import Any

import websocket  # websocket-client

#: Action space v1 (PLAN.md section 9) in Discrete-index order; must match bot/src/bridge/schema.ts.
ACTIONS_V1: tuple[str, ...] = (
    "noop",
    "goto_nearest_log",
    "dig_facing_block",
    "collect_drops",
    "turn_left",
    "turn_right",
    "step_forward",
    "jump_forward",
)
GRID_CLASSES: tuple[str, ...] = ("air", "solid", "log", "leaves", "water", "lava", "item_drop", "other", "unknown")
GRID_SHAPE: tuple[int, int, int] = (9, 9, 5)
GRID_SIZE = GRID_SHAPE[0] * GRID_SHAPE[1] * GRID_SHAPE[2]


class BridgeError(RuntimeError):
    """The bot answered with ``{"t": "error"}`` (or the connection broke)."""


class SchemaError(ValueError):
    """A bot message does not match the PLAN 4.5 schema (as extended in docs/rl.md)."""


def _num(v: Any, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise SchemaError(f"{what}: expected a finite number, got {v!r}")
    return float(v)


def _int(v: Any, what: str, lo: int | None = None) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise SchemaError(f"{what}: expected an integer, got {v!r}")
    if lo is not None and v < lo:
        raise SchemaError(f"{what}: {v} < {lo}")
    return v


def _bool(v: Any, what: str) -> bool:
    if not isinstance(v, bool):
        raise SchemaError(f"{what}: expected a bool, got {v!r}")
    return v


def validate_obs_message(m: Any) -> dict[str, Any]:
    """Checks one ``obs`` message against the schema; returns it or raises SchemaError."""
    if not isinstance(m, dict) or m.get("t") != "obs":
        raise SchemaError(f"not an obs message: {str(m)[:200]}")
    _int(m.get("id"), "id", 0)
    _int(m.get("tick"), "tick")
    obs = m.get("obs")
    if not isinstance(obs, dict):
        raise SchemaError("obs: missing")
    grid = obs.get("grid")
    if not isinstance(grid, list) or len(grid) != GRID_SIZE:
        raise SchemaError(f"obs.grid: expected {GRID_SIZE} ints")
    for i, g in enumerate(grid):
        if _int(g, f"obs.grid[{i}]", 0) >= len(GRID_CLASSES):
            raise SchemaError(f"obs.grid[{i}]: class {g} out of range")
    s = obs.get("self")
    if not isinstance(s, dict):
        raise SchemaError("obs.self: missing")
    pos = s.get("pos")
    if not isinstance(pos, list) or len(pos) != 3:
        raise SchemaError("obs.self.pos: expected [x, y, z]")
    for i, v in enumerate(pos):
        _num(v, f"obs.self.pos[{i}]")
    for k in ("yaw", "pitch", "health", "food"):
        _num(s.get(k), f"obs.self.{k}")
    _bool(s.get("on_ground"), "obs.self.on_ground")
    inv = obs.get("inventory")
    if not isinstance(inv, dict):
        raise SchemaError("obs.inventory: expected an object")
    for k, v in inv.items():
        if not isinstance(k, str):
            raise SchemaError("obs.inventory: keys must be item names")
        _int(v, f"obs.inventory.{k}", 0)
    nl = obs.get("nearest_log")
    if nl is not None:
        if not isinstance(nl, dict):
            raise SchemaError("obs.nearest_log: expected an object or null")
        for k in ("dx", "dy", "dz", "dist"):
            _num(nl.get(k), f"obs.nearest_log.{k}")
        _bool(nl.get("in_reach"), "obs.nearest_log.in_reach")
    ls = obs.get("last_skill")
    if not isinstance(ls, dict):
        raise SchemaError("obs.last_skill: missing")
    _bool(ls.get("ok"), "obs.last_skill.ok")
    if "reason" in ls and not isinstance(ls["reason"], str):
        raise SchemaError("obs.last_skill.reason: expected a string")
    rs = m.get("reward_signals")
    if not isinstance(rs, dict):
        raise SchemaError("reward_signals: missing")
    _int(rs.get("logs_delta"), "reward_signals.logs_delta", 0)
    _bool(rs.get("died"), "reward_signals.died")
    _int(rs.get("ticks_used"), "reward_signals.ticks_used", 0)
    _bool(rs.get("log_in_reach"), "reward_signals.log_in_reach")
    done = _bool(m.get("done"), "done")
    term = _bool(m.get("terminated"), "terminated")
    trunc = _bool(m.get("truncated"), "truncated")
    if done != (term or trunc):
        raise SchemaError("done must equal terminated or truncated")
    info = m.get("info")
    if not isinstance(info, dict):
        raise SchemaError("info: missing")
    _int(info.get("corrections"), "info.corrections", 0)
    return m


class BridgeClient:
    """Blocking client: ``reset()`` and ``step()`` return the bot's ``obs`` message (validated)."""

    def __init__(self, url: str = "ws://127.0.0.1:8765", timeout: float = 120.0, validate: bool = True) -> None:
        self.url = url
        self.timeout = timeout
        self.validate = validate
        self._id = 0
        self._ws = websocket.create_connection(url, timeout=timeout, enable_multithread=False)
        hello = self._recv()
        if hello.get("t") == "error":
            self._ws.close()
            raise BridgeError(f"bridge refused the connection: {hello.get('message')}")
        if hello.get("t") != "hello":
            raise SchemaError(f"expected hello, got {str(hello)[:200]}")
        if list(hello.get("actions", [])) != list(ACTIONS_V1):
            raise SchemaError(f"action list mismatch: bot {hello.get('actions')} vs client {list(ACTIONS_V1)}")
        self.hello: dict[str, Any] = hello

    def _recv(self) -> dict[str, Any]:
        try:
            raw = self._ws.recv()
        except Exception as e:  # noqa: BLE001 - surface any socket problem as BridgeError
            raise BridgeError(f"connection to {self.url} failed: {e}") from e
        m = json.loads(raw)
        if not isinstance(m, dict):
            raise SchemaError(f"not a JSON object: {str(raw)[:200]}")
        return m

    def request(self, msg: dict[str, Any]) -> dict[str, Any]:
        self._id += 1
        mid = self._id
        self._ws.send(json.dumps({**msg, "id": mid}))
        m = self._recv()
        if m.get("t") == "error":
            raise BridgeError(f"{msg.get('t')} #{mid}: {m.get('message')}")
        if m.get("id") != mid:
            raise SchemaError(f"reply id {m.get('id')} != request id {mid}")
        return m

    def reset(self, scenario: str = "forest_small", seed: int = 0, origin: tuple[int, int] | None = None, tool: str | None = None) -> dict[str, Any]:
        msg: dict[str, Any] = {"t": "reset", "scenario": scenario, "seed": int(seed)}
        opts: dict[str, Any] = {}
        if origin is not None:
            opts["origin"] = [int(origin[0]), int(origin[1])]
        if tool is not None:
            opts["tool"] = tool
        if opts:
            msg["options"] = opts
        m = self.request(msg)
        return validate_obs_message(m) if self.validate else m

    def step(self, action: int | str | dict[str, Any]) -> dict[str, Any]:
        if isinstance(action, dict):
            a = action
        elif isinstance(action, str):
            a = {"kind": action}
        else:
            a = {"kind": ACTIONS_V1[int(action)]}
        m = self.request({"t": "step", "action": a})
        return validate_obs_message(m) if self.validate else m

    def close(self) -> None:
        try:
            if self._ws.connected:
                self.request({"t": "close"})
        except Exception:  # noqa: BLE001 - closing anyway
            pass
        finally:
            try:
                self._ws.close()
            except Exception:  # noqa: BLE001
                pass
