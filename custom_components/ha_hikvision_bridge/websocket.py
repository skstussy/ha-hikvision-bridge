from __future__ import annotations

from datetime import timedelta
from urllib.parse import quote

import voluptuous as vol

from homeassistant.components.http.auth import async_sign_path
from homeassistant.components.websocket_api import async_response, websocket_command
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LEGACY_DOMAIN


def _build_webrtc_result(hass: HomeAssistant, rtsp_url: str) -> dict:
    """Build a signed WebRTC websocket response payload."""
    unsigned_path = f"/api/webrtc/ws?url={quote(rtsp_url, safe='')}"
    signed_path = async_sign_path(hass, unsigned_path, timedelta(seconds=30))
    return {
        "path": signed_path,
        "debug": {
            "unsigned_path": unsigned_path,
            "expires_seconds": 30,
        },
    }


def _collect_debug_events(hass: HomeAssistant, entry_id: str | None, camera_id: str | None, limit: int) -> list[dict]:
    """Collect recent backend debug events for one or more coordinators."""
    data = hass.data.get(DOMAIN, {})

    coordinators = []
    if entry_id:
        coordinator = data.get(entry_id)
        if coordinator is not None:
            coordinators.append(coordinator)
    else:
        coordinators = list(data.values())

    events: list[dict] = []
    for coordinator in coordinators:
        try:
            events.extend(coordinator.get_debug_events(camera_id=camera_id, limit=limit))
        except Exception:
            continue

    return sorted(
        events,
        key=lambda item: (str(item.get("ts") or ""), str(item.get("id") or "")),
    )[-limit:]


@websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/webrtc_url",
        vol.Required("url"): str,
    }
)
@async_response
async def async_handle_webrtc_url(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return a signed WebRTC websocket path for a source URL."""
    connection.send_result(msg["id"], _build_webrtc_result(hass, msg["url"]))


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
    entry_id = msg.get("entry_id")
    camera_id = msg.get("camera_id")
    limit = max(1, min(int(msg.get("limit", 150) or 150), 500))
    connection.send_result(
        msg["id"],
        {"events": _collect_debug_events(hass, entry_id=entry_id, camera_id=camera_id, limit=limit)},
    )


@websocket_command(
    {
        vol.Required("type"): f"{LEGACY_DOMAIN}/webrtc_url",
        vol.Required("url"): str,
    }
)
@async_response
async def async_handle_legacy_webrtc_url(hass: HomeAssistant, connection, msg: dict) -> None:
    """Legacy alias for the WebRTC URL websocket command."""
    connection.send_result(msg["id"], _build_webrtc_result(hass, msg["url"]))


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
    """Legacy alias for backend debug event retrieval."""
    entry_id = msg.get("entry_id")
    camera_id = msg.get("camera_id")
    limit = max(1, min(int(msg.get("limit", 150) or 150), 500))
    connection.send_result(
        msg["id"],
        {"events": _collect_debug_events(hass, entry_id=entry_id, camera_id=camera_id, limit=limit)},
    )


from homeassistant.components import websocket_api

@websocket_api.websocket_command({
    "type": "ha_hikvision_bridge/subscribe_debug"
})
async def async_subscribe_debug(hass, connection, msg):
    manager = hass.data["ha_hikvision_bridge"]["debug_manager"]

    def forward(event):
        connection.send_message({
            "type": "event",
            "event": event,
        })

    manager.register_listener(forward)
    
