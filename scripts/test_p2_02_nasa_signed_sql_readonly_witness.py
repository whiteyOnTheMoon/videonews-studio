"""No-network contract and false-full-registry rejection regression tests."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import p2_02_nasa_signed_sql_readonly_witness as m


def entry(id: str, host: str, status: str = "approved") -> dict[str, str]:
    return {"id": id, "baseUrl": f"https://{host}/news/", "status": status}


NASA = entry("nasa_news", "www.nasa.gov")
NOAA = entry("noaa_news", "www.noaa.gov")
USGS = entry("usgs_news", "www.usgs.gov")
HOSTS = ["www.nasa.gov", "www.noaa.gov", "www.usgs.gov"]
SIGNED = [NASA, NOAA, USGS]


class ParityTests(unittest.TestCase):
    def test_subset_of_approved_hosts_is_valid_even_when_full_db_is_larger(self):
        extra = entry("other_pending", "www.example.com", "pending")
        status = m.registry_parity(SIGNED + [extra], SIGNED, HOSTS)
        self.assertFalse(status["full_registry_equal"])
        self.assertTrue(status["approved_host_subset_equal"])
        self.assertTrue(status["approved_sources_only_on_granted_hosts"])

    def test_reject_hidden_blocked_child_and_approved_ungranted_host(self):
        blocked_child = entry("nasa_child_blocked", "www.nasa.gov", "blocked")
        status = m.registry_parity(SIGNED + [blocked_child], SIGNED, HOSTS)
        self.assertFalse(status["approved_host_subset_equal"])
        status = m.registry_parity(
            SIGNED + [entry("outside_approved", "www.example.com")], SIGNED, HOSTS
        )
        self.assertFalse(status["approved_sources_only_on_granted_hosts"])

    def test_reject_missing_source_or_invalid_host_without_logging_registry(self):
        self.assertFalse(
            m.registry_parity(SIGNED, SIGNED + [entry("missing", "www.nasa.gov")], HOSTS)[
                "approved_host_subset_equal"
            ]
        )
        self.assertFalse(m.registry_parity(SIGNED, SIGNED, "invalid")[
            "approved_host_subset_equal"
        ])
        self.assertFalse(m.registry_parity(
            SIGNED + [{"id": "evil", "baseUrl": "http://www.nasa.gov/news/"}],
            SIGNED, HOSTS,
        )["approved_host_subset_equal"])

    def fixture(self, *, extra=True):
        registry = SIGNED + ([entry("private_pending", "www.example.com", "pending")] if extra else [])
        env = {
            "export": {
                "sourceRevision": 10,
                "hostApprovalRevision": 10,
                "allowedHosts": HOSTS,
                "registryJson": json.dumps({"version": 1, "sources": SIGNED}),
            }
        }
        inbox = json.dumps(env).encode()
        cp = json.dumps({
            "version": 1,
            "sourceRevision": 10,
            "hostApprovalRevision": 10,
            "envelopeSha256": hashlib.sha256(inbox).hexdigest(),
        }).encode()
        row = {
            "source_revision": 10, "host_revision": 10, "sources": registry,
            "approved_hosts": HOSTS, "anchor_digest_ok": True, "policy_ok": True,
        }
        return inbox, cp, row

    def test_witness_returns_redacted_bools_and_accepts_legitimate_db_extra(self):
        inbox, cp, row = self.fixture()
        with (
            patch.object(m, "release"),
            patch.object(m, "command", return_value="PASS"),
            patch.object(m, "protected_read", side_effect=[inbox, inbox, cp]),
            patch.object(m, "sql_read", return_value=row),
        ):
            result = m.inspect("a" * 40)
        self.assertEqual(result["status"], "parity_reviewable")
        self.assertTrue(result["sql_approved_host_subset_equal_signed"])
        self.assertFalse(result["sql_full_registry_equal_signed"])
        self.assertTrue(result["checkpoint_matches_inbox_10_10"])
        self.assertFalse(result["production_authorized"])
        self.assertFalse(result["database_changed"])
        self.assertFalse(result["queue_changed"])
        rendered = json.dumps(result)
        self.assertNotIn("www.nasa.gov", rendered)
        self.assertNotIn("private_pending", rendered)
        self.assertNotIn("envelopeSha256", rendered)

    def test_refuses_wrong_checkpoint_bad_anchor_and_sql_error(self):
        inbox, cp, row = self.fixture()
        for bad_row in [
            {**row, "anchor_digest_ok": False},
            {**row, "policy_ok": False},
            {**row, "sources": SIGNED + [entry("blocked_child", "www.nasa.gov", "blocked")]},
        ]:
            with (
                patch.object(m, "release"),
                patch.object(m, "command", return_value="PASS"),
                patch.object(m, "protected_read", side_effect=[inbox, inbox, cp]),
                patch.object(m, "sql_read", return_value=bad_row),
            ):
                self.assertEqual(m.inspect("a" * 40)["status"], "blocked")
        invalid_cp = json.dumps({"version": 1, "sourceRevision": 7}).encode()
        with (
            patch.object(m, "release"),
            patch.object(m, "command", return_value="PASS"),
            patch.object(m, "protected_read", side_effect=[inbox, inbox, invalid_cp]),
            patch.object(m, "sql_read", return_value=row),
        ):
            self.assertEqual(m.inspect("a" * 40)["status"], "blocked")
        with (
            patch.object(m, "release"),
            patch.object(m, "command", return_value="PASS"),
            patch.object(m, "protected_read", side_effect=[inbox, inbox, cp]),
            patch.object(m, "sql_read", side_effect=RuntimeError("SECRET_QUERY_ERROR")),
        ):
            result = m.inspect("a" * 40)
        self.assertFalse(result["database_readable"])
        self.assertEqual(result["status"], "blocked")
        self.assertNotIn("SECRET_QUERY_ERROR", json.dumps(result))

    def test_protected_read_real_regular_file_stat_result_uses_st_fields(self):
        # Regression: os.stat_result has st_dev/st_ino/st_size/st_mtime_ns
        # and st_ctime_ns, not .dev/.ino/.size/.mtime_ns/.ctime_ns.
        # Use a REAL file; mocking protected_read used to hide the crash.
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "source-export.signed.json"
            payload = b'{"format":"fixture","version":1}'
            path.write_bytes(payload)
            path.chmod(0o600)
            self.assertEqual(
                m.protected_read(path, os.getuid(), os.getgid(), 0o600),
                payload,
            )
            with self.assertRaises(RuntimeError):
                m.protected_read(path, os.getuid(), os.getgid(), 0o640)

    def test_protected_read_rejects_symlink_and_changes_to_file_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "source-export.signed.json"
            path.write_bytes(b'{"format":"fixture","version":1}')
            path.chmod(0o600)
            alias = Path(root) / "alias.signed.json"
            alias.symlink_to(path)
            with self.assertRaises(OSError):
                m.protected_read(alias, os.getuid(), os.getgid(), 0o600)
            before = os.stat(path)
            # Keep the real first fstat; falsify the second to exercise
            # the TOCTOU metadata check without touching any real feed.
            real_fstat = os.fstat
            readings = iter([before, os.stat_result([
                before.st_mode, before.st_ino, before.st_dev,
                before.st_nlink, before.st_uid, before.st_gid,
                before.st_size + 1, before.st_atime, before.st_mtime,
                before.st_ctime,
            ])])
            with patch.object(m.os, "fstat", side_effect=lambda fd: next(readings)):
                with self.assertRaises(RuntimeError):
                    m.protected_read(path, os.getuid(), os.getgid(), 0o600)

    def test_release_failure_exits_before_files_or_sql(self):
        with (
            patch.object(m, "release", side_effect=RuntimeError(m.DENIED)),
            patch.object(m, "protected_read") as read,
            patch.object(m, "sql_read") as sql,
        ):
            with self.assertRaises(RuntimeError):
                m.inspect("a" * 40)
            read.assert_not_called()
            sql.assert_not_called()


if __name__ == "__main__":
    unittest.main()
