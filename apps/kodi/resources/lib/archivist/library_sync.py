from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from .artwork import ArtworkCache


@dataclass(frozen=True)
class SyncResult:
    changed: int
    removed: int
    films: int
    series: int
    episodes: int


def safe_name(value: object, fallback: str = "Untitled") -> str:
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", str(value or fallback))
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text[:120] or fallback


def _text(parent: ET.Element, tag: str, value: object | None, **attributes: str) -> None:
    if value is None or value == "":
        return
    node = ET.SubElement(parent, tag, attributes)
    node.text = str(value)


def _progress(root: ET.Element, item: dict[str, Any]) -> None:
    progress = item.get("progress") or {}
    _text(root, "playcount", 1 if progress.get("completed") else 0)
    position = float(progress.get("positionSeconds") or 0)
    total = float(progress.get("durationSeconds") or item.get("runtimeSeconds") or 0)
    if position > 0 and not progress.get("completed"):
        resume = ET.SubElement(root, "resume")
        _text(resume, "position", position)
        _text(resume, "total", total)


def _ids(root: ET.Element, item: dict[str, Any]) -> None:
    _text(root, "uniqueid", item.get("id"), type="archivist", default="true")
    for provider, value in (item.get("externalIds") or {}).items():
        _text(root, "uniqueid", value, type=str(provider))


def _common(root: ET.Element, item: dict[str, Any]) -> None:
    _text(root, "title", item.get("title"))
    _text(root, "sorttitle", item.get("sortTitle"))
    _text(root, "year", item.get("year"))
    _text(root, "plot", item.get("overview"))
    _text(root, "rating", item.get("rating"))
    _text(root, "mpaa", item.get("certification"))
    _text(root, "originaltitle", item.get("originalTitle"))
    _text(root, "premiered", item.get("releaseDate") or item.get("airDate"))
    _text(root, "studio", item.get("studio") or item.get("network"))
    _text(root, "country", item.get("country"))
    _text(root, "trailer", item.get("trailerUrl"))
    for genre in item.get("genres") or []:
        _text(root, "genre", genre)
    _ids(root, item)
    for person in item.get("cast") or []:
        actor = ET.SubElement(root, "actor")
        _text(actor, "name", person.get("name"))
        _text(actor, "role", person.get("role") or person.get("character"))
        _text(actor, "thumb", person.get("profileUrl") or person.get("imageUrl"))
    for person in item.get("crew") or []:
        job = str(person.get("job") or person.get("role") or "").lower()
        if job == "director":
            _text(root, "director", person.get("name"))
        elif job in {"writer", "screenplay", "story"}:
            _text(root, "credits", person.get("name"))
    ratings = item.get("ratings") or ([] if item.get("rating") is None else [{"provider": "default", "value": item["rating"], "scale": 10}])
    if ratings:
        node = ET.SubElement(root, "ratings")
        for index, rating in enumerate(ratings):
            entry = ET.SubElement(node, "rating", {
                "name": str(rating.get("provider") or "default"), "max": str(rating.get("scale") or 10),
                "default": "true" if index == 0 else "false",
            })
            _text(entry, "value", rating.get("value"))


def _stream_details(root: ET.Element, item: dict[str, Any]) -> None:
    media = item.get("mediaInfo") or {}
    video = media.get("video") or {}
    duration = video.get("durationSeconds") or item.get("runtimeSeconds")
    audio = media.get("audio") or []
    subtitles = media.get("subtitles") or []
    if not any((video, duration, audio, subtitles)):
        return
    fileinfo = ET.SubElement(root, "fileinfo")
    streams = ET.SubElement(fileinfo, "streamdetails")
    if video or duration:
        node = ET.SubElement(streams, "video")
        _text(node, "codec", video.get("codec"))
        _text(node, "aspect", video.get("aspect"))
        _text(node, "width", video.get("width"))
        _text(node, "height", video.get("height"))
        _text(node, "durationinseconds", round(float(duration)) if duration else None)
    for stream in audio:
        node = ET.SubElement(streams, "audio")
        _text(node, "codec", stream.get("codec"))
        _text(node, "language", stream.get("language"))
        _text(node, "channels", stream.get("channels"))
    for stream in subtitles:
        node = ET.SubElement(streams, "subtitle")
        _text(node, "language", stream.get("language"))


def _xml(root: ET.Element) -> bytes:
    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


