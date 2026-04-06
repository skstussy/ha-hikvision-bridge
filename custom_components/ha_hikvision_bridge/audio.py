from __future__ import annotations

from collections import deque
import time
from typing import Any


class HikvisionAudioManager:
    def __init__(self, hass, coordinator) -> None:
        self.hass = hass
        self.coordinator = coordinator
        self._state: dict[str, dict[str, Any]] = {}
        self._buffers: dict[str, deque] = {}
        self._config: dict[str, dict[str, Any]] = {}

        self._defaults = {
            "enabled": False,
            "classifier_enabled": False,
            "abnormal_multiplier": 2.5,
            "silence_threshold": 0.02,
            "clipping_threshold": 0.98,
            "voice_threshold": 0.04,
            "classifier_threshold": 0.70,
            "cooldown_seconds": 8.0,
            "clip_frames": 100,
        }

    def ensure_camera(self, camera_id: str) -> None:
        cam = str(camera_id)
        if cam in self._state:
            return

        self._state[cam] = {
            "enabled": False,
            "classifier_enabled": False,
            "level": 0.0,
            "baseline": 0.01,
            "peak": 0.0,
            "anomaly_score": 0.0,
            "silence": False,
            "clipping": False,
            "abnormal": False,
            "voice_detected": False,
            "classifier_label": None,
            "classifier_confidence": 0.0,
            "last_event": None,
            "last_event_ts": 0.0,
            "last_classifier_ts": 0.0,
            "last_classifier_source": None,
            "last_gunshot_ts": 0.0,
            "sample_count": 0,
            "frames_ingested": 0,
        }
        self._config[cam] = dict(self._defaults)
        self._buffers[cam] = deque(maxlen=self._defaults["clip_frames"])

    def get_state(self, camera_id: str) -> dict | None:
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

    def recalibrate(self, camera_id: str) -> None:
        self.ensure_camera(camera_id)
        state = self._state[str(camera_id)]
        state["baseline"] = max(state["level"], 0.01)

    def set_thresholds(self, camera_id: str, **kwargs) -> None:
        self.ensure_camera(camera_id)
        conf = self._config[str(camera_id)]
        for key, value in kwargs.items():
            if value is not None and key in conf:
                conf[key] = value

    def get_clip(self, camera_id: str) -> list[list[float]]:
        self.ensure_camera(camera_id)
        return list(self._buffers[str(camera_id)])

    def ingest_samples(self, camera_id: str, samples: list[int | float]) -> dict[str, Any] | None:
        self.ensure_camera(camera_id)
        cam = str(camera_id)
        state = self._state[cam]
        conf = self._config[cam]

        if not state["enabled"] or not samples:
            return None

        values = [self._normalize_sample(value) for value in samples]
        level = sum(values) / len(values)
        peak = max(values)
        baseline = (state["baseline"] * 0.98) + (level * 0.02)
        anomaly = level / max(baseline, 0.0001)

        silence = level < conf["silence_threshold"]
        clipping = peak > conf["clipping_threshold"]
        abnormal = anomaly >= conf["abnormal_multiplier"]
        voice_detected = self._detect_voice(values, level, conf["voice_threshold"])

        state.update(
            {
                "level": level,
                "baseline": baseline,
                "peak": peak,
                "anomaly_score": anomaly,
                "silence": silence,
                "clipping": clipping,
                "abnormal": abnormal,
                "voice_detected": voice_detected,
                "sample_count": state.get("sample_count", 0) + len(values),
                "frames_ingested": state.get("frames_ingested", 0) + 1,
            }
        )

        self._buffers[cam].append(values)
        self._emit_detection_events(cam)
        return state

    def update_classifier_result(
        self,
        camera_id: str,
        *,
        label: str | None,
        confidence: float,
        accepted: bool,
        source: str = "classifier",
    ) -> None:
        self.ensure_camera(camera_id)
        state = self._state[str(camera_id)]
        state["classifier_label"] = label
        state["classifier_confidence"] = float(confidence or 0.0)
        state["last_classifier_ts"] = time.time()
        state["last_classifier_source"] = source
        if accepted and label:
            state["last_event"] = f"audio_classifier_{label}"
            if label == "gunshot":
                state["last_gunshot_ts"] = state["last_classifier_ts"]

    def _normalize_sample(self, value: int | float) -> float:
        try:
            sample = float(value)
        except (TypeError, ValueError):
            return 0.0

        if -1.0 <= sample <= 1.0:
            return abs(sample)

        if -32768.0 <= sample <= 32767.0:
            return min(abs(sample) / 32767.0, 1.0)

        return min(max(abs(sample), 0.0), 255.0) / 255.0

    def _detect_voice(self, values: list[float], level: float, threshold: float) -> bool:
        if level < threshold or not values:
            return False
        start = len(values) // 4
        end = len(values) // 2
        mid_band = values[start:end] or values
        mid_energy = sum(mid_band) / len(mid_band)
        peak = max(values)
        spread = peak - min(values)
        return mid_energy > (level * 0.6) and spread > max(threshold * 0.25, 0.01)

    def _emit_detection_events(self, camera_id: str) -> None:
        state = self._state[camera_id]
        now = time.time()
        cooldown = self._config[camera_id]["cooldown_seconds"]

        if now - state["last_event_ts"] < cooldown:
            return

        event = None
        if state["abnormal"]:
            event = "audio_abnormal"
        elif state["clipping"]:
            event = "audio_clipping"
        elif state["silence"]:
            event = "audio_silence"
        elif state["voice_detected"]:
            event = "audio_voice_detected"

        if not event:
            return

        state["last_event"] = event
        state["last_event_ts"] = now

        push = getattr(self.coordinator, "_push_debug_event", None)
        if callable(push):
            push(
                level="info",
                category="audio",
                event=event,
                message=f"Audio detection event for camera {camera_id}",
                camera_id=camera_id,
                context={
                    "level": state["level"],
                    "baseline": state["baseline"],
                    "peak": state["peak"],
                    "anomaly_score": state["anomaly_score"],
                    "voice_detected": state["voice_detected"],
                    "frames_ingested": state.get("frames_ingested", 0),
                },
            )
