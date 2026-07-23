from __future__ import annotations

import tempfile
import time
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.artwork import ArtworkCache


class ArtworkCacheTests(unittest.TestCase):
    def test_downloads_once_and_returns_local_file(self) -> None:
        calls: list[str] = []
        with tempfile.TemporaryDirectory() as directory:
            cache = ArtworkCache(directory, lambda source: calls.append(source) or b"image-data")
            first = cache.resolve("/media/films/Example/poster.jpg")
            second = cache.resolve("/media/films/Example/poster.jpg")
            self.assertEqual(first, second)
            self.assertEqual(Path(first).read_bytes(), b"image-data")
            self.assertEqual(calls, ["/media/films/Example/poster.jpg"])

    def test_refreshes_expired_file(self) -> None:
        payloads = iter((b"old", b"new"))
        with tempfile.TemporaryDirectory() as directory:
            cache = ArtworkCache(directory, lambda _source: next(payloads), max_age_seconds=1)
            target = Path(cache.resolve("https://images.example/poster.png"))
            old = time.time() - 10
            target.touch()
            target.write_bytes(b"old")
            import os
            os.utime(target, (old, old))
            self.assertEqual(Path(cache.resolve("https://images.example/poster.png")).read_bytes(), b"new")

    def test_uses_stale_artwork_when_refresh_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = ArtworkCache(directory, lambda _source: b"cached", max_age_seconds=1)
            target = Path(cache.resolve("https://images.example/poster.png"))
            old = time.time() - 10
            import os
            os.utime(target, (old, old))
            cache.fetch = lambda _source: (_ for _ in ()).throw(RuntimeError("offline"))
            self.assertEqual(cache.resolve("https://images.example/poster.png"), str(target))


if __name__ == "__main__":
    unittest.main()
