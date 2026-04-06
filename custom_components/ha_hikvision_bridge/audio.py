from __future__ import annotations

import asyncio
from collections import deque
import contextlib
import shutil
import struct
import time
from typing import Any


class HikvisionAudioManager:
    def __init__(self, hass, coordinator) -> None:
        self.hass = hass
        self.coordinator = coordinator
        self._state: dict[str, dict[str, Any]] = {}
        self._buffers: dict[str, deque] = {}
        self._config: dict[str, dict[str, Any]] = {}
        self._native_tasks: dict[str, asyncio.Task] = {}
        self._native_processes: dict[str, asyncio.subprocess.Process] = {}

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
            "classifier_rearm_seconds": 12.0,
            "native_stream_enabled": False,
            "native_stream_profile": "active",
            "native_stream_ffmpeg_path": "ffmpeg",
            "native_sample_rate": 8000,
            "native_chunk_size": 3200,
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
            "classifier_metrics": {},
            "last_event": None,
            "last_event_ts": 0.0,
            "last_classifier_ts": 0.0,
            "last_classifier_source": None,
            "last_classifier_accepted": False,
            "last_gunshot_ts": 0.0,
            "sample_count": 0,
            "frames_ingested": 0,
            "native_stream_enabled": False,
            "native_stream_status": "idle",
            "native_stream_profile": "active",
            "native_stream_source": None,
            "native_stream_error": None,
            "native_stream_started_ts": 0.0,
            "native_stream_last_audio_ts": 0.0,
            "native_stream_restart_count": 0,
            "native_stream_bytes": 0,
            "native_stream_frames": 0,
            "native_stream_ffmpeg_path": "ffmpeg",
            "native_stream_audio_codec": None,
            "native_stream_url": None,
            "calibration_score": 0.0,
            "calibration_profile": "default",
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
        state["calibration_score"] = round(min(1.0, max(0.05, state["baseline"] * 8.0)), 3)

    def set_thresholds(self, camera_id: str, **kwargs) -> None:
        self.ensure_camera(camera_id)
        conf = self._config[str(camera_id)]
        for key, value in kwargs.items():
            if value is not None and key in conf:
                conf[key] = value
                if key in {"native_stream_profile", "native_stream_ffmpeg_path"}:
                    self._state[str(camera_id)][key] = value

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
                "native_stream_last_audio_ts": time.time(),
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
        metrics: dict[str, Any] | None = None,
    ) -> None:
        self.ensure_camera(camera_id)
        state = self._state[str(camera_id)]
        state["classifier_label"] = label
        state["classifier_confidence"] = float(confidence or 0.0)
        state["classifier_metrics"] = dict(metrics or {})
        state["last_classifier_ts"] = time.time()
        state["last_classifier_source"] = source
        state["last_classifier_accepted"] = bool(accepted)
        if accepted and label:
            state["last_event"] = f"audio_classifier_{label}"
            if label == "gunshot":
                state["last_gunshot_ts"] = state["last_classifier_ts"]

    async def async_start_native_stream(
        self,
        camera_id: str,
        *,
        stream_url: str,
        ffmpeg_path: str = "ffmpeg",
        sample_rate: int = 8000,
        chunk_size: int = 3200,
        source: str | None = None,
        profile: str = "active",
        audio_codec: str | None = None,
    ) -> None:
        self.ensure_camera(camera_id)
        cam = str(camera_id)
        await self.async_stop_native_stream(cam)

        state = self._state[cam]
        state.update(
            {
                "native_stream_enabled": True,
                "native_stream_status": "starting",
                "native_stream_error": None,
                "native_stream_source": source or "rtsp",
                "native_stream_profile": str(profile or "active"),
                "native_stream_started_ts": time.time(),
                "native_stream_ffmpeg_path": ffmpeg_path,
                "native_stream_audio_codec": audio_codec,
                "native_stream_url": stream_url,
            }
        )
        self._config[cam]["native_stream_enabled"] = True
        self._config[cam]["native_stream_profile"] = str(profile or "active")
        self._config[cam]["native_stream_ffmpeg_path"] = str(ffmpeg_path or "ffmpeg")
        self._config[cam]["native_sample_rate"] = max(4000, int(sample_rate or 8000))
        self._config[cam]["native_chunk_size"] = max(512, int(chunk_size or 3200))

        task = asyncio.create_task(self._native_stream_loop(cam))
        self._native_tasks[cam] = task

    async def async_stop_native_stream(self, camera_id: str) -> None:
        cam = str(camera_id)
        task = self._native_tasks.pop(cam, None)
        proc = self._native_processes.pop(cam, None)
        if proc is not None:
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if proc is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.wait(), timeout=2)
        state = self._state.get(cam)
        if state is not None:
            state["native_stream_enabled"] = False
            if state.get("native_stream_status") not in {"error", "stopped"}:
                state["native_stream_status"] = "stopped"
        self._config.get(cam, {}).update({"native_stream_enabled": False})

    async def async_stop_all_native_streams(self) -> None:
        for cam in list(self._native_tasks):
            await self.async_stop_native_stream(cam)

    async def _native_stream_loop(self, camera_id: str) -> None:
        cam = str(camera_id)
        state = self._state[cam]
        conf = self._config[cam]
        ffmpeg_path = str(conf.get("native_stream_ffmpeg_path") or "ffmpeg")
        if shutil.which(ffmpeg_path) is None:
            state["native_stream_status"] = "error"
            state["native_stream_error"] = f"ffmpeg binary not found: {ffmpeg_path}"
            self._debug_native(cam, "error", "audio_native_ffmpeg_missing", state["native_stream_error"])
            return

        stream_url = state.get("native_stream_url")
        if not stream_url:
            state["native_stream_status"] = "error"
            state["native_stream_error"] = "missing stream url"
            self._debug_native(cam, "error", "audio_native_missing_stream_url", state["native_stream_error"])
            return

        args = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-rtsp_transport",
            "tcp",
            "-i",
            stream_url,
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(int(conf.get("native_sample_rate") or 8000)),
            "-f",
            "s16le",
            "pipe:1",
        ]

        self._debug_native(
            cam,
            "info",
            "audio_native_stream_starting",
            f"Starting native audio stream for camera {cam}",
            context={
                "profile": state.get("native_stream_profile"),
                "source": state.get("native_stream_source"),
                "audio_codec": state.get("native_stream_audio_codec"),
                "ffmpeg_path": ffmpeg_path,
            },
        )

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as err:
            state["native_stream_status"] = "error"
            state["native_stream_error"] = str(err)
            self._debug_native(cam, "error", "audio_native_stream_spawn_failed", "Failed to spawn ffmpeg", error=err)
            return

        self._native_processes[cam] = proc
        state["native_stream_status"] = "running"
        state["native_stream_restart_count"] = int(state.get("native_stream_restart_count", 0)) + 1

        stderr_task = asyncio.create_task(self._consume_ffmpeg_stderr(cam, proc))
        chunk_size = max(512, int(conf.get("native_chunk_size") or 3200))

        try:
            while True:
                if proc.stdout is None:
                    break
                chunk = await proc.stdout.read(chunk_size)
                if not chunk:
                    break
                state["native_stream_bytes"] = int(state.get("native_stream_bytes", 0)) + len(chunk)
                samples = self._decode_pcm16le(chunk)
                if not samples:
                    continue
                state["native_stream_frames"] = int(state.get("native_stream_frames", 0)) + 1
                await self.coordinator.async_ingest_audio_samples(cam, samples)
        except asyncio.CancelledError:
            raise
        except Exception as err:
            state["native_stream_status"] = "error"
            state["native_stream_error"] = str(err)
            self._debug_native(cam, "error", "audio_native_stream_read_failed", "Native audio stream read failed", error=err)
        finally:
            stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stderr_task
            proc = self._native_processes.pop(cam, None) or proc
            if proc is not None:
                with contextlib.suppress(ProcessLookupError):
                    proc.terminate()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(proc.wait(), timeout=2)
            if state.get("native_stream_status") != "error":
                state["native_stream_status"] = "stopped"
            self._debug_native(
                cam,
                "info" if state.get("native_stream_status") != "error" else "warning",
                "audio_native_stream_stopped",
                f"Native audio stream stopped for camera {cam}",
                context={
                    "frames": state.get("native_stream_frames", 0),
                    "bytes": state.get("native_stream_bytes", 0),
                    "status": state.get("native_stream_status"),
                },
            )

    async def _consume_ffmpeg_stderr(self, camera_id: str, proc: asyncio.subprocess.Process) -> None:
        if proc.stderr is None:
            return
        while True:
            line = await proc.stderr.readline()
            if not line:
                return
            text = line.decode(errors="ignore").strip()
            if not text:
                continue
            self._state[str(camera_id)]["native_stream_error"] = text[-500:]
            self._debug_native(
                str(camera_id),
                "debug",
                "audio_native_stream_stderr",
                "ffmpeg stderr",
                context={"stderr": text[-500:]},
            )

    def _decode_pcm16le(self, chunk: bytes) -> list[int]:
        if len(chunk) < 2:
            return []
        usable = len(chunk) - (len(chunk) % 2)
        if usable <= 0:
            return []
        count = usable // 2
        return list(struct.unpack("<" + ("h" * count), chunk[:usable]))

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
                    "native_stream_status": state.get("native_stream_status"),
                },
            )

    def _debug_native(
        self,
        camera_id: str,
        level: str,
        event: str,
        message: str,
        *,
        context: dict[str, Any] | None = None,
        error: Any | None = None,
    ) -> None:
        push = getattr(self.coordinator, "_push_debug_event", None)
        if callable(push):
            push(
                level=level,
                category="audio",
                event=event,
                message=message,
                camera_id=str(camera_id),
                context=context or {},
                error=error,
            )
