from __future__ import annotations

from datetime import timedelta
from urllib.parse import quote

import voluptuous as vol

from homeassistant.components.http.auth import async_sign_path
from homeassistant.components.websocket_api import async_response, websocket_command
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .isapi_probe import async_run_probe, build_catalog_snapshot


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


def _iter_coordinators(hass: HomeAssistant, entry_id: str | None = None) -> list:
    data = hass.data.get(DOMAIN, {})

    if entry_id:
        coordinator = data.get(entry_id)
        return [coordinator] if coordinator is not None else []

    return [value for value in data.values() if hasattr(value, "get_debug_events")]


def _get_coordinator(hass: HomeAssistant, entry_id: str | None = None):
    coordinators = _iter_coordinators(hass, entry_id=entry_id)
    return coordinators[0] if coordinators else None


def _collect_debug_events(hass: HomeAssistant, entry_id: str | None, camera_id: str | None, limit: int) -> list[dict]:
    """Collect recent backend debug events for one or more coordinators."""
    coordinators = _iter_coordinators(hass, entry_id=entry_id)

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


def _get_cached_probe_results(coordinator) -> dict | None:
    return getattr(coordinator, "_isapi_probe_results", None)


def _set_cached_probe_results(coordinator, results: dict) -> None:
    setattr(coordinator, "_isapi_probe_results", results)


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
        vol.Required("type"): f"{DOMAIN}/subscribe_debug",
        vol.Optional("entry_id"): str,
        vol.Optional("camera_id"): str,
        vol.Optional("limit", default=150): int,
    }
)
@async_response
async def async_subscribe_debug(hass: HomeAssistant, connection, msg: dict) -> None:
    """Subscribe to live backend debug events."""
    entry_id = msg.get("entry_id")
    camera_id = msg.get("camera_id")
    limit = max(1, min(int(msg.get("limit", 150) or 150), 500))
    coordinators = _iter_coordinators(hass, entry_id=entry_id)

    unsubscribers = []

    def forward(event: dict) -> None:
        try:
            if camera_id and str(event.get("camera_id") or "") != str(camera_id):
                return
            connection.send_message({
                "id": msg["id"],
                "type": "event",
                "event": event,
            })
        except Exception:
            return

    for coordinator in coordinators:
        manager = getattr(coordinator, "_debug_manager", None)
        register = getattr(manager, "register_listener", None)
        if callable(register):
            try:
                unsubscribers.append(register(forward))
            except Exception:
                continue

    initial_events = _collect_debug_events(hass, entry_id=entry_id, camera_id=camera_id, limit=limit)
    connection.send_result(msg["id"])
    for event in initial_events:
        forward(event)

    def _unsubscribe() -> None:
        for unsub in list(unsubscribers):
            try:
                if callable(unsub):
                    unsub()
            except Exception:
                continue

    connection.subscriptions[msg["id"]] = _unsubscribe


@websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/get_isapi_catalog",
        vol.Optional("entry_id"): str,
    }
)
@async_response
async def async_handle_get_isapi_catalog(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return the grouped ISAPI endpoint catalog for a coordinator."""
    coordinator = _get_coordinator(hass, entry_id=msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No Hikvision coordinator was found")
        return
    connection.send_result(msg["id"], build_catalog_snapshot(coordinator))


@websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/get_isapi_probe_results",
        vol.Optional("entry_id"): str,
    }
)
@async_response
async def async_handle_get_isapi_probe_results(hass: HomeAssistant, connection, msg: dict) -> None:
    """Return cached ISAPI probe results."""
    coordinator = _get_coordinator(hass, entry_id=msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No Hikvision coordinator was found")
        return
    results = _get_cached_probe_results(coordinator)
    connection.send_result(msg["id"], results or {"generated_at": None, "groups": [], "totals": {}, "request_count": 0})


@websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/run_isapi_probe",
        vol.Optional("entry_id"): str,
        vol.Optional("groups", default=[]): [str],
        vol.Optional("include_dangerous", default=True): bool,
        vol.Optional("max_endpoints", default=250): int,
    }
)
@async_response
async def async_handle_run_isapi_probe(hass: HomeAssistant, connection, msg: dict) -> None:
    """Run the grouped ISAPI endpoint probe and cache the results."""
    coordinator = _get_coordinator(hass, entry_id=msg.get("entry_id"))
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "No Hikvision coordinator was found")
        return

    groups = [str(item).strip().lower() for item in (msg.get("groups") or []) if str(item).strip()]
    max_endpoints = max(1, min(int(msg.get("max_endpoints", 250) or 250), 1000))

    push_debug = getattr(coordinator, "_push_debug_event", None)
    if callable(push_debug):
        push_debug(
            category="isapi",
            event="probe_started",
            message="Starting ISAPI endpoint probe",
            context={"groups": groups, "include_dangerous": bool(msg.get("include_dangerous", True)), "max_endpoints": max_endpoints},
        )

    try:
        results = await async_run_probe(
            coordinator,
            groups=groups,
            include_dangerous=bool(msg.get("include_dangerous", True)),
            max_endpoints=max_endpoints,
        )
    except Exception as err:
        if callable(push_debug):
            push_debug(
                level="error",
                category="isapi",
                event="probe_failed",
                message="ISAPI endpoint probe failed",
                error=str(err),
            )
        connection.send_error(msg["id"], "probe_failed", str(err))
        return

    _set_cached_probe_results(coordinator, results)

    if callable(push_debug):
        push_debug(
            category="isapi",
            event="probe_completed",
            message="Completed ISAPI endpoint probe",
            context={"totals": results.get("totals"), "request_count": results.get("request_count")},
        )

    connection.send_result(msg["id"], results)
