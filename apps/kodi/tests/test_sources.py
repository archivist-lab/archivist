from __future__ import annotations

import tempfile
import unittest
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.sources import ensure_video_sources


class SourceTests(unittest.TestCase):
    def test_adds_two_sources_preserves_existing_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = root / "sources.xml"
            sources.write_text("<sources><video><source><name>Personal</name><path>/media</path></source></video></sources>")
            self.assertTrue(ensure_video_sources(str(sources), str(root / "Movies"), str(root / "TV Shows")))
            self.assertFalse(ensure_video_sources(str(sources), str(root / "Movies"), str(root / "TV Shows")))
            names = [node.findtext("name") for node in ET.parse(sources).findall("./video/source")]
            self.assertEqual(names, ["Personal", "Archivist Movies", "Archivist TV Shows"])

    def test_removes_only_disabled_managed_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = root / "sources.xml"
            ensure_video_sources(str(sources), str(root / "Movies"), str(root / "TV Shows"))
            self.assertTrue(ensure_video_sources(str(sources), None, str(root / "TV Shows")))
            names = [node.findtext("name") for node in ET.parse(sources).findall("./video/source")]
            self.assertEqual(names, ["Archivist TV Shows"])


if __name__ == "__main__":
    unittest.main()
