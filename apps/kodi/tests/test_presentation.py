from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.presentation import completion_state, info_labels, next_unwatched_episode, progress_values, stream_details, unique_items


class PresentationTests(unittest.TestCase):
    def test_episode_labels_use_native_kodi_fields(self) -> None:
        labels = info_labels({
            "type": "episode", "title": "Winter Is Coming", "seriesTitle": "Game of Thrones",
            "seasonNumber": 1, "episodeNumber": 1, "runtimeSeconds": 3600, "genres": ["Drama"],
        })
        self.assertEqual(labels["mediatype"], "episode")
        self.assertEqual(labels["tvshowtitle"], "Game of Thrones")
        self.assertEqual(labels["season"], 1)

    def test_progress_handles_summary_and_continue_shapes(self) -> None:
        self.assertEqual(progress_values({"progress": {"positionSeconds": 10, "durationSeconds": 100, "completed": False}}), (10.0, 100.0, False))
        self.assertEqual(progress_values({"positionSeconds": 100, "durationSeconds": 100, "completed": True}), (100.0, 100.0, True))

    def test_stream_details_preserve_exact_seconds_and_all_tracks(self) -> None:
        details = stream_details({
            "runtimeSeconds": 3721.4, "quality": {"resolution": "1080p", "codec": "hevc"},
            "mediaInfo": {"video": {"codec": "hevc", "width": 1920, "height": 1080, "aspect": 1.777, "durationSeconds": 3721.4},
                          "audio": [{"codec": "eac3", "language": "eng", "channels": 6}],
                          "subtitles": [{"language": "eng"}]},
        })
        self.assertEqual(details["video"][0]["duration"], 3721)
        self.assertEqual(details["video"][0]["height"], 1080)
        self.assertEqual(details["audio"][0], {"codec": "eac3", "language": "eng", "channels": 6})
        self.assertEqual(details["subtitle"][0], {"language": "eng"})

    def test_next_episode_skips_watched_and_unavailable(self) -> None:
        series = {"seasons": [{"episodes": [
            {"id": 1, "seasonNumber": 1, "episodeNumber": 1, "hasFile": True, "progress": {"completed": True}},
            {"id": 2, "seasonNumber": 1, "episodeNumber": 2, "hasFile": False},
            {"id": 3, "seasonNumber": 1, "episodeNumber": 3, "hasFile": True, "progress": {"completed": True}},
            {"id": 4, "seasonNumber": 1, "episodeNumber": 4, "hasFile": True, "progress": {"completed": False}},
        ]}]}
        self.assertEqual(next_unwatched_episode(series, 1), 4)
        self.assertIsNone(next_unwatched_episode(series, 4))

    def test_completion_threshold_and_deduplication(self) -> None:
        self.assertFalse(completion_state(89, 100, 90))
        self.assertTrue(completion_state(90, 100, 90))
        self.assertTrue(completion_state(1, 100, 90, ended=True))
        items = unique_items([{"type": "film", "id": 1}, {"mediaType": "film", "id": 1}, {"type": "series", "id": 1}])
        self.assertEqual(len(items), 2)


if __name__ == "__main__":
    unittest.main()
