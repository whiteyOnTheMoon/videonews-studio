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

    def test_authenticated_public_package_check_is_fail_closed(self):
        check = (WORKFLOW.parent.parent.parent / "scripts" / "check_ghcr_visibility.sh").read_text(encoding="utf-8")
        self.assertIn("bash scripts/check_ghcr_visibility.sh", self.data)
        self.assertIn("GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}", self.data)
        self.assertIn("Authorization: Bearer ${GHCR_TOKEN}", check)
        self.assertIn("api.github.com/users/whiteyOnTheMoon/packages/container/", check)
        for code in ("200)", "404)", "*)"):
            self.assertIn(code, check)
        self.assertIn("exit 1", check)
        self.assertNotIn("docker push", check)
        self.assertNotIn("docker login", check)

    def test_immutable_tags_and_minimal_credential_access(self):
        self.assertIn('version="sha-$GITHUB_SHA"', self.data)
        self.assertIn("packages: write", self.data)
        self.assertIn("GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}", self.data)
        self.assertNotRegex(self.data, r"(?m)^    env:\n      GHCR_TOKEN:")
        self.assertNotIn("for target in web api;", self.data)
        # Build and push must use the same allowlisted, operator-selected scope.
        self.assertEqual(self.data.count("for target in $RELEASE_TARGETS; do"), 2)
        self.assertIn('printf \'RELEASE_TARGETS=%s\\\\n\' "$targets" >> "$GITHUB_ENV"', self.data)
        self.assertNotIn("docker system prune", self.data)
        self.assertNotIn("docker builder prune", self.data)

    def test_web_only_is_default_denied_and_api_is_never_built_or_pushed(self):
        self.assertIn("release_scope:", self.data)
        self.assertIn("default: DO_NOT_SELECT", self.data)
        self.assertIn("WEB_ONLY) targets=\"web\"", self.data)
        self.assertIn("WEB_AND_API) targets=\"web api\"", self.data)
        self.assertIn('*) echo "BLOCKED: explicit release scope required"', self.data)
        self.assertIn("RELEASE_SCOPE: ${{ inputs.release_scope }}", self.data)
        # An API image must only be smoked in the WEB_AND_API branch.
        smoke = self.data.split("      - name: Verify internal HTTP endpoints", 1)[1]
        smoke = smoke.split("      - name: Authenticate to GitHub Container Registry", 1)[0]
        self.assertIn('if [ "$RELEASE_SCOPE" = WEB_AND_API ]; then', smoke)
        self.assertEqual(smoke.count('if [ "$RELEASE_SCOPE" = WEB_AND_API ]; then'), 2)
        self.assertNotIn("docker push", smoke)
        self.assertNotIn("docker build", smoke)

    def test_serialization_and_no_auto_release(self):
        self.assertIn("group: vns-ghcr-manual-release", self.data)
        self.assertIn("cancel-in-progress: false", self.data)
        self.assertIn("inputs.approval == 'PUBLISH_PRIVATE_IMAGES'", self.data)


if __name__ == "__main__":
    unittest.main()
