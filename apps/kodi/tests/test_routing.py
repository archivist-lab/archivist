from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.routing import integer, parse_query, plugin_url


class RoutingTests(unittest.TestCase):
    def test_query_round_trip(self) -> None:
        url = plugin_url("plugin://plugin.video.archivist/", "search", query="House of the Dragon")
        self.assertEqual(parse_query(url.split("?", 1)[1]), {"action": "search", "query": "House of the Dragon"})

    def test_parser_keeps_last_value_and_blank(self) -> None:
        self.assertEqual(parse_query("?action=films&cursor=&action=series"), {"action": "series", "cursor": ""})

    def test_safe_integer(self) -> None:
        self.assertEqual(integer("42"), 42)
        self.assertEqual(integer("bad", 7), 7)


if __name__ == "__main__":
    unittest.main()
