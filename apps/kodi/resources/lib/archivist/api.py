from __future__ import annotations

import json
import ssl
from dataclasses import dataclass
from http.cookies import SimpleCookie
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen


class ArchivistApiError(RuntimeError):
    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Connection:
    server_url: str
    api_key: str = ""
    session_cookie: str = ""
    device_token: str = ""
    device_id: str = ""
    profile_id: str = "default"
    verify_ssl: bool = True

    @property
    def base_url(self) -> str:
        return self.server_url.strip().rstrip("/")


class ArchivistApi:
    def __init__(self, connection: Connection, timeout: int = 20) -> None:
        self.connection = connection
        self.timeout = timeout

    def absolute_url(self, path: str) -> str:
        raw = path if path.startswith(("http://", "https://")) else urljoin(
            f"{self.connection.base_url}/", path.lstrip("/")
        )
        parts = urlsplit(raw)
        return urlunsplit((
            parts.scheme,
            parts.netloc,
            quote(parts.path, safe="/%:@!$&'()*+,;=-._~"),
            quote(parts.query, safe="=&;%:+,/?@!$'()*-._~"),
            quote(parts.fragment, safe="=&;%:+,/?@!$'()*-._~"),
        ))

    def kodi_url(self, path: str) -> str:
        """Return a URL carrying headers in Kodi's URL|Header=value format."""
        url = self.absolute_url(path)
        headers = {"User-Agent": "Archivist-Kodi/0.4.1"}
        if self.connection.api_key:
            headers["X-API-Key"] = self.connection.api_key
        if self.connection.session_cookie:
            headers["Cookie"] = self.connection.session_cookie
        if self.connection.device_token:
            headers["Authorization"] = f"Bearer {self.connection.device_token}"
        encoded = "&".join(f"{quote(key)}={quote(value)}" for key, value in headers.items())
        return f"{url}|{encoded}" if encoded else url

    def player_path(self, path: str) -> str:
        return f"/api/v1/player/{path.lstrip('/')}"

    def get(self, path: str, query: dict[str, object] | None = None) -> dict[str, Any]:
        return self._request("GET", path, query=query)

    def download(self, path: str) -> bytes:
        """Download protected artwork using the same credentials as API calls."""
        url = self.absolute_url(path)
        request = Request(url, headers=self._headers("image/*"), method="GET")
        context = None if self.connection.verify_ssl else ssl._create_unverified_context()
        try:
            with urlopen(request, timeout=min(self.timeout, 8), context=context) as response:
                content_type = response.headers.get_content_type()
                if not content_type.startswith("image/"):
                    raise ArchivistApiError(f"Artwork returned {content_type}")
                return response.read()
        except HTTPError as error:
            error.read()
            raise ArchivistApiError(f"Artwork returned HTTP {error.code}", error.code) from error
        except (URLError, TimeoutError, ValueError) as error:
            raise ArchivistApiError(f"Could not load artwork: {error}") from error

    def post(self, path: str, body: dict[str, object]) -> dict[str, Any] | None:
        return self._request("POST", path, body=body)

    def delete(self, path: str, query: dict[str, object] | None = None) -> None:
        self._request("DELETE", path, query=query)

    def health(self) -> dict[str, Any]:
        return self.get(self.player_path("health"))

    def sync_manifest(self) -> dict[str, Any]:
        return self._request(
            "GET", self.player_path("sync/manifest"),
            query={"profile": self.connection.profile_id}, timeout=300,
        )

    def sync_changes(self, cursor: int, wait_seconds: int = 25) -> dict[str, Any]:
        return self._request(
            "GET", self.player_path("sync/changes"),
            query={"cursor": max(0, int(cursor)), "wait": max(0, min(30, int(wait_seconds)))},
            timeout=max(10, int(wait_seconds) + 10),
        ) or {}

    def login(self, username: str, password: str) -> str:
        url = self.absolute_url("/api/v1/auth/login")
        payload = json.dumps({"username": username, "password": password}).encode("utf-8")
        request = Request(url, data=payload, headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Archivist-Kodi/0.4.1",
        }, method="POST")
        context = None if self.connection.verify_ssl else ssl._create_unverified_context()
        try:
            with urlopen(request, timeout=self.timeout, context=context) as response:
                cookie = SimpleCookie()
                cookie.load(response.headers.get("Set-Cookie", ""))
                morsel = cookie.get("archivist_session")
                if not morsel or not morsel.value:
                    raise ArchivistApiError("Archivist did not return a login session")
                return f"archivist_session={morsel.value}"
        except HTTPError as error:
            error.read()
            if error.code == 401:
                raise ArchivistApiError("Incorrect Archivist username or password", 401) from error
            raise ArchivistApiError(f"Archivist login returned HTTP {error.code}", error.code) from error
        except (URLError, TimeoutError, ValueError) as error:
            raise ArchivistApiError(f"Could not connect to Archivist: {error}") from error

    def film(self, media_id: int) -> dict[str, Any]:
        return self.get(self.player_path(f"films/{media_id}"), {"profile": self.connection.profile_id})

    def episode(self, media_id: int) -> dict[str, Any]:
        return self.get(self.player_path(f"episodes/{media_id}"), {"profile": self.connection.profile_id})

    def series(self, media_id: int) -> dict[str, Any]:
        return self.get(self.player_path(f"series/{media_id}"), {"profile": self.connection.profile_id})

    def register_device(self, name: str) -> dict[str, Any]:
        return self.post("/api/v1/auth/devices", {"name": name}) or {}

    def tracks(self, media_type: str, media_id: int, edition_id: int = 0) -> dict[str, Any]:
        plural = "films" if media_type == "film" else "episodes"
        return self.get(
            self.player_path(f"stream/{plural}/{media_id}/tracks"),
            {"edition": edition_id or None},
        )

    def save_progress(self, media_type: str, media_id: int, position: float, duration: float, completed: bool) -> None:
        self.post(self.player_path("progress"), {
            "type": media_type,
            "id": media_id,
            "profileId": self.connection.profile_id,
            "positionSeconds": max(0.0, position),
            "durationSeconds": max(0.0, duration),
            "completed": completed,
        })

    def clear_progress(self, media_type: str, media_id: int) -> None:
        self.delete(self.player_path(f"progress/{media_type}/{media_id}"), {"profile": self.connection.profile_id})

    def _request(
        self,
        method: str,
        path: str,
        query: dict[str, object] | None = None,
        body: dict[str, object] | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any] | None:
        url = self.absolute_url(path)
        if query:
            clean = {key: value for key, value in query.items() if value is not None}
            url = f"{url}{'&' if '?' in url else '?'}{urlencode(clean)}"
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = self._headers("application/json")
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if self.connection.api_key:
            headers["X-API-Key"] = self.connection.api_key
        if self.connection.session_cookie:
            headers["Cookie"] = self.connection.session_cookie
        if self.connection.device_token:
            headers["Authorization"] = f"Bearer {self.connection.device_token}"
        context = None if self.connection.verify_ssl else ssl._create_unverified_context()
        request = Request(url, data=payload, headers=headers, method=method)
        try:
            with urlopen(request, timeout=timeout or self.timeout, context=context) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except HTTPError as error:
            raw = error.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(raw)
                message = parsed.get("error", {}).get("message") if isinstance(parsed.get("error"), dict) else parsed.get("error")
            except (ValueError, AttributeError):
                message = None
            if error.code == 401 and self.connection.session_cookie:
                message = "Your Archivist sign-in has expired. Open Configure Connection and sign in again."
            raise ArchivistApiError(str(message or f"Archivist returned HTTP {error.code}"), error.code) from error
        except (URLError, TimeoutError, ValueError) as error:
            raise ArchivistApiError(f"Could not connect to Archivist: {error}") from error

    def _headers(self, accept: str) -> dict[str, str]:
        headers = {"Accept": accept, "User-Agent": "Archivist-Kodi/0.4.1"}
        if self.connection.device_id:
            headers["X-Archivist-Device"] = self.connection.device_id
        if self.connection.api_key:
            headers["X-API-Key"] = self.connection.api_key
        if self.connection.session_cookie:
            headers["Cookie"] = self.connection.session_cookie
        if self.connection.device_token:
            headers["Authorization"] = f"Bearer {self.connection.device_token}"
        return headers
