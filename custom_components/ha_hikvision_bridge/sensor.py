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
        entities.append(HikvisionCameraInfoSensor(coordinator, dvr_serial, cam["id"]))
        entities.append(HikvisionCameraStreamSensor(coordinator, dvr_serial, cam["id"]))
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
            "src_input_port": cam.get("src_input_port"),
            "username": cam.get("username"),
            "proxy_protocol": cam.get("proxy_protocol"),
            "addressing_format": cam.get("addressing_format"),
            "connection_mode": cam.get("connection_mode"),
            "stream_type": cam.get("stream_type"),
            "model": cam.get("model"),
            "serial_number": cam.get("serial_number"),
            "firmware_version": cam.get("firmware_version"),
            "device_id": cam.get("device_id"),
            "dev_index": cam.get("dev_index"),
            "certificate_validation_enabled": cam.get("certificate_validation_enabled"),
            "default_admin_port_enabled": cam.get("default_admin_port_enabled"),
            "timing_enabled": cam.get("timing_enabled"),
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
            "ptz_enabled": cam.get("ptz_enabled"),
            "ptz_online": cam.get("ptz_online"),
            "online": cam.get("online"),
            "card_visible": cam.get("card_visible"),
            "rtsp_url": cam.get("rtsp_url"),
            "rtsp_direct_url": cam.get("rtsp_direct_url"),
            "stream_id": cam.get("stream_id"),
            "stream_profile": cam.get("stream_profile"),
            "main_stream_id": cam.get("main_stream_id"),
            "sub_stream_id": cam.get("sub_stream_id"),
        }


class HikvisionCameraStreamSensor(BaseCameraEntity, SensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_has_entity_name = True
        self._attr_name = "Stream"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_stream"

    @property
    def native_value(self):
        stream = self._stream()
        codec = stream.get("video_codec") or "Unknown"
        width = stream.get("width")
        height = stream.get("height")
        profile = self.coordinator.get_selected_stream_profile(self._cam_id)
        label = "Main-stream" if profile == "main" else "Sub-stream"
        if width and height:
            return f"{label} · {codec} {width}x{height}"
        return f"{label} · {codec}"

    @property
    def extra_state_attributes(self):
        stream = self._stream()
        profiles = self._stream_profiles()
        profile = self.coordinator.get_selected_stream_profile(self._cam_id)
        return {
            "channel": self._cam_id,
            "stream_profile": profile,
            "stream_profile_label": "Main-stream" if profile == "main" else "Sub-stream",
            "available_stream_profiles": sorted(list(profiles.keys())),
            "main_stream_id": (profiles.get("main") or {}).get("stream_id"),
            "sub_stream_id": (profiles.get("sub") or {}).get("stream_id"),
            "stream_id": stream.get("stream_id"),
            "stream_name": stream.get("stream_name"),
            "enabled": stream.get("enabled"),
            "transport": stream.get("transport"),
            "video_enabled": stream.get("video_enabled"),
            "video_input_channel_id": stream.get("video_input_channel_id"),
            "video_codec": stream.get("video_codec"),
            "width": stream.get("width"),
            "height": stream.get("height"),
            "bitrate_mode": stream.get("bitrate_mode"),
            "constant_bitrate": stream.get("constant_bitrate"),
            "fixed_quality": stream.get("fixed_quality"),
            "max_frame_rate_raw": stream.get("max_frame_rate_raw"),
            "max_frame_rate": stream.get("max_frame_rate"),
            "gov_length": stream.get("gov_length"),
            "snapshot_image_type": stream.get("snapshot_image_type"),
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
            "firmware_released_date": nvr.get("firmware_released_date"),
            "mac_address": nvr.get("mac_address"),
            "device_id": nvr.get("device_id"),
            "device_description": nvr.get("device_description"),
            "boot_time": nvr.get("boot_time"),
            "online": nvr.get("online", True),
            "disk_mode": storage.get("disk_mode"),
            "work_mode": storage.get("work_mode"),
            "disk_count": storage.get("disk_count", 0),
            "healthy_disks": storage.get("healthy_disks", 0),
            "failed_disks": storage.get("failed_disks", 0),
            "active_alarm_count": self.coordinator.data.get("alarm_states", {}).get("active_alarm_count", 0),
            "alarm_stream_connected": self.coordinator.data.get("alarm_states", {}).get("stream_connected", False),
            "last_event_type": self.coordinator.data.get("alarm_states", {}).get("last_event_type"),
            "last_event_channel": self.coordinator.data.get("alarm_states", {}).get("last_event_channel"),
            "last_event_state": self.coordinator.data.get("alarm_states", {}).get("last_event_state"),
            "active_alarm_inputs": [key.replace("alarm_input_", "") for key, value in self.coordinator.data.get("alarm_states", {}).items() if key.startswith("alarm_input_") and value],
            "supports_isapi": nvr.get("supports_isapi", True),
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
