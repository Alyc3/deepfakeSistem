"""Regla de dictamen de video (app.video_rule): sin modelos, red ni BD."""
import unittest

from app.video_rule import (CAVEAT_GAN_GUARD, CAVEAT_SCENE_GRAY, CAVEAT_SWAP_BRIEF, current_limits,
                            sustained_level, video_verdict)


class SustainedLevelTests(unittest.TestCase):
    def test_level_held_over_consecutive_frames(self):
        self.assertEqual(sustained_level([0.1, 0.9, 0.8, 0.7, 0.1], 3), 0.7)
        self.assertEqual(sustained_level([0.9, 0.1, 0.9, 0.1, 0.9], 2), 0.1)  # picos sueltos no se sostienen
        self.assertEqual(sustained_level([0.9, 0.95], 3), 0.0)                # sin fotogramas suficientes
        self.assertEqual(sustained_level([], 2), 0.0)


class VideoVerdictTests(unittest.TestCase):
    def test_conviction_by_scene_or_sustained_swap(self):
        self.assertEqual(video_verdict(0.85, 0.02, 0.02), ("Fake", 85.0, None))
        self.assertEqual(video_verdict(0.1, 0.9, 0.95), ("Fake", 90.0, None))
        self.assertEqual(video_verdict(0.9, 0.95, 0.97)[1], 95.0)  # la confianza es la señal más fuerte

    def test_real_needs_clean_scene_no_swap_pair_and_low_gan(self):
        label, confidence, caveat = video_verdict(0.2, 0.01, 0.1)
        self.assertEqual((label, caveat), ("Real", None))
        self.assertEqual(confidence, 80.0)

    def test_each_doubt_explains_itself(self):
        self.assertEqual(video_verdict(0.6, 0.0, 0.0), ("Suspect", 60.0, CAVEAT_SCENE_GRAY))
        self.assertEqual(video_verdict(0.2, 0.3, 0.9), ("Suspect", 90.0, CAVEAT_SWAP_BRIEF))
        self.assertEqual(video_verdict(0.2, 0.0, 0.0, 0.7), ("Suspect", 70.0, CAVEAT_GAN_GUARD))
        both = video_verdict(0.6, 0.3, 0.9)[2]
        self.assertIn(CAVEAT_SCENE_GRAY, both)
        self.assertIn(CAVEAT_SWAP_BRIEF, both)

    def test_without_scene_reading_nothing_is_certified(self):
        self.assertEqual(video_verdict(None, 0.0, 0.0)[0], "Suspect")
        self.assertEqual(video_verdict(None, 0.9, 0.9)[0], "Fake")

    def test_limits_can_be_overridden_without_touching_the_defaults(self):
        self.assertEqual(video_verdict(0.6, 0.0, 0.0, limits={"SCENE_FAKE_LIMIT": 0.55})[0], "Fake")
        self.assertEqual(current_limits()["SCENE_FAKE_LIMIT"], 0.8)


if __name__ == "__main__":
    unittest.main()
