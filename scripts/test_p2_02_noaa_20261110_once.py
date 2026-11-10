#!/usr/bin/env python3
"""Static fail-closed 2026-11-10 NOAA canary tests; never call Docker/SQL/HTTP."""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("p2_02_noaa_20261110_once.sh")


class NOAA20261110OneShotContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = SCRIPT.read_text(encoding="utf-8")

    def test_shell_syntax_and_initial_guards(self):
        process = subprocess.run(
            ["bash", "-n", str(SCRIPT)], capture_output=True, text=True, timeout=5
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertTrue(self.text.startswith("#!/usr/bin/env bash\n"))
        self.assertIn("set -euo pipefail", self.text)
        self.assertIn("umask 077", self.text)
        self.assertIn('test "$(id -u)" = "0" || refuse', self.text)
        self.assertIn("repo_git status --porcelain", self.text)

    def test_root_git_checks_are_truly_readonly_and_fail_closed(self):
        # Running git status under sudo and umask 077 can otherwise replace
        # .git/index with a root-owned 0600 file, breaking ap's read-only checks.
        self.assertIn("git --no-optional-locks", self.text)
        self.assertIn('test "$INDEX_OWNER" = "1000:1" || refuse', self.text)
        self.assertIn('case "$INDEX_MODE" in 600|640|644)', self.text)
        self.assertIn('GIT_STATUS="$(repo_git status --porcelain 2>/dev/null)" || refuse', self.text)
        self.assertIn('test -z "$GIT_STATUS" || refuse', self.text)
        self.assertNotIn('must test -z "$(repo_git status --porcelain)"', self.text)
        for helper in (
            "p2_02_nasa_signed_sql_readonly_witness.py",
            "p2_02_live_redis_acl_readonly.py",
        ):
            source = SCRIPT.with_name(helper).read_text(encoding="utf-8")
            self.assertIn('"git", "--no-optional-locks", "-c",', source)

    def test_git_no_optional_locks_does_not_replace_index_in_dirty_checkout(self):
        # Git can refresh the index as a side effect of status. Prove that
        # the chosen global switch keeps its inode/mtime unchanged even
        # when tracked-file metadata has changed (no network/root needed).
        with tempfile.TemporaryDirectory(prefix="vns-index-test-") as temp:
            worktree = Path(temp)
            subprocess.run(
                ["git", "init", "-q", "-b", "main"],
                cwd=worktree, check=True, capture_output=True, timeout=10,
            )
            tracked = worktree / "notice.txt"
            tracked.write_text("before\\n", encoding="utf-8")
            subprocess.run(
                ["git", "add", "notice.txt"],
                cwd=worktree, check=True, capture_output=True, timeout=10,
            )
            index = worktree / ".git" / "index"
            before = index.stat()
            tracked.write_text("after\\n", encoding="utf-8")
            check = subprocess.run(
                ["git", "--no-optional-locks", "status", "--porcelain"],
                cwd=worktree, check=True, capture_output=True, text=True, timeout=10,
            )
            after = index.stat()
            self.assertIn("notice.txt", check.stdout)
            self.assertEqual(before.st_ino, after.st_ino)
            self.assertEqual(before.st_mtime_ns, after.st_mtime_ns)
            self.assertEqual(before.st_uid, after.st_uid)

    def test_single_source_and_image_are_explicit(self):
        self.assertIn("VNS_FEED_CANARY_SOURCE_ID=noaa_news", self.text)
        self.assertIn(
            "VNS_FEED_CANARY_OPERATOR_ACK=NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY",
            self.text,
        )
        self.assertIn("VNS_FEED_RUNTIME_MODE=single_pass", self.text)
        self.assertIn("VNS_FEED_SOURCE_BOOTSTRAP=false", self.text)
        self.assertIn("VNS_FEED_NASA_512K_ENABLED=false", self.text)
        self.assertIn("NOAA_20261110_SINGLE_METADATA_POLL_ONCE_NO_RETRY", self.text)
        self.assertIn("https://www.noaa.gov/rss.xml", self.text)
        self.assertIn("https://www.noaa.gov/", self.text)
        self.assertIn('entry->>\'usage\'=\'metadata_only\'', self.text)
        self.assertIn('entry->>\'intervalMinutes\'=\'60\'', self.text)
        self.assertIn("a5c73c9ea5b8fba8a982e423c8eb5b5f42d48031", self.text)
        self.assertIn(
            "sha256:0116ba447642645ae81324347ac800fd45991fdf7006676936d7515f285a45ef",
            self.text,
        )

    def test_no_download_build_replay_or_cleanup(self):
        for forbidden in (
            r"\bdocker\s+run\b",
            r"\bdocker\s+rm\b",
            r"\bdocker\s+pull\b",
            r"\bdocker\s+build\b",
            r"\bdocker\s+restart\b",
            r"\bredis-cli\b",
            r"\bdocker\s+compose\b",
            r"\bsystemctl\b",
            r"\bcurl\b",
            r"\bwget\b",
            r"\bchmod\b",
            r"\bchown\b",
        ):
            self.assertIsNone(re.search(forbidden, self.text))
        self.assertEqual(len(re.findall(r"^docker create\b", self.text, re.M)), 1)
        self.assertEqual(len(re.findall(r"^docker start --attach\b", self.text, re.M)), 1)
        self.assertEqual(len(re.findall(r"^docker network connect\b", self.text, re.M)), 1)
        self.assertIn("if docker container inspect", self.text)
        self.assertIn('if test "$ACTION" = "preflight"; then exit 0; fi', self.text)
        self.assertIn('if test "$START_STATUS" != "0"', self.text)
        self.assertIn('test "$STATE" != "exited|0|0"', self.text)
        self.assertNotIn("--rm", self.text)

    def test_historical_canary_and_redis_evidence_are_preserved(self):
        self.assertIn('CONTAINER="vns-noaa-single-20261110-a5c73c9"', self.text)
        self.assertIn('OLD_AUDIT="vns-noaa-single-20261108-a5c73c9"', self.text)
        self.assertIn('test "$OLD_AUDIT_STATE" = "exited|0|0" || refuse', self.text)
        self.assertIn('assert x["counts"]["failed"]==6 and x["counts"]["completed"]==3', self.text)
        self.assertIn('if docker container inspect "$CONTAINER" >/dev/null 2>&1; then refuse; fi', self.text)
        self.assertIn('VNS_P2_NOAA_20261110_RECOVERY_VERIFIED', self.text)
        self.assertIn('OPERATOR_VERIFIED_OFFHOST_RESTORE_AND_SINGLE_POLL_SCOPE', self.text)
        self.assertIn('test "$FREE_KIB" -ge 9437184 || refuse', self.text)
        self.assertIn('test "$MEM_KIB" -ge 2621440 || refuse', self.text)
        self.assertNotIn('completed"]==2', self.text)
        self.assertNotIn('NOAA_SINGLE_METADATA_POLL_ONCE_NO_RETRY', self.text)

    def test_source_rights_and_worker_scope_unchanged(self):
        older = SCRIPT.with_name("p2_02_noaa_one_shot_operator.sh").read_text()
        for line in (
            'IMAGE_ID="sha256:0116ba447642645ae81324347ac800fd45991fdf7006676936d7515f285a45ef"',
            'WORKER_SHA="a5c73c9ea5b8fba8a982e423c8eb5b5f42d48031"',
            "AND entry->>'feedUrl'='https://www.noaa.gov/rss.xml'",
            "AND entry->>'usage'='metadata_only'",
            "--network \"$BACKEND\"",
            "--restart no",
            "--cap-drop ALL",
            "VNS_FEED_CANARY_SOURCE_ID=noaa_news",
            "VNS_FEED_SOURCE_BOOTSTRAP=false",
            "node apps/worker/dist/feed-observe-once.js --once",
        ):
            self.assertIn(line, older)
            self.assertIn(line, self.text)

    def test_only_exact_private_mounts_and_security_restrictions(self):
        self.assertEqual(len(re.findall(r"^\s*--mount ", self.text, re.M)), 7)
        self.assertIn("--network \"$BACKEND\"", self.text)
        self.assertIn('docker network connect "$EGRESS" "$CONTAINER"', self.text)
        for required in (
            "--init", "--read-only", "--cap-drop ALL",
            "--security-opt no-new-privileges", "--restart no", "--pull never",
            "--user 10002:10002", "--memory 384m", "--memory-swap 384m",
            "--pids-limit 96",
            "vns_feed_db_password,target=/run/secrets/vns_feed_db_password,readonly",
            "vns_feed_producer_redis_password,target=/run/secrets/vns_feed_producer_redis_password,readonly",
            "vns_feed_consumer_redis_password,target=/run/secrets/vns_feed_redis_password,readonly",
        ):
            self.assertIn(required, self.text)
        self.assertNotIn("--privileged", self.text)
        self.assertNotIn("--publish", self.text)
        self.assertNotIn("--net=host", self.text)
        self.assertNotIn("--network host", self.text)
        self.assertIn("default_transaction_read_only=on", self.text)
        self.assertIn("status", self.text)

    def test_read_only_preflights_precede_any_container_creation(self):
        guard_part, run_part = self.text.split("docker create \\", 1)
        self.assertIn("p2_02_nasa_signed_sql_readonly_witness.py", guard_part)
        self.assertIn("p2_02_nasa_queue_readonly_preflight.py", guard_part)
        self.assertIn("default_transaction_read_only=on", guard_part)
        self.assertIn("docker image inspect", guard_part)
        self.assertIn("docker container inspect", guard_part)
        self.assertIn("next_eligible_at<=clock_timestamp()", guard_part)
        self.assertIn("vns.admin_source_host_audit", guard_part)
        self.assertIn("read_only", guard_part)
        self.assertIn('test "$ACTION" = "preflight"', guard_part)
        self.assertIn("node apps/worker/dist/feed-observe-once.js --once", run_part)


if __name__ == "__main__":
    unittest.main()
