
from __future__ import annotations

from datetime import timedelta
from urllib.parse import quote

import voluptuous as vol

from homeassistant.components.http.auth import async_sign_path
from homeassistant.components.websocket_api import async_response, websocket_command
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LEGACY_DOMAIN


@websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/webrtc_url",
        vol.Required("url"): str,
    }
)
@async_response
async def async_handle_webrtc_url(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return a signed WebRTC websocket path for a source URL."""
    rtsp_url = msg["url"]
    unsigned_path = f"/api/webrtc/ws?url={quote(rtsp_url, safe='')}"
    signed_path = async_sign_path(hass, unsigned_path, timedelta(seconds=30))
    connection.send_result(
        msg["id"],
        {
            "path": signed_path,
            "debug": {
                "unsigned_path": unsigned_path,
                "expires_seconds": 30,
            },
        },
    )


@websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/get_debug_events",
        vol.Optional("entry_id"): str,
        vol.Optional("camera_id"): str,
        vol.Optional("limit", default=150): int,
    }
)
@async_response
async def async_handle_get_debug_events(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return recent backend debug events for one or more Hikvision coordinators."""
    data = hass.data.get(DOMAIN, {})
    entry_id = msg.get("entry_id")
    camera_id = msg.get("camera_id")
    limit = max(1, min(int(msg.get("limit", 150) or 150), 500))

    coordinators = []
    if entry_id:
        coordinator = data.get(entry_id)
        if coordinator is not None:
            coordinators.append(coordinator)
    else:
        coordinators = list(data.values())

    events = []
    for coordinator in coordinators:
        try:
            events.extend(coordinator.get_debug_events(camera_id=camera_id, limit=limit))
        except Exception:
            continue

    events = sorted(events, key=lambda item: (str(item.get("ts") or ""), str(item.get("id") or "")))[-limit:]
    connection.send_result(msg["id"], {"events": events})


@websocket_command(
    {
        vol.Required("type"): f"{LEGACY_DOMAIN}/webrtc_url",
        vol.Required("url"): str,
    }
)
@async_response
async def async_handle_legacy_webrtc_url(hass: HomeAssistant, connection, msg: dict) -> None:
    await async_handle_webrtc_url(hass, connection, msg)


@websocket_command(
    {
        vol.Required("type"): f"{LEGACY_DOMAIN}/get_debug_events",
        vol.Optional("entry_id"): str,
        vol.Optional("camera_id"): str,
        vol.Optional("limit", default=150): int,
    }
)
@async_response
async def async_handle_legacy_get_debug_events(hass: HomeAssistant, connection, msg: dict) -> None:
    await async_handle_get_debug_events(hass, connection, msg)
