from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.library_sync import LibrarySynchronizer, safe_name


class FakeArtwork:
    def __init__(self, image: str) -> None:
        self.image = image

    def resolve(self, _source: str) -> str:
        return self.image


def manifest() -> dict:
    progress = {"positionSeconds": 120, "durationSeconds": 7200, "completed": False}
    return {
        "revision": "one",
        "films": [{
            "id": 7, "title": "Alien", "sortTitle": "Alien", "year": 1979,
            "overview": "In space.", "runtimeSeconds": 7020, "genres": ["Horror"],
            "originalTitle": "Alien", "studio": "Brandywine", "country": "US", "releaseDate": "1979-05-25",
            "cast": [{"name": "Sigourney Weaver", "role": "Ripley"}],
            "crew": [{"name": "Ridley Scott", "job": "Director"}],
            "posterUrl": "/media/alien/poster.jpg", "backdropUrl": "/media/alien/fanart.jpg",
            "externalIds": {"tmdb": 348, "imdb": "tt0078748"}, "progress": progress,
            "mediaInfo": {"container": "matroska", "video": {"codec": "hevc", "width": 1920, "height": 1080, "aspect": 1.777, "durationSeconds": 7021},
                          "audio": [{"codec": "eac3", "language": "eng", "channels": 6}], "subtitles": [{"language": "eng"}]},
        }],
        "series": [{
            "id": 9, "title": "Severance", "sortTitle": "Severance", "year": 2022,
            "overview": "Work-life balance.", "genres": ["Drama"], "posterUrl": "/media/severance/poster.jpg",
            "backdropUrl": "/media/severance/fanart.jpg", "externalIds": {"tvdb": 371980},
            "seasons": [{"id": 10, "seasonNumber": 1, "posterUrl": "/media/severance/season1.jpg", "episodes": [{
                "id": 11, "title": "Good News About Hell", "seasonNumber": 1, "episodeNumber": 1,
                "overview": "The pilot.", "runtimeSeconds": 3360, "airDate": "2022-02-18",
                "stillUrl": "/media/severance/s01e01.jpg", "progress": {"completed": True},
            }]}],
        }],
    }


class LibrarySyncTests(unittest.TestCase):
    def test_writes_native_strm_nfo_artwork_and_incremental_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "cached.jpg"
            image.write_bytes(b"jpeg")
            root = Path(directory) / "library"
            sync = LibrarySynchronizer(str(root), FakeArtwork(str(image)))
            first = sync.sync(manifest())
            self.assertEqual((first.films, first.series, first.episodes), (1, 1, 1))
            self.assertGreater(first.changed, 0)
            movie = next(root.glob("Movies/*/movie.strm"))
            self.assertEqual(movie.read_text(), "plugin://plugin.video.archivist/?action=play&type=film&id=7&metadata=3")
            movie_nfo = ET.parse(next(root.glob("Movies/*/movie.nfo"))).getroot()
            self.assertEqual(movie_nfo.findtext("uniqueid[@type='archivist']"), "7")
            self.assertEqual(movie_nfo.findtext("resume/position"), "120.0")
            self.assertEqual(movie_nfo.findtext("fileinfo/streamdetails/video/durationinseconds"), "7021")
            self.assertEqual(movie_nfo.findtext("fileinfo/streamdetails/video/codec"), "hevc")
            self.assertEqual(movie_nfo.findtext("fileinfo/streamdetails/audio/channels"), "6")
            self.assertEqual(movie_nfo.findtext("actor/name"), "Sigourney Weaver")
            self.assertEqual(movie_nfo.findtext("director"), "Ridley Scott")
            self.assertEqual(movie_nfo.findtext("premiered"), "1979-05-25")
            episode_nfo = ET.parse(next(root.glob("TV Shows/*/Season 01/S01E01.nfo"))).getroot()
            self.assertEqual(episode_nfo.findtext("playcount"), "1")
            self.assertTrue(next(root.glob("TV Shows/*/season01-poster.jpg")).is_file())
            second = sync.sync(manifest())
            self.assertEqual((second.changed, second.removed), (0, 0))

    def test_removes_entries_missing_from_authoritative_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "cached.jpg"
            image.write_bytes(b"jpeg")
            root = Path(directory) / "library"
            sync = LibrarySynchronizer(str(root), FakeArtwork(str(image)))
            sync.sync(manifest())
            empty = {"revision": "two", "films": [], "series": []}
            result = sync.sync(empty)
            self.assertGreater(result.removed, 0)
            self.assertEqual(list(root.glob("Movies/**/*.strm")), [])
            self.assertEqual(list(root.glob("TV Shows/**/*.strm")), [])
            state = json.loads((root / ".sync-state.json").read_text())
            self.assertEqual(state["revision"], "two")

    def test_sanitizes_kodi_file_names(self) -> None:
        self.assertEqual(safe_name('A/B: C*?'), "A B C")


if __name__ == "__main__":
    unittest.main()
