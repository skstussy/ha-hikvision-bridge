from __future__ import annotations

import asyncio
import logging
from datetime import timedelta, datetime
from urllib.parse import quote
from yarl import URL
import xml.etree.ElementTree as ET

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
    DEFAULT_STREAM_PROFILE,
)
from .digest import DigestAuth
from .helpers import build_rtsp_direct_url, build_rtsp_url, build_stream_profile_map, choose_stream_by_profile, coerce_bool, inject_rtsp_credentials, normalize_stream_profile, parse_storage_capabilities_xml, parse_storage_xml, safe_find_text
from .debug import HikvisionDebugManager, sanitize_debug

_LOGGER = logging.getLogger(__name__)

NS = {"hk": "http://www.hikvision.com/ver20/XMLSchema"}
STREAM_NS = {"isapi": "http://www.isapi.org/ver20/XMLSchema"}


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
    """Return canonical DVR recording tracks for playback search.

    Playback recordings on this DVR exist only on the main stream track for a
    channel, e.g. CH1->101, CH2->201, CH3->301. Keep playback track selection
    separate from live-view stream selection to avoid regressions when the user
    is viewing the sub-stream in live mode.
    """
    values: list[str] = []
    seen: set[str] = set()

    def add(value) -> None:
        raw = str(value or "").strip()
        if raw and raw not in seen:
            seen.add(raw)
            values.append(raw)

    def add_main_recording_track(value) -> None:
        raw = str(value or "").strip()
        if not raw:
            return
        digits = "".join(ch for ch in raw if ch.isdigit())
        if not digits:
            return
        channel_num = digits[0]
        add(f"{channel_num}01")

    main_stream = profiles.get("main") or {}
    add_main_recording_track(main_stream.get("id"))
    add_main_recording_track(active_stream.get("id"))
    add_main_recording_track(cam.get("id"))
    add(cam.get("playback_track_id"))
    add(cam.get("recording_track_id"))
    return values


def _inject_rtsp_playback_window(uri: str, requested_time: str | None, clip_start_time: str | None) -> str:
    if not uri:
        return uri

    start_ts = _format_rtsp_playback_timestamp(requested_time) or _format_rtsp_playback_timestamp(clip_start_time)
    if not start_ts:
        return uri

    lower = uri.lower()
    start_idx = lower.find("starttime=")
    if start_idx == -1:
        separator = "&" if "?" in uri else "?"
        return f"{uri}{separator}starttime={start_ts}"

    end_idx = uri.find("&", start_idx)
    if end_idx == -1:
        return f"{uri[:start_idx]}starttime={start_ts}"

    return f"{uri[:start_idx]}starttime={start_ts}{uri[end_idx:]}"


