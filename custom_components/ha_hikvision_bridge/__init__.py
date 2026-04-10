from __future__ import annotations

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.components.websocket_api import async_register_command
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import config_validation as cv

from .const import (
    DOMAIN,
    PLATFORMS,
    SERVICE_FOCUS,
    SERVICE_GOTO_PRESET,
    SERVICE_IRIS,
    SERVICE_PTZ,
    SERVICE_RETURN_HOME,
    SERVICE_ZOOM,
    SERVICE_SET_STREAM_MODE,
    SERVICE_SET_STREAM_PROFILE,
    SERVICE_PLAYBACK_SEEK,
    SERVICE_PLAYBACK_STOP,
    SERVICE_AUDIO_ENABLE,
    SERVICE_AUDIO_DISABLE,
    SERVICE_AUDIO_RECALIBRATE,
    SERVICE_AUDIO_CAPTURE_CLIP,
    SERVICE_AUDIO_ENABLE_CLASSIFIER,
    SERVICE_AUDIO_DISABLE_CLASSIFIER,
    SERVICE_AUDIO_SET_THRESHOLD,
    SERVICE_AUDIO_INGEST_SAMPLES,
    SERVICE_AUDIO_START_STREAM,
    SERVICE_AUDIO_STOP_STREAM,
    SERVICE_AUDIO_APPLY_CALIBRATION,
)
from .coordinator import HikvisionCoordinator
from .helpers import get_dvr_serial, safe_find_text
from .websocket import (
    async_handle_get_debug_events,
    async_handle_get_isapi_catalog,
    async_handle_get_isapi_probe_results,
    async_handle_run_isapi_probe,
    async_handle_webrtc_url,
    async_subscribe_debug,
)

SERVICE_DOMAINS = (DOMAIN,)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    hass.data.setdefault(DOMAIN, {})
    async_register_command(hass, async_handle_webrtc_url)
    async_register_command(hass, async_handle_get_debug_events)
    async_register_command(hass, async_handle_get_isapi_catalog)
    async_register_command(hass, async_handle_get_isapi_probe_results)
    async_register_command(hass, async_handle_run_isapi_probe)
    async_register_command(hass, async_subscribe_debug)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = HikvisionCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = coordinator

    _create_parent_dvr_device(hass, entry, coordinator)
    for service_domain in SERVICE_DOMAINS:
        await _async_register_services(hass, service_domain)
        await _register_stream_service(hass, service_domain)
    await coordinator.async_start_alarm_stream()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        if coordinator is not None:
            await coordinator.async_stop_alarm_stream()
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)

    if not hass.data.get(DOMAIN):
        for service_domain in SERVICE_DOMAINS:
            for service in (
                SERVICE_PTZ,
                SERVICE_GOTO_PRESET,
                SERVICE_FOCUS,
                SERVICE_IRIS,
                SERVICE_RETURN_HOME,
                SERVICE_ZOOM,
                SERVICE_SET_STREAM_MODE,
                SERVICE_SET_STREAM_PROFILE,
                SERVICE_PLAYBACK_SEEK,
                SERVICE_PLAYBACK_STOP,
                SERVICE_AUDIO_ENABLE,
                SERVICE_AUDIO_DISABLE,
                SERVICE_AUDIO_RECALIBRATE,
                SERVICE_AUDIO_CAPTURE_CLIP,
                SERVICE_AUDIO_ENABLE_CLASSIFIER,
                SERVICE_AUDIO_DISABLE_CLASSIFIER,
                SERVICE_AUDIO_SET_THRESHOLD,
                SERVICE_AUDIO_INGEST_SAMPLES,
                SERVICE_AUDIO_START_STREAM,
                SERVICE_AUDIO_STOP_STREAM,
                SERVICE_AUDIO_APPLY_CALIBRATION,
            ):
                if hass.services.has_service(service_domain, service):
                    hass.services.async_remove(service_domain, service)
    return unload_ok


def _create_parent_dvr_device(hass: HomeAssistant, entry: ConfigEntry, coordinator: HikvisionCoordinator) -> None:
    device_xml = coordinator.data.get("device_xml")
    dvr_serial = get_dvr_serial(coordinator, entry)
    device_registry = dr.async_get(hass)

    device_registry.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, dvr_serial)},
        manufacturer=safe_find_text(device_xml, "manufacturer", "Hikvision") or "Hikvision",
        model=safe_find_text(device_xml, "model", "Hikvision NVR") or "Hikvision NVR",
        name=safe_find_text(device_xml, "deviceName", f"Hikvision NVR ({entry.data.get('host')})") or f"Hikvision NVR ({entry.data.get('host')})",
        serial_number=dvr_serial,
        sw_version=safe_find_text(device_xml, "firmwareVersion"),
    )


