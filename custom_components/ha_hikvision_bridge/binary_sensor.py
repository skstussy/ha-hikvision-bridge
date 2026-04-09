from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .helpers import build_camera_device_info, build_nvr_device_info, get_dvr_serial


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]
    dvr_serial = get_dvr_serial(coordinator, entry)

    entities: list[BinarySensorEntity] = [
        HikvisionNVROnlineBinary(coordinator, entry, dvr_serial),
        HikvisionNVRAlarmStreamBinary(coordinator, entry, dvr_serial),
        HikvisionNVRDiskFullBinary(coordinator, entry, dvr_serial),
        HikvisionNVRDiskErrorBinary(coordinator, entry, dvr_serial),
    ]

    for cam in coordinator.data.get("cameras", []):
        cam_id = cam["id"]
        entities.extend(
            [
                HikvisionCameraOnlineBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraPTZBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraMotionBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraVideoLossBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraIntrusionBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraLineCrossingBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraTamperBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioEnabledBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioClassifierEnabledBinary(
                    coordinator, dvr_serial, cam_id
                ),
                HikvisionCameraAudioAbnormalBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioSilenceBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioClippingBinary(coordinator, dvr_serial, cam_id),
                HikvisionCameraAudioVoiceDetectedBinary(
                    coordinator, dvr_serial, cam_id
                ),
                HikvisionCameraAudioGunshotDetectedBinary(
                    coordinator, dvr_serial, cam_id
                ),
                HikvisionCameraAudioImpactDetectedBinary(
                    coordinator, dvr_serial, cam_id
                ),
                HikvisionCameraAudioScreamDetectedBinary(
                    coordinator, dvr_serial, cam_id
                ),
                HikvisionCameraAudioShoutDetectedBinary(coordinator, dvr_serial, cam_id),
            ]
        )

    for alarm_input in coordinator.data.get("alarm_inputs", []):
        entities.append(
            HikvisionNVRAlarmInputBinary(
                coordinator, entry, dvr_serial, alarm_input["id"]
            )
        )

    async_add_entities(entities)


class BaseCameraBinary(CoordinatorEntity, BinarySensorEntity):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator)
        self._dvr_serial = dvr_serial
        self._cam_id = str(cam_id)
        self._attr_has_entity_name = True

    def _cam(self) -> dict[str, Any]:
        return next(
            (
                camera
                for camera in self.coordinator.data.get("cameras", [])
                if str(camera.get("id")) == self._cam_id
            ),
            {},
        )

    def _alarm_states(self) -> dict[str, Any]:
        return self.coordinator.data.get("alarm_states", {})

    def _audio_state(self) -> dict[str, Any]:
        return self.coordinator.audio.get_state(self._cam_id) or {}

    def _audio_config(self) -> dict[str, Any]:
        config = getattr(self.coordinator.audio, "_config", {})
        return config.get(self._cam_id, {})

    @property
    def available(self) -> bool:
        return bool(self._cam())

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(**build_camera_device_info(self._dvr_serial, self._cam()))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        cam = self._cam()
        return {
            "channel": cam.get("id"),
            "online": cam.get("online"),
            "card_visible": cam.get("card_visible"),
            "ptz_supported": cam.get("ptz_supported"),
            "ptz_proxy_supported": cam.get("ptz_proxy_supported"),
            "ptz_control_method": cam.get("ptz_control_method"),
            "ptz_capability_mode": cam.get("ptz_capability_mode"),
            "ptz_implementation": cam.get("ptz_implementation"),
            "ptz_proxy_ctrl_mode": cam.get("ptz_proxy_ctrl_mode"),
            "ptz_momentary_supported": cam.get("ptz_momentary_supported"),
            "ptz_continuous_supported": cam.get("ptz_continuous_supported"),
            "ptz_proxy_momentary_supported": cam.get("ptz_proxy_momentary_supported"),
            "ptz_proxy_continuous_supported": cam.get("ptz_proxy_continuous_supported"),
            "ptz_unsupported_reason": cam.get("ptz_unsupported_reason"),
        }


class BaseCameraAlarmBinary(BaseCameraBinary):
    _alarm_prefix: str | None = None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        attrs = dict(super().extra_state_attributes)
        if self._alarm_prefix:
            attrs["alarm_key"] = f"{self._alarm_prefix}_{self._cam_id}"
        return attrs


class BaseCameraAudioBinary(BaseCameraBinary):
    def __init__(
        self,
        coordinator,
        dvr_serial: str,
        cam_id: str | int,
        name: str,
        key: str,
    ) -> None:
        super().__init__(coordinator, dvr_serial, cam_id)
        self._audio_key = key
        self._attr_name = name
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_{key}"

    @property
    def is_on(self) -> bool:
        return bool(self._audio_state().get(self._audio_key, False))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        attrs = dict(super().extra_state_attributes)
        attrs["audio_key"] = self._audio_key
        return attrs


