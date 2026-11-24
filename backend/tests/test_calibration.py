"""Estadística y simulador de la calibración: sin modelos, red ni BD."""
import random
import unittest

from app import video_rule
from scripts.calibrate_catalog import auc, best_threshold, build_summary, percentile, second_max, simulate, spearman

T = video_rule.current_limits()


def record(label="Real", gan=0.05, swap=0.02, diff=0.1, scene=0.2, n_context=24, prediction=None, frames=24, rng=None, swaps=None):
    """`swaps`: puntuación de face swap por fotograma (por defecto, `swap` en todos)."""
    rng = rng or random.Random(0)
    cam = {key: {"on_face": 0.6, "area25": 0.4} for key in ("synthesis_gan", "faceswap_dfdc", "diffusion_modern")}
    swaps = swaps or [swap] * frames
    rows = [{"i": i, "found": True, "p_gan": gan, "p_swap": swaps[i], "p_diff": diff, "face_px": [200 + i, 220], "face_fraction": 0.2,
             "sharp": 100 + rng.random() * 50, "bright": 120 + i, "cam": cam} for i in range(frames)]
    result = {"file": f"{label}/{rng.random()}.mp4", "label": label, "ok": True, "frames": rows,
              "scene": {"n_context": n_context, "probes": [{"frame": 0, "production": True, "score": scene}, {"frame": 12, "production": True, "score": scene},
                                                            {"frame": 6, "production": False, "score": scene + 0.05}]},
              "heatmap": {"stability": {"synthesis_gan": 0.8, "faceswap_dfdc": 0.7, "diffusion_modern": 0.9}},
              "meta": {"duration_s": 9.5, "width": 720, "height": 1280, "over_upload_limit": False}, "timing": {"total_s": 150.0}}
    result["production"] = {"prediction": prediction or simulate(result, T), "confidence": 90.0, "caveat": None}
    return result


class StatisticsTests(unittest.TestCase):
    def test_auc_handles_separation_ties_and_inversion(self):
        self.assertEqual(auc([0.9, 0.8], [0.1, 0.2]), 1.0)
        self.assertEqual(auc([0.1], [0.9]), 0.0)
        self.assertEqual(auc([0.5, 0.5], [0.5]), 0.5)

    def test_threshold_percentile_and_rank_correlation(self):
        threshold, tpr, fpr = best_threshold([0.8, 0.9, 0.7], [0.1, 0.2, 0.5])
        self.assertEqual((tpr, fpr), (1.0, 0.0))
        self.assertTrue(0.5 < threshold < 0.7)
        self.assertEqual(percentile([0, 10], 0.25), 2.5)
        self.assertAlmostEqual(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
        self.assertAlmostEqual(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1.0)

    def test_second_max_requires_two_detections(self):
        self.assertEqual(second_max([0.9, 0.1, 0.05]), 0.1)
        self.assertEqual(second_max([0.9]), 0.9)
        self.assertEqual(second_max([]), 0.0)


class SimulatorTests(unittest.TestCase):
    """El simulador aplica app.video_rule a las señales registradas."""

    def verdict(self, **signals):
        return simulate(record(**signals))

    def test_scene_convicts_alone_and_clean_scene_certifies(self):
        self.assertEqual(self.verdict(scene=0.85), "Fake")
        self.assertEqual(self.verdict(scene=0.2), "Real")
        self.assertEqual(self.verdict(scene=0.6), "Suspect")

    def test_face_swap_must_be_sustained(self):
        spike = [0.02] * 24
        spike[5] = spike[11] = 0.99                       # dos picos separados: ruido
        self.assertEqual(self.verdict(swaps=spike), "Real")
        pair = [0.02] * 24
        pair[5] = pair[6] = 0.99                          # dos seguidos: inconcluso
        self.assertEqual(self.verdict(swaps=pair), "Suspect")
        run = [0.02] * 24
        run[5] = run[6] = run[7] = 0.9                    # tres seguidos: condena
        self.assertEqual(self.verdict(swaps=run), "Fake")

    def test_diffusion_no_longer_convicts_and_gan_only_blocks_real(self):
        self.assertEqual(self.verdict(diff=0.95, scene=0.2), "Real")
        self.assertEqual(self.verdict(gan=0.6, scene=0.2), "Suspect")
        self.assertEqual(self.verdict(gan=0.6, scene=0.9), "Fake")

    def test_alternative_thresholds_can_be_tried(self):
        self.assertEqual(simulate(record(scene=0.6), {"SCENE_FAKE_LIMIT": 0.55}), "Fake")


class SummaryTests(unittest.TestCase):
    def test_summary_reports_confusion_errors_and_simulator_agreement(self):
        rng = random.Random(7)
        records = [record("Real", diff=rng.uniform(0.02, 0.2), scene=rng.uniform(0.1, 0.4), rng=rng) for _ in range(6)]
        records += [record("Fake", swap=rng.uniform(0.6, 0.99), scene=rng.uniform(0.3, 0.9), rng=rng) for _ in range(5)]
        records.append(record("Fake", diff=0.1, scene=0.2, rng=rng))  # falso negativo
        records.append({"file": "Real/roto.mp4", "label": "Real", "ok": False, "error": "ilegible"})
        summary = build_summary(records, {"thresholds": T})
        self.assertIn("| **Fake** (6) | 1 | 0 | 5 |", summary)
        self.assertIn("coincide con producción en 12/12", summary)
        self.assertIn("| swap_sostenido3 (prod) | 0.917", summary)
        self.assertIn("Real/roto.mp4 (ilegible)", summary)
        self.assertNotIn("1b. Regla vigente", summary)

    def test_stale_simulator_is_flagged(self):
        records = [record("Real"), record("Fake", swap=0.9, prediction="Real")]
        self.assertIn("desactualizado", build_summary(records, {"thresholds": T}))

    def test_measurements_from_an_older_rule_are_resimulated(self):
        records = [record("Real", prediction="Fake"), record("Fake", swap=0.9, prediction="Fake")]
        summary = build_summary(records, {"thresholds": {"SCENE_PROBES": 2}})
        self.assertIn("## 1b. Regla vigente, simulada", summary)
        self.assertIn("| **Real** (1) | 1 | 0 | 0 |", summary.split("## 1b.")[1])


if __name__ == "__main__":
    unittest.main()
