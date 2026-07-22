from __future__ import annotations

from urllib.parse import parse_qs, urlencode


def parse_query(value: str) -> dict[str, str]:
    query = value[1:] if value.startswith("?") else value
    return {key: values[-1] for key, values in parse_qs(query, keep_blank_values=True).items()}


def plugin_url(base_url: str, action: str, **params: object) -> str:
    values = {"action": action}
    values.update({key: str(value) for key, value in params.items() if value is not None})
    return f"{base_url}?{urlencode(values)}"


def integer(value: object, default: int = 0) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return default