class HikvisionCameraAudioLabelBinary(BaseCameraBinary):
    def __init__(
        self,
        coordinator,
        dvr_serial: str,
        cam_id: str | int,
        label: str,
        name: str,
    ) -> None:
        super().__init__(coordinator, dvr_serial, cam_id)
        self._label = label
        self._attr_name = name
        self._attr_unique_id = (
            f"hikvision_{dvr_serial}_camera_{cam_id}_{label}_detected"
        )

    @property
    def is_on(self) -> bool:
        state = self._audio_state()
        label = state.get("classifier_label")
        confidence = float(state.get("classifier_confidence") or 0.0)
        threshold = float(self._audio_config().get("classifier_threshold") or 0.0)
        return label == self._label and confidence >= threshold

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        attrs = dict(super().extra_state_attributes)
        state = self._audio_state()
        attrs.update(
            {
                "classifier_target_label": self._label,
                "classifier_label": state.get("classifier_label"),
                "classifier_confidence": state.get("classifier_confidence"),
                "classifier_threshold": self._audio_config().get(
                    "classifier_threshold"
                ),
            }
        )
        return attrs


class HikvisionCameraOnlineBinary(BaseCameraBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Online"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_online"
        self._attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    @property
    def is_on(self) -> bool:
        return bool(self._cam().get("online"))


class HikvisionCameraPTZBinary(BaseCameraBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "PTZ Supported"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_ptz_supported"

    @property
    def is_on(self) -> bool:
        return bool(self._cam().get("ptz_supported"))


class HikvisionCameraMotionBinary(BaseCameraAlarmBinary):
    _alarm_prefix = "motion"

    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Motion Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_motion_alarm"
        self._attr_device_class = BinarySensorDeviceClass.MOTION

    @property
    def is_on(self) -> bool:
        return bool(self._alarm_states().get(f"motion_{self._cam_id}", False))


class HikvisionCameraVideoLossBinary(BaseCameraAlarmBinary):
    _alarm_prefix = "video_loss"

    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Video Loss Alarm"
        self._attr_unique_id = (
            f"hikvision_{dvr_serial}_camera_{cam_id}_video_loss_alarm"
        )
        self._attr_device_class = BinarySensorDeviceClass.PROBLEM

    @property
    def is_on(self) -> bool:
        return bool(self._alarm_states().get(f"video_loss_{self._cam_id}", False))


class HikvisionCameraIntrusionBinary(BaseCameraAlarmBinary):
    _alarm_prefix = "intrusion"

    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Intrusion Alarm"
        self._attr_unique_id = (
            f"hikvision_{dvr_serial}_camera_{cam_id}_intrusion_alarm"
        )
        self._attr_device_class = BinarySensorDeviceClass.PROBLEM

    @property
    def is_on(self) -> bool:
        return bool(self._alarm_states().get(f"intrusion_{self._cam_id}", False))


class HikvisionCameraLineCrossingBinary(BaseCameraAlarmBinary):
    _alarm_prefix = "line_crossing"

    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Line Crossing Alarm"
        self._attr_unique_id = (
            f"hikvision_{dvr_serial}_camera_{cam_id}_line_crossing_alarm"
        )
        self._attr_device_class = BinarySensorDeviceClass.PROBLEM

    @property
    def is_on(self) -> bool:
        return bool(self._alarm_states().get(f"line_crossing_{self._cam_id}", False))


class HikvisionCameraTamperBinary(BaseCameraAlarmBinary):
    _alarm_prefix = "tamper"

    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id)
        self._attr_name = "Tamper Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_camera_{cam_id}_tamper_alarm"
        self._attr_device_class = BinarySensorDeviceClass.PROBLEM

    @property
    def is_on(self) -> bool:
        return bool(self._alarm_states().get(f"tamper_{self._cam_id}", False))


class BaseNVRBinary(CoordinatorEntity, BinarySensorEntity):
    def __init__(self, coordinator, entry, dvr_serial: str) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._dvr_serial = dvr_serial
        self._attr_has_entity_name = True

    def _alarm_states(self) -> dict[str, Any]:
        return self.coordinator.data.get("alarm_states", {})

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            **build_nvr_device_info(
                self._dvr_serial,
                self._entry,
                self.coordinator.data.get("device_xml"),
            )
        )


class HikvisionNVROnlineBinary(BaseNVRBinary):
    def __init__(self, coordinator, entry, dvr_serial: str) -> None:
        super().__init__(coordinator, entry, dvr_serial)
        self._attr_name = "NVR Online"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_online"
        self._attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    @property
    def is_on(self) -> bool:
        return bool(
            self.coordinator.last_update_success
            and self.coordinator.data.get("nvr", {}).get("online", True)
        )

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        storage = self.coordinator.data.get("storage", {})
        return {
            "disk_count": storage.get("disk_count", 0),
            "healthy_disks": storage.get("healthy_disks", 0),
            "failed_disks": storage.get("failed_disks", 0),
        }


