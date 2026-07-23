from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse


FetchArtwork = Callable[[str], bytes]


class ArtworkCache:
    """Authenticated artwork cache exposed to Kodi as ordinary local files."""

    def __init__(self, root: str, fetch: FetchArtwork, max_age_seconds: int = 7 * 24 * 60 * 60) -> None:
        self.root = Path(root)
        self.fetch = fetch
        self.max_age_seconds = max_age_seconds

    def resolve(self, source: str) -> str:
        if not source:
            return ""
        target = self._target(source)
        try:
            if target.is_file() and time.time() - target.stat().st_mtime < self.max_age_seconds:
                return str(target)
            payload = self.fetch(source)
            if not payload:
                return ""
            self.root.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(f"{target.suffix}.tmp")
            temporary.write_bytes(payload)
            os.replace(temporary, target)
            return str(target)
        except (OSError, RuntimeError, ValueError):
            # An expired image is still preferable to a broken remote URL while
            # Archivist is temporarily unreachable.
            return str(target) if target.is_file() else ""

    def _target(self, source: str) -> Path:
        suffix = Path(urlparse(source).path).suffix.lower()
        if suffix not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
            suffix = ".img"
        key = hashlib.sha256(source.encode("utf-8")).hexdigest()
        return self.root / f"{key}{suffix}"
