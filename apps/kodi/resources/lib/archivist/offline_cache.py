from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .api import ArchivistApiError


@dataclass(frozen=True)
class CachedResponse:
    payload: dict[str, Any]
    offline: bool
    stored_at: int


class OfflineBrowseCache:
    """Bounded last-known-good cache for Kodi's dynamic browse surfaces."""

    SCHEMA_VERSION = 1

    def __init__(self, path: str, namespace: str, max_entries: int = 128) -> None:
        self.path = Path(path)
        self.namespace = namespace
        self.max_entries = max(8, max_entries)

    def fetch(
        self,
        key: str,
        loader: Callable[[], dict[str, Any]],
        max_age_seconds: int,
        now: int | None = None,
    ) -> CachedResponse:
        timestamp = int(time.time()) if now is None else int(now)
        try:
            payload = loader()
            if not isinstance(payload, dict):
                raise ArchivistApiError("Archivist returned an invalid browse response")
            self.put(key, payload, timestamp)
            return CachedResponse(payload, False, timestamp)
        except ArchivistApiError as error:
            # Never conceal revoked credentials, invalid requests or missing media.
            if error.status and error.status < 500:
                raise
            cached = self.get(key, max_age_seconds, timestamp)
            if cached is None:
                raise
            return CachedResponse(cached["payload"], True, int(cached["storedAt"]))

    def put(self, key: str, payload: dict[str, Any], now: int | None = None) -> None:
        state = self._read()
        entries = state.setdefault("entries", {})
        entries[self._key(key)] = {
            "namespace": self.namespace,
            "name": key,
            "storedAt": int(time.time()) if now is None else int(now),
            "payload": payload,
        }
        if len(entries) > self.max_entries:
            ordered = sorted(entries, key=lambda item: int(entries[item].get("storedAt") or 0))
            for expired in ordered[:len(entries) - self.max_entries]:
                entries.pop(expired, None)
        self._write(state)

    def get(self, key: str, max_age_seconds: int, now: int | None = None) -> dict[str, Any] | None:
        entry = self._read().get("entries", {}).get(self._key(key))
        if not isinstance(entry, dict) or not isinstance(entry.get("payload"), dict):
            return None
        timestamp = int(time.time()) if now is None else int(now)
        stored_at = int(entry.get("storedAt") or 0)
        if stored_at <= 0 or timestamp - stored_at > max(0, max_age_seconds):
            return None
        return entry

    def status(self, now: int | None = None) -> dict[str, int]:
        entries = [
            entry for entry in self._read().get("entries", {}).values()
            if isinstance(entry, dict) and entry.get("namespace") == self.namespace
        ]
        stored = [int(entry.get("storedAt") or 0) for entry in entries]
        return {
            "entries": len(entries),
            "oldest": min(stored, default=0),
            "newest": max(stored, default=0),
            "checkedAt": int(time.time()) if now is None else int(now),
        }

    def _key(self, key: str) -> str:
        return f"{self.namespace}\n{key}"

    def _read(self) -> dict[str, Any]:
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
            if state.get("schemaVersion") == self.SCHEMA_VERSION and isinstance(state.get("entries"), dict):
                return state
        except (OSError, ValueError, AttributeError):
            pass
        return {"schemaVersion": self.SCHEMA_VERSION, "entries": {}}

    def _write(self, state: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, self.path)
