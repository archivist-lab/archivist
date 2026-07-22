from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any


class SyncStatus:
    def __init__(self, path: str) -> None:
        self.path = Path(path)

    def read(self) -> dict[str, Any]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, ValueError):
            return {"consecutiveFailures": 0}

    def success(self, result: Any, now: int | None = None, change_cursor: int | None = None) -> dict[str, Any]:
        timestamp = int(now if now is not None else time.time())
        state = {
            "lastSuccess": timestamp, "lastAttempt": timestamp, "lastError": "",
            "nextAttempt": 0, "consecutiveFailures": 0,
            "changed": int(getattr(result, "changed", 0)), "removed": int(getattr(result, "removed", 0)),
            "changeCursor": int(change_cursor if change_cursor is not None else self.read().get("changeCursor") or 0),
        }
        self._write(state)
        return state

    def failure(self, error: object, base_interval_seconds: int, now: int | None = None) -> dict[str, Any]:
        timestamp = int(now if now is not None else time.time())
        state = self.read()
        failures = int(state.get("consecutiveFailures") or 0) + 1
        delay = min(6 * 60 * 60, max(5 * 60, base_interval_seconds) * (2 ** min(failures - 1, 6)))
        state.update({
            "lastAttempt": timestamp, "lastError": str(error)[:1000],
            "nextAttempt": timestamp + delay, "consecutiveFailures": failures,
        })
        self._write(state)
        return state

    def _write(self, state: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(temporary, self.path)
