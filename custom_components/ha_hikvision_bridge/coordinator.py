from __future__ import annotations

from datetime import timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import aiohttp
import asyncio
import logging
import xml.etree.ElementTree as ET
from contextlib import suppress

from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.exceptions import HomeAssistantError

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
        parts = [f"{method} {path}"]
        if status is not None:
            parts.append(f"failed {status}")
        if detail:
            parts.append(detail)
        elif body:
            parts.append(body)
        super().__init__(": ".join(parts))


def text_ns(node, path, ns, default=""):
    value = node.findtext(path, default=default, namespaces=ns)
    return (value or "").strip()


def text_hk(node, path, default=""):
    return text_ns(node, path, NS, default)


def text_stream(node, path, default=""):
    return text_ns(node, path, STREAM_NS, default)


def _parse_hikvision_dt(value: str | None):
    if not value:
        return None
    parsed = dt_util.parse_datetime(str(value).strip())
    if parsed is not None:
        return parsed
    raw = str(value).strip()
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
        with suppress(ValueError):
            dt_obj = dt_util.parse_datetime(dt_util.as_local(dt_util.utcnow()).strftime(fmt))
            if dt_obj is not None:
                return dt_util.parse_datetime(raw)
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
        if not raw or not raw.isdigit():
            return
        num = int(raw)
        if num <= 0:
            return
        if num >= 100:
            num = num // 100
        add(f"{num}01")

    for value in (
        cam.get("channel"),
        cam.get("id"),
        active_stream.get("channel"),
        (profiles.get("main") or {}).get("channel"),
        (profiles.get("sub") or {}).get("channel"),
        active_stream.get("stream_id"),
        (profiles.get("main") or {}).get("stream_id"),
        (profiles.get("sub") or {}).get("stream_id"),
        cam.get("stream_id"),
    ):
        add_main_recording_track(value)

    return values


def _inject_rtsp_playback_window(playback_uri: str | None, requested_time: str | None, end_time: str | None = None) -> str | None:
    """Normalize Hikvision playback RTSP URIs for better DESCRIBE compatibility.

    Hikvision playback URIs often arrive with a pre-filled ``starttime`` from
    the beginning of the matching clip. That is fine for discovery, but it
    breaks explicit seeking because each restarted playback session reuses the
    clip boundary instead of the user-selected playback time.

    Keep the path normalization that fixed DESCRIBE compatibility, but prefer
    the caller's requested seek timestamp whenever one is supplied.
    """
    if not playback_uri:
        return playback_uri

    try:
        parts = urlsplit(playback_uri)
        query_items = parse_qsl(parts.query, keep_blank_values=True)
        query = dict(query_items)

        # Normalize /path/?query -> /path?query.
        path = parts.path[:-1] if parts.path.endswith('/') else parts.path

        # Explicit seek time must win over any clip-boundary starttime already
        # present in the RTSP playback URI returned by the NVR.
        start_source = requested_time or query.get("starttime")
        start_stamp = _format_rtsp_playback_timestamp(start_source)
        if start_stamp:
            query["starttime"] = start_stamp

        # Hikvision playback RTSP is often fragile when ``endtime`` is
        # present during DESCRIBE. Remove it entirely and rely on the NVR to
        # start the playback session from the requested ``starttime``.
        query.pop("endtime", None)

        rebuilt = urlunsplit((parts.scheme, parts.netloc, path, urlencode(query), parts.fragment))
        return rebuilt
    except Exception:
        return playback_uri


def parse_io_inputs_xml(io_xml) -> list[dict]:
    inputs: list[dict] = []
    if io_xml is None:
        return inputs
    root = io_xml if hasattr(io_xml, "findall") else None
    if root is None:
        return inputs

    def local_name(tag: str) -> str:
        return tag.split("}", 1)[1] if "}" in tag else tag

    for node in root.iter():
        if local_name(node.tag) != "IOPort":
            continue
        values: dict[str, str] = {}
        for child in node:
            values[local_name(child.tag)] = (child.text or "").strip()
        input_id = values.get("id") or values.get("inputID") or values.get("ioPortID") or ""
        if not input_id:
            continue
        status = (values.get("ioPortStatus") or values.get("eventState") or values.get("triggering") or "").strip().lower()
        is_active = status in {"active", "open", "high", "on", "triggered"}
        inputs.append(
            {
                "id": str(input_id),
                "name": values.get("name") or f"Alarm Input {input_id}",
                "status": status or "unknown",
                "active": is_active,
                "triggering": values.get("triggering"),
            }
        )
    return inputs


