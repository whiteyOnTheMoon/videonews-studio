"""0065 operator gate: synthetic unit tests without any VPS, Docker or DB."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import p2_04_schema_0064_to_0065 as gate

SHA = "a" * 40
NAMES = [f"{n:04d}_synthetic" for n in range(1, 64)] + [gate.OLD, gate.NEW]
SNAPSHOT = "1" * 32


def readonly(sql, *, write=False):
    if write:
        raise AssertionError("No mutation may occur in preflight")
    if sql.startswith("SELECT version"):
        return "\n".join(NAMES[:64])
    if sql == gate.BASE_SQL:
        return "t"
    if sql == gate.POST_SQL:
        return "f"
    if sql == gate.STATE_SQL:
        return SNAPSHOT
    raise AssertionError("Unexpected SQL")


class SchemaGateTest(unittest.TestCase):
    def mocks(self):
        return (
            patch.object(gate, "release"),
            patch.object(gate, "idle_database"),
            patch.object(gate, "migration_source", return_value="BEGIN;\nCOMMIT;"),
            patch.object(gate, "versions", return_value=NAMES),
        )

    def test_preflight_and_status_never_write(self):
        a, b, c, d = self.mocks()
        with a as release, b, c, d, patch.object(gate, "query", side_effect=readonly):
            gate.main(["--preflight", "--expected-sha", SHA])
            gate.main(["--status", "--expected-sha", SHA])
            self.assertEqual(release.call_count, 2)

    def test_default_off_never_reaches_schema_write(self):
        a, b, c, d = self.mocks()
        with a, b, c, d, patch.object(gate, "query", side_effect=readonly), \
                patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])

    def test_wrong_sha_or_unverified_recovery_refused(self):
        a, b, c, d = self.mocks()
        env = {gate.APPROVAL_ENV: gate.APPROVAL,
               gate.SHA_ENV: "b" * 40, gate.RECOVERY_ENV: gate.RECOVERY}
        with a, b, c, d, patch.object(gate, "query", side_effect=readonly), \
                patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])
        env[gate.SHA_ENV] = SHA
        env[gate.RECOVERY_ENV] = "NOT_VERIFIED"
        with a, b, c, d, patch.object(gate, "query", side_effect=readonly), \
                patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])

    def test_apply_once_never_repeats(self):
        a, b, c, d = self.mocks()
        done = False
        writes = []

        def database(sql, *, write=False):
            nonlocal done
            if write:
                self.assertFalse(done, "A second schema write is forbidden")
                done = True
                writes.append(sql)
                return ""
            if sql.startswith("SELECT version"):
                return "\n".join(NAMES if done else NAMES[:64])
            if sql == gate.BASE_SQL or sql == gate.POST_SQL:
                return "t"
            if sql == gate.STATE_SQL:
                return SNAPSHOT
            raise AssertionError(sql[:70])

        env = {gate.APPROVAL_ENV: gate.APPROVAL,
               gate.SHA_ENV: SHA, gate.RECOVERY_ENV: gate.RECOVERY}
        with a, b, c, d, patch.object(gate, "query", side_effect=database), \
                patch.dict(os.environ, env, clear=True):
            gate.main(["--apply", "--expected-sha", SHA])
            self.assertEqual(writes, ["BEGIN;\nCOMMIT;"])
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])
            self.assertEqual(len(writes), 1)

    def test_schema_already_new_preflight_fails_closed(self):
        a, b, c, d = self.mocks()
        def database(sql, *, write=False):
            if write:
                raise AssertionError("Already applied")
            if sql.startswith("SELECT version"):
                return "\n".join(NAMES)
            if sql == gate.POST_SQL:
                return "t"
            if sql == gate.BASE_SQL:
                return "f"
            raise AssertionError(sql)
        with a, b, c, d, patch.object(gate, "query", side_effect=database):
            gate.main(["--status", "--expected-sha", SHA])
            with self.assertRaises(RuntimeError):
                gate.main(["--preflight", "--expected-sha", SHA])

    def test_ambiguous_sql_write_not_retried(self):
        a, b, c, d = self.mocks()
        count = 0
        def database(sql, *, write=False):
            nonlocal count
            if write:
                count += 1
                raise RuntimeError(gate.DENIED)
            return readonly(sql)
        env = {gate.APPROVAL_ENV: gate.APPROVAL,
               gate.SHA_ENV: SHA, gate.RECOVERY_ENV: gate.RECOVERY}
        with a, b, c, d, patch.object(gate, "query", side_effect=database), \
                patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])
        self.assertEqual(count, 1)

    def test_no_unintended_runtime_or_publication(self):
        source = Path(gate.__file__).read_text("utf8")
        self.assertNotIn("docker run", source)
        self.assertNotIn("docker start", source)
        self.assertNotIn("docker rm", source)
        self.assertNotIn("published_for_publication=true", source)
        self.assertIn("default_transaction_read_only=on", source)
        self.assertIn("default_transaction_read_only=off", source)


    def test_missing_0064_refused_even_if_0063_is_installed(self):
        a, b, c, d = self.mocks()
        attempts = []

        def missing_0064(sql, *, write=False):
            if write:
                attempts.append(sql)
                raise AssertionError("Missing 0064 must never be applied as 0065")
            if sql.startswith("SELECT version"):
                return "\n".join(NAMES[:63])
            raise AssertionError("No subsequent database read expected")

        env = {gate.APPROVAL_ENV: gate.APPROVAL,
               gate.SHA_ENV: SHA, gate.RECOVERY_ENV: gate.RECOVERY}
        with a, b, c, d, patch.object(gate, "query", side_effect=missing_0064), \
                patch.dict(os.environ, env, clear=True):
            for action in ("--status", "--preflight", "--apply"):
                with self.assertRaises(RuntimeError):
                    gate.main([action, "--expected-sha", SHA])
        self.assertEqual(attempts, [])

    def test_changed_snapshot_before_apply_refuses_without_sql_write(self):
        a, b, c, d = self.mocks()
        snapshot_calls = 0
        writes = []

        def concurrent_mutation(sql, *, write=False):
            nonlocal snapshot_calls
            if write:
                writes.append(sql)
                raise AssertionError("Concurrent snapshot changed")
            if sql.startswith("SELECT version"):
                return "\n".join(NAMES[:64])
            if sql == gate.BASE_SQL:
                return "t"
            if sql == gate.STATE_SQL:
                snapshot_calls += 1
                return ("1" if snapshot_calls == 1 else "2") * 32
            raise AssertionError(sql[:70])

        env = {gate.APPROVAL_ENV: gate.APPROVAL,
               gate.SHA_ENV: SHA, gate.RECOVERY_ENV: gate.RECOVERY}
        with a, b, c, d, patch.object(gate, "query",
                                       side_effect=concurrent_mutation), \
                patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError):
                gate.main(["--apply", "--expected-sha", SHA])
        self.assertEqual(snapshot_calls, 2)
        self.assertEqual(writes, [])


if __name__ == "__main__":
    unittest.main()