class HikvisionNVRAlarmStreamBinary(BaseNVRBinary):
    def __init__(self, coordinator, entry, dvr_serial: str) -> None:
        super().__init__(coordinator, entry, dvr_serial)
        self._attr_name = "Alarm Stream Connected"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_alarm_stream_connected"
        self._attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    @property
    def is_on(self) -> bool:
        return bool(self._alarm_states().get("stream_connected", False))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "last_event_type": self._alarm_states().get("last_event_type"),
            "last_event_channel": self._alarm_states().get("last_event_channel"),
            "last_event_state": self._alarm_states().get("last_event_state"),
        }


class HikvisionNVRDiskFullBinary(BaseNVRBinary):
    def __init__(self, coordinator, entry, dvr_serial: str) -> None:
        super().__init__(coordinator, entry, dvr_serial)
        self._attr_name = "Disk Full Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_disk_full_alarm"
        self._attr_device_class = BinarySensorDeviceClass.PROBLEM

    @property
    def is_on(self) -> bool:
        return bool(self._alarm_states().get("disk_full", False))


class HikvisionNVRDiskErrorBinary(BaseNVRBinary):
    def __init__(self, coordinator, entry, dvr_serial: str) -> None:
        super().__init__(coordinator, entry, dvr_serial)
        self._attr_name = "Disk Error Alarm"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_disk_error_alarm"
        self._attr_device_class = BinarySensorDeviceClass.PROBLEM

    @property
    def is_on(self) -> bool:
        return bool(self._alarm_states().get("disk_error", False))


class HikvisionNVRAlarmInputBinary(BaseNVRBinary):
    def __init__(
        self, coordinator, entry, dvr_serial: str, input_id: str | int
    ) -> None:
        super().__init__(coordinator, entry, dvr_serial)
        self._input_id = str(input_id)
        self._attr_name = f"Alarm Input {self._input_id}"
        self._attr_unique_id = f"hikvision_{dvr_serial}_nvr_alarm_input_{self._input_id}"
        self._attr_device_class = BinarySensorDeviceClass.OPENING

    def _input(self) -> dict[str, Any]:
        for alarm_input in self.coordinator.data.get("alarm_inputs", []):
            if str(alarm_input.get("id")) == self._input_id:
                return alarm_input
        return {}

    @property
    def is_on(self) -> bool:
        return bool(
            self._alarm_states().get(
                f"alarm_input_{self._input_id}",
                self._input().get("active", False),
            )
        )

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        alarm_input = self._input()
        return {
            "input_id": self._input_id,
            "name": alarm_input.get("name") or f"Alarm Input {self._input_id}",
            "status": alarm_input.get("status"),
            "triggering": alarm_input.get("triggering"),
            "alarm_key": f"alarm_input_{self._input_id}",
        }


class HikvisionCameraAudioEnabledBinary(BaseCameraAudioBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Enabled", "enabled")


class HikvisionCameraAudioClassifierEnabledBinary(BaseCameraAudioBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(
            coordinator,
            dvr_serial,
            cam_id,
            "Audio Classifier Enabled",
            "classifier_enabled",
        )


class HikvisionCameraAudioAbnormalBinary(BaseCameraAudioBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Abnormal", "abnormal")
        self._attr_device_class = BinarySensorDeviceClass.SOUND


class HikvisionCameraAudioSilenceBinary(BaseCameraAudioBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Silence", "silence")
        self._attr_device_class = BinarySensorDeviceClass.SOUND


class HikvisionCameraAudioClippingBinary(BaseCameraAudioBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id, "Audio Clipping", "clipping")
        self._attr_device_class = BinarySensorDeviceClass.PROBLEM


class HikvisionCameraAudioVoiceDetectedBinary(BaseCameraAudioBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(
            coordinator,
            dvr_serial,
            cam_id,
            "Audio Voice Detected",
            "voice_detected",
        )
        self._attr_device_class = BinarySensorDeviceClass.SOUND


class HikvisionCameraAudioImpactDetectedBinary(HikvisionCameraAudioLabelBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id, "impact", "Audio Impact Detected")
        self._attr_device_class = BinarySensorDeviceClass.SOUND


class HikvisionCameraAudioScreamDetectedBinary(HikvisionCameraAudioLabelBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id, "scream", "Audio Scream Detected")
        self._attr_device_class = BinarySensorDeviceClass.SOUND


class HikvisionCameraAudioShoutDetectedBinary(HikvisionCameraAudioLabelBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id, "shout", "Audio Shout Detected")
        self._attr_device_class = BinarySensorDeviceClass.SOUND


class HikvisionCameraAudioGunshotDetectedBinary(HikvisionCameraAudioLabelBinary):
    def __init__(self, coordinator, dvr_serial: str, cam_id: str | int) -> None:
        super().__init__(coordinator, dvr_serial, cam_id, "gunshot", "Audio Gunshot Detected")
        self._attr_device_class = BinarySensorDeviceClass.SOUND
