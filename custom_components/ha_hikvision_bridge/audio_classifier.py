from __future__ import annotations

import csv
from dataclasses import dataclass
import importlib
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class _YamnetRuntime:
    tf: Any
    np: Any
    model: Any
    class_names: list[str]


class _SignalHeuristicAudioClassifier:
    def classify_clip(self, clip: list[list[float]]) -> dict[str, Any] | None:
        if not clip:
            return None

        flattened = [max(0.0, min(abs(float(sample)), 1.0)) for frame in clip for sample in frame]
        if len(flattened) < 8:
            return None

        avg = sum(flattened) / len(flattened)
        peak = max(flattened)
        energy = sum(sample * sample for sample in flattened) / len(flattened)
        rms = energy ** 0.5
        crest = peak / max(rms, 0.0001)
        transient = self._transient_score(flattened)
        zero_cross = self._zero_crossing_score(flattened)
        tail_avg = sum(flattened[-max(4, len(flattened) // 10):]) / max(4, len(flattened) // 10)

        if transient >= 0.58 and peak >= 0.9 and crest >= 2.4 and tail_avg <= avg * 0.92:
            confidence = min(0.99, 0.58 + (transient * 0.18) + (peak * 0.12) + min(crest / 10.0, 0.11))
            return {
                "label": "gunshot",
                "confidence": round(confidence, 3),
                "metrics": {
                    "avg": round(avg, 4),
                    "peak": round(peak, 4),
                    "rms": round(rms, 4),
                    "crest": round(crest, 4),
                    "transient": round(transient, 4),
                    "zero_crossing": round(zero_cross, 4),
                },
                "source": "signal_heuristic",
                "backend": "signal_heuristic",
            }

        if transient >= 0.42 and peak >= 0.8 and crest >= 1.9:
            confidence = min(0.95, 0.48 + (transient * 0.22) + (peak * 0.14))
            return {
                "label": "impact",
                "confidence": round(confidence, 3),
                "metrics": {
                    "avg": round(avg, 4),
                    "peak": round(peak, 4),
                    "rms": round(rms, 4),
                    "crest": round(crest, 4),
                    "transient": round(transient, 4),
                    "zero_crossing": round(zero_cross, 4),
                },
                "source": "signal_heuristic",
                "backend": "signal_heuristic",
            }

        if avg >= 0.5 and rms >= 0.42:
            confidence = min(0.9, 0.42 + (avg * 0.22) + (rms * 0.18))
            return {
                "label": "scream",
                "confidence": round(confidence, 3),
                "source": "signal_heuristic",
                "backend": "signal_heuristic",
            }

        if avg >= 0.32 and zero_cross >= 0.08:
            confidence = min(0.85, 0.34 + (avg * 0.2) + (zero_cross * 0.8))
            return {
                "label": "shout",
                "confidence": round(confidence, 3),
                "source": "signal_heuristic",
                "backend": "signal_heuristic",
            }

        return {
            "label": "ambient",
            "confidence": round(max(0.05, 0.4 - avg), 3),
            "source": "signal_heuristic",
            "backend": "signal_heuristic",
        }

    def _transient_score(self, samples: list[float]) -> float:
        if len(samples) < 4:
            return 0.0
        diffs = [abs(samples[index] - samples[index - 1]) for index in range(1, len(samples))]
        return min(1.0, (sum(diffs) / len(diffs)) * 2.6)

    def _zero_crossing_score(self, samples: list[float]) -> float:
        centered = [sample - 0.5 for sample in samples]
        crossings = 0
        for index in range(1, len(centered)):
            prev = centered[index - 1]
            cur = centered[index]
            if (prev <= 0.0 < cur) or (prev >= 0.0 > cur):
                crossings += 1
        return crossings / max(1, len(centered) - 1)


class HikvisionAudioClassifier:
    _YAMNET_SAMPLE_RATE = 16000
    _MAX_SECONDS = 4.8
    _EVENT_MAP: dict[str, tuple[str, ...]] = {
        "gunshot": ("gunshot", "fireworks", "explosion"),
        "impact": ("bang", "slam", "thud", "thump", "smash", "breaking", "shatter", "crash"),
        "scream": ("scream", "screaming", "shriek", "crying, sobbing", "wail"),
        "shout": ("shout", "yell", "bellow", "children shouting", "whoop"),
    }

    def __init__(self) -> None:
        self.available = True
        self._heuristic = _SignalHeuristicAudioClassifier()
        self._runtime: _YamnetRuntime | None = None
        self._load_error: str | None = None

    async def classify_clip(
        self,
        hass,
        camera_id: str,
        clip: list[list[float]],
        *,
        sample_rate: int = 16000,
        preferred_backend: str = "yamnet",
        model_source: str | None = None,
    ) -> dict[str, Any] | None:
        if not clip:
            return None

        backend = str(preferred_backend or "yamnet").strip().lower()
        if backend == "heuristic":
            return self._heuristic.classify_clip(clip)

        if backend == "yamnet":
            try:
                return await hass.async_add_executor_job(
                    self._classify_clip_yamnet_sync,
                    clip,
                    sample_rate,
                    model_source or "https://tfhub.dev/google/yamnet/1",
                )
            except Exception as err:
                self._load_error = str(err)
                fallback = self._heuristic.classify_clip(clip)
                if fallback is None:
                    return None
                metrics = dict(fallback.get("metrics") or {})
                metrics["fallback_reason"] = str(err)
                fallback["metrics"] = metrics
                fallback["source"] = "signal_heuristic"
                fallback["backend"] = "signal_heuristic"
                fallback["requested_backend"] = "yamnet"
                return fallback

        return self._heuristic.classify_clip(clip)

    def _classify_clip_yamnet_sync(
        self,
        clip: list[list[float]],
        sample_rate: int,
        model_source: str,
    ) -> dict[str, Any] | None:
        runtime = self._ensure_yamnet_runtime(model_source)
        waveform = self._prepare_waveform(runtime.np, clip, sample_rate)
        if waveform is None:
            return None

        scores, embeddings, _ = runtime.model(waveform)
        scores_np = runtime.np.array(scores)
        if scores_np.size == 0:
            return None

        class_scores = scores_np.mean(axis=0)
        if class_scores.ndim != 1:
            class_scores = runtime.np.squeeze(class_scores)
        top_indices = runtime.np.argsort(class_scores)[::-1][:5]

        top_classes = []
        for index in top_indices.tolist():
            score = float(class_scores[index])
            label = runtime.class_names[index] if index < len(runtime.class_names) else str(index)
            top_classes.append({"label": label, "confidence": round(score, 4)})

        mapped = self._map_yamnet_scores(runtime.class_names, class_scores)
        metrics = {
            "yamnet_top_classes": top_classes,
            "embedding_frames": int(getattr(embeddings, "shape", [0])[0] or 0),
            "embedding_width": int(getattr(embeddings, "shape", [0, 0])[1] or 0),
            "requested_sample_rate": int(sample_rate or self._YAMNET_SAMPLE_RATE),
            "yamnet_sample_rate": self._YAMNET_SAMPLE_RATE,
            "window_seconds": round(float(len(waveform)) / float(self._YAMNET_SAMPLE_RATE), 3),
        }
        metrics.update(mapped.get("metrics") or {})

        return {
            "label": mapped["label"],
            "confidence": round(float(mapped["confidence"]), 3),
            "metrics": metrics,
            "source": "yamnet",
            "backend": "yamnet",
        }

    def _ensure_yamnet_runtime(self, model_source: str) -> _YamnetRuntime:
        if self._runtime is not None:
            return self._runtime

        np = importlib.import_module("numpy")
        tf = importlib.import_module("tensorflow")
        hub = importlib.import_module("tensorflow_hub")
        model = hub.load(model_source)

        class_map_path = model.class_map_path().numpy().decode("utf-8")
        class_names: list[str] = []
        with Path(class_map_path).open("r", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                name = str(row.get("display_name") or "").strip()
                if name:
                    class_names.append(name)

        self._runtime = _YamnetRuntime(tf=tf, np=np, model=model, class_names=class_names)
        self._load_error = None
        return self._runtime

    def _prepare_waveform(self, np, clip: list[list[float]], sample_rate: int):
        flattened = [float(sample) for frame in clip for sample in frame]
        if not flattened:
            return None

        target_sr = self._YAMNET_SAMPLE_RATE
        max_samples = int(target_sr * self._MAX_SECONDS)
        if sample_rate and int(sample_rate) != target_sr:
            flattened = self._resample_linear(flattened, int(sample_rate), target_sr)
        if len(flattened) > max_samples:
            flattened = flattened[-max_samples:]

        waveform = np.asarray(flattened, dtype=np.float32)
        waveform = np.clip(waveform, -1.0, 1.0)
        if waveform.size < int(target_sr * 0.48):
            return None
        return waveform

    def _resample_linear(self, samples: list[float], input_rate: int, output_rate: int) -> list[float]:
        if not samples or input_rate <= 0 or output_rate <= 0 or input_rate == output_rate:
            return list(samples)

        duration = len(samples) / float(input_rate)
        output_length = max(1, int(round(duration * output_rate)))
        if len(samples) == 1:
            return [samples[0]] * output_length

        resampled: list[float] = []
        scale = (len(samples) - 1) / max(output_length - 1, 1)
        for out_index in range(output_length):
            position = out_index * scale
            left_index = int(position)
            right_index = min(left_index + 1, len(samples) - 1)
            blend = position - left_index
            sample = (samples[left_index] * (1.0 - blend)) + (samples[right_index] * blend)
            resampled.append(float(sample))
        return resampled

    def _map_yamnet_scores(self, class_names: list[str], class_scores) -> dict[str, Any]:
        score_by_label: dict[str, float] = {}
        matched_classes: dict[str, list[dict[str, float]]] = {}

        for label, tokens in self._EVENT_MAP.items():
            best = 0.0
            matches: list[dict[str, float]] = []
            for index, class_name in enumerate(class_names):
                text = class_name.lower()
                if not any(token in text for token in tokens):
                    continue
                score = float(class_scores[index])
                if score <= 0.0:
                    continue
                matches.append({"label": class_name, "confidence": round(score, 4)})
                if score > best:
                    best = score
            score_by_label[label] = best
            if matches:
                matches.sort(key=lambda item: item["confidence"], reverse=True)
                matched_classes[label] = matches[:4]

        ranked = sorted(score_by_label.items(), key=lambda item: item[1], reverse=True)
        best_label, best_score = ranked[0] if ranked else ("ambient", 0.0)
        if best_score <= 0.0:
            return {"label": "ambient", "confidence": 0.1, "metrics": {"yamnet_event_scores": score_by_label}}

        return {
            "label": best_label,
            "confidence": best_score,
            "metrics": {
                "yamnet_event_scores": {key: round(value, 4) for key, value in score_by_label.items()},
                "yamnet_matched_classes": matched_classes,
            },
        }
