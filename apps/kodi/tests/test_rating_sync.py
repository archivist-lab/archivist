from __future__ import annotations

import tempfile
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.rating_sync import rating_value, reconcile_ratings


def manifest(film: int | None = 4, episode: int | None = None) -> dict:
    return {
        "films": [{"id": 7, "userRating": None if film is None else film * 2}],
        "series": [{"seasons": [{"episodes": [{"id": 11, "userRating": None if episode is None else episode * 2}]}]}],
    }


class RatingSyncTests(unittest.TestCase):
    def test_rounds_kodi_halves_up_to_five_step_scale(self) -> None:
        self.assertEqual([rating_value({"userrating": value}) for value in (0, 1, 2, 3, 9, 10)], [0, 1, 1, 2, 5, 5])

    def test_server_wins_first_sync_and_maps_to_even_kodi_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            applied = []
            result = reconcile_ratings(
                manifest(), [{"type": "film", "id": 7, "userrating": 3}],
                str(Path(directory) / "state.json"), lambda *_: self.fail("must not push"),
                lambda item, value: applied.append((item, value)),
            )
            self.assertEqual(result, (0, 1))
            self.assertEqual(applied[0][1] * 2, 8)

    def test_local_change_pushes_and_clear_remains_sparse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = str(Path(directory) / "state.json")
            local = [{"type": "film", "id": 7, "userrating": 8}]
            reconcile_ratings(manifest(), local, state, lambda *_: None, lambda *_: None)
            pushed = []
            local[0]["userrating"] = 0
            result = reconcile_ratings(manifest(), local, state, lambda *args: pushed.append(args), lambda *_: None)
            self.assertEqual(result, (1, 0))
            self.assertEqual(pushed[0], ("film", 7, 0))

    def test_inherited_values_are_absent_not_materialized(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            applied = []
            reconcile_ratings(
                manifest(episode=None), [{"type": "episode", "id": 11, "userrating": 6}],
                str(Path(directory) / "state.json"), lambda *_: self.fail("must not push"),
                lambda item, value: applied.append(value),
            )
            self.assertEqual(applied, [0])


if __name__ == "__main__":
    unittest.main()
