from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.change_feed import SyncChangeFeed


class FakeApi:
    def __init__(self) -> None:
        self.calls = 0

    def sync_changes(self, cursor: int, _wait: int) -> dict:
        self.calls += 1
        if cursor < 7:
            return {"cursor": 7, "changed": True}
        time.sleep(0.01)
        return {"cursor": 7, "changed": False}


class ChangeFeedTests(unittest.TestCase):
    def test_cursor_advances_only_after_acknowledgement(self) -> None:
        api = FakeApi()
        feed = SyncChangeFeed(lambda: api, cursor=3)
        feed.start()
        deadline = time.time() + 1
        while not feed.has_change() and time.time() < deadline:
            time.sleep(0.01)
        self.assertTrue(feed.has_change())
        self.assertEqual(feed.cursor, 3)
        self.assertEqual(feed.acknowledge(), 7)
        self.assertFalse(feed.has_change())
        feed.stop()


if __name__ == "__main__":
    unittest.main()
