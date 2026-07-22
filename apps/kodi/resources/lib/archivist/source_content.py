from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Any


VIDEO_DB = re.compile(r"^MyVideos(\d+)\.db$", re.IGNORECASE)


def find_video_database(database_root: str) -> Path:
    candidates: list[tuple[int, Path]] = []
    for path in Path(database_root).glob("MyVideos*.db"):
        match = VIDEO_DB.match(path.name)
        if match:
            candidates.append((int(match.group(1)), path))
    if not candidates:
        raise RuntimeError("Kodi's local MyVideos database could not be found")
    return max(candidates, key=lambda candidate: candidate[0])[1]


def ensure_content_types(database_root: str, movies_path: str | None, shows_path: str | None) -> bool:
    """Assign fixed Kodi content types to Archivist-owned source paths only."""
    database = find_video_database(database_root)
    connection = sqlite3.connect(str(database), timeout=10)
    try:
        connection.execute("PRAGMA busy_timeout = 10000")
        columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(path)")}
        required = {"strPath", "strContent"}
        if not required.issubset(columns):
            raise RuntimeError("Kodi's video path schema is not supported")
        changed = False
        for source_path, content, folders, recursive in (
            # Movies live one folder below the source. Kodi's movie scanner
            # only descends into those folders when recursion is enabled.
            (movies_path, "movies", 1, 1),
            # Kodi's TV scanner handles show/season traversal itself.
            (shows_path, "tvshows", 0, 0),
        ):
            if not source_path:
                continue
            values: dict[str, Any] = {
                "strPath": _kodi_path(source_path),
                "strContent": content,
                "strScraper": "metadata.local",
                "scanRecursive": recursive,
                "useFolderNames": folders,
                "strSettings": "",
                "noUpdate": 0,
                "exclude": 0,
            }
            values = {key: value for key, value in values.items() if key in columns}
            existing = connection.execute(
                "SELECT * FROM path WHERE strPath = ?", (values["strPath"],)
            ).fetchone()
            if existing is None:
                names = ", ".join(values)
                placeholders = ", ".join("?" for _ in values)
                connection.execute(
                    f"INSERT INTO path ({names}) VALUES ({placeholders})", tuple(values.values())
                )
                changed = True
                continue
            selected = connection.execute(
                f"SELECT {', '.join(values)} FROM path WHERE strPath = ?", (values["strPath"],)
            ).fetchone()
            if selected != tuple(values.values()):
                assignments = ", ".join(f"{name} = ?" for name in values if name != "strPath")
                parameters = [value for name, value in values.items() if name != "strPath"]
                connection.execute(
                    f"UPDATE path SET {assignments} WHERE strPath = ?", (*parameters, values["strPath"])
                )
                changed = True
        connection.commit()
        return changed
    except sqlite3.Error as error:
        connection.rollback()
        raise RuntimeError(f"Kodi video content setup failed: {error}") from error
    finally:
        connection.close()


def _kodi_path(value: str) -> str:
    return value.rstrip("/\\") + "/"
