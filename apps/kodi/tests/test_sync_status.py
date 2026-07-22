from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from sys import path
path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.sync_status import SyncStatus


class SyncStatusTests(unittest.TestCase):
    def test_failures_back_off_and_success_resets_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status = SyncStatus(str(Path(directory) / "status.json"))
            first = status.failure("offline", 900, now=1000)
            second = status.failure("offline again", 900, now=1100)
            self.assertEqual(first["nextAttempt"], 1900)
            self.assertEqual(second["nextAttempt"], 2900)
            self.assertEqual(second["consecutiveFailures"], 2)
            success = status.success(SimpleNamespace(changed=4, removed=1), now=3000, change_cursor=42)
            self.assertEqual(success["consecutiveFailures"], 0)
            self.assertEqual(success["changed"], 4)
            self.assertEqual(success["changeCursor"], 42)


if __name__ == "__main__":
    unittest.main()
