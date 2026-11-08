#!/usr/bin/env python3
"""Offline P2-04 private cutover admission tests; no Docker mutation."""
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import p2_04_local_admin_cutover as m


def fixture():
    web_env = [
        "VNS_ADMIN_ORIGIN=https://studio.example.org",
        "VNS_WEB_ADMIN_ENABLED=true",
        "VNS_WEB_EDITORIAL_ADMIN_ENABLED=true",
        "VNS_WEB_SOURCE_REGISTRY_ENABLED=true",
        "VNS_WEB_HOST_APPROVAL_ENABLED=false",
    ]
    api_env = [
        "VNS_ADMIN_ORIGIN=https://studio.example.org",
        "VNS_ADMIN_AUTH_ENABLED=true",
        "VNS_EDITORIAL_PERSONAL_DB_ENABLED=true",
        "VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK=true",
        "VNS_P2_SOURCE_ADMIN_ENABLED=true",
        "VNS_P2_SOURCE_ADMIN_OPERATOR_ACK=true",
        "VNS_P2_HOST_ADMIN_ENABLED=false",
        "VNS_P2_HOST_ADMIN_OPERATOR_ACK=false",
    ]
    return {
        "web": {"Config": {"Env": web_env, "Image": m.OLD["web"][0],
                            "Labels": {}}, "Mounts": [],
                "Image": m.OLD["web"][1]},
        "api": {"Config": {"Env": api_env, "Image": m.OLD["api"][0],
                            "Labels": {}}, "Mounts": [{
                    "Type": "bind", "RW": False, "Source": "/var/lib/videonews-studio/private-ci-fixture",
                    "Destination": "/run/secrets/vns_editor_credentials",
                }, {
                    "Type": "bind", "RW": False, "Source": "/var/lib/videonews-studio/private-ci-file",
                    "Destination": "/run/secrets/postgres_password",
                }], "Image": m.OLD["api"][1]},
    }


