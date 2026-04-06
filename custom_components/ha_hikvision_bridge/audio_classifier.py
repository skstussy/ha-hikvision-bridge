from __future__ import annotations


class HikvisionAudioClassifier:
    def __init__(self) -> None:
        self.available = False

    async def classify_clip(self, camera_id: str, clip: list[list[float]]) -> dict | None:
        if not clip:
            return None

        # Stub only. Replace later with a real model runner.
        total = 0.0
        count = 0
        peak = 0.0
        for frame in clip:
            if not frame:
                continue
            total += sum(frame)
            count += len(frame)
            peak = max(peak, max(frame))

        if count == 0:
            return None

        avg = total / count

        if peak > 0.97 and avg > 0.55:
            return {"label": "impact", "confidence": 0.72}
        if avg > 0.48:
            return {"label": "scream", "confidence": 0.68}
        if avg > 0.35:
            return {"label": "shout", "confidence": 0.63}
        return {"label": "ambient", "confidence": 0.40}
