"""Safety regression checks for the manual GHCR publication workflow.

Static guards only: tests must NOT trigger GitHub Actions or upload packages.
"""
from pathlib import Path
import re
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/p1-04-publish-ghcr.yml"


class ReleasePolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = WORKFLOW.read_text(encoding="utf-8")

    def test_manual_only(self):
        header = self.data.split("\npermissions:\n", 1)[0]
        self.assertIn("\n  workflow_dispatch:\n", header)
        self.assertNotRegex(header, r"(?m)^  (push|pull_request|schedule|workflow_run):")
        self.assertIn("default: DO_NOT_PUBLISH", header)

    def test_explicit_commit_and_visibility_confirmation(self):
        self.assertIn("expected_sha:", self.data)
        self.assertIn("VISIBILITY_CHECK", self.data)
        self.assertIn("NO_PUBLIC_PACKAGE", self.data)
        self.assertIn('"$EXPECTED_SHA" != "$GITHUB_SHA"', self.data)
        self.assertIn("refs/heads/main", self.data)

    def test_public_package_check_is_fail_closed(self):
        self.assertIn("api.github.com/users/whiteyOnTheMoon/packages/container/$package", self.data)
        self.assertIn('200) echo "BLOCKED: already-public GHCR package', self.data)
        self.assertIn('*) echo "BLOCKED: cannot verify package visibility', self.data)

    def test_immutable_tags_and_minimal_credential_access(self):
        self.assertIn('version="sha-$GITHUB_SHA"', self.data)
        self.assertIn("packages: write", self.data)
        self.assertIn("GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}", self.data)
        self.assertNotRegex(self.data, r"(?m)^    env:\n      GHCR_TOKEN:")
        self.assertIn("for target in web api;", self.data)
        self.assertNotIn("docker system prune", self.data)
        self.assertNotIn("docker builder prune", self.data)

    def test_serialization_and_no_auto_release(self):
        self.assertIn("group: vns-ghcr-manual-release", self.data)
        self.assertIn("cancel-in-progress: false", self.data)
        self.assertIn("inputs.approval == 'PUBLISH_PRIVATE_IMAGES'", self.data)


if __name__ == "__main__":
    unittest.main()
