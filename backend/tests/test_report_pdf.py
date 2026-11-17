"""Informe PDF: mapas de calor de todos los fotogramas, sin red, BD ni modelos."""
import base64
import io
import re
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

from PIL import Image

from app.forensic_workflow import with_plates
from app.report_pdf import build_forensic_pdf
from app.storage.ports import StorageError


def jpeg(shade: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 36), (shade, 255 - shade, 40)).save(buffer, "JPEG")
    return buffer.getvalue()


def data_uri(raw: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")


CASE = SimpleNamespace(id="case-1", case_number="FGE-2026-0001", title="Suplantación en videollamada")
EVIDENCE = SimpleNamespace(id="evidence-1", file_name="video.mp4", mime_type="video/mp4", file_size_bytes=1_048_576,
                           uploaded_at=datetime(2026, 11, 10, tzinfo=timezone.utc))
PERITO = SimpleNamespace(id="perito-1", first_name="María José", last_name="Núñez", identifier="1104567890", email="mj@example.test")


def video_result(frames: int = 24, images: bool = True) -> dict:
    return {
        "prediction": "Fake", "verdict_forensic": "MANIPULADO", "confidence": 91.4, "frames_analyzed": frames, "faces_detected": frames,
        "processing_time_seconds": 80.0, "models": {"synthesis_gan": 0.1, "faceswap_dfdc": 0.91, "diffusion_modern": 0.3},
        "suspicious_seconds": [{"second": 1.2, "score": 0.8}],
        "explanation": {"image": data_uri(jpeg(250)) if images else None, "second": 1.2, "featured_index": 3, "weights": {"faceswap_dfdc": 0.91},
                        "frames": [{"image": data_uri(jpeg(i * 10)) if images else None, "second": i * 0.4, "signal": i / frames, "index": i}
                                   for i in range(frames)]},
    }


def build(result: dict, **extra) -> bytes:
    return build_forensic_pdf(case=CASE, evidence=EVIDENCE, report_id="report-1", result=result,
                              original_sha256="a" * 64, working_sha256="a" * 64, perito=PERITO, **extra)


def embedded_images(pdf: bytes) -> int:
    return len(re.findall(rb"/Subtype\s*/Image", pdf))


class ReportPdfTests(unittest.TestCase):
    def test_every_analyzed_frame_and_the_featured_heatmap_are_embedded(self):
        pdf = build(video_result(), expert_conclusions="Revisión completa de la secuencia.",
                    audit_events=[{"timestamp": "2026-11-10T15:00:00+00:00", "actor": "perito", "action": "CASE_CREATED"}])
        self.assertTrue(pdf.startswith(b"%PDF"))
        # 24 fotogramas + mapa destacado + logo de la cabecera.
        self.assertGreaterEqual(embedded_images(pdf), 26)

    def test_missing_plates_or_still_images_never_block_the_report(self):
        self.assertTrue(build(video_result(images=False)).startswith(b"%PDF"))
        still = {"prediction": "Real", "verdict_forensic": "SIN_MANIPULACION", "confidence": 88, "faces_detected": 1,
                 "models": {"synthesis_gan": 0.05}, "explanation": {"image": data_uri(jpeg(10)), "weights": {"synthesis_gan": 0.05}}}
        self.assertTrue(build(still).startswith(b"%PDF"))
        self.assertTrue(build({"prediction": "Suspect", "caveat": "Señal sin corroborar."}).startswith(b"%PDF"))

    def test_finalized_report_restores_sealed_heatmaps_and_tolerates_unreadable_ones(self):
        result = video_result(frames=3, images=False)
        explanation = result["explanation"]
        for index, item in enumerate([explanation, *explanation["frames"]]):
            item.pop("image")
            item["artifact"] = {"uri": f"plate-{index}"}
        rows = [SimpleNamespace(id=f"row-{index}", kind="plate", storage_uri=f"plate-{index}", sha256="b" * 64, size_bytes=10,
                                content_type="image/jpeg", manifest_uri="manifest", manifest_sha256="c" * 64, manifest_size_bytes=10)
                for index in range(4)]
        db = MagicMock()
        db.query.return_value.filter.return_value.all.return_value = rows
        storage = MagicMock()

        def read(artifact):
            if artifact.uri == "plate-2":
                raise StorageError("objeto no disponible")
            return jpeg(100)
        storage.read.side_effect = read

        restored = with_plates(storage, db, CASE, EVIDENCE, PERITO, "report-1", result)
        self.assertTrue(restored["explanation"]["image"].startswith("data:image/jpeg;base64,"))
        self.assertTrue(restored["explanation"]["frames"][0]["image"].startswith("data:image/jpeg;base64,"))
        self.assertNotIn("image", restored["explanation"]["frames"][1])  # la ilegible se omite
        self.assertEqual(storage.verify.call_count, 4)
        self.assertNotIn("image", result["explanation"])  # el resultado archivado no se modifica
        self.assertTrue(build(restored).startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
