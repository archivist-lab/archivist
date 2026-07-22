from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parents[1] / "resources" / "lib"))

from archivist.api import ArchivistApi, Connection


class Response:
    def __init__(self, body: dict | None = None, headers: dict[str, str] | None = None) -> None:
        self.body = b"" if body is None else json.dumps(body).encode()
        self.headers = headers if headers is not None else {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self.body


class ImageHeaders(dict):
    def get_content_type(self) -> str:
        return "image/jpeg"


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.api = ArchivistApi(Connection("http://archivist:2424/", api_key="secret token", profile_id="living-room"))

    def test_absolute_and_kodi_urls(self) -> None:
        self.assertEqual(self.api.absolute_url("/media/poster.jpg"), "http://archivist:2424/media/poster.jpg")
        self.assertEqual(
            self.api.absolute_url("/media/series/House of the Dragon (2022)/poster.png"),
            "http://archivist:2424/media/series/House%20of%20the%20Dragon%20(2022)/poster.png",
        )
        self.assertEqual(
            self.api.absolute_url("https://images.example/A%20Film/日本.jpg?size=large image"),
            "https://images.example/A%20Film/%E6%97%A5%E6%9C%AC.jpg?size=large%20image",
        )
        kodi = self.api.kodi_url("/api/v1/player/stream/films/7")
        self.assertTrue(kodi.startswith("http://archivist:2424/api/v1/player/stream/films/7|"))
        self.assertIn("X-API-Key=secret%20token", kodi)

    @patch("archivist.api.urlopen")
    def test_artwork_download_uses_authenticated_request(self, mocked) -> None:
        mocked.return_value = Response(headers=ImageHeaders())
        mocked.return_value.body = b"jpeg"
        self.assertEqual(self.api.download("/media/films/example/poster.jpg"), b"jpeg")
        request = mocked.call_args.args[0]
        self.assertEqual(request.get_header("X-api-key"), "secret token")
        self.assertEqual(request.get_header("Accept"), "image/*")

    @patch("archivist.api.urlopen")
    def test_artwork_download_encodes_spaces_before_constructing_request(self, mocked) -> None:
        mocked.return_value = Response(headers=ImageHeaders())
        mocked.return_value.body = b"jpeg"
        self.api.download("/media/series/House of the Dragon (2022)/poster.png")
        self.assertEqual(
            mocked.call_args.args[0].full_url,
            "http://archivist:2424/media/series/House%20of%20the%20Dragon%20(2022)/poster.png",
        )

    @patch("archivist.api.urlopen")
    def test_json_request_sends_api_key_and_profile_progress(self, mocked) -> None:
        mocked.return_value = Response()
        self.api.save_progress("film", 7, 30, 100, False)
        request = mocked.call_args.args[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("X-api-key"), "secret token")
        payload = json.loads(request.data)
        self.assertEqual(payload["profileId"], "living-room")
        self.assertEqual(payload["id"], 7)

    @patch("archivist.api.urlopen")
    def test_health_uses_player_contract(self, mocked) -> None:
        mocked.return_value = Response({"status": "ok", "serverName": "Archivist"})
        self.assertEqual(self.api.health()["status"], "ok")
        request = mocked.call_args.args[0]
        self.assertEqual(request.full_url, "http://archivist:2424/api/v1/player/health")

    @patch("archivist.api.urlopen")
    def test_sync_manifest_uses_selected_profile(self, mocked) -> None:
        mocked.return_value = Response({"schemaVersion": 1, "films": [], "series": []})
        self.api.sync_manifest()
        self.assertIn("/api/v1/player/sync/manifest?profile=living-room", mocked.call_args.args[0].full_url)
        self.assertEqual(mocked.call_args.kwargs["timeout"], 300)

    @patch("archivist.api.urlopen")
    def test_sync_changes_uses_cursor_and_long_poll_timeout(self, mocked) -> None:
        mocked.return_value = Response({"cursor": 12, "changed": True})
        result = self.api.sync_changes(9, 25)
        self.assertEqual(result["cursor"], 12)
        self.assertIn("sync/changes?cursor=9&wait=25", mocked.call_args.args[0].full_url)
        self.assertEqual(mocked.call_args.kwargs["timeout"], 35)

    @patch("archivist.api.urlopen")
    def test_login_returns_session_without_retaining_password(self, mocked) -> None:
        mocked.return_value = Response({"username": "museum"}, {
            "Set-Cookie": "archivist_session=session-value; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000",
        })
        session = self.api.login("museum", "short-password")
        self.assertEqual(session, "archivist_session=session-value")
        request = mocked.call_args.args[0]
        self.assertEqual(json.loads(request.data), {"username": "museum", "password": "short-password"})

    def test_session_auth_is_attached_to_kodi_and_json_urls(self) -> None:
        api = ArchivistApi(Connection("http://archivist:2424", session_cookie="archivist_session=abc"))
        self.assertIn("Cookie=archivist_session%3Dabc", api.kodi_url("/media/poster.jpg"))

    def test_device_credential_is_attached_to_stream_and_json_requests(self) -> None:
        api = ArchivistApi(Connection("http://archivist:2424", device_token="device-secret", device_id="device-id"))
        self.assertIn("Authorization=Bearer%20device-secret", api.kodi_url("/media/poster.jpg"))
        with patch("archivist.api.urlopen", return_value=Response({"status": "ok"})) as urlopen:
            api.health()
            self.assertEqual(urlopen.call_args.args[0].get_header("Authorization"), "Bearer device-secret")
            self.assertEqual(urlopen.call_args.args[0].get_header("X-archivist-device"), "device-id")


if __name__ == "__main__":
    unittest.main()
