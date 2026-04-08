from __future__ import annotations

from typing import Any
import xml.etree.ElementTree as ET

from .const import (
    DEFAULT_STREAM_PROFILE,
    DOMAIN,
    STREAM_PROFILE_MAIN,
    STREAM_PROFILE_OPTIONS,
    STREAM_PROFILE_SUB,
)

HK_NS = "http://www.hikvision.com/ver20/XMLSchema"


def _local_name(tag: str | None) -> str:
    raw = str(tag or "")
    if "}" in raw:
        raw = raw.rsplit("}", 1)[-1]
    if ":" in raw:
        raw = raw.rsplit(":", 1)[-1]
    return raw


def _iter_elements_by_local_name(xml_obj: Any, *names: str):
    if xml_obj is None:
        return
    wanted = {str(name) for name in names if str(name)}
    if not wanted:
        return
    for elem in xml_obj.iter():
        if _local_name(getattr(elem, "tag", None)) in wanted:
            yield elem


def safe_find_text(
    xml_obj: Any,
    tag: str,
    default: str | None = None,
    namespace: dict[str, str] | None = None,
) -> str | None:
    if isinstance(default, dict) and namespace is None:
        namespace = default
        default = None

    if xml_obj is None:
        return default

    local_tag = _local_name(tag)
    search_paths: list[tuple[str, dict[str, str] | None]] = []

    if namespace and ":" in str(tag):
        search_paths.append((f".//{tag}", namespace))
    if str(tag):
        search_paths.append((f".//{tag}", namespace))
    if local_tag:
        search_paths.append((f".//{{{HK_NS}}}{local_tag}", None))
        search_paths.append((f".//{local_tag}", None))

    seen: set[tuple[str, tuple[tuple[str, str], ...] | None]] = set()
    for path, ns in search_paths:
        ns_key = tuple(sorted((ns or {}).items())) or None
        cache_key = (path, ns_key)
        if cache_key in seen:
            continue
        seen.add(cache_key)
        try:
            value = xml_obj.findtext(path, default=None, namespaces=ns)
        except TypeError:
            try:
                value = xml_obj.findtext(path, namespaces=ns)
            except Exception:
                value = None
        except Exception:
            value = None
        if value is not None:
            value = value.strip()
            if value:
                return value

    for elem in xml_obj.iter():
        if _local_name(getattr(elem, "tag", None)) != local_tag:
            continue
        value = getattr(elem, "text", None)
        if value is None:
            continue
        value = value.strip()
        if value:
            return value

    return default


def get_dvr_serial(coordinator, entry) -> str:
    serial = safe_find_text(coordinator.data.get("device_xml"), "serialNumber")
    return serial or entry.data.get("host", "unknown_dvr")


def build_camera_device_info(dvr_serial: str, cam: dict[str, Any]) -> dict[str, Any]:
    cam_id = str(cam.get("id", "unknown"))
    return {
        "identifiers": {(DOMAIN, f"{dvr_serial}_cam_{cam_id}")},
        "name": cam.get("name") or f"Camera {cam_id}",
        "manufacturer": "Hikvision",
        "model": cam.get("model") or None,
        "sw_version": cam.get("firmware_version") or None,
        "serial_number": cam.get("serial_number") or f"channel_{cam_id}",
        "via_device": (DOMAIN, dvr_serial),
    }


def _quote_credentials(username: str, password: str) -> tuple[str, str]:
    from urllib.parse import quote

    user = quote(username or "", safe="")
    pw = quote(password or "", safe="")
    return user, pw


def build_rtsp_url(username: str, password: str, host: str, stream_id: str | int, port: int = 554) -> str:
    user, pw = _quote_credentials(username, password)
    return f"rtsp://{user}:{pw}@{host}:{port}/ISAPI/Streaming/Channels/{stream_id}"


def build_rtsp_direct_url(username: str, password: str, host: str, stream_id: str | int, port: int = 554) -> str:
    user, pw = _quote_credentials(username, password)
    return f"rtsp://{user}:{pw}@{host}:{port}/Streaming/Channels/{stream_id}/?transportmode=unicast"


