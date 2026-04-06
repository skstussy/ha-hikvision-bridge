from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
import xml.etree.ElementTree as ET

CATALOG = [
    {"id": "system_capabilities", "group": "system", "label": "System capabilities", "path": "/ISAPI/System/capabilities", "method": "GET", "probe": "read"},
    {"id": "system_device_info", "group": "system", "label": "Device info", "path": "/ISAPI/System/deviceInfo", "method": "GET", "probe": "read"},
    {"id": "system_device_info_capabilities", "group": "system", "label": "Device info capabilities", "path": "/ISAPI/System/deviceInfo/capabilities", "method": "GET", "probe": "read"},
    {"id": "system_status", "group": "system", "label": "System status", "path": "/ISAPI/System/status", "method": "GET", "probe": "read"},
    {"id": "system_workingstatus", "group": "system", "label": "Working status", "path": "/ISAPI/System/workingstatus?format=json", "method": "GET", "probe": "read"},
    {"id": "system_time", "group": "system", "label": "System time", "path": "/ISAPI/System/time", "method": "GET", "probe": "read"},
    {"id": "system_time_capabilities", "group": "system", "label": "Time capabilities", "path": "/ISAPI/System/time/capabilities", "method": "GET", "probe": "read"},
    {"id": "system_video_capabilities", "group": "system", "label": "Video capabilities", "path": "/ISAPI/System/Video/capabilities", "method": "GET", "probe": "read"},
    {"id": "system_audio_capabilities", "group": "audio", "label": "Audio capabilities", "path": "/ISAPI/System/Audio/capabilities", "method": "GET", "probe": "read"},
    {"id": "system_twowayaudio_channels", "group": "audio", "label": "Two-way audio channels", "path": "/ISAPI/System/TwoWayAudio/channels", "method": "GET", "probe": "read"},
    {"id": "system_twowayaudio_channel_capabilities", "group": "audio", "label": "Two-way audio channel capabilities", "path": "/ISAPI/System/TwoWayAudio/channels/{channel_id}/capabilities", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "network_capabilities", "group": "network", "label": "Network capabilities", "path": "/ISAPI/System/Network/capabilities", "method": "GET", "probe": "read"},
    {"id": "network_interfaces", "group": "network", "label": "Network interfaces", "path": "/ISAPI/System/Network/interfaces", "method": "GET", "probe": "read"},
    {"id": "network_interface_capabilities", "group": "network", "label": "Interface capabilities", "path": "/ISAPI/System/Network/interfaces/1/capabilities", "method": "GET", "probe": "read"},
    {"id": "network_ddns_capabilities", "group": "network", "label": "DDNS capabilities", "path": "/ISAPI/System/Network/DDNS/capabilities", "method": "GET", "probe": "read"},
    {"id": "network_ftp_capabilities", "group": "network", "label": "FTP capabilities", "path": "/ISAPI/System/Network/ftp/capabilities", "method": "GET", "probe": "read"},
    {"id": "network_mailing_capabilities", "group": "network", "label": "Mailing capabilities", "path": "/ISAPI/System/Network/mailing/capabilities", "method": "GET", "probe": "read"},
    {"id": "network_ssh", "group": "network", "label": "SSH configuration", "path": "/ISAPI/System/Network/ssh", "method": "GET", "probe": "read"},
    {"id": "security_capabilities", "group": "security", "label": "Security capabilities", "path": "/ISAPI/Security/capabilities", "method": "GET", "probe": "read"},
    {"id": "security_users", "group": "security", "label": "Users", "path": "/ISAPI/Security/users", "method": "GET", "probe": "read"},
    {"id": "security_user_permission", "group": "security", "label": "User permission", "path": "/ISAPI/Security/UserPermission", "method": "GET", "probe": "read"},
    {"id": "security_admin_accesses_capabilities", "group": "security", "label": "Admin accesses capabilities", "path": "/ISAPI/Security/adminAccesses/capabilities", "method": "GET", "probe": "read"},
    {"id": "security_illegal_login_lock", "group": "security", "label": "Illegal login lock", "path": "/ISAPI/Security/illegalLoginLock", "method": "GET", "probe": "read"},
    {"id": "event_capabilities", "group": "event", "label": "Event capabilities", "path": "/ISAPI/Event/capabilities", "method": "GET", "probe": "read"},
    {"id": "event_alert_stream", "group": "event", "label": "Alert stream", "path": "/ISAPI/Event/notification/alertStream", "method": "GET", "probe": "read"},
    {"id": "event_subscribe_capabilities", "group": "event", "label": "Subscribe event capabilities", "path": "/ISAPI/Event/notification/subscribeEventCap", "method": "GET", "probe": "read"},
    {"id": "event_channel_capabilities", "group": "event", "label": "Event channel capabilities", "path": "/ISAPI/Event/channels/{channel_id}/capabilities", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "storage_capabilities", "group": "storage", "label": "Content management capabilities", "path": "/ISAPI/ContentMgmt/capabilities", "method": "GET", "probe": "read"},
    {"id": "storage_hdd", "group": "storage", "label": "HDDs", "path": "/ISAPI/ContentMgmt/Storage/hdd", "method": "GET", "probe": "read"},
    {"id": "storage_hdd_capabilities", "group": "storage", "label": "HDD capabilities", "path": "/ISAPI/ContentMgmt/Storage/hdd/capabilities", "method": "GET", "probe": "read"},
    {"id": "storage_extra_info_capabilities", "group": "storage", "label": "Storage extra info capabilities", "path": "/ISAPI/ContentMgmt/Storage/ExtraInfo/capabilities", "method": "GET", "probe": "read"},
    {"id": "record_tracks", "group": "storage", "label": "Record tracks", "path": "/ISAPI/ContentMgmt/record/tracks", "method": "GET", "probe": "read"},
    {"id": "streaming_channels", "group": "streaming", "label": "Streaming channels", "path": "/ISAPI/Streaming/channels", "method": "GET", "probe": "read"},
    {"id": "streaming_channel", "group": "streaming", "label": "Streaming channel", "path": "/ISAPI/Streaming/channels/{channel_id}", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "streaming_channel_capabilities", "group": "streaming", "label": "Streaming channel capabilities", "path": "/ISAPI/Streaming/channels/{channel_id}/capabilities", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "streaming_channel_status", "group": "streaming", "label": "Streaming channel status", "path": "/ISAPI/Streaming/channels/{channel_id}/status", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "streaming_encryption_capabilities", "group": "streaming", "label": "Streaming encryption capabilities", "path": "/ISAPI/Streaming/encryption/capabilities?format=json", "method": "GET", "probe": "read"},
    {"id": "image_channels", "group": "image", "label": "Image channels", "path": "/ISAPI/Image/channels", "method": "GET", "probe": "read"},
    {"id": "image_channel", "group": "image", "label": "Image channel", "path": "/ISAPI/Image/channels/{channel_id}", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "image_channel_capabilities", "group": "image", "label": "Image channel capabilities", "path": "/ISAPI/Image/channels/{channel_id}/capabilities", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "image_channel_color_capabilities", "group": "image", "label": "Image color capabilities", "path": "/ISAPI/Image/channels/{channel_id}/color/capabilities", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "image_focus_configuration_capabilities", "group": "image", "label": "Focus configuration capabilities", "path": "/ISAPI/Image/channels/{channel_id}/focusConfiguration/capabilities", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "ptz_proxy_channels", "group": "ptz", "label": "PTZ proxy channels", "path": "/ISAPI/ContentMgmt/PTZCtrlProxy/channels", "method": "GET", "probe": "read"},
    {"id": "ptz_channels", "group": "ptz", "label": "PTZ channels", "path": "/ISAPI/PTZCtrl/channels/{channel_id}", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "ptz_channel_capabilities", "group": "ptz", "label": "PTZ channel capabilities", "path": "/ISAPI/PTZCtrl/channels/{channel_id}/capabilities", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "ptz_status", "group": "ptz", "label": "PTZ status", "path": "/ISAPI/PTZCtrl/channels/{channel_id}/status", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "ptz_zoom_focus", "group": "ptz", "label": "PTZ zoom/focus", "path": "/ISAPI/PTZCtrl/channels/{channel_id}/zoomFocus", "method": "GET", "probe": "read", "context": "channel"},
    {"id": "smart_capabilities", "group": "smart", "label": "Smart capabilities", "path": "/ISAPI/Smart/capabilities", "method": "GET", "probe": "read"},
    {"id": "thermal_capabilities", "group": "thermal", "label": "Thermal capabilities", "path": "/ISAPI/Thermal/capabilities", "method": "GET", "probe": "read"},
    {"id": "iot_channel_config", "group": "iot", "label": "IOT channel config", "path": "/ISAPI/System/IOT/channelConfig?format=json", "method": "GET", "probe": "read"},
    {"id": "iot_channels", "group": "iot", "label": "IOT channels", "path": "/ISAPI/System/IOT/channels?format=json", "method": "GET", "probe": "read"},
    {"id": "input_proxy_channels", "group": "input_proxy", "label": "Input proxy channels", "path": "/ISAPI/ContentMgmt/InputProxy/channels", "method": "GET", "probe": "read"},
    {"id": "input_proxy_channel", "group": "input_proxy", "label": "Input proxy channel", "path": "/ISAPI/ContentMgmt/InputProxy/channels/{input_proxy_id}", "method": "GET", "probe": "read", "context": "input_proxy"},
    {"id": "input_proxy_channel_capabilities", "group": "input_proxy", "label": "Input proxy channel capabilities", "path": "/ISAPI/ContentMgmt/InputProxy/channels/{input_proxy_id}/capabilities", "method": "GET", "probe": "read", "context": "input_proxy"},
    {"id": "input_proxy_channel_status", "group": "input_proxy", "label": "Input proxy channel status", "path": "/ISAPI/ContentMgmt/InputProxy/channels/{input_proxy_id}/status", "method": "GET", "probe": "read", "context": "input_proxy"},
    {"id": "system_reboot", "group": "maintenance", "label": "System reboot", "path": "/ISAPI/System/reboot", "method": "PUT", "probe": "dangerous", "companions": ["system_capabilities", "system_status"]},
    {"id": "system_shutdown", "group": "maintenance", "label": "System shutdown", "path": "/ISAPI/System/shutdown?format=json", "method": "PUT", "probe": "dangerous", "companions": ["system_capabilities", "system_status"]},
    {"id": "system_factory_reset", "group": "maintenance", "label": "System factory reset", "path": "/ISAPI/System/factoryReset?mode=full", "method": "PUT", "probe": "dangerous", "companions": ["system_capabilities"]},
    {"id": "system_update_firmware", "group": "maintenance", "label": "System update firmware", "path": "/ISAPI/System/updateFirmware", "method": "PUT", "probe": "dangerous", "companions": ["system_capabilities"]},
    {"id": "network_mail_test", "group": "maintenance", "label": "Mailing test", "path": "/ISAPI/System/Network/mailing/test", "method": "PUT", "probe": "dangerous", "companions": ["network_mailing_capabilities"]},
    {"id": "network_ftp_test", "group": "maintenance", "label": "FTP test", "path": "/ISAPI/System/Network/ftp/test", "method": "PUT", "probe": "dangerous", "companions": ["network_ftp_capabilities"]},
    {"id": "event_subscribe", "group": "event", "label": "Subscribe event", "path": "/ISAPI/Event/notification/subscribeEvent", "method": "POST", "probe": "dangerous", "companions": ["event_subscribe_capabilities"]},
    {"id": "event_unsubscribe", "group": "event", "label": "Unsubscribe event", "path": "/ISAPI/Event/notification/unSubscribeEvent", "method": "POST", "probe": "dangerous", "companions": ["event_subscribe_capabilities"]},
    {"id": "io_output_trigger", "group": "maintenance", "label": "IO output trigger", "path": "/ISAPI/System/IO/outputs/1/trigger", "method": "PUT", "probe": "dangerous", "companions": ["system_capabilities"]},
    {"id": "input_proxy_reboot", "group": "maintenance", "label": "Input proxy channel reboot", "path": "/ISAPI/ContentMgmt/InputProxy/channels/{input_proxy_id}/reboot", "method": "GET", "probe": "dangerous", "context": "input_proxy", "companions": ["input_proxy_channel_capabilities"]},
]

