from __future__ import annotations

import sys
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import xbmc
import xbmcaddon
import xbmcgui
import xbmcplugin
import xbmcvfs

from .api import ArchivistApi, ArchivistApiError, Connection
from .artwork import ArtworkCache
from .kodi_sync import repair_managed_library, synchronize
from .offline_cache import OfflineBrowseCache
from .sync_status import SyncStatus
from .presentation import find_season, info_labels, media_type, next_unwatched_episode, progress_values, stream_details, unique_items
from .playback import DEFAULT_AUDIO_CODECS, DEFAULT_VIDEO_CODECS, plan_playback
from .routing import integer, parse_query, plugin_url


ADDON_ID = "plugin.video.archivist"


class ArchivistPlugin:
    def __init__(self, argv: list[str]) -> None:
        self.base_url = argv[0]
        self.handle = int(argv[1])
        self.params = parse_query(argv[2] if len(argv) > 2 else "")
        self.addon = xbmcaddon.Addon(ADDON_ID)
        self.api = ArchivistApi(self._connection())
        self._manifest_cache: dict[str, Any] | None = None
        self._offline_notice_shown = False
        self.profile_root = Path(xbmcvfs.translatePath(f"special://profile/addon_data/{ADDON_ID}"))
        namespace = f"{self.api.connection.base_url}|{self.api.connection.profile_id}"
        self.offline_cache = OfflineBrowseCache(str(self.profile_root / "browse-cache.json"), namespace)
        self.artwork = ArtworkCache(
            xbmcvfs.translatePath(f"special://profile/addon_data/{ADDON_ID}/artwork"),
            self.api.download,
        )

    def _connection(self) -> Connection:
        return Connection(
            server_url=self.addon.getSettingString("server_url") or "http://localhost:2424",
            api_key=self.addon.getSettingString("api_key"),
            session_cookie=self.addon.getSettingString("session_cookie"),
            device_token=self.addon.getSettingString("device_token"),
            device_id=self.addon.getSettingString("device_id"),
            profile_id=self.addon.getSettingString("profile_id") or "default",
            verify_ssl=self.addon.getSettingBool("verify_ssl"),
        )

    def execute(self) -> None:
        action = self.params.get("action", "root")
        routes: dict[str, Callable[[], None]] = {
            "root": self.root,
            "films": lambda: self.library("film"),
            "series": lambda: self.library("series"),
            "series_detail": self.series_detail,
            "season": self.season,
            "continue": self.continue_watching,
            "recent": self.recent,
            "recommendations": self.recommendations,
            "collections": self.collections,
            "collection": self.collection,
            "search": self.search,
            "play": self.play,
            "mark_watched": lambda: self.set_watched(True),
            "mark_unwatched": lambda: self.set_watched(False),
            "test": self.test_connection,
            "setup": self.setup_connection,
            "settings": self.open_settings,
            "sync": self.sync_library,
            "diagnostics": self.playback_diagnostics,
            "sync_status": self.sync_status,
            "offline_status": self.offline_status,
            "repair": self.repair_library,
        }
        route = routes.get(action)
        if not route:
            xbmcgui.Dialog().notification("Archivist", "Unknown add-on route", xbmcgui.NOTIFICATION_ERROR)
            return
        try:
            route()
        except ArchivistApiError as error:
            xbmc.log(f"[Archivist] API error: {error}", xbmc.LOGERROR)
            xbmcgui.Dialog().ok("Archivist", str(error))
            if action not in {"play", "mark_watched", "mark_unwatched", "test"}:
                xbmcplugin.endOfDirectory(self.handle, succeeded=False)
        except Exception as error:  # Kodi must always receive a closed directory.
            xbmc.log(f"[Archivist] Unexpected error: {error}", xbmc.LOGERROR)
            xbmcgui.Dialog().ok("Archivist", f"The request failed: {error}")
            if action not in {"play", "mark_watched", "mark_unwatched", "test"}:
                xbmcplugin.endOfDirectory(self.handle, succeeded=False)

    def root(self) -> None:
        if not (self.api.connection.session_cookie or self.api.connection.api_key):
            xbmcgui.Dialog().notification("Archivist", "Sign in before browsing", xbmcgui.NOTIFICATION_WARNING)
        self._folder("Configure Connection", "setup")
        self._folder("Continue Watching", "continue")
        self._folder("Recently Added", "recent")
        self._folder("Recommendations", "recommendations")
        self._folder("Films", "films")
        self._folder("Series", "series")
        self._folder("Collections", "collections")
        self._folder("Search", "search")
        self._folder("Test Connection", "test")
        self._folder("Synchronize Kodi Library", "sync")
        self._folder("Synchronization Status", "sync_status")
        self._folder("Offline Cache Status", "offline_status")
        self._folder("Repair Archivist Kodi Library", "repair")
        self._folder("Playback Diagnostics", "diagnostics")
        self._folder("Settings", "settings")
        self._finish("videos")

    def library(self, kind: str) -> None:
        endpoint = "films" if kind == "film" else "series"
        manifest = self._manifest()
        items = manifest.get(endpoint, [])
        page_size = self._integer_setting("page_size", 36)
        page = max(0, integer(self.params.get("page"), 0))
        start = page * page_size
        for item in items[start:start + page_size]:
            self._media(item)
        if start + page_size < len(items):
            self._folder("Next page", endpoint, page=page + 1)
        self._finish("movies" if kind == "film" else "tvshows")

    def continue_watching(self) -> None:
        response = self._cached("progress", lambda: self.api.get(
            self.api.player_path("progress"), {"profile": self.api.connection.profile_id},
        ))
        items = [item for item in response.get("progress", []) if not item.get("completed") and float(item.get("positionSeconds") or 0) > 0]
        for item in items:
            self._media(item)
        self._finish("videos")

    def recent(self) -> None:
        response = self._cached("home", lambda: self.api.get(self.api.player_path("home")))
        rails = response.get("rails", {})
        for item in unique_items([*rails.get("recentFilms", []), *rails.get("recentEpisodes", [])]):
            self._media(item)
        self._finish("videos")

    def recommendations(self) -> None:
        selected = self.params.get("kind")
        if not selected:
            self._folder("Films", "recommendations", kind="film")
            self._folder("Series", "recommendations", kind="series")
            return self._finish("videos")
        response = self._cached(f"recommendations:{selected}", lambda: self.api.get(
            self.api.player_path(f"recommendations/{selected}"), {"profile": self.api.connection.profile_id},
        ))
        for item in response.get("items", []):
            self._media(item)
        self._finish("movies" if selected == "film" else "tvshows")

    def collections(self) -> None:
        limit = self._integer_setting("page_size", 36)
        response = self._cached(f"collections:{limit}", lambda: self.api.get(
            self.api.player_path("browse/collections"),
            {"availability": "available", "sort": "title", "limit": limit},
        ))
        for item in response.get("items", []):
            self._folder(item.get("title") or "Collection", "collection", collection_id=item.get("id"), item=item)
        self._finish("sets")

    def collection(self) -> None:
        collection_id = integer(self.params.get("collection_id"))
        response = self._cached(f"collection:{collection_id}", lambda: self.api.get(
            self.api.player_path("browse/films"), {
                "collectionId": collection_id,
                "availability": "available", "sort": "year", "direction": "asc", "limit": 60,
            },
        ))
        for item in response.get("items", []):
            self._media(item)
        self._finish("movies")

    def search(self) -> None:
        query = self.params.get("query")
        if not query:
            query = xbmcgui.Dialog().input("Search Archivist", type=xbmcgui.INPUT_ALPHANUM).strip()
        if not query:
            return self._finish("videos")
        response = self._cached(f"search:{query.casefold()}", lambda: self.api.get(
            self.api.player_path("search"), {"q": query, "limit": 30},
        ))
        groups = response.get("groups", {})
        for item in unique_items([*groups.get("films", []), *groups.get("series", []), *groups.get("episodes", []), *groups.get("collections", [])]):
            if media_type(item) == "collection":
                self._folder(item.get("title") or "Collection", "collection", collection_id=item.get("id"), item=item)
            else:
                self._media(item)
        self._finish("videos")

    def series_detail(self) -> None:
        series_id = integer(self.params.get("id"))
        series = self._manifest_series(series_id)
        for season in series.get("seasons", []):
            self._folder(
                season.get("title") or f"Season {season.get('seasonNumber')}",
                "season", id=series_id, season=season.get("seasonNumber"), item={
                    **season, "type": "season", "overview": season.get("overview") or series.get("overview"),
                    "posterUrl": season.get("posterUrl") or series.get("posterUrl"), "backdropUrl": series.get("backdropUrl"),
                },
            )
        self._finish("seasons")

    def season(self) -> None:
        series = self._manifest_series(integer(self.params.get("id")))
        selected = find_season(series, integer(self.params.get("season")))
        if not selected:
            raise ArchivistApiError("Season not found", 404)
        episodes = selected.get("episodes", [])
        hide_watched = self.addon.getSettingBool("hide_watched_episodes")
        visible = [episode for episode in episodes if not (hide_watched and progress_values(episode)[2])]
        for episode in visible:
            enriched = {**episode, "seriesTitle": series.get("title"), "seriesPosterUrl": series.get("posterUrl")}
            self._media(enriched, next_episode=next_unwatched_episode(series, integer(episode.get("id"))))
        self._finish("episodes")

    def play(self) -> None:
        kind = self.params.get("type", "film")
        media_id = integer(self.params.get("id"))
        detail = self.api.film(media_id) if kind == "film" else self.api.episode(media_id)
        edition_id = integer(self.params.get("edition"), 0)
        if kind == "film" and not edition_id:
            edition_id = self._select_edition(detail)
            if edition_id < 0:
                xbmcplugin.setResolvedUrl(self.handle, False, xbmcgui.ListItem(offscreen=True))
                return
        edition = next((item for item in detail.get("editions", []) if int(item.get("id") or 0) == edition_id), None)
        playback = (edition or {}).get("playback") or detail.get("playback") or {}
        stream_url = playback.get("streamUrl")
        if not stream_url:
            raise ArchivistApiError("This item is not available to play", 404)
        plural = "films" if kind == "film" else "episodes"
        transcode_url = self.api.player_path(f"stream/{plural}/{media_id}/transcode")
        if edition_id:
            transcode_url = f"{transcode_url}?edition={edition_id}"
        tracks = self.api.tracks(kind, media_id, edition_id)
        plan = plan_playback(
            tracks,
            stream_path=stream_url,
            transcode_path=transcode_url,
            video_codecs=self.addon.getSettingString("video_codecs") or DEFAULT_VIDEO_CODECS,
            audio_codecs=self.addon.getSettingString("audio_codecs") or DEFAULT_AUDIO_CODECS,
            max_height=self._integer_setting("max_video_height", 2160),
            preferred_audio=self.addon.getSettingString("preferred_audio_language"),
            preferred_subtitle=self.addon.getSettingString("preferred_subtitle_language"),
            subtitle_mode=self.addon.getSettingString("subtitle_mode") or "forced",
            force_transcode=self.params.get("fallback") == "transcode" or self.addon.getSettingBool("force_transcode"),
        )
        list_item = self._list_item(detail, playable=True)
        list_item.setPath(self.api.kodi_url(plan["streamPath"]))
        list_item.setContentLookup(False)
        next_episode = integer(self.params.get("next"), 0)
        if kind == "episode" and not next_episode and self.addon.getSettingBool("auto_play_next"):
            try:
                next_episode = next_unwatched_episode(self.api.series(integer(detail.get("seriesId"))), media_id) or 0
            except ArchivistApiError:
                next_episode = 0
        fallback_route = ""
        if plan.get("fallbackPath"):
            fallback_route = plugin_url(
                self.base_url, "play", type=kind, id=media_id, next=next_episode,
                edition=edition_id or None, fallback="transcode",
            )
        properties = {
            "Type": kind,
            "Id": str(media_id),
            "Profile": self.api.connection.profile_id,
            "NextEpisodeId": str(next_episode or 0),
            "PlaybackMode": str(plan["mode"]),
            "PlaybackReason": str(plan["reason"]),
            "AudioOrdinal": str(plan.get("audioOrdinal", -1)),
            "SubtitleOrdinal": str(plan.get("subtitleOrdinal", -1)),
            "SubtitleExternal": "true" if int((plan.get("subtitle") or {}).get("index", 0)) < 0 else "false",
            "Segments": json.dumps(plan.get("segments") or {}),
            "FallbackRoute": fallback_route,
        }
        window = xbmcgui.Window(10000)
        for key, value in properties.items():
            list_item.setProperty(f"Archivist.{key}", value)
            window.setProperty(f"Archivist.Pending.{key}", value)
        selected_subtitle = plan.get("subtitle") or {}
        if selected_subtitle.get("textBased"):
            subtitle_path = self.api.player_path(
                f"stream/{plural}/{media_id}/subtitle/{selected_subtitle['index']}.vtt"
            )
            if edition_id:
                subtitle_path = f"{subtitle_path}?edition={edition_id}"
            list_item.setSubtitles([self.api.kodi_url(subtitle_path)])
        self.addon.setSettingString("last_playback_diagnostics", json.dumps({
            **plan["diagnostics"], "title": detail.get("title"), "edition": (edition or {}).get("name"),
        }))
        xbmcplugin.setResolvedUrl(self.handle, True, list_item)

    def _select_edition(self, detail: dict[str, Any]) -> int:
        editions = [edition for edition in detail.get("editions", []) if edition.get("available")]
        if len(editions) <= 1:
            return int(editions[0].get("id") or 0) if editions and editions[0].get("isDefault") else 0
        labels = []
        for edition in editions:
            quality = edition.get("quality") or {}
            technical = " · ".join(str(value) for value in (
                quality.get("resolution"), quality.get("source"), quality.get("codec")
            ) if value)
            runtime = int(float(edition.get("runtimeSeconds") or 0) / 60)
            suffix = " · ".join(value for value in (f"{runtime} min" if runtime else "", technical) if value)
            labels.append(f"{edition.get('name') or 'Edition'}{f' — {suffix}' if suffix else ''}")
        default_index = next((index for index, edition in enumerate(editions) if edition.get("isDefault")), 0)
        selected = xbmcgui.Dialog().select("Choose edition", labels, preselect=default_index)
        return -1 if selected < 0 else int(editions[selected].get("id") or 0)

    def playback_diagnostics(self) -> None:
        try:
            details = json.loads(self.addon.getSettingString("last_playback_diagnostics") or "{}")
        except ValueError:
            details = {}
        if not details:
            xbmcgui.Dialog().ok("Playback Diagnostics", "No Archivist playback has been planned yet.")
        else:
            labels = {
                "title": "Title", "edition": "Edition", "mode": "Mode", "reason": "Reason",
                "container": "Container", "videoCodec": "Video", "height": "Height",
                "audioCodec": "Audio", "audioTrack": "Audio track", "subtitleTrack": "Subtitle",
            }
            lines = [f"{labels[key]}: {details[key]}" for key in labels if details.get(key) not in (None, "")]
            xbmcgui.Dialog().textviewer("Playback Diagnostics", "\n".join(lines))
        self._finish("files")

    def set_watched(self, watched: bool) -> None:
        kind = self.params.get("type", "film")
        media_id = integer(self.params.get("id"))
        if watched:
            detail = self.api.film(media_id) if kind == "film" else self.api.episode(media_id)
            duration = float(detail.get("runtimeSeconds") or 0)
            self.api.save_progress(kind, media_id, duration, duration, True)
        else:
            self.api.clear_progress(kind, media_id)
        xbmcgui.Dialog().notification("Archivist", "Marked watched" if watched else "Marked unwatched", xbmcgui.NOTIFICATION_INFO)
        xbmc.executebuiltin("Container.Refresh")

    def test_connection(self) -> None:
        health = self.api.health()
        xbmcgui.Dialog().ok("Archivist", f"Connected to {health.get('serverName', 'Archivist')} {health.get('version', '')}")
        self._finish("files")

    def setup_connection(self) -> None:
        dialog = xbmcgui.Dialog()
        server_url = dialog.input(
            "Archivist server URL",
            defaultt=self.addon.getSettingString("server_url") or "http://localhost:2424",
            type=xbmcgui.INPUT_ALPHANUM,
        ).strip()
        if not server_url:
            return self._finish("files")
        username = dialog.input(
            "Archivist username",
            defaultt=self.addon.getSettingString("username"),
            type=xbmcgui.INPUT_ALPHANUM,
        ).strip()
        if not username:
            return self._finish("files")
        password = dialog.input(
            "Archivist password",
            type=xbmcgui.INPUT_ALPHANUM,
            option=xbmcgui.ALPHANUM_HIDE_INPUT,
        )
        if not password:
            return self._finish("files")
        profile_id = dialog.input(
            "Archivist Player profile",
            defaultt=self.addon.getSettingString("profile_id") or "default",
            type=xbmcgui.INPUT_ALPHANUM,
        ).strip() or "default"
        self.addon.setSettingString("server_url", server_url.rstrip("/"))
        login_api = ArchivistApi(Connection(server_url.rstrip("/"), verify_ssl=self.addon.getSettingBool("verify_ssl")))
        session_cookie = login_api.login(username, password)
        self.addon.setSettingString("username", username)
        session_api = ArchivistApi(Connection(
            server_url.rstrip("/"), session_cookie=session_cookie,
            verify_ssl=self.addon.getSettingBool("verify_ssl"),
        ))
        try:
            credential = session_api.register_device(xbmc.getInfoLabel("System.FriendlyName") or "Kodi device")
            self.addon.setSettingString("device_token", str(credential.get("token") or ""))
            self.addon.setSettingString("device_id", str(credential.get("id") or ""))
            self.addon.setSettingString("session_cookie", "")
        except ArchivistApiError as error:
            xbmc.log(f"[Archivist] Device credential unavailable; retaining login session: {error}", xbmc.LOGWARNING)
            self.addon.setSettingString("session_cookie", session_cookie)
        self.addon.setSettingString("profile_id", profile_id)
        self.api = ArchivistApi(self._connection())
        health = self.api.health()
        if self.addon.getSettingBool("library_sync"):
            synchronize(self.api, self.addon)
        dialog.ok("Archivist", f"Connected to {health.get('serverName', 'Archivist')} {health.get('version', '')}")
        self._finish("files")

    def open_settings(self) -> None:
        self.addon.openSettings()
        self._finish("files")

    def sync_library(self) -> None:
        profile_root = xbmcvfs.translatePath(f"special://profile/addon_data/{ADDON_ID}")
        status = SyncStatus(f"{profile_root}/sync-status.json")
        try:
            result = synchronize(self.api, self.addon)
            status.success(result)
        except Exception as error:
            status.failure(error, max(5, self._integer_setting("sync_interval", 15)) * 60)
            raise
        xbmcgui.Dialog().ok(
            "Archivist",
            f"Kodi library synchronized. {result.films} films, {result.series} series and "
            f"{result.episodes} episodes. {result.changed} files updated, {result.removed} removed.",
        )
        self._finish("files")

    def sync_status(self) -> None:
        profile_root = xbmcvfs.translatePath(f"special://profile/addon_data/{ADDON_ID}")
        state = SyncStatus(f"{profile_root}/sync-status.json").read()
        timestamp = lambda value: datetime.fromtimestamp(int(value)).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z") if value else "Never"
        lines = [
            f"Last success: {timestamp(state.get('lastSuccess'))}",
            f"Last attempt: {timestamp(state.get('lastAttempt'))}",
            f"Consecutive failures: {state.get('consecutiveFailures') or 0}",
            f"Next retry: {timestamp(state.get('nextAttempt')) if state.get('nextAttempt') else 'Normal schedule'}",
        ]
        if state.get("lastError"):
            lines.append(f"Last error: {state['lastError']}")
        xbmcgui.Dialog().textviewer("Archivist Synchronization", "\n".join(lines))
        self._finish("files")

    def offline_status(self) -> None:
        state = self.offline_cache.status()
        timestamp = lambda value: datetime.fromtimestamp(int(value)).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z") if value else "Never"
        enabled = self.addon.getSettingBool("offline_browse")
        lines = [
            f"Offline browsing: {'Enabled' if enabled else 'Disabled'}",
            f"Cached responses: {state['entries']}",
            f"Oldest response: {timestamp(state['oldest'])}",
            f"Newest response: {timestamp(state['newest'])}",
            f"Retention: {self._integer_setting('offline_cache_days', 30)} days",
            "",
            "Cached screens remain browsable during a temporary server outage. Playback and changes to watched state still require Archivist.",
        ]
        xbmcgui.Dialog().textviewer("Archivist Offline Cache", "\n".join(lines))
        self._finish("files")

    def repair_library(self) -> None:
        if not xbmcgui.Dialog().yesno("Archivist", "Rebuild the managed Archivist Movies and TV Shows library?"):
            return self._finish("files")
        result = repair_managed_library(self.api, self.addon)
        xbmcgui.Dialog().ok("Archivist", f"Repair complete. {result.changed} files rebuilt.")
        self._finish("files")

    def _media(self, item: dict[str, Any], next_episode: int | None = None) -> None:
        item = self._enrich_from_manifest(item)
        kind = media_type(item)
        if kind == "series":
            url = plugin_url(self.base_url, "series_detail", id=item.get("id"))
            list_item = self._list_item(item)
            xbmcplugin.addDirectoryItem(self.handle, url, list_item, isFolder=True)
            return
        if kind not in {"film", "episode"}:
            return
        url = plugin_url(self.base_url, "play", type=kind, id=item.get("id"), next=next_episode)
        list_item = self._list_item(item, playable=True)
        list_item.addContextMenuItems([
            ("Mark watched", f"RunPlugin({plugin_url(self.base_url, 'mark_watched', type=kind, id=item.get('id'))})"),
            ("Mark unwatched", f"RunPlugin({plugin_url(self.base_url, 'mark_unwatched', type=kind, id=item.get('id'))})"),
        ])
        xbmcplugin.addDirectoryItem(self.handle, url, list_item, isFolder=False)

    def _folder(self, label: str, action: str, item: dict[str, Any] | None = None, **params: object) -> None:
        list_item = self._list_item(item or {"title": label})
        xbmcplugin.addDirectoryItem(self.handle, plugin_url(self.base_url, action, **params), list_item, isFolder=True)

    def _list_item(self, item: dict[str, Any], playable: bool = False) -> Any:
        label = item.get("title") or item.get("seriesTitle") or "Untitled"
        list_item = xbmcgui.ListItem(label=label, offscreen=True)
        list_item.setInfo("video", info_labels(item))
        for stream_type, streams in stream_details(item).items():
            for stream in streams:
                list_item.addStreamInfo(stream_type, stream)
        poster = item.get("posterUrl") or item.get("seriesPosterUrl") or item.get("stillUrl")
        backdrop = item.get("backdropUrl") or item.get("landscapeUrl") or item.get("stillUrl")
        logo = item.get("logoUrl")
        art = {
            "poster": self._artwork(poster),
            "thumb": self._artwork(item.get("stillUrl") or poster),
            "fanart": self._artwork(backdrop),
            "clearlogo": self._artwork(logo),
        }
        list_item.setArt({key: value for key, value in art.items() if value})
        position, duration, completed = progress_values(item)
        try:
            if duration > 0:
                list_item.getVideoInfoTag().setResumePoint(position, duration)
        except (AttributeError, TypeError):
            list_item.setProperty("ResumeTime", str(position))
            list_item.setProperty("TotalTime", str(duration))
        list_item.setProperty("Watched", "true" if completed else "false")
        if playable:
            list_item.setProperty("IsPlayable", "true")
        return list_item

    def _manifest_series(self, series_id: int) -> dict[str, Any]:
        series = next(
            (item for item in self._manifest().get("series", []) if int(item.get("id") or 0) == series_id),
            None,
        )
        if not series:
            raise ArchivistApiError("Series not found or has no available episodes", 404)
        return series

    def _manifest(self) -> dict[str, Any]:
        if self._manifest_cache is None:
            try:
                self._manifest_cache = self._cached("manifest", self.api.sync_manifest)
            except ArchivistApiError as error:
                if error.status and error.status < 500:
                    raise
                manifest_path = self.profile_root / "sync-manifest.json"
                max_age = self._offline_max_age()
                if (
                    not self.addon.getSettingBool("offline_browse")
                    or not manifest_path.is_file()
                    or time.time() - manifest_path.stat().st_mtime > max_age
                ):
                    raise
                try:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    if not isinstance(manifest, dict):
                        raise ValueError("invalid manifest")
                except (OSError, ValueError):
                    raise error
                self.offline_cache.put("manifest", manifest, int(manifest_path.stat().st_mtime))
                self._manifest_cache = manifest
                self._notify_offline(int(manifest_path.stat().st_mtime))
        return self._manifest_cache

    def _enrich_from_manifest(self, item: dict[str, Any]) -> dict[str, Any]:
        kind = media_type(item)
        media_id = integer(item.get("id"))
        if not media_id or kind not in {"film", "series", "episode"}:
            return item
        try:
            manifest = self._manifest()
        except ArchivistApiError:
            return item
        candidates = manifest.get("films", []) if kind == "film" else manifest.get("series", [])
        if kind == "episode":
            candidates = [episode for series in manifest.get("series", []) for season in series.get("seasons", []) for episode in season.get("episodes", [])]
        match = next((candidate for candidate in candidates if integer(candidate.get("id")) == media_id), None)
        return {**item, **match} if match else item

    def _artwork(self, source: str | None) -> str:
        if not source:
            return ""
        try:
            return self.artwork.resolve(source) or self.api.kodi_url(source)
        except ArchivistApiError as error:
            xbmc.log(f"[Archivist] Artwork cache miss for {source}: {error}", xbmc.LOGWARNING)
            return self.api.kodi_url(source)

    def _finish(self, content: str) -> None:
        xbmcplugin.setContent(self.handle, content)
        xbmcplugin.addSortMethod(self.handle, xbmcplugin.SORT_METHOD_UNSORTED)
        xbmcplugin.endOfDirectory(self.handle, cacheToDisc=False)

    def _cached(self, key: str, loader: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        if not self.addon.getSettingBool("offline_browse"):
            return loader() or {}
        result = self.offline_cache.fetch(key, lambda: loader() or {}, self._offline_max_age())
        if result.offline:
            self._notify_offline(result.stored_at)
        return result.payload

    def _offline_max_age(self) -> int:
        return max(1, self._integer_setting("offline_cache_days", 30)) * 24 * 60 * 60

    def _notify_offline(self, stored_at: int) -> None:
        if self._offline_notice_shown:
            return
        self._offline_notice_shown = True
        age = max(0, int(time.time()) - stored_at)
        if age < 3600:
            description = f"{max(1, age // 60)} minutes old"
        elif age < 86400:
            description = f"{age // 3600} hours old"
        else:
            description = f"{age // 86400} days old"
        xbmcgui.Dialog().notification(
            "Archivist Offline", f"Showing cached library data ({description})", xbmcgui.NOTIFICATION_WARNING,
        )

    def _integer_setting(self, name: str, default: int) -> int:
        value = self.addon.getSettingInt(name)
        return value if value > 0 else default


def run(argv: list[str] | None = None) -> None:
    ArchivistPlugin(argv or sys.argv).execute()
