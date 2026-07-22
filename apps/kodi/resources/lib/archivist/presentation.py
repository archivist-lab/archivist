from __future__ import annotations

from typing import Any, Iterable


def media_type(item: dict[str, Any]) -> str:
    value = str(item.get("type") or item.get("mediaType") or "").lower()
    return {"films": "film", "movies": "film", "episodes": "episode"}.get(value, value)


def progress_values(item: dict[str, Any]) -> tuple[float, float, bool]:
    progress = item.get("progress") or {}
    position = float(progress.get("positionSeconds") or item.get("positionSeconds") or 0)
    duration = float(progress.get("durationSeconds") or item.get("durationSeconds") or item.get("runtimeSeconds") or 0)
    return position, duration, bool(progress.get("completed", item.get("completed", False)))


def info_labels(item: dict[str, Any]) -> dict[str, Any]:
    kind = media_type(item)
    title = item.get("title") or "Untitled"
    labels: dict[str, Any] = {
        "title": title,
        "originaltitle": item.get("originalTitle") or title,
        "plot": item.get("overview") or item.get("plot") or "",
        "year": item.get("year"),
        "rating": item.get("rating"),
        "mpaa": item.get("certification"),
        "genre": item.get("genres") or [],
        "studio": item.get("studio") or item.get("network"),
        "duration": item.get("runtimeSeconds"),
        "dateadded": item.get("acquiredAt") or item.get("addedAt"),
        "mediatype": {"film": "movie", "series": "tvshow", "episode": "episode"}.get(kind, "video"),
    }
    if kind == "episode":
        labels.update({
            "tvshowtitle": item.get("seriesTitle") or "",
            "season": item.get("seasonNumber"),
            "episode": item.get("episodeNumber"),
            "aired": item.get("airDate"),
        })
    return {key: value for key, value in labels.items() if value not in (None, "", [])}


def stream_details(item: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    media = item.get("mediaInfo") or {}
    video = media.get("video") or {}
    quality = item.get("quality") or {}
    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    if not width and not height:
        resolution = str(quality.get("resolution") or "").lower()
        dimensions = {"2160p": (3840, 2160), "4k": (3840, 2160), "1080p": (1920, 1080), "720p": (1280, 720), "480p": (720, 480)}
        width, height = dimensions.get(resolution, (0, 0))
    duration = round(float(video.get("durationSeconds") or item.get("runtimeSeconds") or 0))
    video_values = {
        "codec": video.get("codec") or quality.get("codec"),
        "width": width or None,
        "height": height or None,
        "aspect": video.get("aspect"),
        "duration": duration or None,
    }
    videos = [{key: value for key, value in video_values.items() if value is not None}] if any(video_values.values()) else []
    audio = [{key: value for key, value in {
        "codec": track.get("codec"), "language": track.get("language"), "channels": track.get("channels"),
    }.items() if value is not None} for track in media.get("audio") or []]
    subtitles = [{"language": track["language"]} for track in media.get("subtitles") or [] if track.get("language")]
    return {"video": videos, "audio": audio, "subtitle": subtitles}


def ordered_episodes(series: dict[str, Any]) -> list[dict[str, Any]]:
    episodes = [episode for season in series.get("seasons", []) for episode in season.get("episodes", [])]
    return sorted(episodes, key=lambda episode: (int(episode.get("seasonNumber") or 0), int(episode.get("episodeNumber") or 0)))


def next_unwatched_episode(series: dict[str, Any], current_id: int) -> int | None:
    episodes = ordered_episodes(series)
    found = False
    for episode in episodes:
        if int(episode.get("id") or 0) == current_id:
            found = True
            continue
        if not found or not episode.get("hasFile"):
            continue
        _, _, completed = progress_values(episode)
        if not completed:
            return int(episode["id"])
    return None


def find_season(series: dict[str, Any], season_number: int) -> dict[str, Any] | None:
    return next((season for season in series.get("seasons", []) if int(season.get("seasonNumber") or 0) == season_number), None)


def unique_items(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in items:
        key = f"{media_type(item)}:{item.get('id')}"
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def completion_state(position: float, duration: float, threshold: int, ended: bool = False) -> bool:
    if ended:
        return True
    bounded_threshold = max(50, min(100, threshold))
    return duration > 0 and position / duration * 100 >= bounded_threshold
