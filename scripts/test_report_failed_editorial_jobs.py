import contextlib
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import report_failed_editorial_jobs as mod


class FailedJobsReportTests(unittest.TestCase):
    def test_empty_report(self):
        self.assertEqual(mod.render("TOTAL|0"), ["FAILED_JOBS: 0, showing 0"])

    def test_bounded_sanitized_rows(self):
        ident = "12345678-1234-4234-8234-123456789abc"
        self.assertEqual(mod.render(
            f"TOTAL|1\nJOB|{ident}|research|3|3|bullmq_failed"
        ), [
            "FAILED_JOBS: 1, showing 1",
            f"JOB: {ident} | research | 3/3 | bullmq_failed",
        ])

    def test_reject_malformed_or_inconsistent_output(self):
        examples = (
            "",
            "TOTAL|not-a-number",
            "TOTAL|0\nJOB|123|research|1|3|other",
            "TOTAL|1",
            "TOTAL|1\nJOB|123|research|1|3|other",
            "TOTAL|1\nJOB|12345678-1234-4234-8234-123456789abc|upload|21|3|other",
            "TOTAL|1\nJOB|12345678-1234-4234-8234-123456789abc|research|1|3|unsafe text",
            "TOTAL|0\nFAIL|12345678-1234-4234-8234-123456789abc|research|1|3|other",
        )
        for raw in examples:
            with self.subTest(raw=raw[:50]):
                with self.assertRaises(ValueError):
                    mod.render(raw)

    def test_only_scoped_secret_is_mounted_into_ephemeral_client(self):
        seen = []
        def safe_run(args, timeout=20):
            seen.append(args)
            return "TOTAL|0"

        with (
            patch.object(mod.sys, "argv", ["report_failed_editorial_jobs.py", "--list"]),
            patch.object(mod, "validate_secret"),
            patch.object(mod, "preflight", return_value="sha256:ci-only"),
            patch.object(mod, "run", side_effect=safe_run),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            mod.main()
        self.assertEqual(len(seen), 1)
        cmd = seen[0]
        self.assertEqual(cmd[:3], ["docker", "run", "--rm"])
        self.assertIn("--pull=never", cmd)
        self.assertIn("--read-only", cmd)
        self.assertIn("--cap-drop=ALL", cmd)
        self.assertIn("--network", cmd)
        self.assertIn("--user", cmd)
        self.assertIn("1000:1000", cmd)
        self.assertIn("--mount", cmd)
        self.assertIn(str(mod.SECRET), " ".join(cmd))
        self.assertEqual(" ".join(cmd).count("type=bind,"), 1)
        self.assertNotIn("--privileged", cmd)
        self.assertNotIn("--publish", cmd)
        self.assertIn("FAILED_JOBS: 0", output.getvalue())

    def test_explicit_opt_in_and_fail_closed_behavior(self):
        with patch.object(mod.sys, "argv", ["report_failed_editorial_jobs.py"]):
            with self.assertRaises(RuntimeError):
                mod.main()
        with (
            patch.object(mod.sys, "argv", ["report_failed_editorial_jobs.py", "--list"]),
            patch.object(mod, "validate_secret"),
            patch.object(mod, "preflight", return_value="sha256:ci-only"),
            patch.object(mod, "run", return_value="TOTAL|2"),
        ):
            with self.assertRaises(ValueError):
                mod.main()

    def test_readonly_only_sql_and_no_editorial_activations(self):
        self.assertIn("default_transaction_read_only=on", mod.CLIENT)
        self.assertIn("vns_job_status_sync_login", mod.CLIENT)
        self.assertIn("inet_client_addr()", mod.CLIENT)
        self.assertIn("status='failed'", mod.QUERY)
        self.assertIn("LIMIT 20", mod.QUERY)
        self.assertNotIn("INSERT INTO", mod.QUERY)
        self.assertNotIn("UPDATE vns", mod.QUERY)
        self.assertNotIn("DELETE FROM", mod.QUERY)
        self.assertNotIn("docker compose", mod.CLIENT)
        result = subprocess.run(
            ["/bin/sh", "-n"], input=mod.CLIENT, text=True,
            capture_output=True, check=False, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