class LocalAdminCutover(unittest.TestCase):
    def test_dependency_free_commands_and_no_publication(self):
        code = Path(m.__file__).read_text("utf-8")
        self.assertIn('"--no-deps", "--no-build", "--pull", "never"', code)
        self.assertIn('"--wait-timeout", "120"', code)
        self.assertIn('for service in SWITCH_SERVICES:', code)
        self.assertEqual(m.SWITCH_SERVICES, ("api", "web"))
        self.assertEqual(len(m.OVERLAYS), 5)
        self.assertEqual(m.IMAGE_REV,
                         "6b7902c93d8c05efc7d97affe8fcf17ef268a6fc")
        for forbidden in (
            '"down"', '"restart"', '"stop"', '"push"', '"build"',
            "docker login", "--remove-orphans", "docker system prune",
            "docker volume rm", "feed-candidate-project-once.js",
            "publish_news", "publish_video",
        ):
            if forbidden == '"build"':
                self.assertIn('or "build" in item', code)
            else:
                self.assertNotIn(forbidden, code)

    def test_live_env_flags_and_editor_mount_reused_privately(self):
        value = m.environment(fixture())
        self.assertEqual(value["VNS_ADMIN_ORIGIN"],
                         "https://studio.example.org")
        self.assertEqual(
            value["VNS_P2_EDITORIAL_PERSONAL_CREDENTIALS_DIR"], "/var/lib/videonews-studio/private-ci-fixture"
        )
        self.assertEqual(value["VNS_P2_SOURCE_ADMIN_OPERATOR_ACK"], "true")
        self.assertEqual(value["VNS_WEB_HOST_APPROVAL_ENABLED"], "false")
        self.assertEqual(value["COMPOSE_PROFILES"], "")
        self.assertEqual(m.image_environment(value, new=True)["VNS_API_IMAGE"],
                         m.NEW["api"][0])
        self.assertEqual(m.image_environment(value, new=False)["VNS_WEB_IMAGE"],
                         m.OLD["web"][0])

    def test_absent_admin_login_or_broken_credentials_refused(self):
        for service, key, value in (
            ("web", "VNS_WEB_EDITORIAL_ADMIN_ENABLED", "false"),
            ("api", "VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK", "false"),
            ("web", "VNS_ADMIN_ORIGIN", "http://not-https.example"),
            ("api", "VNS_ADMIN_ORIGIN", "https://other.example"),
        ):
            items = fixture()
            original = items[service]["Config"]["Env"]
            items[service]["Config"]["Env"] = [
                key + "=" + value if element.startswith(key + "=")
                else element for element in original
            ]
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.environment(items)
        items = fixture()
        items["api"]["Mounts"][0]["RW"] = True
        with self.assertRaises(RuntimeError):
            m.environment(items)

    def test_compose_must_match_live_env_secrets_and_networks(self):
        live = fixture()
        conf = {
            "name": "videonews-studio",
            "services": {
                "web": {
                    "image": m.NEW["web"][0], "pull_policy": "never",
                    "read_only": True, "cap_drop": ["ALL"],
                    "environment": {
                        x.partition("=")[0]: x.partition("=")[2]
                        for x in live["web"]["Config"]["Env"]
                    },
                    "networks": {"frontend": None},
                },
                "api": {
                    "image": m.NEW["api"][0], "pull_policy": "never",
                    "read_only": True, "cap_drop": ["ALL"],
                    "environment": {
                        x.partition("=")[0]: x.partition("=")[2]
                        for x in live["api"]["Config"]["Env"]
                    },
                    "networks": {"frontend": None, "backend": None},
                    "volumes": [{
                        "source": "/var/lib/videonews-studio/private-ci-fixture", "target":
                        "/run/secrets/vns_editor_credentials"
                    }],
                    "secrets": [{
                        "source": "postgres_password",
                        "target": "postgres_password",
                    }],
                },
            },
        }
        with patch.object(m, "run", return_value=json.dumps(conf)):
            m.validate_compose(live, {})
        bad = json.loads(json.dumps(conf))
        bad["services"]["api"]["environment"]["VNS_ADMIN_AUTH_ENABLED"] = "false"
        with patch.object(m, "run", return_value=json.dumps(bad)), \
                self.assertRaises(RuntimeError):
            m.validate_compose(live, {})
        bad = json.loads(json.dumps(conf))
        bad["services"]["api"]["ports"] = ["4000:4000"]
        with patch.object(m, "run", return_value=json.dumps(bad)), \
                self.assertRaises(RuntimeError):
            m.validate_compose(live, {})
        bad = json.loads(json.dumps(conf))
        bad["services"]["api"]["secrets"] = []
        with patch.object(m, "run", return_value=json.dumps(bad)), \
                self.assertRaises(RuntimeError):
            m.validate_compose(live, {})

    def common(self):
        return [
            patch.object(m, "release"),
            patch.object(m, "live", return_value=fixture()),
            patch.object(m, "environment", return_value={"fixture": "true"}),
            patch.object(m, "inspect_images"),
            patch.object(m, "validate_compose"),
            patch.object(m, "check_app_states"),
            patch.object(m, "unchanged"),
        ]

    def test_preflight_never_replaces_container(self):
        a, b, c, d, e, f, g = self.common()
        with a, b, c, d, e, f as states, g, \
                patch.object(m, "apply_services") as apply:
            m.main(["--preflight", "--expected-operator-sha", "a" * 40])
            states.assert_called_once_with(expect_new=False)
            apply.assert_not_called()

    def test_success_recreates_only_api_then_web(self):
        a, b, c, d, e, f, g = self.common()
        with a, b, c, d, e, f, g, \
                patch.object(m, "apply_services") as apply:
            m.main(["--apply", "--expected-operator-sha", "a" * 40])
            self.assertEqual(
                [call.args[1] for call in apply.call_args_list],
                ["api", "web"],
            )

    def test_failed_web_triggers_only_one_api_web_rollback(self):
        a, b, c, d, e, f, g = self.common()
        attempts = []

        def fake_apply(env, service):
            attempts.append(service)
            if len(attempts) == 2:
                raise RuntimeError("Synthetic web health failure")

        with a, b, c, d, e, f, g, \
                patch.object(m, "apply_services", side_effect=fake_apply), \
                self.assertRaises(RuntimeError):
            m.main(["--apply", "--expected-operator-sha", "a" * 40])
        self.assertEqual(attempts, ["api", "web", "api", "web"])

    def test_subprocess_failures_are_generic(self):
        with patch.object(m.subprocess, "run", return_value=SimpleNamespace(
            returncode=1, stdout="secret-looking details", stderr="tokens"
        )), self.assertRaisesRegex(RuntimeError, "^REFUSED:"):
            m.run(["docker", "compose", "config"])


if __name__ == "__main__":
    unittest.main()
