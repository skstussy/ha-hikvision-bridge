from __future__ import annotations

from io import BytesIO
import importlib
from typing import Any


class HikvisionVideoClassifier:
    def __init__(self) -> None:
        self.available = True
        self._model = None
        self._model_source: str | None = None
        self._load_error: str | None = None

    async def classify_image(
        self,
        hass,
        camera_id: str,
        image_bytes: bytes,
        *,
        model_source: str,
        confidence: float = 0.45,
        image_size: int = 640,
        max_detections: int = 10,
        device: str | None = None,
        target_labels: list[str] | None = None,
    ) -> dict[str, Any] | None:
        if not image_bytes:
            return None
        try:
            return await hass.async_add_executor_job(
                self._classify_image_sync,
                image_bytes,
                model_source,
                confidence,
                image_size,
                max_detections,
                device,
                target_labels or [],
            )
        except Exception as err:
            self._load_error = str(err)
            return {
                "label": None,
                "confidence": 0.0,
                "detections": [],
                "backend": "ultralytics",
                "device": device or "auto",
                "error": str(err),
            }

    def _classify_image_sync(
        self,
        image_bytes: bytes,
        model_source: str,
        confidence: float,
        image_size: int,
        max_detections: int,
        device: str | None,
        target_labels: list[str],
    ) -> dict[str, Any] | None:
        model = self._ensure_model(model_source)
        pil_image = self._load_pil_image(image_bytes)
        target_set = {str(item).strip().lower() for item in target_labels if str(item).strip()}

        kwargs: dict[str, Any] = {
            "conf": float(confidence or 0.45),
            "imgsz": int(image_size or 640),
            "max_det": int(max_detections or 10),
            "verbose": False,
        }
        if device not in {None, "", "auto"}:
            kwargs["device"] = device

        results = model.predict(pil_image, **kwargs)
        if not results:
            return {
                "label": None,
                "confidence": 0.0,
                "detections": [],
                "backend": "ultralytics",
                "device": device or "auto",
            }

        result = results[0]
        names = getattr(result, "names", {}) or {}
        boxes = getattr(result, "boxes", None)
        detections: list[dict[str, Any]] = []
        if boxes is not None:
            xyxy = getattr(boxes, "xyxy", None)
            confs = getattr(boxes, "conf", None)
            classes = getattr(boxes, "cls", None)
            total = len(classes) if classes is not None else 0
            for index in range(total):
                cls_id = int(float(classes[index]))
                label = str(names.get(cls_id, cls_id)).strip().lower()
                if target_set and label not in target_set:
                    continue
                box = xyxy[index].tolist() if xyxy is not None else [0, 0, 0, 0]
                detections.append(
                    {
                        "label": label,
                        "confidence": round(float(confs[index]), 4) if confs is not None else 0.0,
                        "bbox": [round(float(value), 2) for value in box],
                    }
                )

        detections.sort(key=lambda item: item["confidence"], reverse=True)
        top = detections[0] if detections else None
        return {
            "label": top["label"] if top else None,
            "confidence": float(top["confidence"]) if top else 0.0,
            "detections": detections[: max(1, int(max_detections or 10))],
            "backend": "ultralytics",
            "device": device or "auto",
        }

    def _ensure_model(self, model_source: str):
        if self._model is not None and self._model_source == model_source:
            return self._model
        ultralytics = importlib.import_module("ultralytics")
        self._model = ultralytics.YOLO(model_source)
        self._model_source = model_source
        self._load_error = None
        return self._model

    def _load_pil_image(self, image_bytes: bytes):
        pil = importlib.import_module("PIL.Image")
        return pil.open(BytesIO(image_bytes)).convert("RGB")
