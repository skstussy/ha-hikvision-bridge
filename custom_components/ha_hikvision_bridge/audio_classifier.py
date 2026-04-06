from __future__ import annotations

from typing import Any


class HikvisionAudioClassifier:
    def __init__(self) -> None:
        self.available = True

    async def classify_clip(self, camera_id: str, clip: list[list[float]]) -> dict[str, Any] | None:
        if not clip:
            return None

        flattened = [max(0.0, min(float(sample), 1.0)) for frame in clip for sample in frame]
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
            }

        if avg >= 0.5 and rms >= 0.42:
            confidence = min(0.9, 0.42 + (avg * 0.22) + (rms * 0.18))
            return {"label": "scream", "confidence": round(confidence, 3)}

        if avg >= 0.32 and zero_cross >= 0.08:
            confidence = min(0.85, 0.34 + (avg * 0.2) + (zero_cross * 0.8))
            return {"label": "shout", "confidence": round(confidence, 3)}

        return {"label": "ambient", "confidence": round(max(0.05, 0.4 - avg), 3)}

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
