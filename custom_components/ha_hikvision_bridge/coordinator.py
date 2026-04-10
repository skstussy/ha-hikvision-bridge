from __future__ import annotations

import asyncio
import logging
from datetime import timedelta, datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from yarl import URL
import xml.etree.ElementTree as ET
from typing import Any

from aiohttp import ClientError, ClientResponseError
from homeassistant.core import HomeAssistant
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .audio import HikvisionAudioManager
from .audio_classifier import HikvisionAudioClassifier

from .const import (
    CONF_DEBUG_CATEGORIES,
    CONF_DEBUG_ENABLED,
    CONF_HOST,
    CONF_PASSWORD,
    CONF_PORT,
    CONF_USERNAME,
    CONF_USE_HTTPS,
    CONF_VERIFY_SSL,
    DEFAULT_RTSP_PORT,
    DEFAULT_STREAM_MODE,
    DEFAULT_STREAM_PROFILE,
    DOMAIN,
    STREAM_MODE_RTSP,
    STREAM_MODE_RTSP_DIRECT,
    STREAM_MODE_SNAPSHOT,
    STREAM_MODE_WEBRTC,
    STREAM_MODE_WEBRTC_DIRECT,
)
from .digest import DigestAuth
from .helpers import (
    build_rtsp_direct_url,
    build_rtsp_url,
    build_stream_profile_map,
    choose_stream_by_profile,
    coerce_bool,
    inject_rtsp_credentials,
    normalize_stream_profile,
    merge_storage_sources,
    parse_input_proxy_channels,
    parse_storage_capabilities_xml,
    parse_storage_xml,
    parse_streaming_channels,
    safe_find_text,
)
from .debug import HikvisionDebugManager, sanitize_debug

_LOGGER = logging.getLogger(__name__)


class HikvisionEndpointError(UpdateFailed):
    def __init__(self, *, method: str, path: str, status: int | None = None, body: str | None = None, classification: str = "request_error", detail: str | None = None):
        self.method = method
        self.path = path
        self.status = status
        self.body = body
        self.classification = classification
        self.detail = detail
        parts = [f"{method} {path}", classification]
        if status is not None:
            parts.append(f"status={status}")
        if detail:
            parts.append(detail)
        super().__init__(" | ".join(parts))


def _parse_hikvision_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = dt_util.parse_datetime(text)
    except (TypeError, ValueError):
        parsed = None
    if parsed is not None:
        return parsed
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S"):
        try:
            parsed = datetime.strptime(text, fmt)
            if parsed.tzinfo is None:
                return dt_util.as_local(parsed).astimezone(dt_util.UTC)
            return parsed.astimezone(dt_util.UTC)
        except ValueError:
            continue
    return None


def _format_rtsp_playback_timestamp(value: str | None) -> str | None:
    parsed = _parse_hikvision_dt(value)
    if parsed is None:
        return None
    return dt_util.as_utc(parsed).strftime("%Y%m%dT%H%M%SZ")


def _format_search_timestamp(value: str | None) -> str | None:
    parsed = _parse_hikvision_dt(value)
    if parsed is None:
        return None
    return dt_util.as_utc(parsed).strftime("%Y-%m-%dT%H:%M:%SZ")


def _candidate_playback_track_ids(cam: dict, active_stream: dict, profiles: dict) -> list[str]:
    """Return canonical DVR main-stream recording tracks for playback search.

    Playback recordings on Hikvision DVR/NVR channels are exposed on the main
    recording track for a channel, e.g. CH1 -> 101, CH2 -> 201, CH3 -> 301.
    Never search playback using the currently selected live-view stream because
    live mode may be on a sub-stream while recordings still exist only on the
    channel's main stream track.
    """
    values: list[str] = []
    seen: set[str] = set()

    def extract_stream_value(value) -> str:
        if isinstance(value, dict):
            for key in ("channel", "stream_id", "id", "track_id"):
                candidate = value.get(key)
                if candidate:
                    return str(candidate).strip()
            return ""
        return str(value or "").strip()

    def add_main_recording_track(value) -> None:
        raw = extract_stream_value(value)
        if not raw:
            return

        digits = "".join(ch for ch in raw if ch.isdigit())
        if not digits:
            return

        try:
            channel_num = int(digits)
        except ValueError:
            return

        if channel_num <= 0:
            return
        if channel_num >= 100:
            channel_num = channel_num // 100

        track_id = f"{channel_num}01"
        if track_id not in seen:
            seen.add(track_id)
            values.append(track_id)

    for value in (
        cam.get("channel"),
        cam.get("id"),
        active_stream.get("channel"),
        (profiles.get("main") or {}).get("channel") if isinstance(profiles.get("main"), dict) else None,
        (profiles.get("sub") or {}).get("channel") if isinstance(profiles.get("sub"), dict) else None,
        active_stream.get("stream_id"),
        profiles.get("main"),
        profiles.get("mainstream"),
        profiles.get("sub"),
        cam.get("stream_id"),
    ):
        add_main_recording_track(value)

    return values


def _inject_rtsp_playback_window(playback_uri: str | None, requested_time: str | None, end_time: str | None = None) -> str | None:
    """Normalize Hikvision playback RTSP URIs while preserving seek intent."""
    if not playback_uri:
        return playback_uri

    try:
        parts = urlsplit(playback_uri)
        query_items = parse_qsl(parts.query, keep_blank_values=True)
        query = dict(query_items)

        path = parts.path[:-1] if parts.path.endswith("/") else parts.path

        start_stamp = _format_rtsp_playback_timestamp(requested_time or query.get("starttime"))
        if start_stamp:
            query["starttime"] = start_stamp

        if "endtime" in query:
            end_stamp = _format_rtsp_playback_timestamp(end_time or query.get("endtime"))
            if end_stamp:
                query["endtime"] = end_stamp
            else:
                query.pop("endtime", None)

        return urlunsplit((parts.scheme, parts.netloc, path, urlencode(query), parts.fragment))
    except Exception:
        return playback_uri



