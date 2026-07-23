from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.api import ArchivistApiError
from archivist.offline_cache import OfflineBrowseCache


class OfflineBrowseCacheTests(unittest.TestCase):
    def test_returns_last_good_response_only_for_connectivity_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = OfflineBrowseCache(f"{directory}/browse.json", "server|default")
            online = cache.fetch("home", lambda: {"rails": {"recentFilms": [{"id": 1}]}}, 3600, now=100)
            self.assertFalse(online.offline)
            offline = cache.fetch(
                "home", lambda: (_ for _ in ()).throw(ArchivistApiError("offline")), 3600, now=200,
            )
            self.assertTrue(offline.offline)
            self.assertEqual(offline.payload, online.payload)
            with self.assertRaises(ArchivistApiError):
                cache.fetch(
                    "home", lambda: (_ for _ in ()).throw(ArchivistApiError("revoked", 401)), 3600, now=201,
                )

    def test_expired_and_other_profile_entries_are_not_used(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/browse.json"
            first = OfflineBrowseCache(path, "server|first")
            first.put("manifest", {"films": [{"id": 1}]}, now=100)
            self.assertIsNone(first.get("manifest", 50, now=151))
            second = OfflineBrowseCache(path, "server|second")
            self.assertIsNone(second.get("manifest", 3600, now=101))

    def test_prunes_oldest_entries_and_recovers_from_corrupt_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "browse.json"
            path.write_text("not-json", encoding="utf-8")
            cache = OfflineBrowseCache(str(path), "server|default", max_entries=8)
            for index in range(10):
                cache.put(f"entry-{index}", {"index": index}, now=100 + index)
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(len(state["entries"]), 8)
            self.assertIsNone(cache.get("entry-0", 3600, now=200))
            self.assertEqual(cache.status(now=200)["entries"], 8)


if __name__ == "__main__":
    unittest.main()
