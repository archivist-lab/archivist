from __future__ import annotations

from dataclasses import dataclass
import json
import time
from pathlib import Path
from typing import Any

import xbmc
import xbmcaddon
import xbmcgui
import xbmcvfs

from .api import ArchivistApi, ArchivistApiError, Connection
from .presentation import completion_state
from .kodi_sync import synchronize
from .native_sync import reconcile_native_metadata, reconcile_native_progress
from .routing import integer
from .sync_status import SyncStatus
from .change_feed import SyncChangeFeed


ADDON_ID = "plugin.video.archivist"


@dataclass
class PlayingMedia:
    media_type: str
    media_id: int
    next_episode_id: int = 0
    position: float = 0
    duration: float = 0
    segments: dict[str, Any] | None = None
    intro_handled: bool = False
    credits_handled: bool = False


class ArchivistPlayer(xbmc.Player):
    def __init__(self, api_factory, addon: AnyAddon) -> None:
        super().__init__()
        self.api_factory = api_factory
        self.addon = addon
        self.current: PlayingMedia | None = None

    def onAVStarted(self) -> None:
        item = self.getPlayingItem()
        window = xbmcgui.Window(10000)
        value = lambda key: item.getProperty(f"Archivist.{key}") or window.getProperty(f"Archivist.Pending.{key}")
        media_type = value("Type")
        media_id = integer(value("Id"))
        next_id = integer(value("NextEpisodeId"))
        try:
            segments = json.loads(value("Segments") or "{}")
        except ValueError:
            segments = {}
        audio_ordinal = integer(value("AudioOrdinal"), -1)
        subtitle_ordinal = integer(value("SubtitleOrdinal"), -1)
        subtitle_external = value("SubtitleExternal") == "true"
        for key in (
            "Type", "Id", "Profile", "NextEpisodeId", "PlaybackMode", "PlaybackReason",
            "AudioOrdinal", "SubtitleOrdinal", "SubtitleExternal", "Segments", "FallbackRoute",
        ):
            window.clearProperty(f"Archivist.Pending.{key}")
        if media_type not in {"film", "episode"} or media_id < 1:
            self.current = None
            return
        self.current = PlayingMedia(media_type, media_id, next_id, segments=segments)
        try:
            if audio_ordinal >= 0:
                self.setAudioStream(audio_ordinal)
            if subtitle_external:
                self.showSubtitles(True)
            elif subtitle_ordinal >= 0:
                self.setSubtitleStream(subtitle_ordinal)
                self.showSubtitles(True)
        except (AttributeError, RuntimeError) as error:
            xbmc.log(f"[Archivist] Preferred track selection was not applied: {error}", xbmc.LOGWARNING)
        self._capture_time()
        self._report(False)

    def onPlayBackError(self) -> None:
        window = xbmcgui.Window(10000)
        fallback = window.getProperty("Archivist.Pending.FallbackRoute")
        window.clearProperty("Archivist.Pending.FallbackRoute")
        if fallback:
            xbmc.log("[Archivist] Direct play failed; retrying with compatibility transcoding", xbmc.LOGWARNING)
            xbmcgui.Dialog().notification("Archivist", "Retrying with compatibility playback", xbmcgui.NOTIFICATION_WARNING)
            xbmc.executebuiltin(f"PlayMedia({fallback})")

    def onPlayBackPaused(self) -> None:
        self._capture_time()
        self._report(False)

    def onPlayBackStopped(self) -> None:
        self._capture_time()
        self._report(False)
        self.current = None

    def onPlayBackEnded(self) -> None:
        current = self.current
        self._capture_time()
        self._report(True)
        self.current = None
        if current and current.next_episode_id and self.addon.getSettingBool("auto_play_next"):
            xbmc.executebuiltin(
                f"PlayMedia(plugin://{ADDON_ID}/?action=play&type=episode&id={current.next_episode_id})"
            )

    def tick(self, report: bool = True) -> None:
        if not self.current or not self.isPlayingVideo():
            return
        self._capture_time()
        self._handle_segments()
        if report:
            self._report(False)

    def _handle_segments(self) -> None:
        if not self.current or not self.current.segments:
            return
        for kind in ("intro", "credits"):
            handled = self.current.intro_handled if kind == "intro" else self.current.credits_handled
            segment = self.current.segments.get(kind) or {}
            start = float(segment.get("start") or -1)
            end = float(segment.get("end") or -1)
            if handled or start < 0 or end <= start or not (start <= self.current.position < end):
                continue
            if kind == "intro":
                self.current.intro_handled = True
                should_skip = self.addon.getSettingBool("prompt_skip_intro") and xbmcgui.Dialog().yesno("Archivist", "Skip intro?")
            else:
                self.current.credits_handled = True
                should_skip = self.addon.getSettingBool("auto_skip_credits") or (
                    self.addon.getSettingBool("prompt_skip_credits") and xbmcgui.Dialog().yesno("Archivist", "Skip credits?")
                )
            if should_skip:
                try:
                    self.seekTime(end)
                    self.current.position = end
                except RuntimeError as error:
                    xbmc.log(f"[Archivist] Could not skip {kind}: {error}", xbmc.LOGWARNING)

    def _capture_time(self) -> None:
        if not self.current:
            return
        try:
            self.current.position = max(self.current.position, float(self.getTime()))
        except RuntimeError:
            pass
        try:
            self.current.duration = max(self.current.duration, float(self.getTotalTime()))
        except RuntimeError:
            pass

    def _report(self, ended: bool) -> None:
        if not self.current:
            return
        threshold = self.addon.getSettingInt("watched_threshold") or 90
        completed = completion_state(self.current.position, self.current.duration, threshold, ended)
        try:
            self.api_factory().save_progress(
                self.current.media_type,
                self.current.media_id,
                self.current.duration if completed else self.current.position,
                self.current.duration,
                completed,
            )
        except ArchivistApiError as error:
            xbmc.log(f"[Archivist] Could not save playback progress: {error}", xbmc.LOGWARNING)


