"""Exercise the actual bundled model: identity, rest, propagation and recovery."""
from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from brain_worker import Brain


class BrainTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.brain = Brain()
        cls.rest_state = cls.brain.state

    def setUp(self):
        self.brain.state = self.rest_state

    def test_bundle_identity_and_gray_rest(self):
        b = self.brain
        self.assertEqual((b.count, b.edge_count, b.column_count), (19463, 340922, 437))
        self.assertEqual(b.neuron_hash, "d197716db5254ea0")
        for _ in range(10):
            values = b.advance([])
            self.assertEqual(values.dtype, np.int8)
            self.assertEqual(len(values), b.count)
            self.assertEqual(np.count_nonzero(values), 0)

    def test_visual_input_propagates_with_both_signs_and_recovers(self):
        b = self.brain
        patch = {"center": [-0.7, 0, 1], "half_size": [0.3, 0.3],
                 "luminance": 1, "chroma": 1}
        for _ in range(15):
            values = b.advance([patch])
        self.assertGreater(np.count_nonzero(values > 0), 0)
        self.assertGreater(np.count_nonzero(values < 0), 0)
        roles = b.neurons["role"].to_numpy()
        # Activity is propagated through the graph, not restricted to stimulated inputs.
        self.assertGreater(np.count_nonzero(values[roles == "projection"]), 0)
        for _ in range(90):
            values = b.advance([])
        self.assertEqual(np.count_nonzero(values), 0)

    def test_left_and_right_stimuli_reach_different_neurons(self):
        patterns = []
        for side in [-1, 1]:
            self.brain.state = self.rest_state
            for _ in range(10):
                values = self.brain.advance([{"center": [side * 0.7, 0, 1],
                    "half_size": [0.3, 0.3], "luminance": 1, "chroma": 1}])
            patterns.append(values)
        self.assertGreater(np.count_nonzero(patterns[0] != patterns[1]), 100)

    def test_covering_an_eye_removes_only_its_visual_input(self):
        b = self.brain
        patches = [{"center": [-0.7, 0, 1], "half_size": [0.3, 0.3],
                    "luminance": 1, "chroma": 1}]
        open_eye = np.asarray(b.retina(patches))
        left = np.asarray(b.left_columns)
        self.assertGreater(np.count_nonzero(np.abs(open_eye[:, left] - 0.5) > 0.01), 0)
        for field, covered in [("blindLeft", left), ("blindRight", ~left)]:
            observed = np.asarray(b.retina(patches, {field: True}))
            np.testing.assert_array_equal(observed[:, covered], 0.5)
            np.testing.assert_array_equal(observed[:, ~covered], open_eye[:, ~covered])
        for _ in range(10):
            values = b.advance(patches, {"blindLeft": True, "blindRight": True})
        self.assertEqual(np.count_nonzero(values), 0)

    def test_target_color_changes_chroma_without_changing_luminance(self):
        b = self.brain
        patch = {"center": [-0.7, 0, 1], "half_size": [0.3, 0.3], "luminance": 1}
        red = np.asarray(b.retina([{**patch, "chroma": 1}]))
        blue = np.asarray(b.retina([{**patch, "chroma": 0}]))
        np.testing.assert_array_equal(red[0], blue[0])
        self.assertGreater(np.max(np.abs(red[1] - blue[1])), 0.2)

    def test_stimulation_changes_selected_neuron_and_releases(self):
        b = self.brain
        index = int(b.graph.input_neuron[0])
        for _ in range(10):
            values = b.advance([], {"stimulate": {"index": index, "current": 0.75}})
        self.assertGreater(int(values[index]), 0)
        self.assertGreater(np.count_nonzero(values), 1)
        for _ in range(90):
            values = b.advance([])
        self.assertIsNone(b.stimulation)
        self.assertEqual(np.count_nonzero(values), 0)


if __name__ == "__main__":
    unittest.main()