class HikvisionCoordinator(DataUpdateCoordinator):
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry):
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
        self.audio.ingest_samples(str(camera_id), samples)
        await self._maybe_run_audio_classifier(str(camera_id))
        self.async_update_listeners()

    async def _maybe_run_audio_classifier(self, camera_id: str) -> None:
        state = self.audio.get_state(camera_id)
        if not state:
            return
        if not state.get("classifier_enabled"):
            return
        if not (state.get("abnormal") or state.get("voice_detected")):
            return

        clip = self.audio.get_clip(camera_id)
        result = await self.audio_classifier.classify_clip(camera_id, clip)
        if not result:
            return

        state["classifier_label"] = result.get("label")
        state["classifier_confidence"] = result.get("confidence", 0.0)

        label = state["classifier_label"]
        confidence = state["classifier_confidence"]
        threshold = self.audio._config[str(camera_id)]["classifier_threshold"]

        if confidence >= threshold:
            state["last_event"] = f"audio_classifier_{label}"
            push = getattr(self, "_push_debug_event", None)
            if callable(push):
                push(
                    level="info",
                    category="audio",
                    event="audio_classifier_match",
                    message=f"Audio classifier matched {label} for camera {camera_id}",
                    camera_id=camera_id,
                    context={
                        "label": label,
                        "confidence": confidence,
                        "threshold": threshold,
                    },
                )
            self.hass.bus.async_fire(
                f"{DOMAIN}_audio_detected",
                {
                    "camera_id": camera_id,
                    "label": label,
                    "confidence": confidence,
                    "threshold": threshold,
                },
            )
        self.async_update_listeners()

    def url(self, path: str) -> str:
        scheme = "https" if self.use_https else "http"
        return f"{scheme}://{self.host}:{self.port}{path}"

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
        category: str = "backend",
        event: str = "event",
        message: str = "",
        camera_id: str | None = None,
        context: dict | None = None,
        request: dict | None = None,
        response: dict | None = None,
        error = None,
    ) -> None:
        normalized_category = str(category or "backend").lower()
        if not self._debug_category_enabled(normalized_category):
            return
    
        event_obj = self._debug_manager.push(
            level=level,
            category=normalized_category,
            event=event,
            message=message,
            source="backend",
            camera_id=camera_id,
            entry_id=self.entry.entry_id,
            context=context,
            request=request,
            response=response,
            error=(str(error) if error is not None else None),
        )
    
        log_message = "[%s] %s" % (normalized_category, message or event)
        extra = sanitize_debug({
            "event": event_obj.get("event"),
            "camera_id": event_obj.get("camera_id"),
            "context": event_obj.get("context"),
            "request": event_obj.get("request"),
            "response": event_obj.get("response"),
            "error": event_obj.get("error"),
        })
        if level == "error":
            _LOGGER.error(log_message, extra=extra)
        elif level == "warning":
            _LOGGER.warning(log_message, extra=extra)
        else:
            _LOGGER.debug(log_message, extra=extra)

        self.async_update_listeners()

    async def _request_text(
        self,
        method: str,
        path: str,
        *,
        data: str | bytes | None = None,
        expected: set[int] | None = None,
        headers: dict | None = None,
    ) -> str:
        if expected is None:
            expected = {200}
        url = self.url(path)
        request_meta = {"method": method, "path": path, "url": url, "expected": sorted(expected)}
        if data is not None:
            request_meta["body"] = data if isinstance(data, str) else data.decode(errors="ignore")
        self._push_debug_event(
            category="isapi",
            event="request",
            message=f"{method} {path}",
            request=request_meta,
        )
        try:
            async with self.session.request(
                method,
                url,
                data=data,
                headers=headers,
                auth=self.digest,
                ssl=self.verify_ssl,
            ) as resp:
                text = await resp.text()
                response_meta = {"status": resp.status, "body": text}
                if resp.status not in expected:
                    classification = "http_error"
                    detail = None
                    if resp.status in (401, 403):
                        classification = "auth_error"
                    elif resp.status == 404:
                        classification = "not_found"
                    elif resp.status in (405, 415):
                        classification = "unsupported"
                    elif resp.status >= 500:
                        classification = "device_error"
                    self._push_debug_event(
                        level="warning",
                        category="isapi",
                        event="response_error",
                        message=f"{method} {path} -> {resp.status}",
                        request=request_meta,
                        response=response_meta,
                    )
                    raise HikvisionEndpointError(
                        method=method,
                        path=path,
                        status=resp.status,
                        body=text,
                        classification=classification,
                        detail=detail,
                    )
                self._push_debug_event(
                    category="isapi",
                    event="response_ok",
                    message=f"{method} {path} -> {resp.status}",
                    request=request_meta,
                    response=response_meta,
                )
                return text
        except HikvisionEndpointError:
            raise
        except ClientResponseError as err:
            self._push_debug_event(
                level="error",
                category="isapi",
                event="response_exception",
                message=f"{method} {path} client response error",
                request=request_meta,
                error=err,
            )
            raise HikvisionEndpointError(
                method=method,
                path=path,
                classification="client_response_error",
                detail=str(err),
            ) from err
        except (asyncio.TimeoutError, ClientError) as err:
            self._push_debug_event(
                level="error",
                category="isapi",
                event="request_exception",
                message=f"{method} {path} request failed",
                request=request_meta,
                error=err,
            )
            raise HikvisionEndpointError(
                method=method,
                path=path,
                classification="network_error",
                detail=str(err),
            ) from err

    async def _request_xml(self, method: str, path: str, *, data: str | bytes | None = None, expected: set[int] | None = None, headers: dict | None = None):
        text = await self._request_text(method, path, data=data, expected=expected, headers=headers)
        if not text.strip():
            return None
        try:
            return ET.fromstring(text)
        except ET.ParseError as err:
            self._push_debug_event(
                level="warning",
                category="isapi",
                event="parse_error",
                message=f"{method} {path} returned invalid XML",
                response={"body": text},
                error=err,
            )
            raise HikvisionEndpointError(
                method=method,
                path=path,
                classification="parse_error",
                detail=str(err),
                body=text,
            ) from err

    async def _fetch_rtsp_port(self) -> int:
        try:
            xml = await self._request_xml("GET", "/ISAPI/System/Network/interfaces/1/ports", expected={200})
        except UpdateFailed:
            return DEFAULT_RTSP_PORT
        value = safe_find_text(xml, "rtspPortNo")
        try:
            return int(value) if value else DEFAULT_RTSP_PORT
        except (TypeError, ValueError):
            return DEFAULT_RTSP_PORT

    def _stream_rtsp_url(self, stream_id: str | None) -> str | None:
        if not stream_id:
            return None
        return build_rtsp_url(self.host, self.rtsp_port, self.username, self.password, stream_id)

    def _stream_rtsp_direct_url(self, stream_id: str | None) -> str | None:
        if not stream_id:
            return None
        return build_rtsp_direct_url(self.host, self.rtsp_port, self.username, self.password, stream_id)

    def get_stream_profiles(self, cam_id: str) -> dict:
        return self.data.get("stream_profiles_by_camera", {}).get(str(cam_id), {})

    def get_active_stream(self, cam_id: str) -> dict:
        return self.data.get("streams", {}).get(str(cam_id), {})

    def get_selected_stream_profile(self, cam_id: str) -> str:
        return normalize_stream_profile(self._stream_profile_by_camera.get(str(cam_id), DEFAULT_STREAM_PROFILE))

    async def async_set_stream_profile(self, cam_id: str, profile: str) -> None:
        cam_key = str(cam_id)
        normalized = normalize_stream_profile(profile)
        self._stream_profile_by_camera[cam_key] = normalized
        streams_by_camera = self.data.get("streams_by_camera", {})
        stream_profiles_by_camera = self.data.get("stream_profiles_by_camera", {})
        self.data["streams"][cam_key] = choose_stream_by_profile(
            streams_by_camera.get(cam_key, []),
            normalized,
        )
        self.entry.async_update_entry(
            data=self.entry.data,
            options={
                **self.entry.options,
                "stream_profile_by_camera": dict(self._stream_profile_by_camera),
            },
        )
        self.async_update_listeners()

    async def _async_update_data(self):
        device_xml = await self._request_xml("GET", "/ISAPI/System/deviceInfo", expected={200})
        if device_xml is None:
            raise UpdateFailed("Device info unavailable")
        capabilities_xml = await self._request_xml("GET", "/ISAPI/System/capabilities", expected={200})
        channels_xml = await self._request_xml("GET", "/ISAPI/ContentMgmt/InputProxy/channels", expected={200})
        streams_xml = await self._request_xml("GET", "/ISAPI/Streaming/channels", expected={200})
        ptz_xml = await self._request_xml("GET", "/ISAPI/PTZCtrl/channels", expected={200, 404})
        alarm_xml = await self._request_xml("GET", "/ISAPI/System/IO/inputs", expected={200, 404})
        storage_xml = await self._request_xml("GET", "/ISAPI/ContentMgmt/Storage", expected={200, 404})
        storage_caps_xml = await self._request_xml("GET", "/ISAPI/ContentMgmt/Storage/hdd/capabilities", expected={200, 404})
        self.rtsp_port = await self._fetch_rtsp_port()

        cameras = self._extract_cameras(channels_xml, capabilities_xml, ptz_xml)
        streams, streams_by_camera, stream_profiles_by_camera = self._extract_streams(streams_xml)
        alarm_inputs = self._extract_alarm_inputs(alarm_xml)
        storage = parse_storage_xml(storage_xml)
        storage_caps = parse_storage_capabilities_xml(storage_caps_xml)
        storage.update(storage_caps)

        return {
            "device_xml": device_xml,
            "nvr": {
                "name": safe_find_text(device_xml, "deviceName"),
                "serial_number": safe_find_text(device_xml, "serialNumber"),
                "model": safe_find_text(device_xml, "model"),
                "manufacturer": safe_find_text(device_xml, "manufacturer", "Hikvision") or "Hikvision",
                "firmware_version": safe_find_text(device_xml, "firmwareVersion"),
            },
            "cameras": cameras,
            "streams": streams,
            "streams_by_camera": streams_by_camera,
            "stream_profiles_by_camera": stream_profiles_by_camera,
            "alarm_inputs": alarm_inputs,
            "alarm_states": self.data.get("alarm_states", {}) if getattr(self, "data", None) else {},
            "storage": storage,
        }

    def _extract_cameras(self, channels_xml, capabilities_xml, ptz_xml) -> list[dict]:
        proxy_caps = {}
        if capabilities_xml is not None:
            for ch in capabilities_xml.findall(".//hk:VideoInputProxyChannelCap", NS):
                chan = safe_find_text(ch, "id")
                proxy_caps[str(chan)] = {
                    "ptz_proxy_supported": coerce_bool(safe_find_text(ch, "PTZProxy", False)),
                    "proxy_ctrl_mode": safe_find_text(ch, "proxyProtocol"),
                }
        ptz_map = self._extract_ptz_map(ptz_xml) if ptz_xml is not None else {}
        cameras: list[dict] = []
        for ch in channels_xml.findall(".//hk:InputProxyChannel", NS):
            channel_id = safe_find_text(ch, "id")
            if not channel_id:
                continue
            cam = {
                "id": str(channel_id),
                "name": safe_find_text(ch, "name", f"Camera {channel_id}") or f"Camera {channel_id}",
                "online": coerce_bool(safe_find_text(ch, "online", True)),
                "ip_address": safe_find_text(ch, "sourceInputPortDescriptor/ipAddress"),
                "manage_port": safe_find_text(ch, "sourceInputPortDescriptor/managePortNo"),
                "card_visible": True,
                "ptz_supported": False,
                "ptz_proxy_supported": False,
                "ptz_direct_supported": False,
                "ptz_control_method": "none",
                "ptz_capability_mode": None,
                "ptz_implementation": None,
                "ptz_proxy_ctrl_mode": None,
                "ptz_momentary_supported": False,
                "ptz_continuous_supported": False,
                "ptz_proxy_momentary_supported": False,
                "ptz_proxy_continuous_supported": False,
                "ptz_direct_momentary_supported": False,
                "ptz_direct_continuous_supported": False,
                "ptz_unsupported_reason": None,
            }
            proxy = proxy_caps.get(str(channel_id), {})
            ptz = ptz_map.get(str(channel_id), {})
            cam["ptz_proxy_supported"] = bool(proxy.get("ptz_proxy_supported"))
            cam["ptz_proxy_ctrl_mode"] = proxy.get("proxy_ctrl_mode")
            cam["ptz_direct_supported"] = bool(ptz)
            cam["ptz_capability_mode"] = ptz.get("capability_mode")
            cam["ptz_implementation"] = ptz.get("implementation")
            cam["ptz_direct_momentary_supported"] = bool(ptz.get("momentary_supported"))
            cam["ptz_direct_continuous_supported"] = bool(ptz.get("continuous_supported"))
            cam["ptz_proxy_momentary_supported"] = bool(proxy.get("ptz_proxy_supported"))
            cam["ptz_proxy_continuous_supported"] = bool(proxy.get("ptz_proxy_supported"))
            cam["ptz_momentary_supported"] = cam["ptz_proxy_momentary_supported"] or cam["ptz_direct_momentary_supported"]
            cam["ptz_continuous_supported"] = cam["ptz_proxy_continuous_supported"] or cam["ptz_direct_continuous_supported"]
            if cam["ptz_proxy_supported"]:
                cam["ptz_supported"] = True
                cam["ptz_control_method"] = "proxy"
            elif cam["ptz_direct_supported"]:
                cam["ptz_supported"] = True
                cam["ptz_control_method"] = "direct"
            else:
                cam["ptz_unsupported_reason"] = "No PTZ capabilities found"
            cameras.append(cam)
            self.audio.ensure_camera(str(channel_id))
        return cameras

    def _extract_streams(self, streams_xml) -> tuple[dict[str, dict], dict[str, list[dict]], dict[str, dict]]:
        streams_by_camera: dict[str, list[dict]] = {}
        for stream_xml in streams_xml.findall(".//isapi:StreamingChannel", STREAM_NS):
            stream_id = text_stream(stream_xml, "isapi:id")
            name = text_stream(stream_xml, "isapi:channelName")
            transport = text_stream(stream_xml, "isapi:Transport/isapi:ControlProtocolList/isapi:ControlProtocol")
            video_input_channel_id = text_stream(stream_xml, "isapi:Video/isapi:videoInputChannelID")
            stream = {
                "id": stream_id,
                "name": name,
                "stream_profile": normalize_stream_profile(stream_id),
                "transport": transport,
                "video_input_channel_id": video_input_channel_id,
                "audio_enabled": coerce_bool(text_stream(stream_xml, "isapi:Audio/isapi:enabled")),
                "audio_input_channel_id": text_stream(stream_xml, "isapi:Audio/isapi:audioInputChannelID"),
                "audio_codec": text_stream(stream_xml, "isapi:Audio/isapi:audioCompressionType"),
                "rtsp_url": self._stream_rtsp_url(stream_id),
                "rtsp_direct_url": self._stream_rtsp_direct_url(stream_id),
            }
            if video_input_channel_id:
                streams_by_camera.setdefault(str(video_input_channel_id), []).append(stream)

        stream_profiles_by_camera = {
            cam_id: build_stream_profile_map(items)
            for cam_id, items in streams_by_camera.items()
        }
        active_streams = {
            cam_id: choose_stream_by_profile(items, self._stream_profile_by_camera.get(cam_id, DEFAULT_STREAM_PROFILE))
            for cam_id, items in streams_by_camera.items()
        }
        return active_streams, streams_by_camera, stream_profiles_by_camera

    def _extract_ptz_map(self, ptz_xml) -> dict[str, dict]:
        ptz_map: dict[str, dict] = {}
        for ch in ptz_xml.findall(".//hk:PTZChannel", NS):
            channel_id = safe_find_text(ch, "id")
            if not channel_id:
                continue
            absolute_supported = coerce_bool(safe_find_text(ch, "AbsolutePanTiltPosition", False))
            relative_supported = coerce_bool(safe_find_text(ch, "RelativePanTiltPosition", False))
            continuous_supported = coerce_bool(safe_find_text(ch, "ContinuousPanTilt", False))
            if absolute_supported or relative_supported or continuous_supported:
                ptz_map[str(channel_id)] = {
                    "capability_mode": "capabilities",
                    "implementation": "direct",
                    "momentary_supported": absolute_supported or relative_supported,
                    "continuous_supported": continuous_supported,
                }
        return ptz_map

    async def async_start_alarm_stream(self) -> None:
        if self._alarm_stream_task is None or self._alarm_stream_task.done():
            self._alarm_stream_task = self.hass.async_create_task(self._alarm_stream_loop())

    async def async_stop_alarm_stream(self) -> None:
        task = self._alarm_stream_task
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._alarm_stream_task = None

    async def _alarm_stream_loop(self) -> None:
        while True:
            try:
                await self._consume_alarm_stream()
            except asyncio.CancelledError:
                raise
            except Exception as err:
                _LOGGER.warning("Alarm stream failed: %s", err)
                self._push_debug_event(
                    level="warning",
                    category="alarm",
                    event="alarm_stream_error",
                    message="Alarm stream loop failed",
                    error=err,
                )
                self.data.setdefault("alarm_states", {})["stream_connected"] = False
                self.async_update_listeners()
                await asyncio.sleep(5)

    async def _consume_alarm_stream(self) -> None:
        path = "/ISAPI/Event/notification/alertStream"
        url = self.url(path)
        self._push_debug_event(
            category="alarm",
            event="alarm_stream_connect",
            message="Connecting to alarm stream",
            request={"method": "GET", "path": path, "url": url},
        )
        async with self.session.get(url, auth=self.digest, ssl=self.verify_ssl) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise UpdateFailed(f"Alert stream failed: {resp.status} {text}")
            self.data.setdefault("alarm_states", {})["stream_connected"] = True
            self.async_update_listeners()
            buffer = ""
            async for chunk in resp.content.iter_chunked(1024):
                buffer += chunk.decode(errors="ignore")
                while "\r\n\r\n" in buffer:
                    part, buffer = buffer.split("\r\n\r\n", 1)
                    if "<EventNotificationAlert" not in part:
                        continue
                    try:
                        alert = ET.fromstring(part)
                    except ET.ParseError:
                        continue
                    self._handle_alert(alert)

    def _handle_alert(self, alert) -> None:
        event_type = safe_find_text(alert, "eventType")
        state = safe_find_text(alert, "eventState")
        channel = safe_find_text(alert, "channelID")
        alarm_states = self.data.setdefault("alarm_states", {})
        alarm_states["last_event_type"] = event_type
        alarm_states["last_event_channel"] = channel
        alarm_states["last_event_state"] = state

        if event_type == "videoloss":
            alarm_states[f"video_loss_{channel}"] = state == "active"
        elif event_type == "motion":
            alarm_states[f"motion_{channel}"] = state == "active"
        elif event_type == "linedetection":
            alarm_states[f"line_crossing_{channel}"] = state == "active"
        elif event_type == "fielddetection":
            alarm_states[f"intrusion_{channel}"] = state == "active"
        elif event_type == "shelteralarm":
            alarm_states[f"tamper_{channel}"] = state == "active"
        elif event_type == "diskfull":
            alarm_states["disk_full"] = state == "active"
        elif event_type == "diskerror":
            alarm_states["disk_error"] = state == "active"
        elif event_type == "IO":
            alarm_input_port = safe_find_text(alert, "inputIOPortID") or channel
            if alarm_input_port:
                alarm_states[f"alarm_input_{alarm_input_port}"] = state == "active"

        self._push_debug_event(
            category="alarm",
            event="alarm_event",
            message=f"Alarm event {event_type} channel={channel} state={state}",
            camera_id=str(channel) if channel else None,
            context={"event_type": event_type, "state": state},
        )
        self.async_update_listeners()

    async def ptz(self, channel: str, pan: int, tilt: int, duration: int = 500) -> None:
        root = ET.Element("PTZData")
        ET.SubElement(root, "pan").text = str(pan)
        ET.SubElement(root, "tilt").text = str(tilt)
        ET.SubElement(root, "zoom").text = "0"
        payload = ET.tostring(root, encoding="unicode")
        await self._request_text(
            "PUT",
            f"/ISAPI/PTZCtrl/channels/{channel}/continuous",
            data=payload,
            expected={200},
            headers={"Content-Type": "application/xml"},
        )
        await asyncio.sleep(duration / 1000)
        root = ET.Element("PTZData")
        ET.SubElement(root, "pan").text = "0"
        ET.SubElement(root, "tilt").text = "0"
        ET.SubElement(root, "zoom").text = "0"
        payload = ET.tostring(root, encoding="unicode")
        await self._request_text(
            "PUT",
            f"/ISAPI/PTZCtrl/channels/{channel}/continuous",
            data=payload,
            expected={200},
            headers={"Content-Type": "application/xml"},
        )

    async def goto_preset(self, channel: str, preset: int) -> None:
        await self._request_text(
            "PUT",
            f"/ISAPI/PTZCtrl/channels/{channel}/presets/{preset}/goto",
            expected={200},
        )

    async def focus(self, channel: str, direction: int = 1, speed: int = 60, duration: int = 500) -> None:
        normalized_direction = 1 if int(direction) >= 0 else -1
        focus_value = max(1, min(100, abs(int(speed)))) * normalized_direction
        payload = f"<FocusData><focus>{focus_value}</focus></FocusData>"
        path = f"/ISAPI/ContentMgmt/InputProxy/channels/{channel}/focus"
        await self._request_text(
            "PUT",
            path,
            data=payload,
            expected={200},
            headers={"Content-Type": "application/xml"},
        )
        await asyncio.sleep(duration / 1000)
        await self._request_text(
            "PUT",
            path,
            data="<FocusData><focus>0</focus></FocusData>",
            expected={200},
            headers={"Content-Type": "application/xml"},
        )

    async def iris(self, channel: str, direction: int = 1, speed: int = 60, duration: int = 500) -> None:
        normalized_direction = 1 if int(direction) >= 0 else -1
        iris_value = max(1, min(100, abs(int(speed)))) * normalized_direction
        payload = f"<IrisData><iris>{iris_value}</iris></IrisData>"
        path = f"/ISAPI/ContentMgmt/InputProxy/channels/{channel}/iris"
        await self._request_text(
            "PUT",
            path,
            data=payload,
            expected={200},
            headers={"Content-Type": "application/xml"},
        )
        await asyncio.sleep(duration / 1000)
        await self._request_text(
            "PUT",
            path,
            data="<IrisData><iris>0</iris></IrisData>",
            expected={200},
            headers={"Content-Type": "application/xml"},
        )

    async def zoom(self, channel: str, direction: int = 1, speed: int = 50, duration: int = 500) -> None:
        normalized_direction = 1 if int(direction) >= 0 else -1
        zoom_value = max(1, min(100, abs(int(speed)))) * normalized_direction
        payload = f"<PTZData><pan>0</pan><tilt>0</tilt><zoom>{zoom_value}</zoom></PTZData>"
        path = f"/ISAPI/PTZCtrl/channels/{channel}/continuous"
        await self._request_text(
            "PUT",
            path,
            data=payload,
            expected={200},
            headers={"Content-Type": "application/xml"},
        )
        await asyncio.sleep(duration / 1000)
        await self._request_text(
            "PUT",
            path,
            data="<PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>",
            expected={200},
            headers={"Content-Type": "application/xml"},
        )

    async def return_to_center(self, channel: str, state: dict, speed: int = 50, duration: int = 350, step_delay: int = 150) -> None:
        pan = int(state.get("pan", 0) or 0)
        tilt = int(state.get("tilt", 0) or 0)
        zoom = int(state.get("zoom", 0) or 0)

        while pan != 0 or tilt != 0 or zoom != 0:
            step_pan = 0 if pan == 0 else (-1 if pan > 0 else 1) * speed
            step_tilt = 0 if tilt == 0 else (-1 if tilt > 0 else 1) * speed
            step_zoom = 0 if zoom == 0 else (-1 if zoom > 0 else 1) * speed
            payload = f"<PTZData><pan>{step_pan}</pan><tilt>{step_tilt}</tilt><zoom>{step_zoom}</zoom></PTZData>"
            path = f"/ISAPI/PTZCtrl/channels/{channel}/continuous"
            await self._request_text(
                "PUT",
                path,
                data=payload,
                expected={200},
                headers={"Content-Type": "application/xml"},
            )
            await asyncio.sleep(duration / 1000)
            await self._request_text(
                "PUT",
                path,
                data="<PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>",
                expected={200},
                headers={"Content-Type": "application/xml"},
            )
            pan += -1 if pan > 0 else (1 if pan < 0 else 0)
            tilt += -1 if tilt > 0 else (1 if tilt < 0 else 0)
            zoom += -1 if zoom > 0 else (1 if zoom < 0 else 0)
            await asyncio.sleep(step_delay / 1000)

    async def search_playback_uri(self, cam_id: str, requested_time: str) -> dict | None:
        camera_id = str(cam_id)
        cam = next((c for c in self.data.get("cameras", []) if str(c.get("id")) == camera_id), None)
        if not cam:
            return None
        active_stream = self.get_active_stream(camera_id) or {}
        stream_profiles = self.get_stream_profiles(camera_id) or {}
        track_ids = _candidate_playback_track_ids(cam, active_stream, stream_profiles)

        requested_search_ts = _format_search_timestamp(requested_time)
        requested_rtsp_ts = _format_rtsp_playback_timestamp(requested_time)
        if requested_search_ts is None or requested_rtsp_ts is None:
            self._push_debug_event(
                level="warning",
                category="playback",
                event="invalid_requested_time",
                message=f"Invalid playback timestamp for camera {camera_id}",
                camera_id=camera_id,
                context={"requested_time": requested_time},
            )
            return None

        for track_id in track_ids:
            payload = f"""<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription>
    <searchID>1</searchID>
    <trackList>
        <trackID>{track_id}</trackID>
    </trackList>
    <timeSpanList>
        <timeSpan>
            <startTime>{requested_search_ts}</startTime>
            <endTime>{requested_search_ts}</endTime>
        </timeSpan>
    </timeSpanList>
    <maxResults>10</maxResults>
    <searchResultPostion>0</searchResultPostion>
    <metadataList>
        <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
    </metadataList>
</CMSearchDescription>"""
            self._push_debug_event(
                category="playback",
                event="playback_search_request",
                message=f"Searching playback for camera {camera_id} track {track_id}",
                camera_id=camera_id,
                request={"track_id": track_id, "requested_time": requested_time, "requested_search_ts": requested_search_ts},
            )
            try:
                response_xml = await self._request_xml(
                    "POST",
                    "/ISAPI/ContentMgmt/search",
                    data=payload,
                    expected={200},
                    headers={"Content-Type": "application/xml"},
                )
            except UpdateFailed as err:
                self._push_debug_event(
                    level="warning",
                    category="playback",
                    event="playback_search_error",
                    message=f"Playback search failed for camera {camera_id} track {track_id}",
                    camera_id=camera_id,
                    request={"track_id": track_id},
                    error=err,
                )
                continue
            if response_xml is None:
                continue

            matches = response_xml.findall(".//hk:searchMatchItem", NS)
            for match in matches:
                playback_uri = safe_find_text(match, "playbackURI")
                clip_start_time = safe_find_text(match, "timeSpan/startTime")
                clip_end_time = safe_find_text(match, "timeSpan/endTime")
                if not playback_uri:
                    continue
                playback_uri = _inject_rtsp_playback_window(playback_uri, requested_time, clip_start_time)
                playback_uri = inject_rtsp_credentials(playback_uri, self.username, self.password)
                playback_uri = playback_uri.replace("&endtime=", "&_dropped_endtime=")
                result = {
                    "playback_uri": playback_uri,
                    "playback_clip_start_time": clip_start_time,
                    "playback_clip_end_time": clip_end_time,
                    "track_id": track_id,
                }
                self._push_debug_event(
                    category="playback",
                    event="playback_search_match",
                    message=f"Playback match found for camera {camera_id} track {track_id}",
                    camera_id=camera_id,
                    response=result,
                )
                return result
        self._push_debug_event(
            category="playback",
            event="playback_search_empty",
            message=f"No playback found for camera {camera_id}",
            camera_id=camera_id,
            context={"requested_time": requested_time},
        )
        return None


def text_stream(parent, path):
    node = parent.find(path, STREAM_NS)
    return node.text if node is not None else None
