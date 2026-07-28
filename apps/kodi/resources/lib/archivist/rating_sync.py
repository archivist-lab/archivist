from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any, Callable


def rating_value(item: dict[str, Any]) -> int:
    """Normalize Kodi's 0–10 userrating to Archivist's sparse 0–5 value."""
    raw = item.get("userRating") if "userRating" in item else item.get("userrating")
    try:
        value = float(raw or 0)
    except (TypeError, ValueError):
        return 0
    return 0 if value <= 0 else max(1, min(5, math.ceil(value / 2)))


def reconcile_ratings(
    manifest: dict[str, Any], kodi_items: list[dict[str, Any]], state_path: str,
    push_server: Callable[[str, int, int], None],
    apply_kodi: Callable[[dict[str, Any], int], None],
) -> tuple[int, int]:
    """Reconcile explicit film/episode ratings; server wins first sync/conflicts."""
    target = Path(state_path)
    try:
        previous = json.loads(target.read_text(encoding="utf-8")).get("items", {})
    except (FileNotFoundError, ValueError, OSError):
        previous = {}

    server_items: dict[str, dict[str, Any]] = {}
    for film in manifest.get("films") or []:
        server_items[f"film:{film['id']}"] = film
    for series in manifest.get("series") or []:
        for season in series.get("seasons") or []:
            for episode in season.get("episodes") or []:
                server_items[f"episode:{episode['id']}"] = episode
    local_items = {f"{item['type']}:{item['id']}": item for item in kodi_items}

    pushed = applied = 0
    next_state: dict[str, Any] = {}
    for key, server_item in server_items.items():
        local_item = local_items.get(key)
        if not local_item:
            continue
        server = rating_value(server_item)
        local = rating_value(local_item)
        old = previous.get(key)
        local_changed = bool(old and local != old.get("local"))
        server_changed = bool(old and server != old.get("server"))
        if local_changed and not server_changed:
            push_server(local_item["type"], int(local_item["id"]), local)
            server = local
            pushed += 1
        elif local != server or not old and int(local_item.get("userrating") or 0) != server * 2:
            apply_kodi(local_item, server)
            local = server
            applied += 1
        next_state[key] = {"local": local, "server": server}

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps({"schemaVersion": 1, "items": next_state}, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temporary, target)
    return pushed, applied