class HikvisionCoordinator(DataUpdateCoordinator):
    def __init__(self, hass, entry):
        super().__init__(
            hass,
            _LOGGER,
            name="HA Hikvision Bridge",
            update_interval=timedelta(seconds=15),
        )
        self.entry = entry
        self.host = entry.data[CONF_HOST]
        self.port = entry.data[CONF_PORT]
        self.username = entry.data[CONF_USERNAME]
        self.password = entry.data[CONF_PASSWORD]
        self.use_https = entry.data[CONF_USE_HTTPS]
        self.verify_ssl = entry.data[CONF_VERIFY_SSL]
        self.rtsp_port = DEFAULT_RTSP_PORT
        self._stream_profile_by_camera: dict[str, str] = {}
        self._alarm_task: asyncio.Task | None = None
        self._alarm_running = False
        self._playback_debug_by_camera: dict[str, list[dict]] = {}
        self._debug_enabled = bool(entry.options.get(CONF_DEBUG_ENABLED, False))
        categories = entry.options.get(CONF_DEBUG_CATEGORIES) or ["playback", "isapi", "websocket", "stream", "alarm", "ptz"]
        self._debug_categories = {str(item).strip().lower() for item in categories if str(item).strip()}
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
                {
                    "source": "audio",
                    "camera": camera_id,
                    "category": "audio",
                    "level": "info",
                    "event": "audio_classifier_match",
                    "details": {
                        "label": label,
                        "confidence": confidence,
                    },
                }
            )

    def url(self, path: str) -> str:
        scheme = "https" if self.use_https else "http"
        return f"{scheme}://{self.host}:{self.port}{path}"

    def get_playback_debug(self, cam_id: str) -> list[dict]:
        return list(self._playback_debug_by_camera.get(str(cam_id), []))


    def get_debug_events(self, camera_id: str | None = None, limit: int = 150) -> list[dict]:
        return self._debug_manager.get_events(camera_id=camera_id, entry_id=self.entry.entry_id, limit=limit)
    
    def _debug_category_enabled(self, category: str) -> bool:
        if not self._debug_enabled:
            return False
        return not self._debug_categories or str(category or "backend").lower() in self._debug_categories
    
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
        if str(level).lower() == "error":
            _LOGGER.error("%s | %s", log_message, extra)
        elif str(level).lower() == "warn":
            _LOGGER.warning("%s | %s", log_message, extra)
        else:
            _LOGGER.debug("%s | %s", log_message, extra)
    
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


    async def _request_raw(self, method: str, path: str, data: str | None = None):
        url = self.url(path)
        base_headers = {"Content-Type": "application/xml"}

        async def do_request(*, headers=None, auth=None):
            return await self.session.request(
                method,
                url,
                headers=headers or dict(base_headers),
                data=data,
                ssl=self.verify_ssl,
                auth=auth,
            )

        headers = dict(base_headers)
        if self.digest.ready():
            headers["Authorization"] = self.digest.build(method, path)

        resp = await do_request(headers=headers)

        if resp.status == 401:
            www_auth = resp.headers.get("WWW-Authenticate", "")
            body = await resp.text()
            resp.release()

            # Standard Digest challenge path
            if www_auth:
                self.digest.parse(www_auth)
                headers = dict(base_headers)
                headers["Authorization"] = self.digest.build(method, path)
                return await do_request(headers=headers)

            # Some Hikvision / proxy endpoints reply with a bare HTML 401 page and
            # omit WWW-Authenticate entirely. Fall back to Basic auth for those.
            basic_resp = await do_request(
                headers=dict(base_headers),
                auth=aiohttp.BasicAuth(self.username, self.password),
            )
            if basic_resp.status != 401:
                return basic_resp

            # Final recovery: drop any stale digest state, probe again, and if the
            # device now returns a proper challenge, retry with a fresh digest.
            basic_resp.release()
            self.digest = DigestAuth(self.username, self.password)
            probe = await do_request(headers=dict(base_headers))
            if probe.status == 401:
                fresh_auth = probe.headers.get("WWW-Authenticate", "")
                if fresh_auth:
                    await probe.text()
                    probe.release()
                    self.digest.parse(fresh_auth)
                    headers = dict(base_headers)
                    headers["Authorization"] = self.digest.build(method, path)
                    return await do_request(headers=headers)

            _LOGGER.debug(
                "401 without WWW-Authenticate for %s %s; initial body=%s",
                method,
                path,
                body[:300],
            )
            return probe

        return resp

    def _classify_endpoint_issue(self, *, status: int | None = None, body: str | None = None, err: Exception | None = None) -> str:
        message = str(body or err or "").lower()
        if isinstance(err, asyncio.TimeoutError):
            return "transport_error"
        if isinstance(err, aiohttp.ClientError):
            return "transport_error"
        if status == 404:
            return "missing"
        if status in (401, 403):
            if self._is_not_supported_error(Exception(message)):
                return "unsupported"
            return "forbidden"
        if self._is_not_supported_error(Exception(message)):
            return "unsupported"
        if status is not None and status >= 500:
            return "device_error"
        if status is not None and status >= 400:
            return "request_error"
        if err is not None:
            return "transport_error"
        return "request_error"

    def _endpoint_issue_context(self, *, method: str, path: str, status: int | None = None, classification: str, detail: str | None = None) -> dict:
        return {
            "method": method,
            "path": path,
            "status": status,
            "classification": classification,
            "detail": (detail or "")[:300] or None,
        }

    async def request(self, method: str, path: str, data: str | None = None):
        try:
            resp = await self._request_raw(method, path, data=data)
        except Exception as err:
            classification = self._classify_endpoint_issue(err=err)
            raise HikvisionEndpointError(method=method, path=path, classification=classification, detail=str(err)) from err
        text = await resp.text()
        if resp.status not in (200, 201):
            classification = self._classify_endpoint_issue(status=resp.status, body=text)
            raise HikvisionEndpointError(method=method, path=path, status=resp.status, body=text, classification=classification)

        try:
            return ET.fromstring(text)
        except ET.ParseError:
            return text

    async def request_bytes(self, method: str, path: str, data: str | None = None) -> bytes:
        try:
            resp = await self._request_raw(method, path, data=data)
        except Exception as err:
            classification = self._classify_endpoint_issue(err=err)
            raise HikvisionEndpointError(method=method, path=path, classification=classification, detail=str(err)) from err
        body = await resp.read()
        if resp.status not in (200, 201):
            try:
                text = body.decode("utf-8", errors="ignore")
            except Exception:
                text = "<binary>"
            classification = self._classify_endpoint_issue(status=resp.status, body=text)
            raise HikvisionEndpointError(method=method, path=path, status=resp.status, body=text, classification=classification)
        return body

    def _stream_rtsp_url(self, stream_id: str | int | None) -> str | None:
        if not stream_id:
            return None
        return build_rtsp_url(self.username, self.password, self.host, stream_id, self.rtsp_port)

    def _stream_rtsp_direct_url(self, stream_id: str | int | None) -> str | None:
        if not stream_id:
            return None
        return build_rtsp_direct_url(self.username, self.password, self.host, stream_id, self.rtsp_port)

    def _extract_streams(self, streaming_xml) -> tuple[dict[str, dict], dict[str, list[dict]], dict[str, dict[str, dict]]]:
        streams_by_camera: dict[str, list[dict]] = {}

        for stream_xml in streaming_xml.findall(".//isapi:StreamingChannel", STREAM_NS):
            stream_id = text_stream(stream_xml, "isapi:id")
            video_input_channel_id = (
                text_stream(stream_xml, "isapi:Video/isapi:dynVideoInputChannelID")
                or text_stream(stream_xml, "isapi:Video/isapi:videoInputChannelID")
            )
            if not stream_id:
                continue

            max_frame_rate_raw = text_stream(stream_xml, "isapi:Video/isapi:maxFrameRate")
            try:
                max_frame_rate = float(max_frame_rate_raw) / 100.0 if max_frame_rate_raw else None
            except Exception:
                max_frame_rate = max_frame_rate_raw

            stream = {
                "stream_id": stream_id,
                "stream_name": text_stream(stream_xml, "isapi:channelName"),
                "enabled": coerce_bool(text_stream(stream_xml, "isapi:enabled")),
                "transport": text_stream(
                    stream_xml,
                    "isapi:Transport/isapi:ControlProtocolList/isapi:ControlProtocol/isapi:streamingTransport",
                ),
                "video_enabled": coerce_bool(text_stream(stream_xml, "isapi:Video/isapi:enabled")),
                "video_input_channel_id": video_input_channel_id,
                "video_codec": text_stream(stream_xml, "isapi:Video/isapi:videoCodecType"),
                "width": text_stream(stream_xml, "isapi:Video/isapi:videoResolutionWidth"),
                "height": text_stream(stream_xml, "isapi:Video/isapi:videoResolutionHeight"),
                "bitrate_mode": text_stream(stream_xml, "isapi:Video/isapi:videoQualityControlType"),
                "constant_bitrate": text_stream(stream_xml, "isapi:Video/isapi:constantBitRate"),
                "fixed_quality": text_stream(stream_xml, "isapi:Video/isapi:fixedQuality"),
                "max_frame_rate_raw": max_frame_rate_raw,
                "max_frame_rate": max_frame_rate,
                "gov_length": text_stream(stream_xml, "isapi:Video/isapi:GovLength"),
                "snapshot_image_type": text_stream(stream_xml, "isapi:Video/isapi:snapShotImageType"),
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
            channel_id = text_hk(ch, "hk:id")
            if not channel_id:
                continue
            ptz_map[channel_id] = {
                "id": channel_id,
                "name": text_hk(ch, "hk:name"),
                "enabled": coerce_bool(text_hk(ch, "hk:enabled"), default=True),
                "online": coerce_bool(text_hk(ch, "hk:online"), default=True),
                "video_input_id": text_hk(ch, "hk:videoInputID"),
                "control_protocol": text_hk(ch, "hk:controlProtocol"),
                "ctrl_mode": text_hk(ch, "hk:ctrlMode"),
                "proxy_type": text_hk(ch, "hk:proxyType"),
            }
        return ptz_map


    def _infer_ptz_mode_support(self, *values: str | None) -> tuple[bool | None, bool | None]:
        combined = "\n".join(str(value or "") for value in values).strip().lower()
        if not combined:
            return None, None
        has_momentary = "momentary" in combined
        has_continuous = "continuous" in combined
        return has_momentary, has_continuous

    async def _get_direct_ptz_capabilities(self, channel_id: str) -> dict[str, object]:
        try:
            resp = await self._request_raw("GET", f"/ISAPI/PTZCtrl/channels/{channel_id}/capabilities")
            body = await resp.text()
            supported = resp.status in (200, 201) and "PTZChannelCap" in body
            momentary_supported, continuous_supported = self._infer_ptz_mode_support(body)
            return {
                "supported": supported,
                "momentary_supported": bool(momentary_supported) if momentary_supported is not None else None,
                "continuous_supported": bool(continuous_supported) if continuous_supported is not None else None,
            }
        except Exception:
            return {
                "supported": False,
                "momentary_supported": None,
                "continuous_supported": None,
            }

    def _build_ptz_capabilities(self, cam_id: str, ptz_info: dict, direct_ptz_caps: dict[str, object]) -> dict[str, object]:
        proxy_supported = bool(cam_id and cam_id in (self.data.get("ptz_map", {}) if isinstance(self.data, dict) else {})) or bool(ptz_info)
        proxy_ctrl_mode = str(ptz_info.get("ctrl_mode") or "").strip()
        proxy_mode_momentary, proxy_mode_continuous = self._infer_ptz_mode_support(proxy_ctrl_mode)

        direct_supported = bool(direct_ptz_caps.get("supported"))
        direct_mode_momentary = direct_ptz_caps.get("momentary_supported")
        direct_mode_continuous = direct_ptz_caps.get("continuous_supported")

        proxy_momentary_supported = bool(proxy_supported and (proxy_mode_momentary is True or (proxy_mode_momentary is None and proxy_mode_continuous is None)))
        proxy_continuous_supported = bool(proxy_supported and proxy_mode_continuous is True)
        direct_momentary_supported = bool(direct_supported and direct_mode_momentary is True)
        direct_continuous_supported = bool(direct_supported and direct_mode_continuous is True)

        integration_ptz_supported = proxy_momentary_supported
        unsupported_reason = None
        if not integration_ptz_supported:
            if proxy_supported and proxy_continuous_supported and not proxy_momentary_supported:
                unsupported_reason = "proxy_continuous_only"
            elif direct_supported:
                unsupported_reason = "direct_ptz_not_implemented"
            elif proxy_supported:
                unsupported_reason = "proxy_mode_unknown"
            else:
                unsupported_reason = "not_supported"

        if integration_ptz_supported:
            control_method = "proxy"
        elif proxy_supported:
            control_method = "proxy"
        elif direct_supported:
            control_method = "direct"
        else:
            control_method = None

        capability_mode = None
        if proxy_supported:
            if proxy_momentary_supported and proxy_continuous_supported:
                capability_mode = "proxy_momentary_continuous"
            elif proxy_momentary_supported:
                capability_mode = "proxy_momentary"
            elif proxy_continuous_supported:
                capability_mode = "proxy_continuous"
            else:
                capability_mode = "proxy_unknown"
        elif direct_supported:
            if direct_momentary_supported and direct_continuous_supported:
                capability_mode = "direct_momentary_continuous"
            elif direct_momentary_supported:
                capability_mode = "direct_momentary"
            elif direct_continuous_supported:
                capability_mode = "direct_continuous"
            else:
                capability_mode = "direct_unknown"

        return {
            "ptz_proxy_supported": proxy_supported,
            "ptz_direct_supported": direct_supported,
            "ptz_proxy_ctrl_mode": proxy_ctrl_mode or None,
            "ptz_proxy_momentary_supported": proxy_momentary_supported,
            "ptz_proxy_continuous_supported": proxy_continuous_supported,
            "ptz_direct_momentary_supported": direct_momentary_supported,
            "ptz_direct_continuous_supported": direct_continuous_supported,
            "ptz_momentary_supported": proxy_momentary_supported or direct_momentary_supported,
            "ptz_continuous_supported": proxy_continuous_supported or direct_continuous_supported,
            "ptz_capability_mode": capability_mode,
            "ptz_supported": integration_ptz_supported,
            "ptz_control_method": control_method,
            "ptz_implementation": "proxy_momentary" if integration_ptz_supported else None,
            "ptz_unsupported_reason": unsupported_reason,
        }

    def _is_real_camera(self, camera: dict, dvr_name: str, dvr_model: str, dvr_serial: str) -> bool:
        cam_name = (camera.get("name") or "").strip()
        cam_model = (camera.get("model") or "").strip()
        cam_serial = (camera.get("serial_number") or "").strip()
        cam_ip = (camera.get("ip_address") or "").strip()

        if cam_serial and dvr_serial and cam_serial == dvr_serial:
            return False
        if cam_name and dvr_name and cam_name == dvr_name and not cam_ip:
            return False
        if cam_model and dvr_model and cam_model == dvr_model and (not cam_ip or cam_ip == self.host):
            return False
        if cam_model.startswith("DS-76") and (not cam_ip or cam_ip == self.host):
            return False
        return True


    def _camera_by_id(self, cam_id: str) -> dict:
        return next((cam for cam in self.data.get("cameras", []) if str(cam.get("id")) == str(cam_id)), {})

    @staticmethod
    def _local_name(tag: str) -> str:
        return tag.split("}", 1)[1] if "}" in tag else tag

    def _find_first_text(self, node, name: str, default: str = "") -> str:
        if node is None:
            return default
        for child in node.iter():
            if self._local_name(child.tag) == name:
                return (child.text or "").strip()
        return default

    def _parse_playback_matches(self, xml_root) -> list[dict]:
        matches: list[dict] = []
        if xml_root is None or not hasattr(xml_root, "iter"):
            return matches
        for node in xml_root.iter():
            if self._local_name(node.tag) != "searchMatchItem":
                continue
            descriptor = None
            for child in node:
                if self._local_name(child.tag) == "mediaSegmentDescriptor":
                    descriptor = child
                    break
            matches.append(
                {
                    "playback_uri": self._find_first_text(descriptor or node, "playbackURI"),
                    "start_time": self._find_first_text(descriptor or node, "startTime"),
                    "end_time": self._find_first_text(descriptor or node, "endTime"),
                }
            )
        return [item for item in matches if item.get("playback_uri")]

    async def search_playback_uri(self, cam_id: str, requested_time: str) -> dict | None:
        cam = self._camera_by_id(cam_id)
        active_stream = self.get_active_stream(cam_id) or {}
        profiles = self.get_stream_profiles(cam_id) or {}
        candidates = _candidate_playback_track_ids(cam, active_stream, profiles)

        if not candidates:
            self._store_playback_debug(cam_id, {
                "ok": False,
                "reason": "No candidate track IDs were available for playback search.",
                "requested_time": requested_time,
            })
            return None

        requested_dt = _parse_hikvision_dt(requested_time)
        if requested_dt is not None:
            search_start = _format_search_timestamp((requested_dt - timedelta(hours=12)).isoformat()) or requested_time
            search_end = _format_search_timestamp((requested_dt + timedelta(hours=12)).isoformat()) or requested_time
        else:
            search_start = _format_search_timestamp(requested_time) or requested_time
            search_end = _format_search_timestamp(requested_time) or requested_time

        for track_id in candidates:
            body = f"""<?xml version="1.0" encoding="UTF-8"?>
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
                resp = await self._request_raw("POST", "/ISAPI/ContentMgmt/search", data=body)
                status = resp.status
                response_text = await resp.text()
            except Exception as err:
                self._store_playback_debug(cam_id, {
                    "ok": False,
                    "track_id": track_id,
                    "requested_time": requested_time,
                    "search_start": search_start,
                    "search_end": search_end,
                    "request": {
                        "method": "POST",
                        "path": "/ISAPI/ContentMgmt/search",
                        "headers": {"Content-Type": "application/xml"},
                        "body": body,
                    },
                    "error": str(err),
                })
                continue

            debug_entry = {
                "ok": status in (200, 201),
                "track_id": track_id,
                "requested_time": requested_time,
                "search_start": search_start,
                "search_end": search_end,
                "request": {
                    "method": "POST",
                    "path": "/ISAPI/ContentMgmt/search",
                    "headers": {"Content-Type": "application/xml"},
                    "body": body,
                },
                "response": {
                    "status": status,
                    "body": response_text[:4000],
                },
            }

            if status not in (200, 201):
                self._store_playback_debug(cam_id, debug_entry)
                continue

            try:
                result = ET.fromstring(response_text)
            except ET.ParseError:
                debug_entry["ok"] = False
                debug_entry["reason"] = "Playback search response was not valid XML."
                self._store_playback_debug(cam_id, debug_entry)
                continue

            matches = self._parse_playback_matches(result)
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
                    contains_requested = int(start_dt is not None and end_dt is not None and start_dt <= requested_dt <= end_dt)
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
            adjusted_uri = _inject_rtsp_playback_window(playback_uri, requested_time or clip_start, clip_end)
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
                "playback_uri": authenticated_uri,
                "playback_clip_start_time": best_match.get("start_time"),
                "playback_clip_end_time": best_match.get("end_time"),
                "playback_requested_time": requested_time,
                "track_id": track_id,
            }

        self._store_playback_debug(cam_id, {
            "ok": False,
            "requested_time": requested_time,
            "reason": "Playback search completed but no usable recording URI was found.",
        })
        return None

    def _is_not_supported_error(self, err: Exception) -> bool:
        message = str(err or "").lower()
        markers = (
            " notsupport",
            "notsupport",
            "not supported",
            "invalid operation",
            "invalidoperation",
            "feature not supported",
            "not implement",
            "notimplemented",
            "unsupported",
        )
        return any(marker in message for marker in markers)

    def _log_optional_endpoint_issue(self, err: Exception, *, method: str, path: str, capability: str) -> None:
        classification = getattr(err, "classification", None) or self._classify_endpoint_issue(err=err)
        status = getattr(err, "status", None)
        detail = getattr(err, "body", None) or getattr(err, "detail", None) or str(err)
        level = "warn" if classification in {"unsupported", "missing", "forbidden"} else "error"
        self._push_debug_event(
            level=level,
            category="backend",
            event="optional_endpoint_unavailable",
            message=f"Optional endpoint unavailable: {path}",
            context={"capability": capability, **self._endpoint_issue_context(method=method, path=path, status=status, classification=classification, detail=detail)},
            error=detail,
        )

    async def _async_update_data(self):
        try:
            device_xml = await self.request("GET", "/ISAPI/System/deviceInfo?JumpChildDev=true")
            storage_xml = None
            storage_caps_xml = None
            storage_extra_caps_xml = None
            storage_info_supported = False
            storage_hdd_caps_supported = False
            storage_extra_caps_supported = False

            try:
                storage_xml = await self.request("GET", "/ISAPI/ContentMgmt/Storage")
                storage_info_supported = True
            except HikvisionEndpointError as err:
                self._log_optional_endpoint_issue(err, method="GET", path="/ISAPI/ContentMgmt/Storage", capability="storage_info")
                if err.classification not in {"unsupported", "missing", "forbidden"}:
                    raise

            try:
                storage_caps_xml = await self.request("GET", "/ISAPI/ContentMgmt/Storage/hdd/capabilities")
                storage_hdd_caps_supported = True
            except HikvisionEndpointError as err:
                self._log_optional_endpoint_issue(err, method="GET", path="/ISAPI/ContentMgmt/Storage/hdd/capabilities", capability="storage_hdd_caps")
                if err.classification not in {"unsupported", "missing", "forbidden"}:
                    raise

            try:
                storage_extra_caps_xml = await self.request("GET", "/ISAPI/ContentMgmt/Storage/ExtraInfo/capabilities")
                storage_extra_caps_supported = True
            except HikvisionEndpointError as err:
                self._log_optional_endpoint_issue(err, method="GET", path="/ISAPI/ContentMgmt/Storage/ExtraInfo/capabilities", capability="storage_extra_caps")
                if err.classification not in {"unsupported", "missing", "forbidden"}:
                    storage_extra_caps_xml = None
                else:
                    storage_extra_caps_xml = None
            try:
                io_inputs_xml = await self.request("GET", "/ISAPI/System/IO/inputs")
            except Exception:
                io_inputs_xml = None
            cameras_xml = await self.request("GET", "/ISAPI/ContentMgmt/InputProxy/channels")
            ptz_xml = await self.request("GET", "/ISAPI/ContentMgmt/PTZCtrlProxy/channels")
            streaming_xml = await self.request("GET", "/ISAPI/ContentMgmt/StreamingProxy/channels")

            dvr_name = text_hk(device_xml, "hk:deviceName")
            dvr_model = text_hk(device_xml, "hk:model")
            dvr_serial = text_hk(device_xml, "hk:serialNumber")

            ptz_map = self._extract_ptz_map(ptz_xml)
            active_streams, streams_by_camera, stream_profiles_by_camera = self._extract_streams(streaming_xml)
            storage_info = parse_storage_xml(storage_xml)
            storage_caps = parse_storage_capabilities_xml(storage_caps_xml)
            if storage_extra_caps_xml is not None:
                extra_disk_mode = safe_find_text(storage_extra_caps_xml, "diskMode")
                if extra_disk_mode:
                    storage_caps["disk_mode"] = extra_disk_mode
            storage_hdds = storage_info.get("hdds") or storage_caps.get("hdds") or []
            storage_present = bool(
                storage_hdds
                or int(storage_info.get("disk_count", 0) or 0) > 0
                or int(storage_caps.get("disk_count", 0) or 0) > 0
                or int(storage_info.get("total_capacity_mb", 0) or 0) > 0
                or int(storage_caps.get("total_capacity_mb", 0) or 0) > 0
            )
            playback_supported = bool(storage_info_supported and storage_present)
            device_capabilities = {
                "storage_info_supported": storage_info_supported,
                "storage_hdd_caps_supported": storage_hdd_caps_supported,
                "storage_extra_caps_supported": storage_extra_caps_supported,
                "storage_present": storage_present,
                "playback_supported": playback_supported,
            }
            alarm_inputs = parse_io_inputs_xml(io_inputs_xml)

            all_cameras: list[dict] = []
            entity_cameras: list[dict] = []

            for ch in cameras_xml.findall(".//hk:InputProxyChannel", NS):
                cam_id = text_hk(ch, "hk:id")
                if not cam_id:
                    continue
                src = ch.find("hk:sourceInputPortDescriptor", NS)

                def src_text(tag, default=""):
                    if src is None:
                        return default
                    return text_hk(src, f"hk:{tag}", default)

                ip_addr = src_text("ipAddress")
                model = src_text("model")
                serial = src_text("serialNumber")
                firmware = src_text("firmwareVersion")
                ptz_info = ptz_map.get(cam_id, {})
                active_stream = active_streams.get(cam_id, {})
                stream_profiles = stream_profiles_by_camera.get(cam_id, {})
                selected_stream_profile = normalize_stream_profile(self._stream_profile_by_camera.get(cam_id, DEFAULT_STREAM_PROFILE))
                direct_ptz_caps = await self._get_direct_ptz_capabilities(cam_id)
                ptz_capabilities = self._build_ptz_capabilities(cam_id, ptz_info, direct_ptz_caps)

                camera = {
                    "id": cam_id,
                    "name": text_hk(ch, "hk:name", f"Camera {cam_id}"),
                    "ip_address": ip_addr,
                    "manage_port": src_text("managePortNo"),
                    "src_input_port": src_text("srcInputPort"),
                    "username": src_text("userName"),
                    "proxy_protocol": src_text("proxyProtocol"),
                    "addressing_format": src_text("addressingFormatType"),
                    "connection_mode": src_text("connMode"),
                    "stream_type": src_text("streamType"),
                    "model": model,
                    "serial_number": serial,
                    "firmware_version": firmware,
                    "device_id": src_text("deviceID"),
                    "dev_index": text_hk(ch, "hk:devIndex"),
                    "certificate_validation_enabled": coerce_bool(text_hk(ch, "hk:certificateValidationEnabled")),
                    "default_admin_port_enabled": coerce_bool(text_hk(ch, "hk:defaultAdminPortEnabled")),
                    "timing_enabled": coerce_bool(text_hk(ch, "hk:enableTiming")),
                    **ptz_capabilities,
                    "ptz_enabled": ptz_info.get("enabled"),
                    "ptz_online": ptz_info.get("online"),
                    "online": bool(ip_addr and (model or serial or firmware)),
                    "card_visible": bool(ip_addr and (model or serial or firmware)),
                    "rtsp_url": active_stream.get("rtsp_url"),
                    "rtsp_direct_url": active_stream.get("rtsp_direct_url"),
                    "stream_id": active_stream.get("stream_id"),
                    "stream_profile": selected_stream_profile,
                    "stream_profile_options": sorted(list(stream_profiles.keys())),
                    "main_stream_id": (stream_profiles.get("main") or {}).get("stream_id"),
                    "sub_stream_id": (stream_profiles.get("sub") or {}).get("stream_id"),
                    "playback_supported": playback_supported,
                    "storage_present": storage_present,
                    "storage_info_supported": storage_info_supported,
                    "storage_hdd_caps_supported": storage_hdd_caps_supported,
                }
                all_cameras.append(camera)

                if self._is_real_camera(camera, dvr_name, dvr_model, dvr_serial):
                    entity_cameras.append(camera)

            return {
                "device_xml": device_xml,
                "storage_xml": storage_xml,
                "storage_capabilities_xml": storage_caps_xml,
                "storage_extra_capabilities_xml": storage_extra_caps_xml,
                "io_inputs_xml": io_inputs_xml,
                "cameras_xml": cameras_xml,
                "ptz_xml": ptz_xml,
                "streaming_xml": streaming_xml,
                "all_cameras": all_cameras,
                "cameras": entity_cameras,
                "streams": active_streams,
                "streams_by_camera": streams_by_camera,
                "stream_profiles": stream_profiles_by_camera,
                "ptz_map": ptz_map,
                "nvr": {
                    "name": dvr_name,
                    "model": dvr_model,
                    "serial_number": dvr_serial,
                    "firmware_version": text_hk(device_xml, "hk:firmwareVersion"),
                    "firmware_released_date": text_hk(device_xml, "hk:firmwareReleasedDate"),
                    "manufacturer": text_hk(device_xml, "hk:manufacturer", "Hikvision"),
                    "mac_address": text_hk(device_xml, "hk:macAddress"),
                    "device_id": text_hk(device_xml, "hk:deviceID"),
                    "device_description": text_hk(device_xml, "hk:deviceDescription"),
                    "boot_time": text_hk(device_xml, "hk:bootTime"),
                    "supports_isapi": True,
                    "online": True,
                },
                "storage": {**storage_info, **storage_caps, **device_capabilities},
                "capabilities": device_capabilities,
                "alarm_states": dict((self.data or {}).get("alarm_states") or self._default_alarm_states()),
            }
        except HikvisionEndpointError as err:
            self._push_debug_event(
                level="error",
                category="backend",
                event="required_endpoint_failed",
                message=f"Required endpoint failed: {err.path}",
                context=self._endpoint_issue_context(method=err.method, path=err.path, status=err.status, classification=err.classification, detail=err.body or err.detail),
                error=err.body or err.detail or str(err),
            )
            raise UpdateFailed(f"Failed to refresh Hikvision data: [{err.classification}] {err}") from err
        except Exception as err:
            self._push_debug_event(
                level="error",
                category="backend",
                event="refresh_transport_error",
                message="Unhandled refresh failure",
                context={"classification": self._classify_endpoint_issue(err=err)},
                error=str(err),
            )
            raise UpdateFailed(f"Failed to refresh Hikvision data: {err}") from err



    async def async_start_alarm_stream(self) -> None:
        if self._alarm_task and not self._alarm_task.done():
            return
        self._alarm_running = True
        self._alarm_task = self.hass.async_create_task(self._alarm_stream_loop())

    async def async_stop_alarm_stream(self) -> None:
        self._alarm_running = False
        task = self._alarm_task
        self._alarm_task = None
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    def _default_alarm_states(self) -> dict:
        states = {
            "disk_full": False,
            "disk_error": False,
            "stream_connected": False,
            "last_event_type": None,
            "last_event_channel": None,
            "last_event_state": None,
            "active_alarm_count": 0,
        }
        for cam in (self.data or {}).get("cameras", []):
            cam_id = str(cam.get("id"))
            if cam_id:
                for prefix in ("motion", "video_loss", "intrusion", "line_crossing", "tamper"):
                    states.setdefault(f"{prefix}_{cam_id}", False)
        for alarm_input in (self.data or {}).get("alarm_inputs", []):
            input_id = str(alarm_input.get("id"))
            if input_id:
                states.setdefault(f"alarm_input_{input_id}", bool(alarm_input.get("active")))
        return states

    def _local_name(self, tag: str) -> str:
        if "}" in tag:
            return tag.split("}", 1)[1]
        return tag

    def _parse_alarm_event(self, xml_text: str) -> dict:
        root = ET.fromstring(xml_text)
        values: dict[str, str] = {}
        for node in root.iter():
            values[self._local_name(node.tag)] = (node.text or "").strip()

        event_type = (values.get("eventType") or values.get("eventDescription") or "").strip()
        event_state = (values.get("eventState") or values.get("state") or "").strip().lower()
        channel = (
            values.get("channelID")
            or values.get("dynVideoInputChannelID")
            or values.get("videoInputChannelID")
            or values.get("inputID")
            or ""
        ).strip()

        input_id = (
            values.get("inputID")
            or values.get("ioPortID")
            or values.get("inputNo")
            or values.get("portNo")
            or values.get("alarmInID")
            or ""
        ).strip()

        return {
            "event_type": event_type,
            "event_state": event_state,
            "channel": channel,
            "input_id": input_id,
            "raw": values,
        }


    def _apply_alarm_event(self, event: dict) -> bool:
        current = dict(self.data or {})
        states = dict(current.get("alarm_states") or self._default_alarm_states())
        changed = False

        event_type = str(event.get("event_type") or "").strip().lower()
        event_state = str(event.get("event_state") or "").strip().lower()
        channel = str(event.get("channel") or "").strip()
        input_id = str(event.get("input_id") or "").strip()
        is_active = event_state in {"active", "on", "start", "triggered", "open", "high"}

        def set_state(key: str, value) -> None:
            nonlocal changed
            if states.get(key) != value:
                states[key] = value
                changed = True

        def match_event(value: str, *aliases: str) -> bool:
            normalized = value.replace("-", "").replace("_", "").replace(" ", "")
            return normalized in {alias.replace("-", "").replace("_", "").replace(" ", "") for alias in aliases}

        set_state("stream_connected", True)
        set_state("last_event_type", event_type or None)
        set_state("last_event_channel", channel or input_id or None)
        set_state("last_event_state", event_state or None)

        if channel:
            if match_event(event_type, "vmd", "motiondetection", "motion"):
                set_state(f"motion_{channel}", is_active)
            elif match_event(event_type, "videoloss", "video loss"):
                set_state(f"video_loss_{channel}", is_active)
            elif match_event(event_type, "fielddetection", "field detection", "intrusiondetection", "intrusion"):
                set_state(f"intrusion_{channel}", is_active)
            elif match_event(event_type, "linedetection", "line crossing", "linecrossing", "linecrossingdetection"):
                set_state(f"line_crossing_{channel}", is_active)
            elif match_event(event_type, "tamperdetection", "tamper", "videotamper", "scenechangedetection", "shelteralarm"):
                set_state(f"tamper_{channel}", is_active)

        if match_event(event_type, "diskfull", "disk full"):
            set_state("disk_full", is_active)
        elif match_event(event_type, "diskerror", "disk error"):
            set_state("disk_error", is_active)

        if input_id and match_event(event_type, "alarmin", "alarminput", "alarm in", "io", "ioinput", "externalalarm", "alarm"):
            set_state(f"alarm_input_{input_id}", is_active)

        active_alarm_count = sum(
            1
            for key, value in states.items()
            if key not in {"stream_connected", "last_event_type", "last_event_channel", "last_event_state", "active_alarm_count"}
            and bool(value)
        )
        set_state("active_alarm_count", active_alarm_count)

        if changed:
            current["alarm_states"] = states
            self.async_set_updated_data(current)
        return changed

    async def _alarm_stream_loop(self) -> None:
        path = "/ISAPI/Event/notification/alertStream"
        backoff = 5

        while self._alarm_running:
            try:
                resp = await self._request_raw("GET", path)
                if resp.status not in (200, 201):
                    body = await resp.text()
                    raise UpdateFailed(f"GET {path} failed {resp.status}: {body}")

                current = dict(self.data or {})
                states = dict(current.get("alarm_states") or self._default_alarm_states())
                if not states.get("stream_connected"):
                    states["stream_connected"] = True
                    current["alarm_states"] = states
                    self.async_set_updated_data(current)

                buffer = ""
                async for chunk in resp.content.iter_chunked(1024):
                    if not self._alarm_running:
                        break
                    text = chunk.decode("utf-8", errors="ignore")
                    if not text:
                        continue
                    buffer += text

                    end_tag = "</EventNotificationAlert>"
                    while end_tag in buffer:
                        end_index = buffer.index(end_tag) + len(end_tag)
                        segment = buffer[:end_index]
                        buffer = buffer[end_index:]
                        start_index = segment.find("<EventNotificationAlert")
                        if start_index == -1:
                            continue
                        xml_text = segment[start_index:]
                        try:
                            event = self._parse_alarm_event(xml_text)
                        except Exception as err:
                            _LOGGER.debug("Failed to parse Hikvision alarm event: %s", err)
                            continue
                        self._apply_alarm_event(event)

                resp.release()
            except asyncio.CancelledError:
                raise
            except Exception as err:
                _LOGGER.debug("Hikvision alarm stream disconnected: %s", err)

            if self._alarm_running:
                current = dict(self.data or {})
                states = dict(current.get("alarm_states") or self._default_alarm_states())
                if states.get("stream_connected"):
                    states["stream_connected"] = False
                    current["alarm_states"] = states
                    self.async_set_updated_data(current)
                await asyncio.sleep(backoff)

    def _camera_ptz_profile(self, channel: str | int) -> dict:
        return self._camera_by_id(str(channel)) or {}

    def _validate_proxy_momentary_ptz(self, channel: str | int) -> dict:
        camera = self._camera_ptz_profile(channel)
        if camera.get("ptz_supported") is not True:
            reason = camera.get("ptz_unsupported_reason") or "not_supported"
            raise HomeAssistantError(f"PTZ is not supported by this integration for channel {channel} ({reason}).")
        if camera.get("ptz_control_method") != "proxy":
            method = camera.get("ptz_control_method") or "none"
            raise HomeAssistantError(f"PTZ control method {method} is not implemented for channel {channel}.")
        if camera.get("ptz_proxy_momentary_supported") is not True:
            raise HomeAssistantError(f"Proxy momentary PTZ is not available for channel {channel}.")
        return camera

    async def ptz(self, channel, pan, tilt, duration=500):
        self._validate_proxy_momentary_ptz(channel)
        xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<PTZData version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <pan>{int(pan)}</pan>
    <tilt>{int(tilt)}</tilt>
    <Momentary>
        <duration>{int(duration)}</duration>
    </Momentary>
</PTZData>'''
        await self.request(
            "PUT",
            f"/ISAPI/ContentMgmt/PTZCtrlProxy/channels/{channel}/momentary",
            data=xml,
        )

    async def zoom(self, channel, direction, speed=50, duration=500):
        self._validate_proxy_momentary_ptz(channel)
        signed_zoom = max(-100, min(100, int(speed))) * (1 if int(direction) >= 0 else -1)
        xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<PTZData version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <pan>0</pan>
    <tilt>0</tilt>
    <zoom>{int(signed_zoom)}</zoom>
    <Momentary>
        <duration>{int(duration)}</duration>
    </Momentary>
</PTZData>'''
        await self.request(
            "PUT",
            f"/ISAPI/ContentMgmt/PTZCtrlProxy/channels/{channel}/momentary",
            data=xml,
        )

    async def _drive_lens(self, path: str, tag: str, value: int, duration: int = 500):
        duration_ms = max(50, int(duration or 500))
        value_tag = tag[:-4].lower()
        active_xml = f'<?xml version="1.0" encoding="UTF-8"?><{tag}><{value_tag}>{int(value)}</{value_tag}></{tag}>'
        stop_xml = f'<?xml version="1.0" encoding="UTF-8"?><{tag}><{value_tag}>0</{value_tag}></{tag}>'
        await self.request("PUT", path, data=active_xml)
        await asyncio.sleep(duration_ms / 1000.0)
        await self.request("PUT", path, data=stop_xml)

    async def goto_preset(self, channel, preset):
        await self.request(
            "PUT",
            f"/ISAPI/ContentMgmt/PTZCtrlProxy/channels/{channel}/presets/{preset}/goto",
            data="",
        )

    async def focus(self, channel, direction=1, speed=60, duration=500):
        signed_focus = max(-100, min(100, int(speed))) * (1 if int(direction) >= 0 else -1)
        await self._drive_lens(
            f"/ISAPI/ContentMgmt/InputProxy/channels/{channel}/video/focus",
            "FocusData",
            signed_focus,
            duration,
        )

    async def iris(self, channel, direction=1, speed=60, duration=500):
        signed_iris = max(-100, min(100, int(speed))) * (1 if int(direction) >= 0 else -1)
        await self._drive_lens(
            f"/ISAPI/ContentMgmt/InputProxy/channels/{channel}/video/iris",
            "IrisData",
            signed_iris,
            duration,
        )

    async def return_to_center(self, channel, state: dict | None = None, speed: int = 50, duration: int = 350, step_delay: int = 150):
        state = state or {}
        pan = int(state.get("pan", 0) or 0)
        tilt = int(state.get("tilt", 0) or 0)
        zoom = int(state.get("zoom", 0) or 0)

        step_delay_s = max(0, int(step_delay)) / 1000.0
        duration = max(50, int(duration))
        speed = max(1, min(100, int(speed)))

        async def step(pan_value: int, tilt_value: int):
            await self.ptz(channel, pan_value, tilt_value, duration)
            if step_delay_s:
                await asyncio.sleep(step_delay_s)

        while pan > 0:
            await step(-speed, 0)
            pan -= 1
        while pan < 0:
            await step(speed, 0)
            pan += 1

        while tilt > 0:
            await step(0, -speed)
            tilt -= 1
        while tilt < 0:
            await step(0, speed)
            tilt += 1

        while zoom > 0:
            await self.zoom(channel, -1, speed, duration)
            zoom -= 1
            if step_delay_s:
                await asyncio.sleep(step_delay_s)

        while zoom < 0:
            await self.zoom(channel, 1, speed, duration)
            zoom += 1
            if step_delay_s:
                await asyncio.sleep(step_delay_s)

        return {"zoom_pending": False, "completed": True}

    def get_selected_stream_profile(self, channel: str) -> str:
        return normalize_stream_profile(self._stream_profile_by_camera.get(str(channel), DEFAULT_STREAM_PROFILE))

    def get_stream_profiles(self, channel: str) -> dict[str, dict]:
        return self.data.get("stream_profiles", {}).get(str(channel), {})

    def get_active_stream(self, channel: str) -> dict:
        return self.data.get("streams", {}).get(str(channel), {})

    def set_stream_profile(self, channel: str, profile: str) -> None:
        cam_id = str(channel)
        self._stream_profile_by_camera[cam_id] = normalize_stream_profile(profile)
        streams_for_camera = self.data.get("streams_by_camera", {}).get(cam_id, [])
        active_stream = choose_stream_by_profile(streams_for_camera, self._stream_profile_by_camera[cam_id])
        profiles = build_stream_profile_map(streams_for_camera)

        updated = dict(self.data)
        streams = dict(updated.get("streams", {}))
        streams[cam_id] = active_stream
        updated["streams"] = streams

        stream_profiles = dict(updated.get("stream_profiles", {}))
        stream_profiles[cam_id] = profiles
        updated["stream_profiles"] = stream_profiles

        cameras = []
        for camera in updated.get("cameras", []):
            if str(camera.get("id")) == cam_id:
                revised = dict(camera)
                revised["rtsp_url"] = active_stream.get("rtsp_url")
                revised["rtsp_direct_url"] = active_stream.get("rtsp_direct_url")
                revised["stream_id"] = active_stream.get("stream_id")
                revised["stream_profile"] = self._stream_profile_by_camera[cam_id]
                revised["stream_profile_options"] = sorted(list(profiles.keys()))
                revised["main_stream_id"] = (profiles.get("main") or {}).get("stream_id")
                revised["sub_stream_id"] = (profiles.get("sub") or {}).get("stream_id")
                cameras.append(revised)
            else:
                cameras.append(camera)
        updated["cameras"] = cameras
        self.async_set_updated_data(updated)

    async def snapshot_image(self, channel: str) -> bytes | None:
        stream = self.data.get("streams", {}).get(str(channel), {})
        stream_id = stream.get("stream_id")
        if not stream_id:
            return None

        paths = (
            f"/ISAPI/ContentMgmt/StreamingProxy/channels/{stream_id}/picture",
            f"/ISAPI/Streaming/channels/{stream_id}/picture",
        )
        for path in paths:
            try:
                return await self.request_bytes("GET", path)
            except Exception as err:
                _LOGGER.debug("Snapshot fetch failed for %s via %s: %s", channel, path, err)
        return None