class HikvisionCoordinator(DataUpdateCoordinator):
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry):
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_{entry.entry_id}",
            update_interval=timedelta(seconds=30),
        )
        self.hass = hass
        self.entry = entry
        self.host = entry.data[CONF_HOST]
        self.port = entry.data[CONF_PORT]
        self.username = entry.data[CONF_USERNAME]
        self.password = entry.data[CONF_PASSWORD]
        self.use_https = entry.data.get(CONF_USE_HTTPS, True)
        self.verify_ssl = entry.data.get(CONF_VERIFY_SSL, False)
        self.rtsp_port = DEFAULT_RTSP_PORT
        self._alarm_stream_task: asyncio.Task | None = None
        self._ptz_state: dict[str, dict] = {}
        self._ptz_capability_cache: dict[str, dict] = {}
        self._playback_debug_by_camera: dict[str, list[dict]] = {}
        self._stream_profile_by_camera: dict[str, str] = {str(k): normalize_stream_profile(v) for k, v in entry.options.get("stream_profile_by_camera", {}).items()}
        self._debug_enabled = bool(entry.options.get(CONF_DEBUG_ENABLED, False))
        self._debug_categories = {str(v).lower() for v in entry.options.get(CONF_DEBUG_CATEGORIES, ()) if str(v).strip()}
        self._debug_manager = HikvisionDebugManager(max_entries=300)
        self.session = async_get_clientsession(hass)
        self.digest = DigestAuth(self.username, self.password)
        self.audio = HikvisionAudioManager(hass, self)
        self.audio_classifier = HikvisionAudioClassifier()

    async def async_ingest_audio_samples(self, camera_id: str, samples: list[int | float]) -> None:
        state = self.audio.ingest_samples(str(camera_id), samples)
        if not state:
            return

        self._push_debug_event(
            category="audio",
            event="audio_samples_ingested",
            message=f"Ingested audio samples for camera {camera_id}",
            camera_id=str(camera_id),
            context={
                "sample_count": len(samples),
                "level": state.get("level"),
                "peak": state.get("peak"),
                "frames_ingested": state.get("frames_ingested"),
            },
        )
        await self._maybe_run_audio_classifier(str(camera_id))
        self.async_update_listeners()

    async def _maybe_run_audio_classifier(self, camera_id: str) -> None:
        state = self.audio.get_state(camera_id)
        if not state:
            return
        if not state.get("classifier_enabled"):
            return
        if not (state.get("abnormal") or state.get("voice_detected") or state.get("clipping")):
            return

        clip = self.audio.get_clip(camera_id)
        result = await self.audio_classifier.classify_clip(camera_id, clip)
        if not result:
            return

        label = result.get("label")
        confidence = float(result.get("confidence", 0.0) or 0.0)
        threshold = float(self.audio.get_config(str(camera_id)).get("classifier_threshold") or 0.0)
        accepted = bool(label) and confidence >= threshold and label != "ambient"

        self.audio.update_classifier_result(
            str(camera_id),
            label=label,
            confidence=confidence,
            accepted=accepted,
            source="signal_heuristic",
        )

        self._push_debug_event(
            level="info" if accepted else "debug",
            category="audio",
            event="audio_classifier_result",
            message=f"Audio classifier produced {label} for camera {camera_id}",
            camera_id=camera_id,
            context={
                "label": label,
                "confidence": confidence,
                "threshold": threshold,
                "accepted": accepted,
                "metrics": result.get("metrics", {}),
            },
        )

        if accepted:
            payload = {
                "camera_id": camera_id,
                "label": label,
                "confidence": confidence,
                "threshold": threshold,
            }
            self.hass.bus.async_fire(f"{DOMAIN}_audio_detected", payload)
            if label == "gunshot":
                self.hass.bus.async_fire(f"{DOMAIN}_gunshot_detected", payload)
        self.async_update_listeners()

    def url(self, path: str) -> str:
        scheme = "https" if self.use_https else "http"
        return f"{scheme}://{self.host}:{self.port}{path}"

    async def async_get_webrtc_url(self, cam_id: str) -> str | None:
        camera = self.get_camera(cam_id)
        if not camera:
            return None

        stream_url = camera.get("rtsp_direct_url") or camera.get("rtsp_url")
        if not stream_url:
            return None

        stream_url = inject_rtsp_credentials(
            stream_url,
            self.username,
            self.password,
            default_port=self.rtsp_port,
        )

        path = self.entry.options.get("webrtc_path") or self.entry.data.get("webrtc_path") or "/api/webrtc"
        base = URL(path)
        if not base.scheme:
            if base.path.startswith("/"):
                base = URL(f"/{base.path.lstrip('/')}")
            else:
                base = URL(f"/{base.path}")
        query = dict(base.query)
        query["src"] = stream_url
        return str(base.with_query(query))

    def get_camera(self, cam_id: str) -> dict:
        """Return the current camera payload for a channel."""
        cam_id = str(cam_id)
        return next(
            (cam for cam in self.data.get("cameras", []) if str(cam.get("id")) == cam_id),
            {},
        )

    def get_stream_profiles(self, cam_id: str) -> dict:
        """Return the stream profile map for a camera."""
        camera = self.get_camera(cam_id)
        profile_map = camera.get("stream_profile_map") or {}
        return dict(profile_map)

    def get_active_stream(self, cam_id: str) -> dict:
        """Return the resolved active stream metadata for a camera."""
        camera = self.get_camera(cam_id)
        if not camera:
            return {}
        stream_id = camera.get("stream_id")
        return {
            "profile": camera.get("stream_profile"),
            "requested_profile": camera.get("stream_profile_requested"),
            "resolved_profile": camera.get("stream_profile_resolved"),
            "options": list(camera.get("stream_profile_options") or []),
            "selection_source": camera.get("stream_profile_selection_source"),
            "id": stream_id,
            "stream_id": stream_id,
            "stream_name": camera.get("name"),
            "track_id": camera.get("track_id"),
            "rtsp_url": camera.get("rtsp_url"),
            "rtsp_direct_url": camera.get("rtsp_direct_url"),
            "rtsp_profile": camera.get("rtsp_profile"),
            "transport": camera.get("transport"),
            "video_codec": camera.get("video_codec"),
            "width": camera.get("width"),
            "height": camera.get("height"),
            "bitrate_mode": camera.get("bitrate_mode"),
            "constant_bitrate": camera.get("constant_bitrate"),
            "max_frame_rate": camera.get("max_frame_rate"),
            "audio_codec": camera.get("audio_codec"),
            "video_input_channel_id": camera.get("video_input_channel_id"),
            "bitrate": camera.get("bitrate"),
            "width": camera.get("width"),
            "height": camera.get("height"),
        }

    def get_selected_stream_profile(self, cam_id: str) -> str:
        """Return the selected stream profile for a camera."""
        camera = self.get_camera(cam_id)
        return normalize_stream_profile(camera.get("stream_profile"))

    def set_stream_profile(self, cam_id: str, profile: str) -> None:
        """Compatibility wrapper for entity/service callers expecting a sync API."""
        self.hass.async_create_task(self.async_set_stream_profile(cam_id, profile))

    def _find_camera_entity(self, cam_id: str):
        cam_key = str(cam_id)
        for entity in getattr(self, "entities", {}).values():
            if str(getattr(entity, "_cam_id", "")) == cam_key:
                return entity
        return None

    def _refresh_digest_from_header(self, header: str | None = None) -> None:
        self.digest.reset()
        if header and "digest" in header.lower():
            try:
                self.digest.parse(header)
            except Exception:
                self.digest.reset()

    def _normalize_stream_mode(self, mode: str | None) -> str:
        value = str(mode or DEFAULT_STREAM_MODE).strip().lower()
        allowed = {
            STREAM_MODE_WEBRTC,
            STREAM_MODE_WEBRTC_DIRECT,
            STREAM_MODE_RTSP,
            STREAM_MODE_RTSP_DIRECT,
            STREAM_MODE_SNAPSHOT,
        }
        return value if value in allowed else DEFAULT_STREAM_MODE

    async def snapshot_image(self, cam_id: str) -> bytes | None:
        """Fetch a JPEG snapshot for a camera channel."""
        camera = self.get_camera(cam_id)
        stream_id = camera.get("stream_id") or f"{cam_id}01"
        path = f"/ISAPI/Streaming/channels/{stream_id}/picture"
        url = self.url(path)

        for attempt in range(2):
            auth_header = await self.digest.async_get_authorization(
                self.session,
                "GET",
                url,
                verify_ssl=self.verify_ssl,
            )
            async with self.session.get(
                url,
                headers={"Authorization": auth_header},
                ssl=self.verify_ssl,
            ) as resp:
                if resp.status == 401 and attempt == 0:
                    self._refresh_digest_from_header(resp.headers.get("WWW-Authenticate"))
                    continue
                if resp.status != 200:
                    raise HikvisionEndpointError(
                        method="GET",
                        path=path,
                        status=resp.status,
                        body=(await resp.text())[:1000],
                        classification="http_error",
                    )
                return await resp.read()

        raise HikvisionEndpointError(
            method="GET",
            path=path,
            status=401,
            classification="http_error",
            detail="authorization failed after refresh",
        )

    async def _send_put_xml(
        self,
        path: str,
        xml_body: str,
        *,
        expected: tuple[int, ...] = (200, 201, 204),
    ) -> str:
        return await self._request_text(
            "PUT",
            path,
            body=xml_body,
            expected=expected,
            headers={"Content-Type": "application/xml; charset=UTF-8"},
            allow_empty=True,
        )

    def _build_ptz_endpoint(self, cam_id: str, operation: str) -> str:
        cam_key = str(cam_id)
        return f"/ISAPI/ContentMgmt/PTZCtrlProxy/channels/{cam_key}/{operation}"

    async def _probe_ptz_capabilities(self, cam_id: str) -> dict:
        cam_key = str(cam_id)
        cached = self._ptz_capability_cache.get(cam_key)
        if cached:
            return dict(cached)

        result = {
            "ptz_supported": False,
            "ptz_proxy_supported": False,
            "ptz_control_method": "none",
            "ptz_capability_mode": "unknown",
            "ptz_implementation": "none",
            "ptz_proxy_ctrl_mode": None,
            "ptz_momentary_supported": False,
            "ptz_continuous_supported": False,
            "ptz_proxy_momentary_supported": False,
            "ptz_proxy_continuous_supported": False,
            "ptz_unsupported_reason": None,
            "focus_supported": False,
            "iris_supported": False,
            "zoom_supported": False,
        }

        camera = self.get_camera(cam_key)
        if not camera or not camera.get("online", True):
            result["ptz_unsupported_reason"] = "camera_offline"
            self._ptz_capability_cache[cam_key] = dict(result)
            return dict(result)

        if camera.get("ptz_supported") is True and camera.get("ptz_control_method") == "proxy":
            result.update(
                {
                    "ptz_supported": True,
                    "ptz_proxy_supported": bool(camera.get("ptz_proxy_supported", True)),
                    "ptz_control_method": str(camera.get("ptz_control_method") or "proxy"),
                    "ptz_capability_mode": str(camera.get("ptz_capability_mode") or "momentary"),
                    "ptz_implementation": str(camera.get("ptz_implementation") or "ptzctrlproxy"),
                    "ptz_proxy_ctrl_mode": camera.get("ptz_proxy_ctrl_mode") or "isapi",
                    "ptz_momentary_supported": bool(camera.get("ptz_momentary_supported", True)),
                    "ptz_continuous_supported": bool(camera.get("ptz_continuous_supported", False)),
                    "ptz_proxy_momentary_supported": bool(camera.get("ptz_proxy_momentary_supported", True)),
                    "ptz_proxy_continuous_supported": bool(camera.get("ptz_proxy_continuous_supported", False)),
                    "ptz_unsupported_reason": None,
                    "focus_supported": bool(camera.get("focus_supported", False)),
                    "iris_supported": bool(camera.get("iris_supported", False)),
                    "zoom_supported": bool(camera.get("zoom_supported", True)),
                }
            )
            self._ptz_capability_cache[cam_key] = dict(result)
            return dict(result)

        async def probe_xml(path: str) -> ET.Element | None:
            try:
                return await self._request_xml("GET", path)
            except Exception:
                return None

        proxy_info = await probe_xml(f"/ISAPI/ContentMgmt/PTZCtrlProxy/channels/{cam_key}")
        proxy_caps = await probe_xml(
            f"/ISAPI/ContentMgmt/PTZCtrlProxy/channels/{cam_key}/capabilities"
        )
        if proxy_info is not None or proxy_caps is not None:
            result["ptz_supported"] = True
            result["ptz_proxy_supported"] = True
            result["ptz_control_method"] = "proxy"
            result["ptz_capability_mode"] = "momentary"
            result["ptz_implementation"] = "ptzctrlproxy"
            result["ptz_proxy_ctrl_mode"] = "isapi"
            result["ptz_momentary_supported"] = True
            result["ptz_proxy_momentary_supported"] = True
            result["zoom_supported"] = True
            result["ptz_unsupported_reason"] = None
        else:
            result["ptz_unsupported_reason"] = "ptz_proxy_endpoint_unavailable"

        focus_caps = await probe_xml(f"/ISAPI/System/Video/inputs/channels/{cam_key}/focus")
        iris_caps = await probe_xml(f"/ISAPI/System/Video/inputs/channels/{cam_key}/iris")
        result["focus_supported"] = focus_caps is not None
        result["iris_supported"] = iris_caps is not None

        result["ptz_control_path_configured"] = "proxy"
        result["ptz_control_path_active"] = "proxy" if result["ptz_supported"] else "none"

        self._ptz_capability_cache[cam_key] = dict(result)
        return dict(result)

    async def _ensure_ptz_supported(self, cam_id: str) -> dict:
        camera = self.get_camera(cam_id)
        if not camera:
            raise UpdateFailed(f"Unknown camera {cam_id}")
        capabilities = await self._probe_ptz_capabilities(cam_id)
        if not capabilities.get("ptz_supported"):
            raise UpdateFailed(
                capabilities.get("ptz_unsupported_reason") or f"PTZ is not supported for camera {cam_id}"
            )
        return capabilities

    async def ptz(
        self,
        cam_id: str,
        pan: int = 0,
        tilt: int = 0,
        duration: int = 500,
        continuous: bool = False,
        stop: bool = False,
        speed: int = 50,
    ) -> None:
        cam_key = str(cam_id)
        await self._ensure_ptz_supported(cam_key)

        pan = int(pan or 0)
        tilt = int(tilt or 0)
        speed = max(1, min(100, int(speed or 50)))
        if pan != 0 and abs(pan) <= 1:
            pan = speed if pan > 0 else -speed
        if tilt != 0 and abs(tilt) <= 1:
            tilt = speed if tilt > 0 else -speed
        pan = max(-100, min(100, pan))
        tilt = max(-100, min(100, tilt))
        duration = max(0, int(duration or 0))

        endpoint = self._build_ptz_endpoint(cam_key, "momentary")
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<PTZData>'
            f'<pan>{pan}</pan>'
            f'<tilt>{tilt}</tilt>'
            f'<panSpeed>{speed}</panSpeed>'
            f'<tiltSpeed>{speed}</tiltSpeed>'
            '<zoom>0</zoom>'
            f'<Momentary><duration>{duration}</duration></Momentary>'
            '</PTZData>'
        )

        await self._send_put_xml(endpoint, body)
        self._push_debug_event(
            category="ptz",
            event="ptz_move_sent",
            message=f"PTZ move sent for camera {cam_key}",
            camera_id=cam_key,
            context={
                "pan": pan,
                "tilt": tilt,
                "speed": speed,
                "duration": duration,
                "continuous_requested": bool(continuous),
                "stop_requested": bool(stop),
                "mode": "momentary",
                "endpoint": endpoint,
            },
        )

    async def goto_preset(self, cam_id: str, preset: int) -> None:
        cam_key = str(cam_id)
        await self._ensure_ptz_supported(cam_key)
        preset_id = max(1, int(preset))
        await self._request_text(
            "PUT",
            self._build_ptz_endpoint(cam_key, f"presets/{preset_id}/goto"),
            expected=(200, 201, 204),
            allow_empty=True,
        )
        self._push_debug_event(
            category="ptz",
            event="ptz_goto_preset_sent",
            message=f"PTZ preset sent for camera {cam_key}",
            camera_id=cam_key,
            context={"preset": preset_id},
        )

    async def focus(self, cam_id: str, direction: int = 1, speed: int = 60, duration: int = 500) -> None:
        cam_key = str(cam_id)
        speed = max(0, min(100, int(speed or 0)))
        direction_raw = int(direction or 0)
        direction = 0 if direction_raw == 0 else (1 if direction_raw > 0 else -1)
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<FocusData><focus>{direction * speed}</focus></FocusData>'
        )
        await self._send_put_xml(f"/ISAPI/System/Video/inputs/channels/{cam_key}/focus", body)
        if duration > 0:
            await asyncio.sleep(max(0.05, int(duration) / 1000.0))
            stop_body = '<?xml version="1.0" encoding="UTF-8"?><FocusData><focus>0</focus></FocusData>'
            await self._send_put_xml(f"/ISAPI/System/Video/inputs/channels/{cam_key}/focus", stop_body)
        self._push_debug_event(
            category="ptz",
            event="ptz_focus_sent",
            message=f"Focus command sent for camera {cam_key}",
            camera_id=cam_key,
            context={"direction": direction, "speed": speed, "duration": duration},
        )

    async def iris(self, cam_id: str, direction: int = 1, speed: int = 60, duration: int = 500) -> None:
        cam_key = str(cam_id)
        speed = max(0, min(100, int(speed or 0)))
        direction_raw = int(direction or 0)
        direction = 0 if direction_raw == 0 else (1 if direction_raw > 0 else -1)
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<IrisData><iris>{direction * speed}</iris></IrisData>'
        )
        await self._send_put_xml(f"/ISAPI/System/Video/inputs/channels/{cam_key}/iris", body)
        if duration > 0:
            await asyncio.sleep(max(0.05, int(duration) / 1000.0))
            stop_body = '<?xml version="1.0" encoding="UTF-8"?><IrisData><iris>0</iris></IrisData>'
            await self._send_put_xml(f"/ISAPI/System/Video/inputs/channels/{cam_key}/iris", stop_body)
        self._push_debug_event(
            category="ptz",
            event="ptz_iris_sent",
            message=f"Iris command sent for camera {cam_key}",
            camera_id=cam_key,
            context={"direction": direction, "speed": speed, "duration": duration},
        )

    async def zoom(self, cam_id: str, direction: int = 1, speed: int = 50, duration: int = 500) -> None:
        cam_key = str(cam_id)
        await self._ensure_ptz_supported(cam_key)
        speed = max(0, min(100, int(speed or 0)))
        direction_raw = int(direction or 0)
        direction = 0 if direction_raw == 0 else (1 if direction_raw > 0 else -1)
        duration = max(0, int(duration or 0))
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<PTZData>'
            '<pan>0</pan>'
            '<tilt>0</tilt>'
            f'<zoom>{direction * speed}</zoom>'
            f'<Momentary><duration>{duration}</duration></Momentary>'
            '</PTZData>'
        )
        endpoint = self._build_ptz_endpoint(cam_key, "momentary")
        await self._send_put_xml(endpoint, body)
        self._push_debug_event(
            category="ptz",
            event="ptz_zoom_sent",
            message=f"Zoom command sent for camera {cam_key}",
            camera_id=cam_key,
            context={
                "direction": direction,
                "speed": speed,
                "duration": duration,
                "endpoint": endpoint,
            },
        )

    async def return_to_center(
        self,
        cam_id: str,
        state: dict | None = None,
        speed: int = 50,
        duration: int = 350,
        step_delay: int = 150,
    ) -> None:
        cam_key = str(cam_id)
        await self._ensure_ptz_supported(cam_key)
        current = dict(state or {})
        pan_steps = int(current.get("pan") or 0)
        tilt_steps = int(current.get("tilt") or 0)
        zoom_steps = int(current.get("zoom") or 0)
        delay = max(0.05, int(step_delay or 150) / 1000.0)

        async def move_once(pan_value: int = 0, tilt_value: int = 0, zoom_value: int = 0) -> None:
            if pan_value or tilt_value:
                await self.ptz(cam_key, pan=pan_value, tilt=tilt_value, duration=duration)
            elif zoom_value:
                await self.zoom(cam_key, direction=1 if zoom_value > 0 else -1, speed=speed, duration=duration)

        while pan_steps or tilt_steps or zoom_steps:
            if pan_steps:
                await move_once(pan_value=-speed if pan_steps > 0 else speed)
                pan_steps += -1 if pan_steps > 0 else 1
                await asyncio.sleep(delay)
            if tilt_steps:
                await move_once(tilt_value=-speed if tilt_steps > 0 else speed)
                tilt_steps += -1 if tilt_steps > 0 else 1
                await asyncio.sleep(delay)
            if zoom_steps:
                await move_once(zoom_value=-1 if zoom_steps > 0 else 1)
                zoom_steps += -1 if zoom_steps > 0 else 1
                await asyncio.sleep(delay)

        self._push_debug_event(
            category="ptz",
            event="ptz_return_home_sent",
            message=f"Return-to-home correction sent for camera {cam_key}",
            camera_id=cam_key,
            context={"state": state or {}, "speed": speed, "duration": duration, "step_delay": step_delay},
        )

    async def search_playback_uri(
        self,
        cam_id: str,
        start: str | None = None,
        end: str | None = None,
    ) -> dict:
        """Compatibility wrapper for playback search callers."""
        return await self.async_playback_seek(cam_id, start=start, end=end)

    async def async_start_native_audio_stream(
        self,
        cam_id: str,
        *,
        profile: str = "active",
        ffmpeg_path: str = "ffmpeg",
        sample_rate: int = 8000,
        chunk_size: int = 3200,
        enable_classifier: bool = True,
    ) -> None:
        camera = self.get_camera(cam_id)
        if not camera:
            raise UpdateFailed(f"Unknown camera {cam_id}")

        selected_profile = str(profile or "active").lower()
        if selected_profile == "active":
            stream = self.get_active_stream(cam_id)
        else:
            profiles = self.get_stream_profiles(cam_id)
            stream = dict(profiles.get(normalize_stream_profile(selected_profile)) or {})
            if stream:
                stream.setdefault("rtsp_url", build_rtsp_url(
                    self.username,
                    self.password,
                    self.host,
                    stream.get("id"),
                    self.rtsp_port,
                ))
                stream.setdefault("rtsp_direct_url", build_rtsp_direct_url(
                    self.username,
                    self.password,
                    self.host,
                    stream.get("id"),
                    self.rtsp_port,
                ))
        stream_url = stream.get("rtsp_url") or stream.get("rtsp_direct_url") or camera.get("rtsp_url") or camera.get("rtsp_direct_url")
        if not stream_url:
            raise UpdateFailed(f"No RTSP stream URL available for camera {cam_id}")

        self.audio.ensure_camera(str(cam_id))
        self.audio.set_enabled(str(cam_id), True)
        if enable_classifier:
            self.audio.set_classifier_enabled(str(cam_id), True)

        await self.audio.async_start_native_stream(
            str(cam_id),
            stream_url=stream_url,
            ffmpeg_path=ffmpeg_path,
            sample_rate=sample_rate,
            chunk_size=chunk_size,
            source="rtsp",
            profile=selected_profile,
            audio_codec=stream.get("audio_codec"),
        )
        self.async_update_listeners()

    async def async_stop_native_audio_stream(self, cam_id: str) -> None:
        await self.audio.async_stop_native_stream(str(cam_id))
        self.async_update_listeners()

    def _mask_headers(self, headers: dict | None) -> dict:
        masked = dict(headers or {})
        if "Authorization" in masked:
            masked["Authorization"] = "<redacted>"
        return masked

    def _store_playback_debug(self, cam_id: str, entry: dict) -> None:
        key = str(cam_id)
        history = list(self._playback_debug_by_camera.get(key, []))
        history.append(entry)
        self._playback_debug_by_camera[key] = history[-8:]
        self.async_update_listeners()

    def _camera_by_id(self, cam_id: str) -> dict:
        return next(
            (
                cam
                for cam in self.data.get("cameras", [])
                if str(cam.get("id")) == str(cam_id)
            ),
            {},
        )

    def _parse_playback_matches(self, search_xml: ET.Element) -> list[dict]:
        matches: list[dict] = []
        for item in search_xml.iter():
            tag = str(getattr(item, "tag", ""))
            if tag.split("}", 1)[-1] != "searchMatchItem":
                continue
            playback_uri = safe_find_text(item, "playbackURI")
            if not playback_uri:
                continue
            matches.append(
                {
                    "media_segment_descriptor": safe_find_text(item, "mediaSegmentDescriptor"),
                    "playback_uri": playback_uri,
                    "start_time": safe_find_text(item, "startTime"),
                    "end_time": safe_find_text(item, "endTime"),
                }
            )
        return matches

    def get_playback_debug(self, cam_id: str) -> list[dict]:
        return list(self._playback_debug_by_camera.get(str(cam_id), []))

    def get_debug_events(self, camera_id: str | None = None, limit: int = 150) -> list[dict]:
        return self._debug_manager.get_events(camera_id=camera_id, limit=limit)

    def clear_debug_events(self, camera_id: str | None = None) -> None:
        self._debug_manager.clear(camera_id=camera_id)
        self.async_update_listeners()

    def _debug_category_enabled(self, category: str) -> bool:
        if not self._debug_enabled:
            return False
        if not self._debug_categories:
            return True
        return category in self._debug_categories

    def _push_debug_event(
        self,
        *,
        level: str = "info",
        category: str = "general",
        event: str,
        message: str,
        camera_id: str | None = None,
        context: dict | None = None,
    ) -> None:
        if not self._debug_category_enabled(category):
            return
        self._debug_manager.add_event(
            sanitize_debug(
                {
                    "level": level,
                    "category": category,
                    "event": event,
                    "message": message,
                    "camera_id": str(camera_id) if camera_id is not None else None,
                    "context": context or {},
                }
            )
        )

    async def _request_text(
        self,
        method: str,
        path: str,
        *,
        body: str | None = None,
        expected: tuple[int, ...] = (200,),
        headers: dict[str, str] | None = None,
        allow_empty: bool = False,
    ) -> str:
        url = self.url(path)
        req_headers = dict(headers or {})
        last_error: HikvisionEndpointError | None = None

        for attempt in range(2):
            try:
                auth_header = await self.digest.async_get_authorization(
                    self.session, method, url, body=body, verify_ssl=self.verify_ssl
                )
            except Exception as err:
                raise HikvisionEndpointError(
                    method=method,
                    path=path,
                    classification="auth_error",
                    detail=str(err),
                ) from err

            request_headers = dict(req_headers)
            request_headers["Authorization"] = auth_header

            try:
                async with self.session.request(
                    method,
                    url,
                    data=body,
                    headers=request_headers,
                    ssl=self.verify_ssl,
                ) as resp:
                    text = await resp.text()
                    if resp.status == 401 and attempt == 0:
                        self._refresh_digest_from_header(resp.headers.get("WWW-Authenticate"))
                        self._push_debug_event(
                            category="backend",
                            event="auth_challenge_refreshed",
                            message=f"Refreshing digest challenge for {method} {path}",
                            camera_id=None,
                            context={"method": method, "path": path},
                        )
                        continue
                    if resp.status not in expected:
                        raise HikvisionEndpointError(
                            method=method,
                            path=path,
                            status=resp.status,
                            body=text[:1000],
                            classification="http_error",
                        )
                    if not allow_empty and not text.strip():
                        raise HikvisionEndpointError(
                            method=method,
                            path=path,
                            status=resp.status,
                            body=text[:1000],
                            classification="empty_response",
                        )
                    return text
            except ClientResponseError as err:
                last_error = HikvisionEndpointError(
                    method=method,
                    path=path,
                    status=err.status,
                    classification="client_response_error",
                    detail=str(err),
                )
            except ClientError as err:
                last_error = HikvisionEndpointError(
                    method=method,
                    path=path,
                    classification="client_error",
                    detail=str(err),
                )
            if last_error is not None:
                raise last_error

        raise HikvisionEndpointError(
            method=method,
            path=path,
            status=401,
            classification="http_error",
            detail="authorization failed after refresh",
        )

    async def _request_xml(
        self,
        method: str,
        path: str,
        *,
        body: str | None = None,
        expected: tuple[int, ...] = (200,),
        headers: dict[str, str] | None = None,
        allow_empty: bool = False,
    ) -> ET.Element:
        text = await self._request_text(
            method,
            path,
            body=body,
            expected=expected,
            headers=headers,
            allow_empty=allow_empty,
        )
        try:
            return ET.fromstring(text)
        except ET.ParseError as err:
            raise HikvisionEndpointError(
                method=method,
                path=path,
                classification="xml_parse_error",
                detail=str(err),
                body=text[:1000],
            ) from err

    async def _async_update_data(self):
        return await self._async_fetch_state()

    async def _async_fetch_state(self):
        data: dict = {
            "nvr": {"online": True},
            "cameras": [],
            "storage": {},
            "alarm_states": {},
            "alarm_inputs": [],
        }

        device_xml = await self._request_xml("GET", "/ISAPI/System/deviceInfo")
        data["device_xml"] = device_xml
        data["nvr"] = {
            "online": True,
            "name": safe_find_text(device_xml, "deviceName") or safe_find_text(device_xml, "name") or self.entry.title or f"Hikvision NVR ({self.host})",
            "manufacturer": safe_find_text(device_xml, "manufacturer") or "Hikvision",
            "model": safe_find_text(device_xml, "model"),
            "firmware_version": safe_find_text(device_xml, "firmwareVersion"),
            "serial_number": safe_find_text(device_xml, "serialNumber"),
            "build_number": safe_find_text(device_xml, "build") or safe_find_text(device_xml, "buildNumber"),
            "device_type": safe_find_text(device_xml, "deviceType"),
            "host": self.host,
        }

        proxy_channels_xml = await self._request_xml(
            "GET",
            "/ISAPI/ContentMgmt/InputProxy/channels",
        )
        streaming_channels_xml = await self._request_xml(
            "GET",
            "/ISAPI/Streaming/channels",
        )

        proxy_channels = parse_input_proxy_channels(proxy_channels_xml)
        streams_by_camera = parse_streaming_channels(streaming_channels_xml)

        cameras_by_id: dict[str, dict] = {
            str(channel.get("id")): dict(channel)
            for channel in proxy_channels
            if channel.get("id") is not None
        }

        for cam_id, streams_for_camera in streams_by_camera.items():
            cameras_by_id.setdefault(
                str(cam_id),
                {
                    "id": str(cam_id),
                    "name": f"Camera {cam_id}",
                    "online": True,
                    "enabled": True,
                    "model": None,
                    "serial_number": None,
                    "firmware_version": None,
                },
            )

            camera_meta = cameras_by_id[str(cam_id)]
            profile_name = self._stream_profile_by_camera.get(str(cam_id), DEFAULT_STREAM_PROFILE)
            active_stream = choose_stream_by_profile(streams_for_camera, profile_name)

            stream_id = active_stream.get("id")
            rtsp_url = None
            rtsp_direct_url = None
            if stream_id:
                rtsp_url = build_rtsp_url(
                    self.username,
                    self.password,
                    self.host,
                    stream_id,
                    self.rtsp_port,
                )
                rtsp_direct_url = build_rtsp_direct_url(
                    self.username,
                    self.password,
                    self.host,
                    stream_id,
                    self.rtsp_port,
                )

            camera_meta.update(
                {
                    "card_visible": True,
                    "stream_profile": profile_name,
                    "stream_profile_requested": profile_name,
                    "stream_profile_resolved": normalize_stream_profile(active_stream.get("profile")),
                    "stream_profile_options": active_stream.get("available_profiles", []),
                    "stream_profile_map": active_stream.get("profile_map", {}),
                    "stream_profile_selection_source": active_stream.get("selection_source"),
                    "stream_id": stream_id,
                    "track_id": active_stream.get("track_id"),
                    "rtsp_url": rtsp_url,
                    "rtsp_direct_url": rtsp_direct_url,
                    "rtsp_profile": normalize_stream_profile(active_stream.get("profile")),
                    "transport": active_stream.get("transport"),
                    "video_codec": active_stream.get("video_codec"),
                    "width": active_stream.get("width"),
                    "height": active_stream.get("height"),
                    "bitrate_mode": active_stream.get("bitrate_mode"),
                    "constant_bitrate": active_stream.get("constant_bitrate"),
                    "bitrate": active_stream.get("constant_bitrate"),
                    "max_frame_rate": active_stream.get("max_frame_rate"),
                    "audio_codec": active_stream.get("audio_codec"),
                    "video_input_channel_id": active_stream.get("video_input_channel_id"),
                    "ptz_supported": False,
                    "ptz_proxy_supported": False,
                    "ptz_control_method": "none",
                    "ptz_capability_mode": "unknown",
                    "ptz_implementation": "none",
                    "ptz_proxy_ctrl_mode": None,
                    "ptz_momentary_supported": False,
                    "ptz_continuous_supported": False,
                    "ptz_proxy_momentary_supported": False,
                    "ptz_proxy_continuous_supported": False,
                    "ptz_unsupported_reason": None,
                }
            )

        for cam_id, camera_meta in list(cameras_by_id.items()):
            if camera_meta.get("stream_id"):
                continue

            profile_name = self._stream_profile_by_camera.get(str(cam_id), DEFAULT_STREAM_PROFILE)
            camera_meta.update(
                {
                    "card_visible": False,
                    "stream_profile": profile_name,
                    "stream_profile_requested": profile_name,
                    "stream_profile_resolved": None,
                    "stream_profile_options": [],
                    "stream_profile_map": {},
                    "stream_profile_selection_source": "unavailable",
                    "stream_id": None,
                    "track_id": None,
                    "rtsp_url": None,
                    "rtsp_direct_url": None,
                    "rtsp_profile": None,
                    "transport": None,
                    "video_codec": None,
                    "width": None,
                    "height": None,
                    "bitrate_mode": None,
                    "constant_bitrate": None,
                    "bitrate": None,
                    "max_frame_rate": None,
                    "audio_codec": None,
                    "video_input_channel_id": None,
                    "ptz_supported": False,
                    "ptz_proxy_supported": False,
                    "ptz_control_method": "none",
                    "ptz_capability_mode": "unknown",
                    "ptz_implementation": "none",
                    "ptz_proxy_ctrl_mode": None,
                    "ptz_momentary_supported": False,
                    "ptz_continuous_supported": False,
                    "ptz_proxy_momentary_supported": False,
                    "ptz_proxy_continuous_supported": False,
                    "ptz_unsupported_reason": "no_stream_metadata",
                }
            )

        ordered_camera_ids = sorted(
            cameras_by_id,
            key=lambda value: (
                int(value) if str(value).isdigit() else str(value),
            ),
        )

        for cam_id in ordered_camera_ids:
            camera_meta = cameras_by_id[cam_id]
            if camera_meta.get("stream_id") and camera_meta.get("card_visible", True):
                try:
                    camera_meta.update(await self._probe_ptz_capabilities(str(cam_id)))
                except Exception as err:
                    camera_meta.update(
                        {
                            "ptz_supported": False,
                            "ptz_proxy_supported": False,
                            "ptz_control_method": "none",
                            "ptz_capability_mode": "error",
                            "ptz_implementation": "none",
                            "ptz_proxy_ctrl_mode": None,
                            "ptz_momentary_supported": False,
                            "ptz_continuous_supported": False,
                            "ptz_proxy_momentary_supported": False,
                            "ptz_proxy_continuous_supported": False,
                            "ptz_unsupported_reason": str(err),
                            "focus_supported": False,
                            "iris_supported": False,
                            "zoom_supported": False,
                        }
                    )

        data["cameras"] = [cameras_by_id[cam_id] for cam_id in ordered_camera_ids]

        storage_info: dict[str, Any] = {}
        storage_caps: dict[str, Any] = {}
        storage_hdd_caps: dict[str, Any] = {}
        storage_extra_caps: dict[str, Any] = {}

        try:
            storage_xml = await self._request_xml("GET", "/ISAPI/ContentMgmt/Storage")
            storage_info = parse_storage_xml(storage_xml)
            storage_info["storage_info_supported"] = True
        except Exception:
            storage_info = {"storage_info_supported": False}

        try:
            storage_capabilities = await self._request_xml(
                "GET", "/ISAPI/ContentMgmt/Storage/capabilities"
            )
            storage_caps = parse_storage_capabilities_xml(storage_capabilities)
        except Exception:
            storage_caps = {}

        try:
            storage_hdd_caps_xml = await self._request_xml(
                "GET", "/ISAPI/ContentMgmt/Storage/hdd/capabilities"
            )
            storage_hdd_caps = parse_storage_capabilities_xml(storage_hdd_caps_xml)
            storage_hdd_caps["storage_hdd_caps_supported"] = True
        except Exception:
            storage_hdd_caps = {"storage_hdd_caps_supported": False}

        try:
            storage_extra_caps_xml = await self._request_xml(
                "GET", "/ISAPI/ContentMgmt/Storage/ExtraInfo/capabilities"
            )
            storage_extra_caps = parse_storage_capabilities_xml(storage_extra_caps_xml)
            storage_extra_caps["storage_extra_caps_supported"] = True
        except Exception:
            storage_extra_caps = {"storage_extra_caps_supported": False}

        data["storage_capabilities"] = merge_storage_sources(storage_caps, storage_hdd_caps, storage_extra_caps)
        data["storage"] = merge_storage_sources(storage_info, storage_caps, storage_hdd_caps, storage_extra_caps)
        data["nvr"].update(
            {
                "storage_present": data["storage"].get("storage_present"),
                "playback_supported": data["storage"].get("playback_supported"),
                "disk_count": data["storage"].get("disk_count"),
                "healthy_disks": data["storage"].get("healthy_disks"),
                "failed_disks": data["storage"].get("failed_disks"),
                "disk_mode": data["storage"].get("disk_mode"),
                "work_mode": data["storage"].get("work_mode"),
                "total_capacity_mb": data["storage"].get("total_capacity_mb"),
                "free_capacity_mb": data["storage"].get("free_capacity_mb"),
                "used_capacity_mb": data["storage"].get("used_capacity_mb"),
                "hdds": data["storage"].get("hdds", []),
                "storage_info_supported": data["storage"].get("storage_info_supported", False),
                "storage_hdd_caps_supported": data["storage"].get("storage_hdd_caps_supported", False),
                "storage_extra_caps_supported": data["storage"].get("storage_extra_caps_supported", False),
            }
        )

        return data

    async def async_start_alarm_stream(self) -> None:
        return None

    async def async_stop_alarm_stream(self) -> None:
        if self._alarm_stream_task is not None:
            self._alarm_stream_task.cancel()
            self._alarm_stream_task = None

    async def async_set_stream_profile(self, cam_id: str, profile: str) -> None:
        cam_key = str(cam_id)
        normalized = normalize_stream_profile(profile)
        self._stream_profile_by_camera[cam_key] = normalized
        camera = self.get_camera(cam_key)
        if camera:
            camera["stream_profile"] = normalized
            camera["stream_profile_requested"] = normalized
            profile_map = camera.get("stream_profile_map") or {}
            resolved = normalize_stream_profile((profile_map.get(normalized) or {}).get("profile") or normalized)
            camera["stream_profile_resolved"] = resolved
        entity = self._find_camera_entity(cam_key)
        if entity is not None:
            entity.async_write_ha_state()
        await self.async_request_refresh()

    async def async_set_stream_mode(self, cam_id: str, mode: str) -> None:
        cam_key = str(cam_id)
        normalized = self._normalize_stream_mode(mode)
        camera = self.get_camera(cam_key)
        if camera:
            camera["stream_mode"] = normalized
        entity = self._find_camera_entity(cam_key)
        if entity is not None:
            entity.set_stream_mode(normalized)
            return

    async def async_playback_seek(
        self,
        cam_id: str,
        start: str | None = None,
        end: str | None = None,
    ) -> dict:
        target_camera = self._camera_by_id(cam_id)
        if not target_camera:
            raise UpdateFailed(f"Unknown camera {cam_id}")

        active_stream = self.get_active_stream(cam_id) or {}
        stream_profile_map = build_stream_profile_map(
            list(self.data.get("streams", {}).get(str(cam_id), []))
        )
        if not stream_profile_map:
            stream_profile_map = target_camera.get("stream_profile_map") or {}

        track_ids = _candidate_playback_track_ids(
            target_camera,
            active_stream,
            stream_profile_map,
        )

        requested_time = start or end
        if not track_ids:
            self._store_playback_debug(
                cam_id,
                {
                    "ok": False,
                    "reason": "No candidate track IDs were available for playback search.",
                    "requested_time": requested_time,
                },
            )
            raise UpdateFailed(f"No playback track ids available for camera {cam_id}")

        requested_dt = _parse_hikvision_dt(requested_time)
        explicit_start_dt = _parse_hikvision_dt(start)
        explicit_end_dt = _parse_hikvision_dt(end)

        if explicit_start_dt is not None and explicit_end_dt is not None:
            search_start = _format_search_timestamp(start) or dt_util.as_utc(explicit_start_dt).strftime("%Y-%m-%dT%H:%M:%SZ")
            search_end = _format_search_timestamp(end) or dt_util.as_utc(explicit_end_dt).strftime("%Y-%m-%dT%H:%M:%SZ")
        elif requested_dt is not None:
            search_start = _format_search_timestamp((requested_dt - timedelta(hours=12)).isoformat()) or dt_util.as_utc(requested_dt - timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%SZ")
            search_end = _format_search_timestamp((requested_dt + timedelta(hours=12)).isoformat()) or dt_util.as_utc(requested_dt + timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            fallback_dt = dt_util.utcnow()
            search_start = _format_search_timestamp((fallback_dt - timedelta(hours=12)).isoformat()) or dt_util.as_utc(fallback_dt - timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%SZ")
            search_end = _format_search_timestamp((fallback_dt + timedelta(hours=12)).isoformat()) or dt_util.as_utc(fallback_dt + timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%SZ")

        request_headers = {"Content-Type": "application/xml"}

        for track_id in track_ids:
            payload = f"""<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
  <searchID>11111111-1111-1111-1111-111111111111</searchID>
  <trackIDList>
    <trackID>{track_id}</trackID>
  </trackIDList>
  <timeSpanList>
    <timeSpan>
      <startTime>{search_start}</startTime>
      <endTime>{search_end}</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>128</maxResults>
  <searchResultPosition>0</searchResultPosition>
</CMSearchDescription>"""
            try:
                response_text = await self._request_text(
                    "POST",
                    "/ISAPI/ContentMgmt/search",
                    body=payload,
                    headers=request_headers,
                    expected=(200, 201),
                )
                status = 200
            except HikvisionEndpointError as err:
                self._store_playback_debug(
                    cam_id,
                    {
                        "ok": False,
                        "track_id": track_id,
                        "requested_time": requested_time,
                        "search_start": search_start,
                        "search_end": search_end,
                        "request": {
                            "method": "POST",
                            "path": "/ISAPI/ContentMgmt/search",
                            "headers": self._mask_headers(request_headers),
                            "body": payload,
                        },
                        "response": {
                            "status": err.status,
                            "body": err.body or "",
                        },
                        "error": str(err),
                    },
                )
                continue

            debug_entry = {
                "ok": True,
                "track_id": track_id,
                "requested_time": requested_time,
                "search_start": search_start,
                "search_end": search_end,
                "request": {
                    "method": "POST",
                    "path": "/ISAPI/ContentMgmt/search",
                    "headers": self._mask_headers(request_headers),
                    "body": payload,
                },
                "response": {
                    "status": status,
                    "body": response_text[:4000],
                },
            }

            try:
                result_xml = ET.fromstring(response_text)
            except ET.ParseError:
                debug_entry["ok"] = False
                debug_entry["reason"] = "Playback search response was not valid XML."
                self._store_playback_debug(cam_id, debug_entry)
                continue

            matches = self._parse_playback_matches(result_xml)
            debug_entry["match_count"] = len(matches)
            if not matches:
                debug_entry["ok"] = False
                debug_entry["reason"] = "Playback search returned no matching recordings."
                self._store_playback_debug(cam_id, debug_entry)
                continue

            best_match = matches[0]
            if requested_dt is not None:
                def score(item: dict) -> tuple[int, float]:
                    start_dt = _parse_hikvision_dt(item.get("start_time"))
                    end_dt = _parse_hikvision_dt(item.get("end_time"))
                    contains_requested = int(
                        start_dt is not None
                        and end_dt is not None
                        and start_dt <= requested_dt <= end_dt
                    )
                    if contains_requested:
                        span = (end_dt - start_dt).total_seconds()
                        return (0, span)
                    if start_dt is not None:
                        distance = abs((requested_dt - start_dt).total_seconds())
                        return (1, distance)
                    return (2, float("inf"))

                best_match = sorted(matches, key=score)[0]

            playback_uri = best_match.get("playback_uri")
            clip_start = best_match.get("start_time") or requested_time
            clip_end = best_match.get("end_time")
            adjusted_uri = _inject_rtsp_playback_window(playback_uri, requested_time, clip_end)
            authenticated_uri = inject_rtsp_credentials(
                adjusted_uri or playback_uri,
                self.username,
                self.password,
                self.rtsp_port,
            )

            debug_entry["selected_match"] = {
                "start_time": best_match.get("start_time"),
                "end_time": best_match.get("end_time"),
                "playback_uri": authenticated_uri,
            }
            self._store_playback_debug(cam_id, debug_entry)

            return {
                "camera_id": str(cam_id),
                "playback_uri": authenticated_uri,
                "playback_clip_start_time": clip_start,
                "playback_clip_end_time": clip_end,
                "playback_requested_time": requested_time,
                "track_id": track_id,
                "matches": matches,
                "match_count": len(matches),
            }

        self._store_playback_debug(
            cam_id,
            {
                "ok": False,
                "requested_time": requested_time,
                "reason": "Playback search completed but no usable recording URI was found.",
            },
        )
        return {
            "camera_id": str(cam_id),
            "matches": [],
            "match_count": 0,
        }

    async def async_playback_stop(self, cam_id: str) -> None:
        self._playback_debug_by_camera.pop(str(cam_id), None)
        self.async_update_listeners()
