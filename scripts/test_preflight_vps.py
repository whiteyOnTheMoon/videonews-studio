import unittest

from preflight_vps import GIB, assess


def measurements(**overrides):
    reading = {
        "disk_free": 25 * GIB,
        "mem_available": 3 * GIB,
        "swap_total": 2 * GIB,
        "swap_used": int(1.4 * GIB),
        "checkout": True,
        "name_collision": False,
    }
    reading.update(overrides)
    return reading


class VpsPreflightTests(unittest.TestCase):
    def test_preview_gate_passes_under_measured_resource_snapshot_with_checkout(self):
        allowed, findings = assess(measurements(), "preview")
        self.assertTrue(allowed)
        self.assertEqual(len(findings), 5)

    def test_build_gate_blocks_measured_disk_and_swap(self):
        allowed, findings = assess(measurements(), "build")
        self.assertFalse(allowed)
        self.assertTrue(any("disk free" in item and item.startswith("BLOCK") for item in findings))
        self.assertTrue(any("swap used" in item and item.startswith("BLOCK") for item in findings))

    def test_missing_checkout_blocks_preview(self):
        self.assertFalse(assess(measurements(checkout=False), "preview")[0])

    def test_existing_project_name_blocks_preview(self):
        self.assertFalse(assess(measurements(name_collision=True), "preview")[0])

    def test_low_memory_blocks_preview(self):
        self.assertFalse(assess(measurements(mem_available=GIB), "preview")[0])

    def test_excessive_swap_blocks_preview(self):
        self.assertFalse(assess(measurements(swap_used=int(1.8 * GIB)), "preview")[0])

    def test_no_swap_is_accepted(self):
        self.assertTrue(assess(measurements(swap_total=0, swap_used=0), "preview")[0])

    def test_unknown_mode_fails_closed(self):
        with self.assertRaises(ValueError):
            assess(measurements(), "deploy")


if __name__ == "__main__":
    unittest.main()
