from __future__ import annotations

import threading
from typing import Any, Callable

from .api import ArchivistApi, ArchivistApiError


class SyncChangeFeed:
    """Background long-poll client with explicit sync acknowledgement.

    A cursor advances only after the Kodi service has successfully applied the
    corresponding manifest. Failed syncs therefore cannot lose a notification.
    """

    def __init__(self, api_factory: Callable[[], ArchivistApi], cursor: int = 0) -> None:
        self.api_factory = api_factory
        self.cursor = max(0, int(cursor))
        self._pending_cursor: int | None = None
        self._changed = threading.Event()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="ArchivistChangeFeed", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=1)

    def has_change(self) -> bool:
        return self._changed.is_set()

    def acknowledge(self) -> int:
        with self._lock:
            if self._pending_cursor is not None:
                self.cursor = self._pending_cursor
            self._pending_cursor = None
            self._changed.clear()
            self._wake.set()
            return self.cursor

    def retry(self) -> None:
        # Keep the pending cursor and signal set. The service's persisted
        # synchronization backoff decides when the manifest is attempted again.
        self._wake.set()

    def _run(self) -> None:
        failures = 0
        while not self._stop.is_set():
            with self._lock:
                pending = self._pending_cursor is not None
                cursor = self.cursor
            if pending:
                self._wake.wait(1)
                self._wake.clear()
                continue
            try:
                payload: dict[str, Any] = self.api_factory().sync_changes(cursor, 25)
                failures = 0
                candidate = max(0, int(payload.get("cursor") or 0))
                if bool(payload.get("changed")) or candidate != cursor:
                    with self._lock:
                        self._pending_cursor = candidate
                        self._changed.set()
            except (ArchivistApiError, OSError, RuntimeError, ValueError, TypeError):
                failures += 1
                self._stop.wait(min(60, 2 ** min(failures, 6)))
