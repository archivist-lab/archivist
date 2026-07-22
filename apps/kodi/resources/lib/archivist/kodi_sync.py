from __future__ import annotations

import json
import shutil
from pathlib import Path

import xbmc
import xbmcvfs

from .api import ArchivistApi
from .artwork import ArtworkCache
from .library_sync import LibrarySynchronizer, SyncResult
from .sources import ensure_video_sources
from .source_content import ensure_content_types


ADDON_ID = "plugin.video.archivist"


def synchronize(api: ArchivistApi, addon) -> SyncResult:
    profile_root = xbmcvfs.translatePath(f"special://profile/addon_data/{ADDON_ID}")
    artwork = ArtworkCache(f"{profile_root}/artwork", api.download)
    library_root = f"{profile_root}/library"
    manifest = api.sync_manifest()
    result = LibrarySynchronizer(library_root, artwork, ADDON_ID).sync(
        manifest,
        include_films=addon.getSettingBool("sync_films"),
        include_series=addon.getSettingBool("sync_series"),
    )
    Path(profile_root).mkdir(parents=True, exist_ok=True)
    manifest_path = Path(profile_root) / "sync-manifest.json"
    temporary = manifest_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest), encoding="utf-8")
    temporary.replace(manifest_path)
    movies_path = f"{library_root}/Movies" if addon.getSettingBool("sync_films") else None
    shows_path = f"{library_root}/TV Shows" if addon.getSettingBool("sync_series") else None
    ensure_video_sources(
        xbmcvfs.translatePath("special://profile/sources.xml"),
        movies_path,
        shows_path,
    )
    content_changed = ensure_content_types(
        xbmcvfs.translatePath("special://database"), movies_path, shows_path,
    )
    if result.changed or result.removed or content_changed:
        _rpc("VideoLibrary.Scan", {"showdialogs": False})
        if result.removed:
            _rpc("VideoLibrary.Clean", {"showdialogs": False})
    return result


def repair_managed_library(api: ArchivistApi, addon) -> SyncResult:
    profile_root = Path(xbmcvfs.translatePath(f"special://profile/addon_data/{ADDON_ID}"))
    library_root = profile_root / "library"
    marker = library_root / ".archivist-managed"
    if library_root.exists() and not marker.is_file():
        raise RuntimeError("Refusing to repair a library not marked as Archivist-managed")
    for name in ("Movies", "TV Shows"):
        target = library_root / name
        if target.exists():
            shutil.rmtree(target)
    for state in (library_root / ".sync-state.json", profile_root / "sync-manifest.json", profile_root / "progress-state.json"):
        try:
            state.unlink()
        except FileNotFoundError:
            pass
    return synchronize(api, addon)


def _rpc(method: str, params: dict) -> None:
    response = json.loads(xbmc.executeJSONRPC(json.dumps({
        "jsonrpc": "2.0", "id": "archivist-sync", "method": method, "params": params,
    })))
    if response.get("error"):
        raise RuntimeError(f"Kodi {method} failed: {response['error'].get('message', 'unknown error')}")
