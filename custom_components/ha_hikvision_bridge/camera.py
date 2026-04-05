from __future__ import annotations

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    DEFAULT_STREAM_MODE,
    DOMAIN,
    STREAM_MODE_RTSP,
    STREAM_MODE_RTSP_DIRECT,
    STREAM_MODE_SNAPSHOT,
    STREAM_MODE_WEBRTC,
    STREAM_MODE_WEBRTC_DIRECT,
)
from .helpers import build_camera_device_info, get_dvr_serial


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data[DOMAIN][entry.entry_id]
    dvr_serial = get_dvr_serial(coordinator, entry)
    entities = [
        HikvisionCameraEntity(coordinator, dvr_serial, cam["id"])
        for cam in coordinator.data.get("cameras", [])
    ]
    async_add_entities(entities)


class HikvisionCameraEntity(CoordinatorEntity, Camera):
    _attr_supported_features = CameraEntityFeature.STREAM
    use_stream_for_stills = True

    def __init__(self, coordinator, dvr_serial, cam_id):
        CoordinatorEntity.__init__(self, coordinator)
        Camera.__init__(self)
        self._dvr_serial = dvr_serial
        self._cam_id = str(cam_id)
        self._attr_has_entity_name = True
        self._attr_name = None
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{self._cam_id}"
        self._stream_mode = DEFAULT_STREAM_MODE
        self._playback_uri = None
        self._playback_active = False
        self._playback_requested_time = None
        self._playback_error = None
        self._playback_clip_start_time = None
        self._playback_clip_end_time = None

    def _cam(self):
        return next(
            (
                c
                for c in self.coordinator.data.get("cameras", [])
                if str(c["id"]) == self._cam_id
            ),
            {},
        )

    def _stream(self):
        return self.coordinator.get_active_stream(self._cam_id)

    def _stream_profiles(self):
        return self.coordinator.get_stream_profiles(self._cam_id)

    @property
    def brand(self):
        return "Hikvision"

    @property
    def model(self):
        return self._cam().get("model")

    @property
    def available(self):
        return bool(self._cam().get("online", True))

    @property
    def is_streaming(self):
        return self.available and bool(self._stream().get("rtsp_url"))

    @property
    def device_info(self):
        return DeviceInfo(**build_camera_device_info(self._dvr_serial, self._cam()))

    @property
    def extra_state_attributes(self):
        cam = self._cam()
        stream = self._stream()
        profiles = self._stream_profiles()
        rtsp_url = stream.get("rtsp_url") or cam.get("rtsp_url")
        direct_rtsp_url = stream.get("rtsp_direct_url") or cam.get("rtsp_direct_url")
        active_video_method = (
            "Snapshot"
            if self._stream_mode == STREAM_MODE_SNAPSHOT
            else "RTSP Direct"
            if self._stream_mode == STREAM_MODE_RTSP_DIRECT
            else "RTSP"
            if self._stream_mode == STREAM_MODE_RTSP
            else "WebRTC Direct"
            if self._stream_mode == STREAM_MODE_WEBRTC_DIRECT
            else "WebRTC"
        )
        return {
            "channel": self._cam_id,
            "stream_id": stream.get("stream_id"),
            "stream_name": stream.get("stream_name"),
            "stream_profile": self.coordinator.get_selected_stream_profile(self._cam_id),
            "stream_profile_label": "Main-stream" if self.coordinator.get_selected_stream_profile(self._cam_id) == "main" else "Sub-stream",
            "available_stream_profiles": sorted(list(profiles.keys())),
            "main_stream_id": (profiles.get("main") or {}).get("stream_id"),
            "sub_stream_id": (profiles.get("sub") or {}).get("stream_id"),
            "ptz_supported": cam.get("ptz_supported"),
            "ptz_proxy_supported": cam.get("ptz_proxy_supported"),
            "ptz_direct_supported": cam.get("ptz_direct_supported"),
            "ptz_control_method": cam.get("ptz_control_method"),
            "rtsp_url": rtsp_url,
            "rtsp_direct_url": direct_rtsp_url,
            "webrtc_url": direct_rtsp_url or rtsp_url,
            "card_visible": cam.get("card_visible"),
            "online": cam.get("online"),
            "stream_mode": self._stream_mode,
            "video_method": active_video_method,
            "stream_transport": stream.get("transport"),
            "stream_video_codec": stream.get("video_codec"),
            "stream_width": stream.get("width"),
            "stream_height": stream.get("height"),
            "stream_bitrate_mode": stream.get("bitrate_mode"),
            "stream_bitrate": stream.get("constant_bitrate"),
            "stream_max_frame_rate": stream.get("max_frame_rate"),
            "stream_audio_codec": stream.get("audio_codec"),
            "playback_active": self._playback_active,
            "playback_uri": self._playback_uri,
            "playback_requested_time": self._playback_requested_time,
            "playback_error": self._playback_error,
            "playback_clip_start_time": self._playback_clip_start_time,
            "playback_clip_end_time": self._playback_clip_end_time,
            "playback_debug": self.coordinator.get_playback_debug(self._cam_id),
            "playback_state_label": "playback" if self._playback_active and self._playback_uri else "live",
            "playback_supported": cam.get("playback_supported", False),
            "storage_present": cam.get("storage_present", False),
            "storage_info_supported": cam.get("storage_info_supported", False),
            "storage_hdd_caps_supported": cam.get("storage_hdd_caps_supported", False),
        }

    async def stream_source(self):
        stream = self._stream()
        cam = self._cam()
        rtsp_url = stream.get("rtsp_url") or cam.get("rtsp_url")
        direct_rtsp_url = stream.get("rtsp_direct_url") or cam.get("rtsp_direct_url")
        if self._playback_active and self._playback_uri:
            return self._playback_uri
        if self._stream_mode == STREAM_MODE_SNAPSHOT:
            return None
        if self._stream_mode in (STREAM_MODE_RTSP_DIRECT, STREAM_MODE_WEBRTC_DIRECT):
            return direct_rtsp_url or rtsp_url
        return rtsp_url or direct_rtsp_url

    async def async_camera_image(self, width=None, height=None):
        try:
            return await self.coordinator.snapshot_image(self._cam_id)
        except Exception:
            session = async_get_clientsession(self.hass)
            url = self._cam().get("snapshot") or self._cam().get("snapshot_url")
            if not url:
                return None
            async with session.get(url) as resp:
                if resp.status == 200:
                    return await resp.read()
            return None

    async def async_added_to_hass(self):
        await super().async_added_to_hass()
        if not hasattr(self.coordinator, "entities"):
            self.coordinator.entities = {}
        self.coordinator.entities[self.entity_id] = self

    async def async_will_remove_from_hass(self):
        await super().async_will_remove_from_hass()
        entities = getattr(self.coordinator, "entities", {})
        entities.pop(self.entity_id, None)

    def set_stream_mode(self, mode):
        if mode in (STREAM_MODE_WEBRTC, STREAM_MODE_WEBRTC_DIRECT, STREAM_MODE_RTSP, STREAM_MODE_RTSP_DIRECT, STREAM_MODE_SNAPSHOT):
            self._stream_mode = mode
            self.async_write_ha_state()

    def set_stream_profile(self, profile):
        self.coordinator.set_stream_profile(self._cam_id, profile)
        self.async_write_ha_state()

    def start_playback(self, playback_uri, requested_time=None, error=None, clip_start_time=None, clip_end_time=None):
        self._playback_uri = playback_uri
        self._playback_requested_time = requested_time
        self._playback_error = error
        self._playback_clip_start_time = clip_start_time
        self._playback_clip_end_time = clip_end_time
        self._playback_active = bool(playback_uri)
        self.async_write_ha_state()

    def stop_playback(self):
        self._playback_uri = None
        self._playback_active = False
        self._playback_requested_time = None
        self._playback_error = None
        self._playback_clip_start_time = None
        self._playback_clip_end_time = None
        self.async_write_ha_state()
