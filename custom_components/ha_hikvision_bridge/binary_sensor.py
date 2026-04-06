from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .helpers import build_camera_device_info, build_nvr_device_info, get_dvr_serial


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data[DOMAIN][entry.entry_id]
    dvr_serial = get_dvr_serial(coordinator, entry)
    entities = [
        HikvisionNVROnlineBinary(coordinator, entry, dvr_serial),
        HikvisionNVRAlarmStreamBinary(coordinator, entry, dvr_serial),
        HikvisionNVRDiskFullBinary(coordinator, entry, dvr_serial),
        HikvisionNVRDiskErrorBinary(coordinator, entry, dvr_serial),
    ]
    for cam in coordinator.data.get("cameras", []):
        entities.append(HikvisionCameraOnlineBinary(coordinator, dvr_serial, cam["id"]))
        entities.append(HikvisionCameraPTZBinary(coordinator, dvr_serial, cam["id"]))
        entities.append(HikvisionCameraMotionBinary(coordinator, dvr_serial, cam["id"]))
        entities.append(HikvisionCameraVideoLossBinary(coordinator, dvr_serial, cam["id"]))
        entities.append(HikvisionCameraIntrusionBinary(coordinator, dvr_serial, cam["id"]))
        entities.append(HikvisionCameraLineCrossingBinary(coordinator, dvr_serial, cam["id"]))
        entities.append(HikvisionCameraTamperBinary(coordinator, dvr_serial, cam["id"]))
    for alarm_input in coordinator.data.get("alarm_inputs", []):
        entities.append(HikvisionNVRAlarmInputBinary(coordinator, entry, dvr_serial, alarm_input["id"]))
    async_add_entities(entities)