def inject_rtsp_credentials(rtsp_uri: str | None, username: str, password: str, default_port: int = 554) -> str | None:
    if not rtsp_uri:
        return rtsp_uri

    from urllib.parse import urlsplit, urlunsplit

    try:
        parts = urlsplit(rtsp_uri)
    except Exception:
        return rtsp_uri

    if parts.scheme.lower() not in {"rtsp", "rtsps"}:
        return rtsp_uri

    hostname = parts.hostname or ""
    if not hostname:
        return rtsp_uri

    current_user = parts.username
    current_password = parts.password
    port = parts.port or default_port
    user, pw = _quote_credentials(current_user or username or "", current_password or password or "")

    auth = f"{user}:{pw}@" if user or pw else ""
    host = hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = f"{auth}{host}:{port}" if port else f"{auth}{host}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def classify_stream_profile(stream_id: str | int | None) -> str:
    sid = str(stream_id or "")
    if sid.endswith("02"):
        return STREAM_PROFILE_SUB
    return STREAM_PROFILE_MAIN


def normalize_stream_profile(profile: str | None) -> str:
    value = str(profile or DEFAULT_STREAM_PROFILE).strip().lower()
    return value if value in STREAM_PROFILE_OPTIONS else DEFAULT_STREAM_PROFILE


def parse_input_proxy_channels(xml_obj: ET.Element | None) -> list[dict[str, Any]]:
    channels: list[dict[str, Any]] = []
    if xml_obj is None:
        return channels

    for channel in _iter_elements_by_local_name(xml_obj, "InputProxyChannel"):
        cam_id = safe_find_text(channel, "id")
        if not cam_id:
            continue
        channels.append(
            {
                "id": str(cam_id),
                "name": safe_find_text(channel, "name", f"Camera {cam_id}") or f"Camera {cam_id}",
                "online": coerce_bool(safe_find_text(channel, "online"), default=True),
                "enabled": coerce_bool(safe_find_text(channel, "enabled"), default=True),
                "model": safe_find_text(channel, "model"),
                "serial_number": safe_find_text(channel, "serialNumber"),
                "firmware_version": safe_find_text(channel, "firmwareVersion"),
                "manufacturer": safe_find_text(channel, "manufacturer") or "Hikvision",
                "ip_address": safe_find_text(channel, "ipAddress") or safe_find_text(channel, "ipAddressV4") or safe_find_text(channel, "srcInputPort") or safe_find_text(channel, "sourceInputPortDescriptor"),
                "manage_port": safe_find_text(channel, "managePort") or safe_find_text(channel, "portNo"),
            }
        )
    return channels


def parse_streaming_channels(xml_obj: ET.Element | None) -> dict[str, list[dict[str, Any]]]:
    streams_by_camera: dict[str, list[dict[str, Any]]] = {}
    if xml_obj is None:
        return streams_by_camera

    for channel in _iter_elements_by_local_name(xml_obj, "StreamingChannel"):
        stream_id = safe_find_text(channel, "id")
        if not stream_id:
            continue

        digits = "".join(ch for ch in str(stream_id) if ch.isdigit())
        if len(digits) >= 3:
            cam_id = str(int(digits[:-2]))
        else:
            cam_id = str(stream_id)

        entry = {
            "id": str(stream_id),
            "stream_id": str(stream_id),
            "track_id": safe_find_text(channel, "trackID") or str(stream_id),
            "name": safe_find_text(channel, "channelName") or safe_find_text(channel, "name") or f"Stream {stream_id}",
            "profile": classify_stream_profile(stream_id),
            "video_enabled": coerce_bool(
                safe_find_text(channel, "enabled") or safe_find_text(channel, "videoEnabled"),
                default=True,
            ),
            "transport": safe_find_text(channel, "transportType")
            or safe_find_text(channel, "TransportType")
            or safe_find_text(channel, "streamingTransport"),
            "video_codec": safe_find_text(channel, "videoCodecType"),
            "width": safe_find_text(channel, "videoResolutionWidth"),
            "height": safe_find_text(channel, "videoResolutionHeight"),
            "bitrate_mode": safe_find_text(channel, "videoBitRateType") or safe_find_text(channel, "videoQualityControlType"),
            "constant_bitrate": safe_find_text(channel, "vbrUpperCap") or safe_find_text(channel, "constantBitRate"),
            "bitrate": safe_find_text(channel, "constantBitRate") or safe_find_text(channel, "vbrUpperCap"),
            "max_frame_rate": safe_find_text(channel, "maxFrameRate"),
            "audio_codec": safe_find_text(channel, "audioCompressionType"),
            "video_input_channel_id": safe_find_text(channel, "dynVideoInputChannelID") or safe_find_text(channel, "videoInputChannelID"),
        }
        streams_by_camera.setdefault(cam_id, []).append(entry)

    return streams_by_camera