async def _async_register_services(hass: HomeAssistant, service_domain: str) -> None:
    if hass.services.has_service(service_domain, SERVICE_PTZ):
        return

    async def _resolve_coordinator(call: ServiceCall) -> HikvisionCoordinator:
        entry_id = call.data.get("entry_id")
        data = hass.data.get(DOMAIN, {})
        if entry_id:
            return data[entry_id]
        if len(data) == 1:
            return next(iter(data.values()))
        channel = str(call.data.get("channel", ""))
        for coordinator in data.values():
            if any(str(cam.get("id")) == channel for cam in coordinator.data.get("cameras", [])):
                return coordinator
        return next(iter(data.values()))

    async def ptz_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        await coordinator.ptz(
            call.data["channel"],
            call.data.get("pan", 0),
            call.data.get("tilt", 0),
            call.data.get("duration", 500),
            call.data.get("continuous", False),
            call.data.get("stop", False),
            call.data.get("speed", 50),
        )

    async def preset_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        await coordinator.goto_preset(call.data["channel"], call.data["preset"])

    async def focus_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        await coordinator.focus(
            call.data["channel"],
            call.data.get("direction", 1),
            call.data.get("speed", 60),
            call.data.get("duration", 500),
        )

    async def iris_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        await coordinator.iris(
            call.data["channel"],
            call.data.get("direction", 1),
            call.data.get("speed", 60),
            call.data.get("duration", 500),
        )

    async def zoom_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        await coordinator.zoom(
            call.data["channel"],
            call.data.get("direction", 1),
            call.data.get("speed", 50),
            call.data.get("duration", 500),
        )

    async def return_home_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        await coordinator.return_to_center(
            call.data["channel"],
            call.data.get("state", {}),
            call.data.get("speed", 50),
            call.data.get("duration", 350),
            call.data.get("step_delay", 150),
        )

    async def audio_enable_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        channel = str(call.data["channel"])
        coordinator.audio.set_enabled(channel, True)
        coordinator._push_debug_event(
            category="audio",
            event="audio_enabled",
            message=f"Audio analytics enabled for camera {channel}",
            camera_id=channel,
        )

    async def audio_disable_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        channel = str(call.data["channel"])
        coordinator.audio.set_enabled(channel, False)
        coordinator._push_debug_event(
            category="audio",
            event="audio_disabled",
            message=f"Audio analytics disabled for camera {channel}",
            camera_id=channel,
        )

    async def audio_recalibrate_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        channel = str(call.data["channel"])
        coordinator.audio.recalibrate(channel)
        coordinator._push_debug_event(
            category="audio",
            event="audio_recalibrated",
            message=f"Audio baseline recalibrated for camera {channel}",
            camera_id=channel,
        )

    async def audio_enable_classifier_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        channel = str(call.data["channel"])
        coordinator.audio.set_classifier_enabled(channel, True)
        coordinator._push_debug_event(
            category="audio",
            event="audio_classifier_enabled",
            message=f"Audio classifier enabled for camera {channel}",
            camera_id=channel,
        )

    async def audio_disable_classifier_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        channel = str(call.data["channel"])
        coordinator.audio.set_classifier_enabled(channel, False)
        coordinator._push_debug_event(
            category="audio",
            event="audio_classifier_disabled",
            message=f"Audio classifier disabled for camera {channel}",
            camera_id=channel,
        )

    async def audio_capture_clip_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        channel = str(call.data["channel"])
        clip = coordinator.audio.get_clip(channel)
        push = getattr(coordinator, "_push_debug_event", None)
        if callable(push):
            push(
                level="info",
                category="audio",
                event="audio_clip_captured",
                message=f"Audio clip captured for camera {channel}",
                camera_id=channel,
                context={"frames": len(clip)},
            )

    async def audio_set_threshold_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        channel = str(call.data["channel"])
        coordinator.audio.set_thresholds(
            channel,
            abnormal_multiplier=call.data.get("abnormal_multiplier"),
            silence_threshold=call.data.get("silence_threshold"),
            clipping_threshold=call.data.get("clipping_threshold"),
            voice_threshold=call.data.get("voice_threshold"),
            classifier_threshold=call.data.get("classifier_threshold"),
        )
        coordinator._push_debug_event(
            category="audio",
            event="audio_thresholds_updated",
            message=f"Audio thresholds updated for camera {channel}",
            camera_id=channel,
            context={key: value for key, value in call.data.items() if key not in {"entry_id"}},
        )

    async def audio_ingest_samples_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        channel = str(call.data["channel"])
        samples = [float(sample) for sample in call.data.get("samples", [])]
        if not coordinator.audio.get_state(channel):
            coordinator.audio.ensure_camera(channel)
        if not (coordinator.audio.get_state(channel) or {}).get("enabled"):
            coordinator.audio.set_enabled(channel, True)
        if call.data.get("classifier", False) and not (coordinator.audio.get_state(channel) or {}).get("classifier_enabled"):
            coordinator.audio.set_classifier_enabled(channel, True)
        await coordinator.async_ingest_audio_samples(channel, samples)

    async def audio_start_stream_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        channel = str(call.data["channel"])
        await coordinator.async_start_native_audio_stream(
            channel,
            profile=call.data.get("profile", "active"),
            ffmpeg_path=call.data.get("ffmpeg_path", "ffmpeg"),
            sample_rate=call.data.get("sample_rate", 8000),
            chunk_size=call.data.get("chunk_size", 3200),
            enable_classifier=call.data.get("classifier", True),
        )

    async def audio_stop_stream_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        await coordinator.async_stop_native_audio_stream(str(call.data["channel"]))

    async def audio_apply_calibration_service(call: ServiceCall) -> None:
        coordinator = await _resolve_coordinator(call)
        channel = str(call.data["channel"])
        preset = str(call.data.get("preset", "balanced")).lower()
        presets = {
            "quiet": {
                "abnormal_multiplier": 1.9,
                "silence_threshold": 0.012,
                "voice_threshold": 0.025,
                "classifier_threshold": 0.62,
                "cooldown_seconds": 6.0,
            },
            "balanced": {
                "abnormal_multiplier": 2.5,
                "silence_threshold": 0.02,
                "voice_threshold": 0.04,
                "classifier_threshold": 0.7,
                "cooldown_seconds": 8.0,
            },
            "noisy": {
                "abnormal_multiplier": 3.1,
                "silence_threshold": 0.04,
                "voice_threshold": 0.06,
                "classifier_threshold": 0.82,
                "cooldown_seconds": 12.0,
            },
        }
        coordinator.audio.set_thresholds(channel, **presets.get(preset, presets["balanced"]))
        state = coordinator.audio.get_state(channel)
        if state is not None:
            state["calibration_profile"] = preset if preset in presets else "balanced"
        coordinator._push_debug_event(
            category="audio",
            event="audio_calibration_applied",
            message=f"Audio calibration preset applied for camera {channel}",
            camera_id=channel,
            context={"preset": preset if preset in presets else "balanced"},
        )
        coordinator.async_update_listeners()


    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_START_STREAM,
        audio_start_stream_service,
        schema=vol.Schema(
            {
                vol.Required("channel"): cv.string,
                vol.Optional("profile", default="active"): cv.string,
                vol.Optional("ffmpeg_path", default="ffmpeg"): cv.string,
                vol.Optional("sample_rate", default=8000): vol.Coerce(int),
                vol.Optional("chunk_size", default=3200): vol.Coerce(int),
                vol.Optional("classifier", default=True): cv.boolean,
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_STOP_STREAM,
        audio_stop_stream_service,
        schema=vol.Schema(
            {
                vol.Required("channel"): cv.string,
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_APPLY_CALIBRATION,
        audio_apply_calibration_service,
        schema=vol.Schema(
            {
                vol.Required("channel"): cv.string,
                vol.Optional("preset", default="balanced"): cv.string,
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )

    hass.services.async_register(
        service_domain,
        SERVICE_PTZ,
        ptz_service,
        schema=vol.Schema(
            {
                vol.Required("channel"): cv.string,
                vol.Optional("pan", default=0): vol.Coerce(int),
                vol.Optional("tilt", default=0): vol.Coerce(int),
                vol.Optional("speed", default=50): vol.Coerce(int),
                vol.Optional("duration", default=500): vol.Coerce(int),
                vol.Optional("continuous", default=False): cv.boolean,
                vol.Optional("stop", default=False): cv.boolean,
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_GOTO_PRESET,
        preset_service,
        schema=vol.Schema(
            {
                vol.Required("channel"): cv.string,
                vol.Required("preset"): vol.Coerce(int),
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_FOCUS,
        focus_service,
        schema=vol.Schema(
            {
                vol.Required("channel"): cv.string,
                vol.Optional("direction", default=1): vol.Coerce(int),
                vol.Optional("speed", default=60): vol.Coerce(int),
                vol.Optional("duration", default=500): vol.Coerce(int),
                vol.Optional("continuous", default=False): cv.boolean,
                vol.Optional("stop", default=False): cv.boolean,
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_IRIS,
        iris_service,
        schema=vol.Schema(
            {
                vol.Required("channel"): cv.string,
                vol.Optional("direction", default=1): vol.Coerce(int),
                vol.Optional("speed", default=60): vol.Coerce(int),
                vol.Optional("duration", default=500): vol.Coerce(int),
                vol.Optional("continuous", default=False): cv.boolean,
                vol.Optional("stop", default=False): cv.boolean,
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_ZOOM,
        zoom_service,
        schema=vol.Schema(
            {
                vol.Required("channel"): cv.string,
                vol.Optional("direction", default=1): vol.Coerce(int),
                vol.Optional("speed", default=50): vol.Coerce(int),
                vol.Optional("duration", default=500): vol.Coerce(int),
                vol.Optional("continuous", default=False): cv.boolean,
                vol.Optional("stop", default=False): cv.boolean,
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_RETURN_HOME,
        return_home_service,
        schema=vol.Schema(
            {
                vol.Required("channel"): cv.string,
                vol.Required("state"): dict,
                vol.Optional("speed", default=50): vol.Coerce(int),
                vol.Optional("duration", default=350): vol.Coerce(int),
                vol.Optional("step_delay", default=150): vol.Coerce(int),
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_ENABLE,
        audio_enable_service,
        schema=vol.Schema({
            vol.Required("channel"): cv.string,
            vol.Optional("entry_id"): cv.string,
        }),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_DISABLE,
        audio_disable_service,
        schema=vol.Schema({
            vol.Required("channel"): cv.string,
            vol.Optional("entry_id"): cv.string,
        }),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_RECALIBRATE,
        audio_recalibrate_service,
        schema=vol.Schema({
            vol.Required("channel"): cv.string,
            vol.Optional("entry_id"): cv.string,
        }),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_CAPTURE_CLIP,
        audio_capture_clip_service,
        schema=vol.Schema({
            vol.Required("channel"): cv.string,
            vol.Optional("entry_id"): cv.string,
        }),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_ENABLE_CLASSIFIER,
        audio_enable_classifier_service,
        schema=vol.Schema({
            vol.Required("channel"): cv.string,
            vol.Optional("entry_id"): cv.string,
        }),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_DISABLE_CLASSIFIER,
        audio_disable_classifier_service,
        schema=vol.Schema({
            vol.Required("channel"): cv.string,
            vol.Optional("entry_id"): cv.string,
        }),
    )
    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_SET_THRESHOLD,
        audio_set_threshold_service,
        schema=vol.Schema({
            vol.Required("channel"): cv.string,
            vol.Optional("abnormal_multiplier"): vol.Coerce(float),
            vol.Optional("silence_threshold"): vol.Coerce(float),
            vol.Optional("clipping_threshold"): vol.Coerce(float),
            vol.Optional("voice_threshold"): vol.Coerce(float),
            vol.Optional("classifier_threshold"): vol.Coerce(float),
            vol.Optional("entry_id"): cv.string,
        }),
    )

    hass.services.async_register(
        service_domain,
        SERVICE_AUDIO_INGEST_SAMPLES,
        audio_ingest_samples_service,
        schema=vol.Schema({
            vol.Required("channel"): cv.string,
            vol.Required("samples"): [vol.Coerce(float)],
            vol.Optional("classifier", default=False): cv.boolean,
            vol.Optional("entry_id"): cv.string,
        }),
    )


async def _register_stream_service(hass: HomeAssistant, service_domain: str) -> None:
    if hass.services.has_service(service_domain, SERVICE_SET_STREAM_MODE):
        return

    async def set_stream_mode(call: ServiceCall) -> None:
        entity_id = call.data["entity_id"]
        mode = call.data["mode"]
        for coordinator in hass.data.get(DOMAIN, {}).values():
            entities = getattr(coordinator, "entities", {})
            entity = entities.get(entity_id)
            if entity is not None:
                await coordinator.async_set_stream_mode(entity._cam_id, mode)
                break

    hass.services.async_register(service_domain, SERVICE_SET_STREAM_MODE, set_stream_mode)

    async def set_stream_profile(call: ServiceCall) -> None:
        entity_id = call.data["entity_id"]
        profile = call.data["profile"]
        for coordinator in hass.data.get(DOMAIN, {}).values():
            entities = getattr(coordinator, "entities", {})
            entity = entities.get(entity_id)
            if entity is not None:
                await coordinator.async_set_stream_profile(entity._cam_id, profile)
                break

    hass.services.async_register(service_domain, SERVICE_SET_STREAM_PROFILE, set_stream_profile)

    async def playback_seek(call: ServiceCall) -> None:
        entity_id = call.data["entity_id"]
        timestamp = call.data["timestamp"]
        for coordinator in hass.data.get(DOMAIN, {}).values():
            entities = getattr(coordinator, "entities", {})
            entity = entities.get(entity_id)
            if entity is None:
                continue

            playback_result = await coordinator.search_playback_uri(entity._cam_id, timestamp)
            playback_uri = None
            clip_start_time = None
            clip_end_time = None

            if isinstance(playback_result, str):
                playback_uri = playback_result
            elif isinstance(playback_result, dict):
                playback_uri = playback_result.get("playback_uri")
                clip_start_time = playback_result.get("playback_clip_start_time") or playback_result.get("clip_start_time")
                clip_end_time = playback_result.get("playback_clip_end_time") or playback_result.get("clip_end_time")

                if not playback_uri:
                    matches = playback_result.get("matches")
                    if isinstance(matches, list) and matches:
                        first_match = matches[0]
                        if isinstance(first_match, str):
                            playback_uri = first_match
                        elif isinstance(first_match, dict):
                            playback_uri = first_match.get("playback_uri")
                            clip_start_time = (
                                clip_start_time
                                or first_match.get("playback_clip_start_time")
                                or first_match.get("clip_start_time")
                                or first_match.get("start_time")
                            )
                            clip_end_time = (
                                clip_end_time
                                or first_match.get("playback_clip_end_time")
                                or first_match.get("clip_end_time")
                                or first_match.get("end_time")
                            )
            elif isinstance(playback_result, list) and playback_result:
                first_match = playback_result[0]
                if isinstance(first_match, str):
                    playback_uri = first_match
                elif isinstance(first_match, dict):
                    playback_uri = first_match.get("playback_uri")
                    clip_start_time = (
                        first_match.get("playback_clip_start_time")
                        or first_match.get("clip_start_time")
                        or first_match.get("start_time")
                    )
                    clip_end_time = (
                        first_match.get("playback_clip_end_time")
                        or first_match.get("clip_end_time")
                        or first_match.get("end_time")
                    )

            if playback_uri:
                entity.start_playback(
                    playback_uri,
                    requested_time=timestamp,
                    error=None,
                    clip_start_time=clip_start_time,
                    clip_end_time=clip_end_time,
                )
            else:
                entity.start_playback(
                    None,
                    requested_time=timestamp,
                    error="No recording found for requested time",
                )
            break

    hass.services.async_register(
        service_domain,
        SERVICE_PLAYBACK_SEEK,
        playback_seek,
        schema=vol.Schema({
            vol.Required("entity_id"): cv.entity_id,
            vol.Required("timestamp"): cv.string,
        }),
    )

    async def playback_stop(call: ServiceCall) -> None:
        entity_id = call.data["entity_id"]
        for coordinator in hass.data.get(DOMAIN, {}).values():
            entities = getattr(coordinator, "entities", {})
            entity = entities.get(entity_id)
            if entity is not None:
                entity.stop_playback()
                break

    hass.services.async_register(
        service_domain,
        SERVICE_PLAYBACK_STOP,
        playback_stop,
        schema=vol.Schema({
            vol.Required("entity_id"): cv.entity_id,
        }),
    )
