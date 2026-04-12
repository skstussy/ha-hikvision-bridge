from __future__ import annotations

import asyncio
import contextlib
import time
from typing import Any


class HikvisionVideoManager:
    def __init__(self, hass, coordinator) -> None:
        self.hass = hass
        self.coordinator = coordinator
        self._state: dict[str, dict[str, Any]] = {}
        self._config: dict[str, dict[str, Any]] = {}
        self._monitor_tasks: dict[str, asyncio.Task] = {}

        self._defaults = {
            "enabled": False,
            "classifier_enabled": False,
            "runtime_backend": "ultralytics",
            "runtime_preference": "auto",
            "model_source": "yolov8n.pt",
            "object_threshold": 0.45,
            "frame_interval_seconds": 2.5,
            "idle_interval_seconds": 15.0,
            "cooldown_seconds": 10.0,
            "motion_gated": True,
            "image_size": 640,
            "max_detections": 10,
            "target_labels": [
                "person",
                "car",
                "truck",
                "bus",
                "motorcycle",
                "bicycle",
                "dog",
                "cat",
            ],
        }

    def ensure_camera(self, camera_id: str) -> None:
        cam = str(camera_id)
        if cam in self._state:
            return

        self._state[cam] = {
            "enabled": False,
            "classifier_enabled": False,
            "runtime_backend": "ultralytics",
            "runtime_status": "idle",
            "runtime_device": "unknown",
            "runtime_error": None,
            "loop_status": "stopped",
            "last_event": None,
            "last_event_ts": 0.0,
            "last_run_ts": 0.0,
            "last_frame_ts": 0.0,
            "last_detection_ts": 0.0,
            "top_label": None,
            "top_confidence": 0.0,
            "detected_labels": [],
            "detections": [],
            "detection_count": 0,
            "frames_processed": 0,
            "skipped_frames": 0,
            "motion_gated_skips": 0,
            "last_motion_active": False,
        }
        self._config[cam] = dict(self._defaults)

    def get_state(self, camera_id: str) -> dict[str, Any] | None:
        return self._state.get(str(camera_id))

    def get_config(self, camera_id: str) -> dict[str, Any]:
        self.ensure_camera(camera_id)
        return dict(self._config[str(camera_id)])

    def set_enabled(self, camera_id: str, enabled: bool) -> None:
        self.ensure_camera(camera_id)
        self._state[str(camera_id)]["enabled"] = bool(enabled)

    def set_classifier_enabled(self, camera_id: str, enabled: bool) -> None:
        self.ensure_camera(camera_id)
        self._state[str(camera_id)]["classifier_enabled"] = bool(enabled)

    def set_options(self, camera_id: str, **kwargs) -> None:
        self.ensure_camera(camera_id)
        conf = self._config[str(camera_id)]
        state = self._state[str(camera_id)]
        for key, value in kwargs.items():
            if value is None or key not in conf:
                continue
            if key == "target_labels":
                if isinstance(value, str):
                    conf[key] = [item.strip().lower() for item in value.split(",") if item.strip()]
                elif isinstance(value, (list, tuple, set)):
                    conf[key] = [str(item).strip().lower() for item in value if str(item).strip()]
            else:
                conf[key] = value
            if key in {"runtime_backend"}:
                state[key] = conf[key]

    def update_runtime_state(
        self,
        camera_id: str,
        *,
        status: str | None = None,
        backend: str | None = None,
        device: str | None = None,
        error: str | None = None,
    ) -> None:
        self.ensure_camera(camera_id)
        state = self._state[str(camera_id)]
        if status is not None:
            state["runtime_status"] = status
        if backend is not None:
            state["runtime_backend"] = backend
        if device is not None:
            state["runtime_device"] = device
        state["runtime_error"] = error

    def update_detection_result(
        self,
        camera_id: str,
        *,
        label: str | None,
        confidence: float,
        detections: list[dict[str, Any]] | None = None,
        source: str = "snapshot",
        backend: str = "ultralytics",
        device: str = "unknown",
        accepted: bool = False,
        error: str | None = None,
        motion_active: bool = False,
    ) -> None:
        self.ensure_camera(camera_id)
        state = self._state[str(camera_id)]
        now = time.time()
        detections = list(detections or [])
        state["runtime_backend"] = backend
        state["runtime_device"] = device
        state["runtime_error"] = error
        state["runtime_status"] = "ready" if error is None else "error"
        state["frames_processed"] = int(state.get("frames_processed", 0)) + 1
        state["last_run_ts"] = now
        state["last_frame_ts"] = now
        state["last_motion_active"] = bool(motion_active)
        state["top_label"] = label
        state["top_confidence"] = float(confidence or 0.0)
        state["detections"] = detections
        state["detected_labels"] = [str(item.get("label")) for item in detections if item.get("label")]
        state["detection_count"] = len(detections)
        if accepted and label:
            state["last_detection_ts"] = now
            state["last_event"] = f"video_classifier_{label}"
            state["last_event_ts"] = now
        elif error:
            state["last_event"] = "video_classifier_error"
            state["last_event_ts"] = now
        else:
            state["last_event"] = f"video_classifier_{source}"
            state["last_event_ts"] = now

    async def async_start_monitor(self, camera_id: str, **options) -> None:
        cam = str(camera_id)
        self.ensure_camera(cam)
        if options:
            self.set_options(cam, **options)
        self.set_enabled(cam, True)
        if "classifier_enabled" in options:
            self.set_classifier_enabled(cam, bool(options["classifier_enabled"]))
        self._state[cam]["loop_status"] = "starting"
        existing = self._monitor_tasks.get(cam)
        if existing and not existing.done():
            return
        task = asyncio.create_task(self._monitor_loop(cam))
        self._monitor_tasks[cam] = task

    async def async_stop_monitor(self, camera_id: str) -> None:
        cam = str(camera_id)
        task = self._monitor_tasks.pop(cam, None)
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        state = self._state.get(cam)
        if state is not None:
            state["loop_status"] = "stopped"
            if state.get("runtime_status") not in {"error"}:
                state["runtime_status"] = "idle"

    async def async_stop_all_monitors(self) -> None:
        for cam in list(self._monitor_tasks):
            await self.async_stop_monitor(cam)

    async def _monitor_loop(self, camera_id: str) -> None:
        cam = str(camera_id)
        state = self._state[cam]
        state["loop_status"] = "running"
        try:
            while True:
                conf = self._config[cam]
                motion_active = bool(self.coordinator.data.get("alarm_states", {}).get(f"motion_{cam}", False))
                interval = float(conf.get("frame_interval_seconds") or 2.5)
                if not motion_active:
                    interval = float(conf.get("idle_interval_seconds") or interval)
                    if bool(conf.get("motion_gated", True)):
                        state["motion_gated_skips"] = int(state.get("motion_gated_skips", 0)) + 1
                if state.get("enabled") and state.get("classifier_enabled"):
                    await self.coordinator.async_run_video_detection_cycle(cam, motion_active=motion_active)
                else:
                    state["skipped_frames"] = int(state.get("skipped_frames", 0)) + 1
                await asyncio.sleep(max(1.0, interval))
        except asyncio.CancelledError:
            raise
        except Exception as err:
            state["loop_status"] = "error"
            state["runtime_status"] = "error"
            state["runtime_error"] = str(err)
            push = getattr(self.coordinator, "_push_debug_event", None)
            if callable(push):
                push(
                    level="error",
                    category="video_ai",
                    event="video_monitor_loop_failed",
                    message=f"Video monitor loop failed for camera {cam}",
                    camera_id=cam,
                    context={"error": str(err)},
                )
        finally:
            if state.get("loop_status") != "error":
                state["loop_status"] = "stopped"
