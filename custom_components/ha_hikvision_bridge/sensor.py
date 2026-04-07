from __future__ import annotations

from datetime import datetime, timezone

from homeassistant.components.sensor import SensorEntity
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .helpers import build_camera_device_info, build_nvr_device_info, get_dvr_serial


def _iso_from_ts(value):
    try:
        ts = float(value or 0.0)
    except (TypeError, ValueError):
        return None
    if ts <= 0:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data[DOMAIN][entry.entry_id]
    dvr_serial = get_dvr_serial(coordinator, entry)
    entities = [
        HikvisionNVRSystemInfoSensor(coordinator, entry, dvr_serial),
        HikvisionNVRStorageInfoSensor(coordinator, entry, dvr_serial),
    ]
    for hdd in coordinator.data.get("storage", {}).get("hdds", []):
        hdd_id = str(hdd.get("id") or len(entities))
        entities.append(HikvisionNVRHDDSensor(coordinator, entry, dvr_serial, hdd_id))
    for cam in coordinator.data.get("cameras", []):
        cam_id = cam["id"]
        entities.extend(
            [
                HikvisionCameraInfoSensor(coordinator, dvr_serial, cam_id),
                HikvisionCameraStreamSensor(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioLevelSensor(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioPeakSensor(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioAnomalySensor(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioClassifierLabelSensor(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioClassifierConfidenceSensor(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioClassifierThresholdSensor(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioLastEventSensor(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioStreamStatusSensor(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioLastGunshotSensor(coordinator, dvr_serial, cam_id),
            ]
        )
    async_add_entities(entities)


class BaseCameraEntity(CoordinatorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator)
        self._dvr_serial = dvr_serial
        self._cam_id = str(cam_id)

    def _cam(self):
        return next((c for c in self.coordinator.data.get("cameras", []) if str(c["id"]) == self._cam_id), {})

    def _stream(self):
        return self.coordinator.get_active_stream(self._cam_id)

    def _stream_profiles(self):
        return self.coordinator.get_stream_profiles(self._cam_id)

    def _audio_state(self):
        return self.coordinator.audio.get_state(self._cam_id) or {}

    def _audio_config(self):
        return self.coordinator.audio.get_config(self._cam_id)

    @property
    def device_info(self):
        return DeviceInfo(**build_camera_device_info(self._dvr_serial, self._cam()))


class BaseCameraAudioSensor(CoordinatorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id, name, key):
        super().__init__(coordinator)
        self._dvr_serial = dvr_serial
        self._cam_id = str(cam_id)
        self._key = key
        self._attr_name = name
        self._attr_has_entity_name = True
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_{key}"

    def _cam(self):
        return next((c for c in self.coordinator.data.get("cameras", []) if str(c["id"]) == self._cam_id), {})

    def _audio_state(self):
        return self.coordinator.audio.get_state(self._cam_id) or {}

    def _audio_config(self):
        return self.coordinator.audio.get_config(self._cam_id)

    @property
    def device_info(self):
        return DeviceInfo(**build_camera_device_info(self._dvr_serial, self._cam()))

    @property
    def native_value(self):
        return self._audio_state().get(self._key)

    @property
    def extra_state_attributes(self):
        state = self._audio_state()
        cfg = self._audio_config()
        return {
            "channel": self._cam_id,
            "enabled": state.get("enabled"),
            "classifier_enabled": state.get("classifier_enabled"),
            "frames_ingested": state.get("frames_ingested"),
            "sample_count": state.get("sample_count"),
            "native_stream_status": state.get("native_stream_status"),
            "native_stream_profile": state.get("native_stream_profile"),
            "native_stream_source": state.get("native_stream_source"),
            "native_stream_audio_codec": state.get("native_stream_audio_codec"),
            "native_stream_last_audio": _iso_from_ts(state.get("native_stream_last_audio_ts")),
            "last_classifier_source": state.get("last_classifier_source"),
            "last_classifier_accepted": state.get("last_classifier_accepted"),
            "classifier_threshold": cfg.get("classifier_threshold"),
            "calibration_profile": state.get("calibration_profile"),
            "calibration_score": state.get("calibration_score"),
        }


class BaseNVREntity(CoordinatorEntity):
    def __init__(self, coordinator, entry, dvr_serial):
        super().__init__(coordinator)
        self._entry = entry
        self._dvr_serial = dvr_serial
        self._attr_has_entity_name = True

    @property
    def device_info(self):
        return DeviceInfo(**build_nvr_device_info(self._dvr_serial, self._entry, self.coordinator.data.get("device_xml")))

    def _nvr(self):
        return self.coordinator.data.get("nvr", {})

    def _storage(self):
        return self.coordinator.data.get("storage", {})


class HikvisionCameraInfoSensor(BaseCameraEntity, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_has_entity_name = True
        self._attr_name = "Info"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_info"

    @property
    def native_value(self):
        cam = self._cam()
        return cam.get("name") or f"Camera {self._cam_id}"

    @property
    def extra_state_attributes(self):
        cam = self._cam()
        return {
            "channel": cam.get("id"),
            "name": cam.get("name"),
            "model": cam.get("model"),
            "manufacturer": cam.get("manufacturer", "Hikvision"),
            "serial_number": cam.get("serial_number"),
            "firmware_version": cam.get("firmware_version"),
            "ip_address": cam.get("ip_address"),
            "manage_port": cam.get("manage_port"),
            "online": cam.get("online"),
            "card_visible": cam.get("card_visible"),
            "ptz_supported": cam.get("ptz_supported"),
            "ptz_proxy_supported": cam.get("ptz_proxy_supported"),
            "ptz_direct_supported": cam.get("ptz_direct_supported"),
            "ptz_control_method": cam.get("ptz_control_method"),
            "ptz_capability_mode": cam.get("ptz_capability_mode"),
            "ptz_implementation": cam.get("ptz_implementation"),
            "ptz_proxy_ctrl_mode": cam.get("ptz_proxy_ctrl_mode"),
            "ptz_momentary_supported": cam.get("ptz_momentary_supported"),
            "ptz_continuous_supported": cam.get("ptz_continuous_supported"),
            "ptz_proxy_momentary_supported": cam.get("ptz_proxy_momentary_supported"),
            "ptz_proxy_continuous_supported": cam.get("ptz_proxy_continuous_supported"),
            "ptz_direct_momentary_supported": cam.get("ptz_direct_momentary_supported"),
            "ptz_direct_continuous_supported": cam.get("ptz_direct_continuous_supported"),
            "ptz_unsupported_reason": cam.get("ptz_unsupported_reason"),
        }


class HikvisionCameraStreamSensor(BaseCameraEntity, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_has_entity_name = True
        self._attr_name = "Stream"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_stream"
        self._attr_icon = "mdi:cctv"

    @property
    def native_value(self):
        stream = self._stream()
        return stream.get("resolved_profile") or stream.get("profile") or stream.get("requested_profile") or "unknown"

    @property
    def extra_state_attributes(self):
        stream = self._stream()
        audio_state = self._audio_state()
        return {
            "channel": self._cam_id,
            "stream_id": stream.get("id"),
            "stream_name": stream.get("stream_name") or stream.get("name"),
            "stream_profile": stream.get("resolved_profile") or stream.get("profile") or stream.get("requested_profile"),
            "transport": stream.get("transport"),
            "video_input_channel_id": stream.get("video_input_channel_id"),
            "bitrate_mode": stream.get("bitrate_mode"),
            "bitrate": stream.get("bitrate") or stream.get("constant_bitrate"),
            "constant_bitrate": stream.get("constant_bitrate"),
            "max_frame_rate": stream.get("max_frame_rate"),
            "video_codec": stream.get("video_codec"),
            "width": stream.get("width"),
            "height": stream.get("height"),
            "audio_codec": stream.get("audio_codec"),
            "rtsp_url": stream.get("rtsp_url"),
            "rtsp_direct_url": stream.get("rtsp_direct_url"),
            "native_stream_status": audio_state.get("native_stream_status"),
            "native_stream_profile": audio_state.get("native_stream_profile"),
            "native_stream_source": audio_state.get("native_stream_source"),
        }


class HikvisionNVRSystemInfoSensor(BaseNVREntity, SensorEntity):
    def __init__(self, coordinator, entry, dvr_serial):
        super().__init__(coordinator, entry, dvr_serial)
        self._attr_name = "NVR System Info"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_system_info"
        self._attr_icon = "mdi:server"

    @property
    def native_value(self):
        return self._nvr().get("name") or f"Hikvision NVR ({self._entry.data.get('host')})"

    @property
    def extra_state_attributes(self):
        nvr = self._nvr()
        storage = self._storage()
        return {
            "device_name": nvr.get("name"),
            "nvr_name": nvr.get("name"),
            "model": nvr.get("model"),
            "manufacturer": nvr.get("manufacturer", "Hikvision"),
            "serial_number": nvr.get("serial_number"),
            "firmware_version": nvr.get("firmware_version"),
            "storage_info_supported": storage.get("storage_info_supported", False),
            "storage_hdd_caps_supported": storage.get("storage_hdd_caps_supported", False),
            "storage_extra_caps_supported": storage.get("storage_extra_caps_supported", False),
            "storage_present": storage.get("storage_present", False),
            "playback_supported": storage.get("playback_supported", False),
        }


class HikvisionNVRStorageInfoSensor(BaseNVREntity, SensorEntity):
    def __init__(self, coordinator, entry, dvr_serial):
        super().__init__(coordinator, entry, dvr_serial)
        self._attr_name = "NVR Storage Info"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_storage_info"
        self._attr_icon = "mdi:harddisk"

    @property
    def native_value(self):
        storage = self._storage()
        disk_count = int(storage.get("disk_count", 0) or 0)
        return f"{disk_count} disk{'s' if disk_count != 1 else ''}"

    @property
    def extra_state_attributes(self):
        storage = self._storage()
        return {
            "disk_mode": storage.get("disk_mode"),
            "work_mode": storage.get("work_mode"),
            "disk_count": storage.get("disk_count", 0),
            "healthy_disks": storage.get("healthy_disks", 0),
            "failed_disks": storage.get("failed_disks", 0),
            "storage_total": storage.get("total_capacity_mb"),
            "storage_used": storage.get("used_capacity_mb"),
            "storage_free": storage.get("free_capacity_mb"),
            "total_capacity_mb": storage.get("total_capacity_mb"),
            "used_capacity_mb": storage.get("used_capacity_mb"),
            "free_capacity_mb": storage.get("free_capacity_mb"),
            "storage_health": "ok" if int(storage.get("failed_disks", 0) or 0) == 0 else "warning",
            "hdds": storage.get("hdds", []),
            "storage_info_supported": storage.get("storage_info_supported", False),
            "storage_hdd_caps_supported": storage.get("storage_hdd_caps_supported", False),
            "storage_extra_caps_supported": storage.get("storage_extra_caps_supported", False),
            "storage_present": storage.get("storage_present", False),
            "playback_supported": storage.get("playback_supported", False),
        }


class HikvisionNVRHDDSensor(BaseNVREntity, SensorEntity):
    def __init__(self, coordinator, entry, dvr_serial, hdd_id):
        super().__init__(coordinator, entry, dvr_serial)
        self._hdd_id = str(hdd_id)
        self._attr_name = f"HDD {self._hdd_id}"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_hdd_{self._hdd_id}"
        self._attr_icon = "mdi:harddisk"

    def _disk(self):
        for disk in self._storage().get("hdds", []):
            if str(disk.get("id")) == self._hdd_id:
                return disk
        return {}

    @property
    def native_value(self):
        return self._disk().get("status", "unknown")

    @property
    def extra_state_attributes(self):
        disk = self._disk()
        return {
            "disk_id": disk.get("id"),
            "hdd_name": disk.get("name"),
            "hdd_type": disk.get("type"),
            "hdd_path": disk.get("path"),
            "status": disk.get("status"),
            "property": disk.get("property"),
            "manufacturer": disk.get("manufacturer"),
            "capacity_mb": disk.get("capacity_mb"),
            "free_space_mb": disk.get("free_space_mb"),
            "used_space_mb": disk.get("used_space_mb"),
        }


class HikvisionCameraAudioLevelSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Level", "level")
        self._attr_native_unit_of_measurement = "%"

    @property
    def native_value(self):
        return round(float(self._audio_state().get("level") or 0.0) * 100.0, 2)


class HikvisionCameraAudioPeakSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Peak", "peak")
        self._attr_native_unit_of_measurement = "%"

    @property
    def native_value(self):
        return round(float(self._audio_state().get("peak") or 0.0) * 100.0, 2)


class HikvisionCameraAudioAnomalySensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Anomaly Score", "anomaly_score")

    @property
    def native_value(self):
        return round(float(self._audio_state().get("anomaly_score") or 0.0), 3)


class HikvisionCameraAudioClassifierLabelSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Classifier Label", "classifier_label")

    @property
    def extra_state_attributes(self):
        attrs = dict(super().extra_state_attributes)
        attrs["classifier_metrics"] = self._audio_state().get("classifier_metrics") or {}
        return attrs


class HikvisionCameraAudioLastEventSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Last Event", "last_event")


class HikvisionCameraAudioClassifierConfidenceSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Classifier Confidence", "classifier_confidence")

    @property
    def native_value(self):
        return round(float(self._audio_state().get("classifier_confidence") or 0.0), 3)


class HikvisionCameraAudioClassifierThresholdSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Classifier Threshold", "classifier_threshold")

    @property
    def native_value(self):
        return round(float(self._audio_config().get("classifier_threshold") or 0.0), 3)


class HikvisionCameraAudioStreamStatusSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Stream Status", "native_stream_status")
        self._attr_icon = "mdi:waveform"

    @property
    def extra_state_attributes(self):
        attrs = dict(super().extra_state_attributes)
        state = self._audio_state()
        attrs.update(
            {
                "native_stream_error": state.get("native_stream_error"),
                "native_stream_started_at": _iso_from_ts(state.get("native_stream_started_ts")),
                "native_stream_last_audio": _iso_from_ts(state.get("native_stream_last_audio_ts")),
                "native_stream_frames": state.get("native_stream_frames"),
                "native_stream_bytes": state.get("native_stream_bytes"),
                "native_stream_restart_count": state.get("native_stream_restart_count"),
                "ffmpeg_path": state.get("native_stream_ffmpeg_path"),
            }
        )
        return attrs


class HikvisionCameraAudioLastGunshotSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Last Gunshot", "last_gunshot_ts")
        self._attr_icon = "mdi:gunshot"

    @property
    def native_value(self):
        return _iso_from_ts(self._audio_state().get("last_gunshot_ts"))
