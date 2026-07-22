from __future__ import annotations

import os
from pathlib import Path
from xml.etree import ElementTree as ET


MANAGED_SOURCES = ("Archivist Movies", "Archivist TV Shows")


def ensure_video_sources(path: str, movies_path: str | None, shows_path: str | None) -> bool:
    """Add/update Archivist's two native video sources without touching user sources."""
    target = Path(path)
    try:
        root = ET.parse(target).getroot()
    except (FileNotFoundError, ET.ParseError, OSError):
        root = ET.Element("sources")
    video = root.find("video")
    if video is None:
        video = ET.SubElement(root, "video")
        ET.SubElement(video, "default", {"pathversion": "1"})
    desired = {
        "Archivist Movies": movies_path,
        "Archivist TV Shows": shows_path,
    }
    changed = False
    existing = {node.findtext("name"): node for node in video.findall("source")}
    for name, source_path in desired.items():
        node = existing.get(name)
        if not source_path:
            if node is not None:
                video.remove(node)
                changed = True
            continue
        normalized = os.path.join(source_path, "")
        Path(source_path).mkdir(parents=True, exist_ok=True)
        if node is None:
            node = ET.SubElement(video, "source")
            ET.SubElement(node, "name").text = name
            ET.SubElement(node, "path", {"pathversion": "1"}).text = normalized
            ET.SubElement(node, "allowsharing").text = "false"
            changed = True
        else:
            path_node = node.find("path")
            if path_node is None:
                path_node = ET.SubElement(node, "path", {"pathversion": "1"})
            if path_node.text != normalized:
                path_node.text = normalized
                path_node.set("pathversion", "1")
                changed = True
    if not changed:
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(root, space="  ")
    temporary = target.with_suffix(".tmp")
    ET.ElementTree(root).write(temporary, encoding="utf-8", xml_declaration=True)
    os.replace(temporary, target)
    return True