def build_stream_profile_map(streams_for_camera: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    if not streams_for_camera:
        return {}

    ordered = sorted(
        streams_for_camera,
        key=lambda item: (
            0 if item.get("video_enabled") else 1,
            0 if classify_stream_profile(item.get("stream_id")) == STREAM_PROFILE_MAIN else 1,
            item.get("stream_id", ""),
        ),
    )

    profiles: dict[str, dict[str, Any]] = {}
    fallback = ordered[0]
    for stream in ordered:
        profile = classify_stream_profile(stream.get("stream_id"))
        profiles.setdefault(profile, stream)
    profiles.setdefault(STREAM_PROFILE_MAIN, fallback)
    if STREAM_PROFILE_SUB not in profiles and len(ordered) > 1:
        profiles[STREAM_PROFILE_SUB] = ordered[1]
    return profiles


def choose_stream_by_profile(streams_for_camera: list[dict[str, Any]], profile: str | None) -> dict[str, Any]:
    profiles = build_stream_profile_map(streams_for_camera)
    selected = normalize_stream_profile(profile)
    selected_stream = profiles.get(selected)
    selection_source = "requested"

    if selected_stream is None:
        selected_stream = profiles.get(DEFAULT_STREAM_PROFILE)
        selection_source = f"fallback_{DEFAULT_STREAM_PROFILE}"

    if selected_stream is None and profiles:
        selected_stream = next(iter(profiles.values()))
        selection_source = "fallback_first"

    if selected_stream is None:
        return {
            "available_profiles": [],
            "profile_map": {},
            "selection_source": "unavailable",
        }

    selected_stream = dict(selected_stream)
    selected_stream["available_profiles"] = sorted(list(profiles.keys()))
    selected_stream["profile_map"] = {
        profile_name: stream.get("stream_id")
        for profile_name, stream in profiles.items()
        if stream.get("stream_id")
    }
    selected_stream["selection_source"] = selection_source
    return selected_stream


def build_nvr_device_info(dvr_serial: str, entry: Any, device_xml: Any) -> dict[str, Any]:
    host = entry.data.get("host", "unknown") if entry else "unknown"
    model = safe_find_text(device_xml, "model", "Hikvision NVR") or "Hikvision NVR"
    name = safe_find_text(device_xml, "deviceName", f"Hikvision NVR ({host})") or f"Hikvision NVR ({host})"
    return {
        "identifiers": {(DOMAIN, dvr_serial)},
        "name": name,
        "manufacturer": safe_find_text(device_xml, "manufacturer", "Hikvision") or "Hikvision",
        "model": model,
        "sw_version": safe_find_text(device_xml, "firmwareVersion"),
        "serial_number": dvr_serial,
    }




def _iter_hdd_elements(xml_obj: Any) -> list[Any]:
    if xml_obj is None:
        return []
    return list(_iter_elements_by_local_name(xml_obj, "hdd"))


def _parse_hdds_from_xml(xml_obj: Any) -> list[dict[str, Any]]:
    hdds: list[dict[str, Any]] = []
    for hdd in _iter_hdd_elements(xml_obj):
        def ftext(tag: str, default: str = "") -> str:
            value = safe_find_text(hdd, tag, default)
            if value is None:
                return default
            value = str(value).strip()
            return value or default

        try:
            capacity = int(ftext("capacity", "0") or 0)
        except Exception:
            capacity = 0
        try:
            free_space = int(ftext("freeSpace", "0") or 0)
        except Exception:
            free_space = 0
        status = ftext("status", "unknown")
        hdds.append(
            {
                "id": ftext("id"),
                "name": ftext("hddName"),
                "path": ftext("hddPath"),
                "type": ftext("hddType"),
                "status": status,
                "capacity_mb": capacity,
                "free_space_mb": free_space,
                "used_space_mb": max(capacity - free_space, 0),
                "property": ftext("property"),
                "manufacturer": ftext("manufacturer"),
            }
        )
    return hdds


def _storage_summary_from_hdds(hdds: list[dict[str, Any]], *, disk_mode: str | None = None, work_mode: str | None = None) -> dict[str, Any]:
    healthy_statuses = {"ok", "normal", "healthy"}
    result: dict[str, Any] = {
        "hdds": hdds,
        "disk_count": len(hdds),
        "healthy_disks": sum(1 for d in hdds if str(d.get("status", "")).lower() in healthy_statuses),
        "failed_disks": sum(1 for d in hdds if str(d.get("status", "")).lower() not in healthy_statuses),
        "total_capacity_mb": sum(int(d.get("capacity_mb", 0) or 0) for d in hdds),
        "free_capacity_mb": sum(int(d.get("free_space_mb", 0) or 0) for d in hdds),
        "used_capacity_mb": sum(int(d.get("used_space_mb", 0) or 0) for d in hdds),
        "disk_mode": disk_mode,
        "work_mode": work_mode,
    }
    return result

def parse_storage_xml(storage_xml: Any) -> dict[str, Any]:
    result: dict[str, Any] = _storage_summary_from_hdds([], work_mode=None)
    if storage_xml is None:
        return result

    try:
        work_mode = safe_find_text(storage_xml, "workMode")
        hdds = _parse_hdds_from_xml(storage_xml)
        result = _storage_summary_from_hdds(hdds, work_mode=work_mode)
    except Exception:
        return result
    return result


def parse_storage_capabilities_xml(storage_caps_xml: Any) -> dict[str, Any]:
    result: dict[str, Any] = _storage_summary_from_hdds([], disk_mode=safe_find_text(storage_caps_xml, "diskMode"))
    if storage_caps_xml is None:
        return result

    try:
        disk_mode = safe_find_text(storage_caps_xml, "diskMode")
        hdds = _parse_hdds_from_xml(storage_caps_xml)
        result = _storage_summary_from_hdds(hdds, disk_mode=disk_mode)
    except Exception:
        return result
    return result


def merge_storage_sources(*sources: dict[str, Any] | None) -> dict[str, Any]:
    merged: dict[str, Any] = {
        "hdds": [],
        "disk_count": 0,
        "healthy_disks": 0,
        "failed_disks": 0,
        "total_capacity_mb": 0,
        "free_capacity_mb": 0,
        "used_capacity_mb": 0,
        "disk_mode": None,
        "work_mode": None,
        "storage_info_supported": False,
        "storage_hdd_caps_supported": False,
        "storage_extra_caps_supported": False,
        "storage_present": False,
        "playback_supported": False,
    }
    disk_by_id: dict[str, dict[str, Any]] = {}

    for source in sources:
        if not source:
            continue
        for key in ("disk_mode", "work_mode"):
            if source.get(key) and not merged.get(key):
                merged[key] = source.get(key)
        for flag in ("storage_info_supported", "storage_hdd_caps_supported", "storage_extra_caps_supported"):
            if source.get(flag):
                merged[flag] = True
        for disk in source.get("hdds", []) or []:
            disk_id = str(disk.get("id") or len(disk_by_id) + 1)
            current = dict(disk_by_id.get(disk_id, {}))
            current.update({k: v for k, v in (disk or {}).items() if v not in (None, "", [])})
            if "status" not in current:
                current["status"] = "unknown"
            disk_by_id[disk_id] = current

    merged["hdds"] = sorted(
        disk_by_id.values(),
        key=lambda d: int(str(d.get("id")).strip()) if str(d.get("id", "")).strip().isdigit() else str(d.get("id", "")),
    )
    summary = _storage_summary_from_hdds(merged["hdds"], disk_mode=merged.get("disk_mode"), work_mode=merged.get("work_mode"))
    merged.update(summary)
    merged["storage_present"] = bool(merged["disk_count"] or merged["total_capacity_mb"])
    merged["playback_supported"] = bool(merged["storage_present"] and merged["healthy_disks"] > 0)
    return merged

    try:
        hdds = []
        for hdd in storage_caps_xml.findall(f".//{{{HK_NS}}}hdd"):
            def ftext(tag, default=""):
                value = hdd.findtext(f"{{{HK_NS}}}{tag}")
                if value is None:
                    return default
                value = value.strip()
                return value or default
            capacity = int(ftext("capacity", "0") or 0)
            free_space = int(ftext("freeSpace", "0") or 0)
            status = ftext("status", "unknown")
            disk = {
                "id": ftext("id"),
                "name": ftext("hddName"),
                "path": ftext("hddPath"),
                "type": ftext("hddType"),
                "status": status,
                "capacity_mb": capacity,
                "free_space_mb": free_space,
                "used_space_mb": max(capacity - free_space, 0),
                "property": ftext("property"),
                "manufacturer": ftext("manufacturer"),
            }
            hdds.append(disk)
        result["hdds"] = hdds
        result["disk_count"] = len(hdds)
        result["healthy_disks"] = sum(1 for d in hdds if str(d.get("status", "")).lower() in {"ok", "normal", "healthy"})
        result["failed_disks"] = sum(1 for d in hdds if str(d.get("status", "")).lower() not in {"ok", "normal", "healthy"})
        result["total_capacity_mb"] = sum(int(d.get("capacity_mb", 0) or 0) for d in hdds)
        result["free_capacity_mb"] = sum(int(d.get("free_space_mb", 0) or 0) for d in hdds)
        result["used_capacity_mb"] = sum(int(d.get("used_space_mb", 0) or 0) for d in hdds)
    except Exception:
        return result
    return result
