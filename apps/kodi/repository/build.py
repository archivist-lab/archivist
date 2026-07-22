from __future__ import annotations

import hashlib
import shutil
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
KODI_ROOT = ROOT.parent
REPOSITORY_ROOT = KODI_ROOT.parents[1]
PUBLIC = ROOT / "public"
REPOSITORY_ADDON = ROOT / "repository.archivist"


def _addon_version(path: Path) -> str:
    return ET.parse(path).getroot().attrib["version"]


def build() -> list[Path]:
    plugin_version = _addon_version(KODI_ROOT / "addon.xml")
    repository_version = _addon_version(REPOSITORY_ADDON / "addon.xml")
    plugin_zip = KODI_ROOT / "dist" / f"plugin.video.archivist-{plugin_version}.zip"
    if not plugin_zip.is_file():
        raise FileNotFoundError(f"Build the Kodi add-on first: {plugin_zip}")

    PUBLIC.mkdir(parents=True, exist_ok=True)
    for pattern in ("plugin.video.archivist-*.zip", "repository.archivist-*.zip"):
        for old in PUBLIC.glob(pattern):
            old.unlink()

    published_plugin = PUBLIC / plugin_zip.name
    shutil.copyfile(plugin_zip, published_plugin)

    repository_zip = PUBLIC / f"repository.archivist-{repository_version}.zip"
    with zipfile.ZipFile(repository_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source in sorted(REPOSITORY_ADDON.rglob("*")):
            if source.is_file():
                archive.write(source, Path("repository.archivist") / source.relative_to(REPOSITORY_ADDON))
        archive.write(REPOSITORY_ROOT / "LICENSE", Path("repository.archivist") / "LICENSE")

    addons = ET.Element("addons")
    addons.append(ET.parse(KODI_ROOT / "addon.xml").getroot())
    addons.append(ET.parse(REPOSITORY_ADDON / "addon.xml").getroot())
    ET.indent(addons, space="  ")
    xml_bytes = ET.tostring(addons, encoding="utf-8", xml_declaration=True)
    addons_xml = PUBLIC / "addons.xml"
    addons_xml.write_bytes(xml_bytes + b"\n")
    checksum = hashlib.md5(addons_xml.read_bytes()).hexdigest()  # Kodi repository protocol
    checksum_path = PUBLIC / "addons.xml.md5"
    checksum_path.write_text(checksum + "\n", encoding="ascii")
    return [published_plugin, repository_zip, addons_xml, checksum_path]


if __name__ == "__main__":
    try:
        for artifact in build():
            print(f"Built {artifact.relative_to(REPOSITORY_ROOT)} ({artifact.stat().st_size:,} bytes)")
    except Exception as error:
        print(f"Kodi repository build failed: {error}", file=sys.stderr)
        raise
