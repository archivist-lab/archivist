from __future__ import annotations

import json
from typing import Any

import xbmc

from .progress_sync import reconcile_progress


def _rpc(method: str, params: dict[str, Any] | None = None) -> Any:
    response = json.loads(xbmc.executeJSONRPC(json.dumps({
        "jsonrpc": "2.0", "id": "archivist-native", "method": method, "params": params or {},
    })))
    if response.get("error"):
        raise RuntimeError(f"Kodi {method} failed: {response['error'].get('message', 'unknown error')}")
    return response.get("result") or {}


def _archivist_id(item: dict[str, Any]) -> int:
    unique = item.get("uniqueid") or {}
    try:
        return int(unique.get("archivist") or 0)
    except (TypeError, ValueError):
        return 0


def kodi_progress_items() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    movies = _rpc("VideoLibrary.GetMovies", {"properties": ["uniqueid", "playcount", "resume"]}).get("movies", [])
    episodes = _rpc("VideoLibrary.GetEpisodes", {"properties": ["uniqueid", "playcount", "resume"]}).get("episodes", [])
    for kind, id_key, items in (("film", "movieid", movies), ("episode", "episodeid", episodes)):
        for item in items:
            media_id = _archivist_id(item)
            if media_id:
                result.append({**item, "type": kind, "id": media_id, "kodiId": int(item[id_key])})
    return result


def reconcile_native_progress(api, manifest: dict[str, Any], state_path: str) -> tuple[int, int]:
    def push(kind: str, media_id: int, value: dict[str, Any]) -> None:
        if not value["completed"] and value["position"] <= 0:
            api.clear_progress(kind, media_id)
        else:
            api.save_progress(kind, media_id, value["position"], value["duration"], value["completed"])

    def apply(item: dict[str, Any], value: dict[str, Any]) -> None:
        method = "VideoLibrary.SetMovieDetails" if item["type"] == "film" else "VideoLibrary.SetEpisodeDetails"
        id_key = "movieid" if item["type"] == "film" else "episodeid"
        _rpc(method, {
            id_key: item["kodiId"], "playcount": 1 if value["completed"] else 0,
            "resume": {"position": 0 if value["completed"] else value["position"], "total": value["duration"]},
        })

    return reconcile_progress(manifest, kodi_progress_items(), state_path, push, apply)


def _clean(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value not in (None, "", [])}


def _seconds(value: Any) -> int | None:
    try:
        return max(0, round(float(value)))
    except (TypeError, ValueError):
        return None


def _crew(item: dict[str, Any], jobs: set[str]) -> list[str]:
    return [str(person["name"]) for person in item.get("crew") or []
            if person.get("name") and str(person.get("job") or person.get("role") or "").lower() in jobs]


def _actors(item: dict[str, Any]) -> list[dict[str, Any]]:
    return [_clean({"name": person.get("name"), "role": person.get("role") or person.get("character"), "order": index})
            for index, person in enumerate(item.get("cast") or []) if person.get("name")]


def reconcile_native_metadata(manifest: dict[str, Any]) -> int:
    """Apply authoritative NFO fields to existing rows after Kodi's scan finishes."""
    movies = _rpc("VideoLibrary.GetMovies", {"properties": ["uniqueid"]}).get("movies", [])
    shows = _rpc("VideoLibrary.GetTVShows", {"properties": ["uniqueid"]}).get("tvshows", [])
    episodes = _rpc("VideoLibrary.GetEpisodes", {"properties": ["uniqueid"]}).get("episodes", [])
    movie_ids = {_archivist_id(item): item["movieid"] for item in movies if _archivist_id(item)}
    show_ids = {_archivist_id(item): item["tvshowid"] for item in shows if _archivist_id(item)}
    episode_ids = {_archivist_id(item): item["episodeid"] for item in episodes if _archivist_id(item)}
    updated = 0
    for film in manifest.get("films") or []:
        kodi_id = movie_ids.get(int(film["id"]))
        if kodi_id is None:
            continue
        _rpc("VideoLibrary.SetMovieDetails", _clean({
            "movieid": kodi_id, "title": film.get("title"), "sorttitle": film.get("sortTitle"),
            "originaltitle": film.get("originalTitle"), "plot": film.get("overview"), "year": film.get("year"),
            "runtime": _seconds(film.get("runtimeSeconds")), "rating": film.get("rating"), "mpaa": film.get("certification"),
            "genre": film.get("genres"), "studio": [film["studio"]] if film.get("studio") else [],
            "country": [film["country"]] if film.get("country") else [], "premiered": film.get("releaseDate"),
            "trailer": film.get("trailerUrl"), "director": _crew(film, {"director"}),
            "writer": _crew(film, {"writer", "screenplay", "story"}), "actor": _actors(film),
        }))
        updated += 1
    for series in manifest.get("series") or []:
        kodi_id = show_ids.get(int(series["id"]))
        if kodi_id is not None:
            _rpc("VideoLibrary.SetTVShowDetails", _clean({
                "tvshowid": kodi_id, "title": series.get("title"), "sorttitle": series.get("sortTitle"),
                "plot": series.get("overview"), "year": series.get("year"), "rating": series.get("rating"),
                "mpaa": series.get("certification"), "genre": series.get("genres"),
                "studio": [series["network"]] if series.get("network") else [], "status": series.get("seriesStatus"),
                "director": _crew(series, {"director"}), "actor": _actors(series),
            }))
            updated += 1
        for season in series.get("seasons") or []:
            for episode in season.get("episodes") or []:
                episode_kodi_id = episode_ids.get(int(episode["id"]))
                if episode_kodi_id is None:
                    continue
                _rpc("VideoLibrary.SetEpisodeDetails", _clean({
                    "episodeid": episode_kodi_id, "title": episode.get("title"), "plot": episode.get("overview"),
                    "runtime": _seconds(episode.get("runtimeSeconds")), "season": episode.get("seasonNumber"),
                    "episode": episode.get("episodeNumber"), "firstaired": episode.get("airDate"),
                }))
                updated += 1
    return updated
