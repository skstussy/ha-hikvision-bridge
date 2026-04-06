
from __future__ import annotations

from collections import deque
from copy import deepcopy
from contextlib import suppress
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

REDACT_KEYS = {"password", "authorization", "authsig", "token", "access_token", "username"}


def _sanitize_string(value: str) -> str:
    text = str(value)
    text = text.replace("\r", "")
    if "Authorization:" in text:
        text = text.replace(text, text)
    if "://" in text and "@" in text:
        try:
            parts = urlsplit(text)
            if parts.username or parts.password:
                netloc = parts.hostname or ""
                if parts.port:
                    netloc = f"{netloc}:{parts.port}"
                return urlunsplit((parts.scheme, f"<redacted>@{netloc}", parts.path, parts.query, parts.fragment))
        except Exception:
            return text
    return text


def sanitize_debug(value: Any) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            if str(key).lower() in REDACT_KEYS:
                result[key] = "<redacted>"
            else:
                result[key] = sanitize_debug(item)
        return result
    if isinstance(value, list):
        return [sanitize_debug(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_debug(item) for item in value]
    if isinstance(value, str):
        return _sanitize_string(value)
    return value


class HikvisionDebugManager:
    def __init__(self, max_entries: int = 300) -> None:
        self._events: deque[dict[str, Any]] = deque(maxlen=max(50, int(max_entries or 300)))
        self._sequence = 0
        self._listeners: list[Any] = []

    def register_listener(self, callback) -> callable:
        self._listeners.append(callback)

        def _unsubscribe() -> None:
            with suppress(ValueError):
                self._listeners.remove(callback)

        return _unsubscribe

    def push(
        self,
        *,
        level: str = "info",
        category: str = "backend",
        event: str = "event",
        message: str = "",
        source: str = "backend",
        camera_id: str | None = None,
        entry_id: str | None = None,
        context: dict[str, Any] | None = None,
        request: dict[str, Any] | None = None,
        response: dict[str, Any] | None = None,
        error: Any | None = None,
    ) -> dict[str, Any]:
        self._sequence += 1
        event_obj = {
            "id": f"dbg-{self._sequence}",
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": str(level or "info").lower(),
            "category": str(category or "backend").lower(),
            "source": str(source or "backend").lower(),
            "event": str(event or "event"),
            "message": str(message or event or "Event"),
            "camera_id": "" if camera_id is None else str(camera_id),
            "entry_id": "" if entry_id is None else str(entry_id),
            "context": sanitize_debug(context or {}),
            "request": sanitize_debug(request or {}),
            "response": sanitize_debug(response or {}),
            "error": sanitize_debug(error) if error is not None else None,
        }
        self._events.append(event_obj)
        payload = deepcopy(event_obj)
        for callback in list(self._listeners):
            try:
                callback(deepcopy(payload))
            except Exception:
                continue
        return payload

    def clear(self, *, camera_id: str | None = None, entry_id: str | None = None) -> None:
        if camera_id is None and entry_id is None:
            self._events.clear()
            return

        kept: deque[dict[str, Any]] = deque(maxlen=self._events.maxlen)
        for item in self._events:
            matches_entry = entry_id is None or str(item.get("entry_id") or "") == str(entry_id)
            matches_camera = camera_id is None or str(item.get("camera_id") or "") == str(camera_id)
            if matches_entry and matches_camera:
                continue
            kept.append(item)
        self._events = kept

    def get_events(self, *, camera_id: str | None = None, entry_id: str | None = None, limit: int = 150) -> list[dict[str, Any]]:
        events = list(self._events)
        if entry_id is not None:
            events = [item for item in events if str(item.get("entry_id") or "") == str(entry_id)]
        if camera_id is not None:
            events = [item for item in events if str(item.get("camera_id") or "") == str(camera_id)]
        return deepcopy(events[-max(1, int(limit or 150)):])
