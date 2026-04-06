from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .helpers import build_camera_device_info, build_nvr_device_info, get_dvr_serial


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
        entities.append(HikvisionCameraInfoSensor(coordinator, dvr_serial, cam_id))
        entities.append(HikvisionCameraStreamSensor(coordinator, dvr_serial, cam_id))
        entities.append(HikvisionCameraAudioLevelSensor(coordinator, dvr_serial, cam_id))
        entities.append(HikvisionCameraAudioPeakSensor(coordinator, dvr_serial, cam_id))
        entities.append(HikvisionCameraAudioAnomalySensor(coordinator, dvr_serial, cam_id))
        entities.append(HikvisionCameraAudioClassifierLabelSensor(coordinator, dvr_serial, cam_id))
        entities.append(HikvisionCameraAudioLastEventSensor(coordinator, dvr_serial, cam_id))
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

    @property
    def device_info(self):
        from homeassistant.helpers.device_registry import DeviceInfo
        from .helpers import build_camera_device_info
        return DeviceInfo(**build_camera_device_info(self._dvr_serial, self._cam()))

    @property
    def native_value(self):
        state = self.coordinator.audio.get_state(self._cam_id) or {}
        return state.get(self._key)


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
        return stream.get("stream_profile") or "unknown"

    @property
    def extra_state_attributes(self):
        stream = self._stream()
        return {
            "stream_id": stream.get("id"),
            "stream_name": stream.get("name"),
            "stream_profile": stream.get("stream_profile"),
            "transport": stream.get("transport"),
            "video_input_channel_id": stream.get("video_input_channel_id"),
            "audio_enabled": stream.get("audio_enabled"),
            "audio_input_channel_id": stream.get("audio_input_channel_id"),
            "audio_codec": stream.get("audio_codec"),
            "rtsp_url": stream.get("rtsp_url"),
            "rtsp_direct_url": stream.get("rtsp_direct_url"),
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
        state = self.coordinator.audio.get_state(self._cam_id) or {}
        return round(float(state.get("level") or 0.0) * 100.0, 2)


class HikvisionCameraAudioPeakSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Peak", "peak")
        self._attr_native_unit_of_measurement = "%"

    @property
    def native_value(self):
        state = self.coordinator.audio.get_state(self._cam_id) or {}
        return round(float(state.get("peak") or 0.0) * 100.0, 2)


class HikvisionCameraAudioAnomalySensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Anomaly Score", "anomaly_score")

    @property
    def native_value(self):
        state = self.coordinator.audio.get_state(self._cam_id) or {}
        return round(float(state.get("anomaly_score") or 0.0), 3)


class HikvisionCameraAudioClassifierLabelSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Classifier Label", "classifier_label")


class HikvisionCameraAudioLastEventSensor(BaseCameraAudioSensor, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Last Event", "last_event")
