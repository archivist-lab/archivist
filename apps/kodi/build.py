from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = ROOT.parents[1]
DIST = ROOT / "dist"
EXCLUDED_PARTS = {"dist", "tests", "__pycache__", ".pytest_cache"}
INCLUDED_TOP_LEVEL = {"addon.xml", "default.py", "service.py", "README.md"}


def validate() -> str:
    addon = ET.parse(ROOT / "addon.xml").getroot()
    settings = ET.parse(ROOT / "resources" / "settings.xml").getroot()
    translations = (ROOT / "resources" / "language" / "resource.language.en_gb" / "strings.po").read_text(encoding="utf-8")
    translation_ids = set(re.findall(r'^msgctxt "#(\d+)"$', translations, re.MULTILINE))
    label_ids = {element.attrib["label"] for element in settings.findall(".//*[@label]") if element.attrib["label"].isdigit()}
    heading_ids = {element.text or "" for element in settings.findall(".//heading") if (element.text or "").isdigit()}
    missing = sorted((label_ids | heading_ids) - translation_ids)
    if missing:
        raise ValueError(f"Kodi settings reference missing translations: {', '.join(missing)}")
    if settings.find(".//setting[@id='api_key']/control") is None:
        raise ValueError("Kodi settings must expose an api_key edit control")
    version = addon.attrib["version"]
    for source in [ROOT / "default.py", ROOT / "service.py", *(ROOT / "resources" / "lib").rglob("*.py")]:
        compile(source.read_text(encoding="utf-8"), str(source), "exec")
    return version


def source_files() -> list[Path]:
    result = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or any(part in EXCLUDED_PARTS for part in path.relative_to(ROOT).parts):
            continue
        relative = path.relative_to(ROOT)
        if relative.parts[0] == "resources" or str(relative) in INCLUDED_TOP_LEVEL:
            result.append(path)
    return sorted(result)


def build() -> Path:
    version = validate()
    DIST.mkdir(exist_ok=True)
    output = DIST / f"plugin.video.archivist-{version}.zip"
    for previous in DIST.glob("plugin.video.archivist-*.zip"):
        previous.unlink()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source in source_files():
            archive.write(source, Path("plugin.video.archivist") / source.relative_to(ROOT))
        archive.write(REPOSITORY_ROOT / "LICENSE", Path("plugin.video.archivist") / "LICENSE")
    return output


if __name__ == "__main__":
    artifact = build()
    print(f"Built {artifact.relative_to(REPOSITORY_ROOT)} ({artifact.stat().st_size:,} bytes)")
