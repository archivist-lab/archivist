from __future__ import annotations

import re
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).parents[1]


class ManifestTests(unittest.TestCase):
    def test_settings_have_labels_and_login_controls(self) -> None:
        settings = ET.parse(ROOT / "resources" / "settings.xml").getroot()
        translations = (ROOT / "resources" / "language" / "resource.language.en_gb" / "strings.po").read_text()
        ids = set(re.findall(r'^msgctxt "#(\d+)"$', translations, re.MULTILINE))
        referenced = {element.attrib["label"] for element in settings.findall(".//*[@label]") if element.attrib["label"].isdigit()}
        referenced.update(element.text or "" for element in settings.findall(".//heading"))
        self.assertEqual(referenced - ids, set())
        username = settings.find(".//setting[@id='username']")
        self.assertIsNotNone(username)
        self.assertEqual(username.attrib["label"], "30003")
        token = settings.find(".//setting[@id='api_key']")
        self.assertIsNotNone(token)
        self.assertEqual(token.attrib["label"], "30006")
        sign_in = settings.find(".//setting[@id='sign_in']")
        self.assertIsNotNone(sign_in)
        self.assertEqual(sign_in.attrib["type"], "action")
        self.assertIn("action=setup", sign_in.findtext("data") or "")
        self.assertEqual(token.find("control").attrib["type"], "edit")
        sync_now = settings.find(".//setting[@id='sync_now']")
        self.assertIsNotNone(sync_now)
        self.assertIn("action=sync", sync_now.findtext("data") or "")

    def test_manifest_version_matches_client_version(self) -> None:
        version = ET.parse(ROOT / "addon.xml").getroot().attrib["version"]
        source = (ROOT / "resources" / "lib" / "archivist" / "__init__.py").read_text()
        self.assertIn(f'__version__ = "{version}"', source)

    def test_integer_settings_use_kodis_integer_api(self) -> None:
        plugin = (ROOT / "resources" / "lib" / "archivist" / "plugin.py").read_text()
        service = (ROOT / "resources" / "lib" / "archivist" / "service.py").read_text()
        self.assertIn('getSettingInt(name)', plugin)
        self.assertNotIn('getSettingString("page_size")', plugin)
        self.assertIn('getSettingInt("watched_threshold")', service)
        self.assertIn('getSettingInt("progress_interval")', service)


if __name__ == "__main__":
    unittest.main()