class BaseCameraBinary(CoordinatorEntity, BinarySensorEntity):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator)
        self._dvr_serial = dvr_serial
        self._cam_id = str(cam_id)
        self._attr_has_entity_name = True

    def _cam(self):
        return next((c for c in self.coordinator.data.get("cameras", []) if str(c["id"]) == self._cam_id), {})

    def _alarm_states(self):
        return self.coordinator.data.get("alarm_states", {})

    @property
    def device_info(self):
        return DeviceInfo(**build_camera_device_info(self._dvr_serial, self._cam()))

    @property
    def extra_state_attributes(self):
        cam = self._cam()
        return {
            "channel": cam.get("id"),
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

class BaseCameraAudioBinary(BaseCameraBinary):
    def __init__(self, coordinator, dvr_serial, cam_id, name, key):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._audio_key = key
        self._attr_name = name
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_{key}"

    def _audio_state(self):
        return self.coordinator.audio.get_state(self._cam_id) or {}

    @property
    def is_on(self):
        return bool(self._audio_state().get(self._audio_key, False))
        
class HikvisionCameraOnlineBinary(BaseCameraBinary):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Online"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_online"
        self._attr_device_class = "connectivity"

    @property
    def is_on(self):
        return bool(self._cam().get("online"))


class HikvisionCameraPTZBinary(BaseCameraBinary):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "PTZ Supported"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_ptz_supported"

    @property
    def is_on(self):
        return bool(self._cam().get("ptz_supported"))



class HikvisionCameraMotionBinary(BaseCameraBinary):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Motion Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_motion_alarm"
        self._attr_device_class = "motion"

    @property
    def is_on(self):
        return bool(self._alarm_states().get(f"motion_{self._cam_id}", False))

    @property
    def extra_state_attributes(self):
        attrs = dict(super().extra_state_attributes)
        attrs["alarm_key"] = f"motion_{self._cam_id}"
        return attrs


class HikvisionCameraVideoLossBinary(BaseCameraBinary):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Video Loss Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_video_loss_alarm"
        self._attr_device_class = "problem"

    @property
    def is_on(self):
        return bool(self._alarm_states().get(f"video_loss_{self._cam_id}", False))

    @property
    def extra_state_attributes(self):
        attrs = dict(super().extra_state_attributes)
        attrs["alarm_key"] = f"video_loss_{self._cam_id}"
        return attrs




class HikvisionCameraIntrusionBinary(BaseCameraBinary):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Intrusion Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_intrusion_alarm"
        self._attr_device_class = "problem"

    @property
    def is_on(self):
        return bool(self._alarm_states().get(f"intrusion_{self._cam_id}", False))

    @property
    def extra_state_attributes(self):
        attrs = dict(super().extra_state_attributes)
        attrs["alarm_key"] = f"intrusion_{self._cam_id}"
        return attrs


class HikvisionCameraLineCrossingBinary(BaseCameraBinary):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Line Crossing Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_line_crossing_alarm"
        self._attr_device_class = "problem"

    @property
    def is_on(self):
        return bool(self._alarm_states().get(f"line_crossing_{self._cam_id}", False))

    @property
    def extra_state_attributes(self):
        attrs = dict(super().extra_state_attributes)
        attrs["alarm_key"] = f"line_crossing_{self._cam_id}"
        return attrs


class HikvisionCameraTamperBinary(BaseCameraBinary):
    def __init__(self, coordinator, dvr_serial, cam_id):
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Tamper Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_tamper_alarm"
        self._attr_device_class = "problem"

    @property
    def is_on(self):
        return bool(self._alarm_states().get(f"tamper_{self._cam_id}", False))

    @property
    def extra_state_attributes(self):
        attrs = dict(super().extra_state_attributes)
        attrs["alarm_key"] = f"tamper_{self._cam_id}"
        return attrs

class BaseNVRBinary(CoordinatorEntity, BinarySensorEntity):
    def __init__(self, coordinator, entry, dvr_serial):
        super().__init__(coordinator)
        self._entry = entry
        self._dvr_serial = dvr_serial
        self._attr_has_entity_name = True

    @property
    def device_info(self):
        return DeviceInfo(**build_nvr_device_info(self._dvr_serial, self._entry, self.coordinator.data.get("device_xml")))

    def _alarm_states(self):
        return self.coordinator.data.get("alarm_states", {})


class HikvisionNVROnlineBinary(BaseNVRBinary):
    def __init__(self, coordinator, entry, dvr_serial):
        super().__init__(coordinator, entry, dvr_serial)
        self._attr_name = "NVR Online"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_online"
        self._attr_device_class = "connectivity"

    @property
    def is_on(self):
        return bool(self.coordinator.last_update_success and self.coordinator.data.get("nvr", {}).get("online", True))

    @property
    def extra_state_attributes(self):
        storage = self.coordinator.data.get("storage", {})
        return {
            "disk_count": storage.get("disk_count", 0),
            "healthy_disks": storage.get("healthy_disks", 0),
            "failed_disks": storage.get("failed_disks", 0),
        }


class HikvisionNVRAlarmStreamBinary(BaseNVRBinary):
    def __init__(self, coordinator, entry, dvr_serial):
        super().__init__(coordinator, entry, dvr_serial)
        self._attr_name = "Alarm Stream Connected"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_alarm_stream_connected"
        self._attr_device_class = "connectivity"

    @property
    def is_on(self):
        return bool(self._alarm_states().get("stream_connected", False))

    @property
    def extra_state_attributes(self):
        return {
            "last_event_type": self._alarm_states().get("last_event_type"),
            "last_event_channel": self._alarm_states().get("last_event_channel"),
            "last_event_state": self._alarm_states().get("last_event_state"),
        }


class HikvisionNVRDiskFullBinary(BaseNVRBinary):
    def __init__(self, coordinator, entry, dvr_serial):
        super().__init__(coordinator, entry, dvr_serial)
        self._attr_name = "Disk Full Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_disk_full_alarm"
        self._attr_device_class = "problem"

    @property
    def is_on(self):
        return bool(self._alarm_states().get("disk_full", False))


class HikvisionNVRDiskErrorBinary(BaseNVRBinary):
    def __init__(self, coordinator, entry, dvr_serial):
        super().__init__(coordinator, entry, dvr_serial)
        self._attr_name = "Disk Error Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_disk_error_alarm"
        self._attr_device_class = "problem"

    @property
    def is_on(self):
        return bool(self._alarm_states().get("disk_error", False))


class HikvisionNVRAlarmInputBinary(BaseNVRBinary):
    def __init__(self, coordinator, entry, dvr_serial, input_id):
        super().__init__(coordinator, entry, dvr_serial)
        self._input_id = str(input_id)
        self._attr_name = f"Alarm Input {self._input_id}"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_alarm_input_{self._input_id}"
        self._attr_device_class = "opening"

    def _input(self):
        for alarm_input in self.coordinator.data.get("alarm_inputs", []):
            if str(alarm_input.get("id")) == self._input_id:
                return alarm_input
        return {}

    @property
    def is_on(self):
        return bool(self._alarm_states().get(f"alarm_input_{self._input_id}", self._input().get("active", False)))

    @property
    def extra_state_attributes(self):
        alarm_input = self._input()
        return {
            "input_id": self._input_id,
            "name": alarm_input.get("name") or f"Alarm Input {self._input_id}",
            "status": alarm_input.get("status"),
            "triggering": alarm_input.get("triggering"),
            "alarm_key": f"alarm_input_{self._input_id}",
        }