GROUP_LABELS = {
    "system": "System",
    "maintenance": "Maintenance",
    "network": "Network",
    "security": "Security",
    "event": "Events",
    "storage": "Storage",
    "streaming": "Streaming",
    "image": "Image",
    "ptz": "PTZ",
    "audio": "Audio",
    "smart": "Smart",
    "thermal": "Thermal",
    "iot": "IOT",
    "input_proxy": "Input Proxy",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _root_name_from_text(text: str, content_type: str | None) -> tuple[str | None, str | None]:
    raw = (text or "").strip()
    if not raw:
        return None, None
    lowered_type = str(content_type or "").lower()
    if "json" in lowered_type or raw.startswith("{") or raw.startswith("["):
        try:
            data = json.loads(raw)
        except Exception:
            return None, "json"
        if isinstance(data, dict) and data:
            return next(iter(data.keys())), "json"
        if isinstance(data, list):
            return "list", "json"
        return type(data).__name__, "json"
    try:
        node = ET.fromstring(raw)
    except ET.ParseError:
        return None, "text"
    tag = node.tag.split("}", 1)[1] if "}" in node.tag else node.tag
    return tag, "xml"


def _classify(status: int | None, body: str | None, *, helper=None, error: Exception | None = None) -> str:
    message = str(body or error or "").lower()
    if error is not None:
        return "transport_error"
    if status in (200, 201):
        return "supported"
    if status == 401:
        return "auth_failed"
    if status == 403:
        if "notsupport" in message or "not support" in message or "unsupported" in message:
            return "unsupported"
        return "forbidden"
    if status == 404:
        return "unsupported"
    if status == 405:
        return "method_not_allowed"
    if status and status >= 500:
        return "error"
    if helper is not None:
        try:
            classified = helper(status=status, body=body)
            if classified == "missing":
                return "unsupported"
            if classified == "device_error":
                return "error"
            if classified == "forbidden":
                return "forbidden"
        except Exception:
            pass
    if "notsupport" in message or "not support" in message or "unsupported" in message:
        return "unsupported"
    return "unknown"


def _iter_contexts(coordinator, entry: dict) -> list[dict]:
    all_cameras = list((coordinator.data or {}).get("all_cameras") or (coordinator.data or {}).get("cameras") or [])
    camera_ids = [str(cam.get("id")) for cam in all_cameras if str(cam.get("id") or "").strip()]
    if not camera_ids:
        camera_ids = ["1"]
    input_proxy_ids = list(camera_ids)
    context = entry.get("context")
    if context == "channel":
        return [{"channel_id": camera_id} for camera_id in camera_ids]
    if context == "input_proxy":
        return [{"input_proxy_id": camera_id} for camera_id in input_proxy_ids]
    return [{}]


def _render_path(path_template: str, values: dict) -> str:
    rendered = path_template
    for key, value in values.items():
        rendered = rendered.replace("{" + key + "}", str(value))
    return rendered


def build_catalog_snapshot(coordinator) -> dict:
    context_info = {
        "channel_ids": [str(cam.get("id")) for cam in ((coordinator.data or {}).get("all_cameras") or (coordinator.data or {}).get("cameras") or []) if str(cam.get("id") or "").strip()],
        "input_proxy_ids": [str(cam.get("id")) for cam in ((coordinator.data or {}).get("all_cameras") or (coordinator.data or {}).get("cameras") or []) if str(cam.get("id") or "").strip()],
    }
    groups: dict[str, dict] = {}
    for entry in CATALOG:
        group = entry["group"]
        bucket = groups.setdefault(group, {"key": group, "label": GROUP_LABELS.get(group, group.title()), "entries": []})
        bucket["entries"].append(
            {
                "id": entry["id"],
                "label": entry["label"],
                "method": entry["method"],
                "path_template": entry["path"],
                "probe": entry["probe"],
                "context": entry.get("context"),
                "companions": list(entry.get("companions") or []),
            }
        )
    return {
        "generated_at": _now_iso(),
        "context": context_info,
        "groups": [groups[key] for key in GROUP_LABELS if key in groups],
    }


async def _probe_one(coordinator, entry: dict, context_values: dict) -> dict:
    path = _render_path(entry["path"], context_values)
    method = entry["method"]
    try:
        response = await coordinator._request_raw(method, path)
        status = response.status
        content_type = response.headers.get("Content-Type")
        text = await response.text()
        response.release()
        root_name, body_type = _root_name_from_text(text, content_type)
        classification = _classify(status, text, helper=getattr(coordinator, "_classify_endpoint_issue", None))
        return {
            "id": entry["id"],
            "group": entry["group"],
            "label": entry["label"],
            "path": path,
            "path_template": entry["path"],
            "method": method,
            "probe": entry["probe"],
            "context": dict(context_values),
            "status": status,
            "classification": classification,
            "content_type": content_type,
            "body_type": body_type,
            "response_root": root_name,
            "supported": classification in {"supported", "supported_via_capability"},
            "companions": list(entry.get("companions") or []),
        }
    except Exception as err:
        classification = _classify(None, None, error=err)
        return {
            "id": entry["id"],
            "group": entry["group"],
            "label": entry["label"],
            "path": path,
            "path_template": entry["path"],
            "method": method,
            "probe": entry["probe"],
            "context": dict(context_values),
            "status": None,
            "classification": classification,
            "content_type": None,
            "body_type": None,
            "response_root": None,
            "supported": False,
            "companions": list(entry.get("companions") or []),
            "error": str(err),
        }


def _collapse_group(entries: list[dict], key: str) -> dict:
    summary: dict[str, int] = defaultdict(int)
    for item in entries:
        summary[item["classification"]] += 1
    return {
        "key": key,
        "label": GROUP_LABELS.get(key, key.title()),
        "summary": dict(summary),
        "entries": entries,
    }


async def async_run_probe(coordinator, *, groups: list[str] | None = None, include_dangerous: bool = False, max_endpoints: int = 250) -> dict:
    selected_groups = {str(item).strip().lower() for item in (groups or []) if str(item).strip()}
    safe_results: list[dict] = []
    dangerous_entries: list[tuple[dict, dict]] = []
    by_id: dict[str, list[dict]] = defaultdict(list)

    request_count = 0
    for entry in CATALOG:
        if selected_groups and entry["group"] not in selected_groups:
            continue
        for context_values in _iter_contexts(coordinator, entry):
            if entry["probe"] == "dangerous":
                dangerous_entries.append((entry, context_values))
                continue
            if request_count >= max_endpoints:
                break
            result = await _probe_one(coordinator, entry, context_values)
            safe_results.append(result)
            by_id[result["id"]].append(result)
            request_count += 1
        if request_count >= max_endpoints:
            break

    if include_dangerous:
        for entry, context_values in dangerous_entries:
            companions = entry.get("companions") or []
            companion_supported = False
            companion_unknown = False
            for companion_id in companions:
                companion_results = by_id.get(companion_id) or []
                if not companion_results:
                    companion_unknown = True
                    continue
                if any(item["classification"] == "supported" for item in companion_results):
                    companion_supported = True
                elif any(item["classification"] not in {"unsupported", "auth_failed", "forbidden", "method_not_allowed"} for item in companion_results):
                    companion_unknown = True
            classification = "dangerous_not_probed"
            if companion_supported:
                classification = "supported_via_capability"
            elif companions and not companion_unknown:
                classification = "unsupported"
            safe_results.append(
                {
                    "id": entry["id"],
                    "group": entry["group"],
                    "label": entry["label"],
                    "path": _render_path(entry["path"], context_values),
                    "path_template": entry["path"],
                    "method": entry["method"],
                    "probe": entry["probe"],
                    "context": dict(context_values),
                    "status": None,
                    "classification": classification,
                    "content_type": None,
                    "body_type": None,
                    "response_root": None,
                    "supported": classification in {"supported_via_capability"},
                    "companions": companions,
                }
            )

    grouped_entries: dict[str, list[dict]] = defaultdict(list)
    for item in safe_results:
        grouped_entries[item["group"]].append(item)

    totals: dict[str, int] = defaultdict(int)
    for item in safe_results:
        totals[item["classification"]] += 1

    return {
        "generated_at": _now_iso(),
        "device": {
            "entry_id": coordinator.entry.entry_id,
            "host": coordinator.host,
            "nvr": dict((coordinator.data or {}).get("nvr") or {}),
        },
        "context": build_catalog_snapshot(coordinator)["context"],
        "groups": [_collapse_group(grouped_entries[key], key) for key in GROUP_LABELS if key in grouped_entries],
        "totals": dict(totals),
        "request_count": request_count,
        "include_dangerous": include_dangerous,
        "selected_groups": sorted(selected_groups),
        "max_endpoints": max_endpoints,
    }