class AnyAddon:
    """Small structural type usable on Kodi's runtime-only Addon object."""

    def getSettingString(self, name: str) -> str:  # pragma: no cover - runtime protocol
        raise NotImplementedError

    def getSettingBool(self, name: str) -> bool:  # pragma: no cover - runtime protocol
        raise NotImplementedError

    def getSettingInt(self, name: str) -> int:  # pragma: no cover - runtime protocol
        raise NotImplementedError


def _connection(addon: AnyAddon) -> Connection:
    return Connection(
        server_url=addon.getSettingString("server_url") or "http://localhost:2424",
        api_key=addon.getSettingString("api_key"),
        session_cookie=addon.getSettingString("session_cookie"),
        device_token=addon.getSettingString("device_token"),
        device_id=addon.getSettingString("device_id"),
        profile_id=addon.getSettingString("profile_id") or "default",
        verify_ssl=addon.getSettingBool("verify_ssl"),
    )


def run() -> None:
    addon = xbmcaddon.Addon(ADDON_ID)
    profile_root = Path(xbmcvfs.translatePath(f"special://profile/addon_data/{ADDON_ID}"))
    sync_status = SyncStatus(str(profile_root / "sync-status.json"))
    class ArchivistMonitor(xbmc.Monitor):
        def __init__(self) -> None:
            super().__init__()
            self.scan_finished = False

        def onScanFinished(self, library: str) -> None:
            if str(library).lower() == "video":
                self.scan_finished = True

    monitor = ArchivistMonitor()
    player = ArchivistPlayer(lambda: ArchivistApi(_connection(addon)), addon)
    status_state = sync_status.read()
    change_feed = SyncChangeFeed(
        lambda: ArchivistApi(_connection(addon)),
        cursor=int(status_state.get("changeCursor") or 0),
    )
    if addon.getSettingBool("library_sync") and addon.getSettingBool("event_sync"):
        change_feed.start()
    elapsed = 0
    native_elapsed = 0
    # Existing signed-in installations synchronize immediately after Kodi
    # starts or the add-on is upgraded instead of waiting a full interval.
    next_sync_at = 0
    while not monitor.abortRequested():
        if monitor.waitForAbort(1):
            break
        elapsed += 1
        native_elapsed += 1
        player.tick(False)
        interval = max(5, addon.getSettingInt("progress_interval") or 15)
        if elapsed >= interval:
            elapsed = 0
            player.tick(True)
            if addon.getSettingBool("library_sync") and (monitor.scan_finished or native_elapsed >= 60):
                native_elapsed = 0
                manifest_path = profile_root / "sync-manifest.json"
                try:
                    if manifest_path.is_file():
                        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                        if monitor.scan_finished:
                            reconcile_native_metadata(manifest)
                        pushed, applied = reconcile_native_progress(
                            ArchivistApi(_connection(addon)), manifest, str(profile_root / "progress-state.json"),
                        )
                        if pushed or applied:
                            xbmc.log(f"[Archivist] Kodi progress reconciled: {pushed} to server, {applied} to Kodi", xbmc.LOGINFO)
                        monitor.scan_finished = False
                except (ArchivistApiError, RuntimeError, OSError, ValueError) as error:
                    xbmc.log(f"[Archivist] Native progress reconciliation deferred: {error}", xbmc.LOGWARNING)
        sync_interval = max(5, addon.getSettingInt("sync_interval") or 15) * 60
        now = int(time.time())
        persisted_retry = int(sync_status.read().get("nextAttempt") or 0)
        event_change = change_feed.has_change() if addon.getSettingBool("event_sync") else False
        if addon.getSettingBool("library_sync") and now >= persisted_retry and (event_change or now >= next_sync_at):
            try:
                result = synchronize(ArchivistApi(_connection(addon)), addon)
                acknowledged_cursor = change_feed.acknowledge() if event_change else change_feed.cursor
                sync_status.success(result, now, change_cursor=acknowledged_cursor)
                next_sync_at = now + sync_interval
                xbmc.log(
                    f"[Archivist] Library sync complete: {result.changed} changed, {result.removed} removed",
                    xbmc.LOGINFO,
                )
            except ArchivistApiError as error:
                if event_change:
                    change_feed.retry()
                state = sync_status.failure(error, sync_interval, now)
                next_sync_at = int(state["nextAttempt"])
                xbmc.log(f"[Archivist] Library sync deferred: {error}", xbmc.LOGWARNING)
            except RuntimeError as error:
                if event_change:
                    change_feed.retry()
                state = sync_status.failure(error, sync_interval, now)
                next_sync_at = int(state["nextAttempt"])
                xbmc.log(f"[Archivist] Kodi library update failed: {error}", xbmc.LOGERROR)
    change_feed.stop()
