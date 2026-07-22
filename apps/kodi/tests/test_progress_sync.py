from __future__ import annotations

import tempfile
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.progress_sync import reconcile_progress


def manifest(position: float = 120, completed: bool = False) -> dict:
    return {"films": [{"id": 7, "progress": {"positionSeconds": position, "durationSeconds": 1000, "completed": completed}}], "series": []}


class ProgressSyncTests(unittest.TestCase):
    def test_server_wins_first_sync(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            applied = []
            result = reconcile_progress(
                manifest(), [{"type": "film", "id": 7, "playcount": 0, "resume": {"position": 0, "total": 1000}}],
                str(Path(directory) / "state.json"), lambda *_: self.fail("must not push"),
                lambda item, value: applied.append((item, value)),
            )
            self.assertEqual(result, (0, 1))
            self.assertEqual(applied[0][1]["position"], 120)

    def test_local_only_change_pushes_to_server(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = str(Path(directory) / "state.json")
            local = [{"type": "film", "id": 7, "playcount": 0, "resume": {"position": 120, "total": 1000}}]
            reconcile_progress(manifest(), local, state, lambda *_: None, lambda *_: None)
            pushed = []
            local[0]["resume"]["position"] = 450
            result = reconcile_progress(manifest(), local, state, lambda *args: pushed.append(args), lambda *_: None)
            self.assertEqual(result, (1, 0))
            self.assertEqual(pushed[0][2]["position"], 450)

    def test_server_wins_conflicting_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = str(Path(directory) / "state.json")
            local = [{"type": "film", "id": 7, "playcount": 0, "resume": {"position": 120, "total": 1000}}]
            reconcile_progress(manifest(), local, state, lambda *_: None, lambda *_: None)
            local[0]["resume"]["position"] = 300
            applied = []
            result = reconcile_progress(manifest(600), local, state, lambda *_: self.fail("conflict must not push"), lambda _, value: applied.append(value))
            self.assertEqual(result, (0, 1))
            self.assertEqual(applied[0]["position"], 600)


if __name__ == "__main__":
    unittest.main()
