from __future__ import annotations

from typing import Any
from urllib.parse import urlencode


DEFAULT_VIDEO_CODECS = "h264,hevc,mpeg2video,vc1,vp8,vp9,av1"
DEFAULT_AUDIO_CODECS = "aac,ac3,eac3,dts,truehd,flac,mp3,opus,vorbis"


def _codecs(value: str, fallback: str) -> set[str]:
    return {item.strip().lower() for item in (value or fallback).split(",") if item.strip()}


def _language_match(track: dict[str, Any], preferred: str) -> bool:
    wanted = preferred.strip().lower()
    if not wanted:
        return False
    return wanted in {
        str(track.get("languageCode") or "").lower(),
        str(track.get("language") or "").lower(),
    }


def select_audio(tracks: list[dict[str, Any]], preferred_language: str) -> tuple[dict[str, Any] | None, int]:
    if not tracks:
        return None, -1
    selected = next((track for track in tracks if _language_match(track, preferred_language) and track.get("default")), None)
    selected = selected or next((track for track in tracks if _language_match(track, preferred_language)), None)
    selected = selected or next((track for track in tracks if track.get("default")), tracks[0])
    return selected, tracks.index(selected)


def select_subtitle(
    tracks: list[dict[str, Any]], preferred_language: str, mode: str,
) -> tuple[dict[str, Any] | None, int]:
    if not tracks or mode == "off":
        return None, -1
    matching = [track for track in tracks if _language_match(track, preferred_language)]
    if mode == "forced":
        candidates = [track for track in matching if track.get("forced")]
    elif mode == "preferred":
        candidates = [track for track in matching if track.get("forced")] or matching
    else:
        candidates = matching or tracks
    if not candidates:
        return None, -1
    selected = next((track for track in candidates if track.get("default")), candidates[0])
    return selected, tracks.index(selected)


def plan_playback(
    tracks: dict[str, Any], *, stream_path: str, transcode_path: str,
    video_codecs: str = DEFAULT_VIDEO_CODECS, audio_codecs: str = DEFAULT_AUDIO_CODECS,
    max_height: int = 2160, preferred_audio: str = "", preferred_subtitle: str = "",
    subtitle_mode: str = "forced", force_transcode: bool = False,
) -> dict[str, Any]:
    audio, audio_ordinal = select_audio(list(tracks.get("audio") or []), preferred_audio)
    subtitle, subtitle_ordinal = select_subtitle(list(tracks.get("subtitles") or []), preferred_subtitle, subtitle_mode)
    video = tracks.get("video") or {}
    video_codec = str(video.get("codec") or "").lower()
    audio_codec = str((audio or {}).get("codec") or "").lower()
    height = int(video.get("height") or 0)
    unsupported: list[str] = []
    if video_codec and video_codec not in _codecs(video_codecs, DEFAULT_VIDEO_CODECS):
        unsupported.append(f"video codec {video_codec}")
    if audio_codec and audio_codec not in _codecs(audio_codecs, DEFAULT_AUDIO_CODECS):
        unsupported.append(f"audio codec {audio_codec}")
    if max_height > 0 and height > max_height:
        unsupported.append(f"{height}p exceeds {max_height}p")

    mode = "transcode" if force_transcode or unsupported else "direct"
    reason = "Manual compatibility fallback" if force_transcode else ", ".join(unsupported) if unsupported else "Device supports the selected streams"
    query: dict[str, object] = {}
    if audio is not None:
        query["audio"] = int(audio.get("index", 0))
    if subtitle is not None and not subtitle.get("textBased"):
        query["subs"] = int(subtitle.get("index", 0))
    separator = "&" if "?" in transcode_path else "?"
    transcode_url = f"{transcode_path}{separator}{urlencode(query)}" if query else transcode_path
    return {
        "mode": mode,
        "reason": reason,
        "streamPath": transcode_url if mode == "transcode" else stream_path,
        "fallbackPath": "" if mode == "transcode" else transcode_url,
        "audio": audio,
        "audioOrdinal": audio_ordinal,
        "subtitle": subtitle,
        "subtitleOrdinal": subtitle_ordinal,
        "segments": tracks.get("segments"),
        "analysis": tracks.get("segmentAnalysis"),
        "diagnostics": {
            "mode": mode, "reason": reason, "container": tracks.get("container"),
            "videoCodec": video_codec or None, "height": height or None,
            "audioCodec": audio_codec or None,
            "audioTrack": (audio or {}).get("title") or (audio or {}).get("language"),
            "subtitleTrack": (subtitle or {}).get("title") or (subtitle or {}).get("language"),
        },
    }
