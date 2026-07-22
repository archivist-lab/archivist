from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.playback import plan_playback, select_audio, select_subtitle


TRACKS = {
    "container": "matroska,webm",
    "video": {"codec": "hevc", "height": 2160},
    "audio": [
        {"index": 1, "codec": "eac3", "languageCode": "eng", "default": True},
        {"index": 2, "codec": "aac", "languageCode": "jpn", "default": False},
    ],
    "subtitles": [
        {"index": 3, "codec": "subrip", "languageCode": "eng", "forced": True, "textBased": True},
        {"index": 4, "codec": "pgs", "languageCode": "jpn", "forced": False, "textBased": False},
    ],
    "segments": {"intro": {"start": 12, "end": 78}},
}


class PlaybackTests(unittest.TestCase):
    def test_prefers_requested_audio_and_forced_subtitle(self) -> None:
        audio, ordinal = select_audio(TRACKS["audio"], "jpn")
        self.assertEqual((audio["index"], ordinal), (2, 1))
        subtitle, ordinal = select_subtitle(TRACKS["subtitles"], "eng", "forced")
        self.assertEqual((subtitle["index"], ordinal), (3, 0))

    def test_direct_play_and_transcode_fallback(self) -> None:
        direct = plan_playback(TRACKS, stream_path="/direct", transcode_path="/transcode", preferred_subtitle="eng")
        self.assertEqual(direct["mode"], "direct")
        self.assertEqual(direct["fallbackPath"], "/transcode?audio=1")
        self.assertEqual(direct["segments"]["intro"]["end"], 78)

        transcode = plan_playback(TRACKS, stream_path="/direct", transcode_path="/transcode", video_codecs="h264")
        self.assertEqual(transcode["mode"], "transcode")
        self.assertIn("video codec hevc", transcode["reason"])
        self.assertEqual(transcode["fallbackPath"], "")

    def test_bitmap_subtitle_is_burned_into_transcode(self) -> None:
        plan = plan_playback(
            TRACKS, stream_path="/direct", transcode_path="/transcode",
            preferred_subtitle="jpn", subtitle_mode="always", force_transcode=True,
        )
        self.assertIn("subs=4", plan["streamPath"])


if __name__ == "__main__":
    unittest.main()
