from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.source_content import ensure_content_types, find_video_database


class SourceContentTests(unittest.TestCase):
    def _database(self, root: Path, version: int = 121) -> Path:
        path = root / f"MyVideos{version}.db"
        db = sqlite3.connect(path)
        db.executescript("""
            CREATE TABLE path (
              idPath INTEGER PRIMARY KEY,
              strPath TEXT UNIQUE,
              strContent TEXT,
              strScraper TEXT,
              scanRecursive INTEGER,
              useFolderNames INTEGER,
              strSettings TEXT,
              noUpdate INTEGER,
              exclude INTEGER
            );
            INSERT INTO path (strPath, strContent, strScraper)
            VALUES ('/personal/', 'movies', 'metadata.themoviedb.org.python');
        """)
        db.commit()
        db.close()
        return path

    def test_selects_newest_database_and_hardcodes_managed_types(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._database(root, 120)
            database = self._database(root, 131)
            self.assertEqual(find_video_database(str(root)), database)
            self.assertTrue(ensure_content_types(str(root), "/addon/Movies", "/addon/TV Shows"))
            self.assertFalse(ensure_content_types(str(root), "/addon/Movies", "/addon/TV Shows"))
            db = sqlite3.connect(database)
            try:
                rows = db.execute("SELECT strPath, strContent, strScraper, useFolderNames, scanRecursive FROM path ORDER BY strPath").fetchall()
            finally:
                db.close()
            self.assertEqual(rows, [
                ("/addon/Movies/", "movies", "metadata.local", 1, 1),
                ("/addon/TV Shows/", "tvshows", "metadata.local", 0, 0),
                ("/personal/", "movies", "metadata.themoviedb.org.python", None, None),
            ])

    def test_updates_existing_managed_path_without_touching_other_sources(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = self._database(root)
            db = sqlite3.connect(database)
            db.execute("INSERT INTO path (strPath, strContent, strScraper) VALUES ('/addon/Movies/', '', '')")
            db.commit()
            db.close()
            self.assertTrue(ensure_content_types(str(root), "/addon/Movies", None))
            db = sqlite3.connect(database)
            try:
                managed = db.execute("SELECT strContent, strScraper FROM path WHERE strPath='/addon/Movies/'").fetchone()
                personal = db.execute("SELECT strContent, strScraper FROM path WHERE strPath='/personal/'").fetchone()
            finally:
                db.close()
            self.assertEqual(managed, ("movies", "metadata.local"))
            self.assertEqual(personal, ("movies", "metadata.themoviedb.org.python"))

    def test_repairs_non_recursive_movie_setting_from_031(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = self._database(root)
            db = sqlite3.connect(database)
            db.execute("""INSERT INTO path
              (strPath, strContent, strScraper, scanRecursive, useFolderNames, strSettings, noUpdate, exclude)
              VALUES ('/addon/Movies/', 'movies', 'metadata.local', 0, 1, '', 0, 0)""")
            db.commit()
            db.close()
            self.assertTrue(ensure_content_types(str(root), "/addon/Movies", None))
            db = sqlite3.connect(database)
            try:
                value = db.execute("SELECT scanRecursive FROM path WHERE strPath='/addon/Movies/'").fetchone()
            finally:
                db.close()
            self.assertEqual(value, (1,))


if __name__ == "__main__":
    unittest.main()
