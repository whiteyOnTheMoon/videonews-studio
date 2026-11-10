"""0064 operator schema gate: synthetic offline-only mock tests."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import p3_01_schema_0063_to_0064 as gate

SHA = "a" * 40
NAMES = [f"{n:04d}_synthetic" for n in range(1, 63)] + [
    gate.OLD, gate.NEW, "0065_named_feed_inbox_sources"
]
SNAPSHOT = "1" * 32


def readonly(sql, *, write=False):
    if write:
        raise AssertionError("Read-only verification tried to modify DB")
    if sql.startswith("SELECT version"):
        return "\n".join(NAMES[:63])
    if sql == gate.BASE_SQL:
        return "t"
    if sql == gate.POST_SQL:
        return "f"
    if sql == gate.STATE_SQL:
        return SNAPSHOT
    raise AssertionError("Unexpected SQL")


class AssetSchemaGateTest(unittest.TestCase):
    def mocks(self):
        return (
            patch.object(gate, "release"),
            patch.object(gate, "idle_database"),
            patch.object(gate, "migration_source", return_value="BEGIN;\nCOMMIT;"),
            patch.object(gate, "versions", return_value=NAMES),
            patch.object(gate, "asset_writers_idle"),
        )

    def test_status_and_preflight_require_no_asset_writer_shutdown(self):
        a, b, c, d, e = self.mocks()
        with a as release, b, c, d, e as idle, patch.object(
            gate, "query", side_effect=readonly
        ):
            gate.main(["--status", "--expected-sha", SHA])
            gate.main(["--preflight", "--expected-sha", SHA])
            self.assertEqual(release.call_count, 2)
            idle.assert_not_called()

    def test_default_off_rejects_apply_without_sql_write(self):
        a, b, c, d, e = self.mocks()
        with a, b, c, d, e as idle, patch.object(
            gate, "query", side_effect=readonly
        ), patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])
            idle.assert_not_called()

    def test_wrong_release_or_unverified_backup_rejected(self):
        a, b, c, d, e = self.mocks()
        for key, value in ((gate.SHA_ENV, "b" * 40),
                           (gate.RECOVERY_ENV, "not_verified")):
            env = {
                gate.APPROVAL_ENV: gate.APPROVAL,
                gate.SHA_ENV: SHA,
                gate.RECOVERY_ENV: gate.RECOVERY,
            }
            env[key] = value
            with a, b, c, d, e, patch.object(
                gate, "query", side_effect=readonly
            ), patch.dict(os.environ, env, clear=True):
                with self.assertRaises(RuntimeError):
                    gate.main(["--apply", "--expected-sha", SHA])

    def test_apply_once_and_refuse_second_install(self):
        a, b, c, d, e = self.mocks()
        writes = []

        def database(sql, *, write=False):
            if write:
                self.assertEqual(len(writes), 0)
                writes.append(sql)
                return ""
            if sql.startswith("SELECT version"):
                return "\n".join(NAMES[:64] if writes else NAMES[:63])
            if sql in (gate.BASE_SQL, gate.POST_SQL):
                return "t"
            if sql == gate.STATE_SQL:
                return SNAPSHOT
            raise AssertionError(sql[:60])

        env = {gate.APPROVAL_ENV: gate.APPROVAL,
               gate.SHA_ENV: SHA, gate.RECOVERY_ENV: gate.RECOVERY}
        with a, b, c, d, e as idle, patch.object(
            gate, "query", side_effect=database
        ), patch.dict(os.environ, env, clear=True):
            gate.main(["--apply", "--expected-sha", SHA])
            self.assertEqual(len(writes), 1)
            self.assertEqual(idle.call_count, 2)
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])
            self.assertEqual(len(writes), 1)

    def test_missing_0063_refuses_any_action(self):
        a, b, c, d, e = self.mocks()
        writes = []

        def incomplete(sql, *, write=False):
            if write:
                writes.append(sql)
                raise AssertionError("Missing earlier migration")
            if sql.startswith("SELECT version"):
                return "\n".join(NAMES[:62])
            raise AssertionError("Missing 0063 must stop immediately")

        env = {gate.APPROVAL_ENV: gate.APPROVAL,
               gate.SHA_ENV: SHA, gate.RECOVERY_ENV: gate.RECOVERY}
        with a, b, c, d, e, patch.object(
            gate, "query", side_effect=incomplete
        ), patch.dict(os.environ, env, clear=True):
            for action in ("--status", "--preflight", "--apply"):
                with self.assertRaises(RuntimeError):
                    gate.main([action, "--expected-sha", SHA])
        self.assertEqual(writes, [])

    def test_asset_writer_running_blocks_apply(self):
        a, b, c, d, e = self.mocks()
        env = {gate.APPROVAL_ENV: gate.APPROVAL,
               gate.SHA_ENV: SHA, gate.RECOVERY_ENV: gate.RECOVERY}
        with a, b, c, d, patch.object(
            gate, "asset_writers_idle",
            side_effect=RuntimeError("API/worker still running")
        ), patch.object(gate, "query", side_effect=readonly), patch.dict(
            os.environ, env, clear=True
        ):
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])

    def test_changed_snapshot_after_preflight_blocks_without_write(self):
        a, b, c, d, e = self.mocks()
        count, writes = 0, []

        def database(sql, *, write=False):
            nonlocal count
            if write:
                writes.append(sql)
                raise AssertionError("Changed snapshot must stop")
            if sql.startswith("SELECT version"):
                return "\n".join(NAMES[:63])
            if sql == gate.BASE_SQL:
                return "t"
            if sql == gate.STATE_SQL:
                count += 1
                return ("1" if count == 1 else "2") * 32
            raise AssertionError(sql[:60])

        env = {gate.APPROVAL_ENV: gate.APPROVAL,
               gate.SHA_ENV: SHA, gate.RECOVERY_ENV: gate.RECOVERY}
        with a, b, c, d, e, patch.object(
            gate, "query", side_effect=database
        ), patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])
        self.assertEqual(count, 2)
        self.assertEqual(writes, [])

    def test_ambiguous_write_cannot_retry(self):
        a, b, c, d, e = self.mocks()
        count = 0

        def database(sql, *, write=False):
            nonlocal count
            if write:
                count += 1
                raise RuntimeError(gate.DENIED)
            return readonly(sql)

        env = {gate.APPROVAL_ENV: gate.APPROVAL,
               gate.SHA_ENV: SHA, gate.RECOVERY_ENV: gate.RECOVERY}
        with a, b, c, d, e, patch.object(
            gate, "query", side_effect=database
        ), patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])
        self.assertEqual(count, 1)

    def test_installed_0064_status_not_preflight_or_apply(self):
        a, b, c, d, e = self.mocks()

        def already(sql, *, write=False):
            if write:
                raise AssertionError("0064 already applied")
            if sql.startswith("SELECT version"):
                return "\n".join(NAMES[:64])
            if sql == gate.POST_SQL:
                return "t"
            if sql == gate.STATE_SQL:
                return SNAPSHOT
            raise AssertionError(sql[:70])

        with a, b, c, d, e, patch.object(gate, "query", side_effect=already):
            gate.main(["--status", "--expected-sha", SHA])
            with self.assertRaises(RuntimeError):
                gate.main(["--preflight", "--expected-sha", SHA])

    def test_opaque_diagnostics_and_no_unintended_runtime(self):
        text = Path(gate.__file__).read_text("utf8")
        for forbidden in ("docker run", "docker start", "docker rm",
                          "docker compose up", "published_for_publication=true"):
            self.assertNotIn(forbidden, text)
        self.assertIn("default_transaction_read_only=on", text)
        self.assertIn("default_transaction_read_only=off", text)
        self.assertIn("asset_writers_idle()", text)


if __name__ == "__main__":
    unittest.main()
