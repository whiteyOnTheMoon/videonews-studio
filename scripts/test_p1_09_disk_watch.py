import tempfile
from types import SimpleNamespace
import unittest

from p1_09_disk_watch import GIB, assess_disk, check_disk, main


class DiskWatchTests(unittest.TestCase):
    def test_absolute_thresholds(self):
        self.assertEqual(assess_disk(100 * GIB, 30 * GIB).level, "OK")
        self.assertEqual(assess_disk(100 * GIB, 19 * GIB).level, "WARN")
        self.assertEqual(assess_disk(100 * GIB, 9 * GIB).level, "CRITICAL")

    def test_relative_thresholds_on_large_disk(self):
        self.assertEqual(assess_disk(300 * GIB, 35 * GIB).level, "WARN")
        self.assertEqual(assess_disk(300 * GIB, 20 * GIB).level, "CRITICAL")

    def test_exact_boundaries(self):
        self.assertEqual(assess_disk(100 * GIB, 20 * GIB).exit_code, 0)
        self.assertEqual(assess_disk(100 * GIB, 10 * GIB).exit_code, 2)
        self.assertEqual(assess_disk(100 * GIB, 8 * GIB).exit_code, 3)

    def test_invalid_metrics_fail_closed(self):
        for total, free in [(0, 0), (10, -1), (10, 11), (True, 1), (10.0, 2)]:
            with self.assertRaises(ValueError):
                assess_disk(total, free)

    def test_read_only_usage_injected(self):
        calls = []
        with tempfile.TemporaryDirectory() as path:
            def usage(requested):
                calls.append(requested)
                return SimpleNamespace(total=100 * GIB, free=19 * GIB)
            self.assertEqual(check_disk(path, usage).level, "WARN")
            self.assertEqual(calls, [path])

    def test_missing_directory_reports_unknown(self):
        self.assertEqual(main(["--path", "/this-directory-does-not-exist-vns"]), 4)


if __name__ == "__main__":
    unittest.main()
