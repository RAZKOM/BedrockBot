"""A fake RL bridge (WebSocket server in a thread) that speaks the bot's protocol with scripted state.

Deterministic per (scenario, seed): the arena "has" 5 logs; goto_nearest_log puts a log in reach,
dig_facing_block breaks it (a drop appears), collect_drops picks drops up (+1 log each).
Special seeds: 666 = the bot dies on the first step; 13 = reset fails with an error.
"""

from __future__ import annotations

import json
import threading
from typing import Any

from websockets.sync.server import ServerConnection, serve

ACTIONS = ["noop", "goto_nearest_log", "dig_facing_block", "collect_drops", "turn_left", "turn_right", "step_forward", "jump_forward"]


class FakeState:
    def __init__(self, max_steps: int = 200, target_logs: int = 16) -> None:
        self.max_steps = max_steps
        self.target_logs = target_logs
        self.active = False
        self.seed = 0
        self.steps = 0
        self.tick = 1000
        self.logs = 0
        self.best = 0
        self.drops = 0
        self.in_reach = False
        self.yaw = 0.0
        self.dead_on_step = False
        self.done = False

    def obs(self, mid: int, last: dict[str, Any], delta: int, died: bool, used: int, term: bool, trunc: bool) -> dict[str, Any]:
        grid = [1 if (i % 5) == 0 else 0 for i in range(405)]
        grid[(4 * 9 + 6) * 5 + 1] = 2  # a log two blocks +z
        inv: dict[str, int] = {"stone_axe": 1}
        if self.logs:
            inv["oak_log"] = self.logs
        return {
            "t": "obs",
            "id": mid,
            "tick": self.tick,
            "obs": {
                "grid": grid,
                "self": {"pos": [0.5, -60.0, 0.5], "yaw": self.yaw, "pitch": 0, "health": 20, "food": 20, "on_ground": True},
                "inventory": inv,
                "nearest_log": {"dx": 0.0, "dy": 0.5, "dz": 2.0, "dist": 2.06, "in_reach": self.in_reach},
                "last_skill": last,
            },
            "reward_signals": {"logs_delta": delta, "died": died, "ticks_used": used, "log_in_reach": self.in_reach},
            "done": term or trunc,
            "terminated": term,
            "truncated": trunc,
            "info": {"corrections": 0, "step": self.steps, "logs": self.best},
        }

    def handle(self, m: dict[str, Any]) -> dict[str, Any]:
        mid = m.get("id")
        t = m.get("t")
        if t == "reset":
            if m.get("seed") == 13:
                return {"t": "error", "id": mid, "message": "rl:reset failed: unloaded_chunk"}
            self.__init__(self.max_steps, self.target_logs)
            self.active = True
            self.seed = int(m.get("seed", 0))
            self.dead_on_step = self.seed == 666
            out = self.obs(mid, {"ok": True, "action": "reset"}, 0, False, 0, False, False)
            out["info"]["reset"] = {"seed": self.seed, "checksum": f"{self.seed:08x}"}
            return out
        if t == "step":
            if not self.active or self.done:
                return {"t": "error", "id": mid, "message": "no episode: send reset first"}
            kind = m["action"]["kind"]
            if kind not in ACTIONS:
                return {"t": "error", "id": mid, "message": f"bad message: action.kind: unknown action kind {kind}"}
            self.steps += 1
            used = 10
            ok = True
            if kind == "goto_nearest_log":
                self.in_reach = True
                used = 20
            elif kind == "dig_facing_block":
                ok = self.in_reach
                if ok:
                    self.drops += 1
                    used = 15
            elif kind == "collect_drops":
                self.logs += self.drops
                self.drops = 0
            elif kind in ("turn_left", "turn_right"):
                self.yaw = (self.yaw + (45 if kind == "turn_right" else -45)) % 360
                used = 2
            self.tick += used
            delta = max(0, self.logs - self.best)
            self.best = max(self.best, self.logs)
            died = self.dead_on_step
            term = died or self.best >= self.target_logs
            trunc = not term and self.steps >= self.max_steps
            self.done = term or trunc
            last = {"ok": ok, "action": kind, "ticks": used, **({} if ok else {"reason": "no_block"})}
            return self.obs(mid, last, delta, died, used, term, trunc)
        if t == "close":
            self.active = False
            return {"t": "closed", "id": mid}
        return {"t": "error", "id": mid if isinstance(mid, int) else None, "message": f"bad message: t {t}"}


class FakeBridge:
    """``with FakeBridge() as fb: BridgeClient(fb.url)``. One client at a time, like the bot."""

    def __init__(self, max_steps: int = 200, target_logs: int = 16) -> None:
        self.state = FakeState(max_steps, target_logs)
        self.received: list[dict[str, Any]] = []
        self._busy = False
        self._server = serve(self._handler, "127.0.0.1", 0)
        self.port = self._server.socket.getsockname()[1]
        self.url = f"ws://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def _handler(self, ws: ServerConnection) -> None:
        if self._busy:
            ws.send(json.dumps({"t": "error", "id": None, "message": "bridge busy"}))
            ws.close()
            return
        self._busy = True
        try:
            ws.send(json.dumps({"t": "hello", "protocol": 1, "actions": ACTIONS, "grid": {"shape": [9, 9, 5], "order": "x,z,y", "y_min": -1, "classes": []}, "episode": {"max_steps": self.state.max_steps, "max_ticks": 2400, "target_logs": self.state.target_logs, "action_ticks": 100}, "bot": "Fake"}))
            for raw in ws:
                m = json.loads(raw)
                self.received.append(m)
                out = self.state.handle(m)
                ws.send(json.dumps(out))
                if out["t"] == "closed":
                    break
        finally:
            self._busy = False

    def __enter__(self) -> "FakeBridge":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._thread.join(timeout=5)