class LibrarySynchronizer:
    """Writes an authoritative, Kodi-scannable STRM/NFO mirror."""

    def __init__(self, root: str, artwork: ArtworkCache, plugin_id: str = "plugin.video.archivist") -> None:
        self.root = Path(root)
        self.artwork = artwork
        self.plugin_id = plugin_id
        self.state_path = self.root / ".sync-state.json"

    def sync(self, manifest: dict[str, Any], include_films: bool = True, include_series: bool = True) -> SyncResult:
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / ".archivist-managed").write_text("Managed by Archivist for Kodi.\n", encoding="utf-8")
        previous = self._state().get("files", {})
        desired: dict[str, bytes] = {}
        film_count = series_count = episode_count = 0

        if include_films:
            for film in manifest.get("films") or []:
                self._film(desired, film)
                film_count += 1
        if include_series:
            for series in manifest.get("series") or []:
                episode_count += self._series(desired, series)
                series_count += 1

        hashes = {relative: hashlib.sha256(content).hexdigest() for relative, content in desired.items()}
        changed = 0
        for relative, content in desired.items():
            target = self.root / relative
            if previous.get(relative) == hashes[relative] and target.is_file():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(f"{target.suffix}.tmp")
            temporary.write_bytes(content)
            os.replace(temporary, target)
            changed += 1

        removed = 0
        for relative in set(previous) - set(desired):
            target = self.root / relative
            try:
                target.unlink()
                removed += 1
            except FileNotFoundError:
                pass
        self._prune_empty_directories()
        self._write_state({"schemaVersion": 1, "revision": manifest.get("revision"), "files": hashes})
        return SyncResult(changed, removed, film_count, series_count, episode_count)

    def _film(self, desired: dict[str, bytes], film: dict[str, Any]) -> None:
        label = safe_name(f"{film.get('title')} ({film.get('year')}) [{film.get('id')}]")
        base = Path("Movies") / label
        desired[str(base / "movie.strm")] = self._plugin_url("film", film["id"]).encode()
        root = ET.Element("movie")
        _common(root, film)
        _stream_details(root, film)
        _progress(root, film)
        if film.get("collection"):
            collection = ET.SubElement(root, "set")
            _text(collection, "name", film["collection"].get("name"))
        self._art(root, film.get("posterUrl"), film.get("backdropUrl"), film.get("logoUrl"), film.get("bannerUrl"))
        desired[str(base / "movie.nfo")] = _xml(root)

    def _series(self, desired: dict[str, bytes], series: dict[str, Any]) -> int:
        label = safe_name(f"{series.get('title')} ({series.get('year')}) [{series.get('id')}]")
        base = Path("TV Shows") / label
        root = ET.Element("tvshow")
        _common(root, series)
        self._art(root, series.get("posterUrl"), series.get("backdropUrl"), series.get("logoUrl"), series.get("bannerUrl"))
        desired[str(base / "tvshow.nfo")] = _xml(root)
        episode_count = 0
        for season in series.get("seasons") or []:
            number = int(season.get("seasonNumber") or 0)
            season_dir = base / f"Season {number:02d}"
            season_art = self._cached_art(season.get("posterUrl"))
            if season_art:
                suffix = Path(season_art).suffix or ".jpg"
                desired[str(base / f"season{number:02d}-poster{suffix}")] = Path(season_art).read_bytes()
            for episode in season.get("episodes") or []:
                ep = int(episode.get("episodeNumber") or 0)
                stem = f"S{number:02d}E{ep:02d}"
                desired[str(season_dir / f"{stem}.strm")] = self._plugin_url("episode", episode["id"]).encode()
                nfo = ET.Element("episodedetails")
                _common(nfo, episode)
                _stream_details(nfo, episode)
                _text(nfo, "showtitle", series.get("title"))
                _text(nfo, "season", number)
                _text(nfo, "episode", ep)
                _text(nfo, "aired", episode.get("airDate"))
                _progress(nfo, episode)
                self._art(nfo, episode.get("stillUrl"), None)
                desired[str(season_dir / f"{stem}.nfo")] = _xml(nfo)
                episode_count += 1
        return episode_count

    def _art(self, root: ET.Element, poster: str | None, fanart: str | None, logo: str | None = None, banner: str | None = None) -> None:
        local_poster = self._cached_art(poster)
        if local_poster:
            _text(root, "thumb", local_poster, aspect="poster")
        local_fanart = self._cached_art(fanart)
        if local_fanart:
            node = ET.SubElement(root, "fanart")
            _text(node, "thumb", local_fanart)
        for aspect, source in (("clearlogo", logo), ("banner", banner)):
            local = self._cached_art(source)
            if local:
                _text(root, "thumb", local, aspect=aspect)

    def _cached_art(self, source: str | None) -> str:
        if not source:
            return ""
        try:
            return self.artwork.resolve(source)
        except RuntimeError:
            return ""

    def _plugin_url(self, media_type: str, media_id: object) -> str:
        # The metadata schema marker deliberately changes STRM content when
        # Kodi needs to rescan existing entries for richer stream details.
        return f"plugin://{self.plugin_id}/?action=play&type={media_type}&id={media_id}&metadata=3"

    def _state(self) -> dict[str, Any]:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError, OSError):
            return {}

    def _write_state(self, state: dict[str, Any]) -> None:
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(temporary, self.state_path)

    def _prune_empty_directories(self) -> None:
        for directory in sorted((path for path in self.root.rglob("*") if path.is_dir()), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
