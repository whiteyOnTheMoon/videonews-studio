"""CI-only boundaries for read-only Redis cloud-backup planning.

Never contacts production, Redis, Docker or an object-storage provider.
"""
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "p2_03_redis_cloud_offhost_readonly_preflight.sh"
DOC = ROOT.parent / "docs/P2_03_REDIS_ENCRYPTED_OFFHOST_CLOUD_PREPARATION_2026_11_12.md"


class CloudPreflightContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = SCRIPT.read_text(encoding="utf8")
        cls.doc = DOC.read_text(encoding="utf8")

    def test_bash_syntax_only(self):
        result = subprocess.run(
            ["bash", "-n", str(SCRIPT)],
            text=True, capture_output=True, check=False, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_sha_refused_before_any_external_operation(self):
        result = subprocess.run(
            ["bash", str(SCRIPT), "INVALID"],
            text=True, capture_output=True, check=False, timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("REFUSED:", result.stderr)

    def test_exact_prod_redis_identity_and_health_required(self):
        for required in (
            "videonews-studio-redis-1",
            "redis:8.4.8-alpine@sha256:",
            "videonews-studio_redis_p109_restored",
            '"true|false|healthy"',
            '"volume|$VOLUME|true"',
            'git --no-optional-locks status --porcelain',
        ):
            with self.subTest(required=required):
                self.assertIn(required, self.script)

    def test_docker_is_metadata_only(self):
        commands = re.findall(r"\$\(docker\s+[a-z][a-z-]*", self.script)
        self.assertEqual(commands, ["$(docker inspect"] * 3)
        for forbidden in (
            "docker pause", "docker unpause", "docker exec",
            "docker restart", "docker run", "docker rm",
            "redis-cli", "redis-server", "restic init",
            "restic backup", "CONFIG SET", "curl ", "wget ",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.script)

    def test_unverified_states_never_claim_successful_backup(self):
        for marker in (
            "CLOUD_PROVIDER_CONFIGURED=unverified",
            "ENCRYPTION_KEY_CUSTODY_VERIFIED=false",
            "SOURCE_SNAPSHOT_CONSISTENCY_VERIFIED=false",
            "RESTORE_VERIFIED=false",
            "PRODUCTION_BACKUP_AUTHORIZED=false",
            "PRODUCTION_REDIS_PAUSE_AUTHORIZED=false",
            "BACKUP_CREATED=false", "NETWORK_REQUESTS_SENT=false",
            "DOCKER_MODIFIED=false", "REDIS_MODIFIED=false",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.script)

    def test_doc_requires_independent_restore_and_key_custody(self):
        for phrase in (
            "independently recoverable",
            "restic check --read-data",
            "BACKUP START",
            "Redis 8.10.0",
            "All previous P1-07 release gates remain closed",
            "No productive Redis pause is authorized",
            "synthetic bytes",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, self.doc)

    def test_google_drive_requires_rclone_without_auth_in_preflight(self):
        self.assertIn(
            "for TOOL in restic rclone docker python3 openssl; do",
            self.script,
        )
        for forbidden in (
            "rclone config", "rclone copy", "rclone sync",
            "restic backup", "restic init", "rclone authorize",
            "rclone lsd", "rclone ls ", "rclone serve",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.script)

    def test_google_drive_documentation_no_s3_or_gcs_confusion(self):
        doc = (ROOT.parent /
               "docs/P2_03_GOOGLE_DRIVE_ENCRYPTED_REDIS_BACKUP_2026_11_12.md")
        source = doc.read_text(encoding="utf-8")
        self.assertIn("Google Drive", source)
        self.assertIn("Google Cloud Storage", source)
        self.assertIn("rclone:<remote>:<directory>", source)
        self.assertIn("restic client-side encryption", source)
        self.assertIn("OAuth", source)

    def test_google_drive_retains_independent_recovery_requirements(self):
        doc = (ROOT.parent /
               "docs/P2_03_GOOGLE_DRIVE_ENCRYPTED_REDIS_BACKUP_2026_11_12.md")
        source = doc.read_text(encoding="utf-8")
        for statement in (
            "drive.file",
            "shared Google Drive OAuth client ID",
            "refresh tokens",
            "restic check --read-data",
            "independent",
            "Redis 8.10+",
            "NO actual cloud or Redis backup",
            "OFF_HOST_BACKUP_VERIFIED=false",
            "PRODUCTION_REDIS_PAUSE_AUTHORIZED=false",
        ):
            with self.subTest(statement=statement):
                self.assertIn(statement, source)

    def test_general_doc_identifies_google_drive_via_rclone(self):
        self.assertIn(
            "Google Drive (not Google Cloud Storage)",
            self.doc,
        )
        self.assertIn(
            "Google Drive via restic + rclone",
            self.doc,
        )
        self.assertIn(
            "Google Drive requires the supported restic rclone backend",
            self.doc,
        )

    def test_script_has_no_credentials(self):
        for forbidden in (
            "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID",
            "RESTIC_PASSWORD=", "PASSWORD_FILE=",
            "aws s3", "s3api", "age -r", "gpg -r",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.script)


if __name__ == "__main__":
    unittest.main()
