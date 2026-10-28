#!/usr/bin/env python3
"""Offline synthetic Redis ACL changes, no VPS or real credentials."""
from contextlib import contextmanager
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import p1_09_redis_producer_acl_rollout as rollout
from p1_09_provider_outbox_custody import acl_line


class RedisProducerAclTests(unittest.TestCase):
    @contextmanager
    def fixture(self, existing_extra: bool = False):
        with tempfile.TemporaryDirectory(prefix="vns-redis-producer-test-") as tmp:
            secrets = Path(tmp) / "secrets"
            private = secrets / "vns-outbox"
            secrets.mkdir(mode=0o700)
            private.mkdir(mode=0o700)
            worker = "w" * 64
            producer = "p" * 64
            import hashlib
            old = (
                "user default off\n"
                + "user vns_worker on #"
                + hashlib.sha256(worker.encode()).hexdigest()
                + " ~bull:vns:* +@all -@admin -@dangerous +info\n"
            )
            if existing_extra:
                old += (
                    "user vns_research on #"
                    + hashlib.sha256(b"r" * 64).hexdigest()
                    + " ~bull:vns:vns-research:* +@all -@admin -@dangerous +info\n"
                )
            (secrets / "redis_acl").write_text(old, encoding="ascii")
            os.chmod(secrets / "redis_acl", 0o644)
            (private / "provider-outbox-redis-password").write_text(producer + "\n", encoding="ascii")
            (private / "provider-outbox-acl-candidate").write_text(acl_line(producer), encoding="ascii")
            for p in private.iterdir():
                os.chmod(p, 0o600)
            with patch.object(rollout, "SECRETS", secrets), patch.object(
                rollout, "PRIVATE", private
            ), patch.object(rollout, "operator"):
                yield secrets, private, old, producer

    def test_additive_prepare_and_exact_non_overwriting_install(self):
        with self.fixture(existing_extra=True) as (secrets, private, old, password):
            rollout.preflight()
            rollout.prepare()
            rollout.verify()
            self.assertEqual((secrets / "redis_acl").read_text("ascii"), old)
            merged = (private / rollout.MERGED).read_text("ascii")
            self.assertEqual(merged, old + acl_line(password))
            self.assertEqual(stat.S_IMODE((private / rollout.MERGED).stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                rollout.prepare()
            # On the VPS the invoking shell always uses umask 077.
            old_umask = os.umask(0o077)
            try:
                rollout.install_file()
            finally:
                os.umask(old_umask)
            rollout.installed()
            self.assertEqual((secrets / "redis_acl").read_text("ascii"), merged)
            self.assertEqual((private / rollout.BACKUP).read_text("ascii"), old)
            self.assertEqual(stat.S_IMODE((secrets / "redis_acl").stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE((private / rollout.BACKUP).stat().st_mode), 0o600)
            with self.assertRaises((FileExistsError, ValueError)):
                rollout.install_file()
            self.assertIn("user vns_research on", (secrets / "redis_acl").read_text("ascii"))

    def test_repair_only_exact_already_installed_acl_with_umask_077(self):
        with self.fixture() as (secrets, private, original, password):
            rollout.prepare()
            merged = (private / rollout.MERGED).read_bytes()
            # Synthetic crash after successful atomic rename, before mode check.
            (private / rollout.BACKUP).write_bytes(original.encode("ascii"))
            os.chmod(private / rollout.BACKUP, 0o600)
            (secrets / "redis_acl").write_bytes(merged)
            os.chmod(secrets / "redis_acl", 0o600)
            with self.assertRaises(PermissionError):
                rollout.installed()
            old_umask = os.umask(0o077)
            try:
                rollout.repair_installed_mode()
            finally:
                os.umask(old_umask)
            rollout.installed()
            self.assertEqual(stat.S_IMODE((secrets / "redis_acl").stat().st_mode), 0o644)
            self.assertEqual((secrets / "redis_acl").read_bytes(), merged)
            self.assertEqual((private / rollout.BACKUP).read_text("ascii"), original)
            with self.assertRaises(PermissionError):
                rollout.repair_installed_mode()

    def test_repair_rejects_tampered_or_ambiguous_state(self):
        with self.fixture() as (secrets, private, original, password):
            rollout.prepare()
            merged = (private / rollout.MERGED).read_bytes()
            (private / rollout.BACKUP).write_bytes(original.encode("ascii"))
            os.chmod(private / rollout.BACKUP, 0o600)
            (secrets / "redis_acl").write_bytes(merged)
            os.chmod(secrets / "redis_acl", 0o600)
            (secrets / rollout.TEMP).write_bytes(b"stale-ambiguous")
            with self.assertRaises(FileExistsError):
                rollout.repair_installed_mode()
            (secrets / rollout.TEMP).unlink()
            (secrets / "redis_acl").write_bytes(merged + b"# altered\\n")
            with self.assertRaises(RuntimeError):
                rollout.repair_installed_mode()
            os.chmod(secrets / "redis_acl", 0o644)
            with self.assertRaises(PermissionError):
                rollout.repair_installed_mode()

    def test_repair_gate_rejects_missing_operator_approval(self):
        with patch.object(rollout.os, "geteuid", return_value=1000), patch.object(
            rollout, "command", side_effect=["main", "", "a" * 40]
        ), patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                rollout.operator(repairing=True)

    def test_reject_changed_original_after_prepare(self):
        with self.fixture() as (secrets, private, old, password):
            rollout.prepare()
            (secrets / "redis_acl").write_text(old + "# unexpected edit\n", encoding="ascii")
            with self.assertRaises(RuntimeError):
                rollout.verify()
            with self.assertRaises(RuntimeError):
                rollout.install_file()
            self.assertFalse((private / rollout.BACKUP).exists())

    def test_reject_replaced_acl_symlink_and_world_writable_files(self):
        with self.fixture() as (secrets, private, old, password):
            (secrets / "redis_acl").unlink()
            (secrets / "redis_acl").symlink_to(private / rollout.ACL_CANDIDATE)
            with self.assertRaises(OSError):
                rollout.preflight()
            (secrets / "redis_acl").unlink()
            (secrets / "redis_acl").write_text(old, encoding="ascii")
            os.chmod(secrets / "redis_acl", 0o666)
            with self.assertRaises(PermissionError):
                rollout.preflight()
            os.chmod(secrets / "redis_acl", 0o644)
            os.chmod(private, 0o755)
            with self.assertRaises(PermissionError):
                rollout.preflight()

    def test_reject_existing_producer_default_on_duplicate_or_untrusted_candidate(self):
        with self.fixture() as (secrets, private, old, password):
            for bad in [
                old + acl_line(password),
                old.replace("default off", "default on"),
                old.replace("vns_worker on", "vns_worker off"),
                old + old,
            ]:
                (secrets / "redis_acl").write_text(bad, encoding="ascii")
                with self.assertRaises((ValueError, RuntimeError)):
                    rollout.preflight()
            (secrets / "redis_acl").write_text(old, encoding="ascii")
            (private / rollout.ACL_CANDIDATE).write_text(
                "user vns_provider_producer on +@all ~*\n", encoding="ascii"
            )
            with self.assertRaises(ValueError):
                rollout.preflight()

    def test_refuse_unauthorized_install_without_db_or_docker_actions(self):
        with patch.object(rollout.os, "geteuid", return_value=1000), patch.object(
            rollout, "command", side_effect=["main", "", "a" * 40]
        ), patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                rollout.operator(approving=True)
        self.assertFalse(hasattr(rollout, "restart_redis"))
        self.assertFalse(hasattr(rollout, "install_redis_acl_live"))


if __name__ == "__main__":
    unittest.main()
