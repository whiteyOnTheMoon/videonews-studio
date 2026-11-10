"""Offline safety regressions for P4-12. Never call Docker or Compose."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

PATH = Path(__file__).with_name("p4_12_private_gallery_cutover.py")
spec = importlib.util.spec_from_file_location("p4_12_private_gallery_cutover", PATH)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def synthetic_conf():
    def service(name, networks, *, volumes=None):
        return {
            "image": module.NEW[name][0],
            "pull_policy": "never",
            "read_only": True,
            "cap_drop": ["ALL"],
            "security_opt": ["no-new-privileges:true"],
            "networks": {network: {} for network in networks},
            "environment": dict(module.PREVIEW_ENV[name]),
            "volumes": volumes or [],
            "secrets": [],
        }
    return {
        "name": "videonews-studio",
        "services": {
            "web": service("web", ["frontend"]),
            "api": service("api", ["frontend", "backend"], volumes=[{
                "type": "bind",
                "source": module.PREVIEW,
                "target": module.PREVIEW,
                "read_only": True,
                "bind": {"create_host_path": False},
            }]),
        },
        "secrets": {},
    }


class PrivateGalleryCutoverTests(unittest.TestCase):
    def setUp(self):
        self.records = {
            "web": {"Config": {"Env": []}, "Mounts": []},
            "api": {"Config": {"Env": []}, "Mounts": []},
        }

    def validate(self, config, *, records=None):
        with patch.object(module, "run", return_value=json.dumps(config)):
            module.validate_compose(records or self.records, {})

    def test_exact_release_and_isolated_scope(self):
        self.assertEqual(
            module.IMAGE_REV,
            "a51336ed708bbc0055b1f7722a2da47f4e817bfc",
        )
        self.assertEqual(len(module.OLD_OVERLAYS), 5)
        self.assertEqual(len(module.OVERLAYS), 6)
        self.assertEqual(module.OVERLAYS[-1], "deploy/compose.private-previews.yaml")
        self.assertIn("@sha256:", module.NEW["web"][0])
        self.assertIn("@sha256:", module.NEW["api"][0])
        self.assertEqual(set(module.SWITCH_SERVICES), {"web", "api"})
        self.assertEqual(module.PREVIEW_ENV["api"]["VNS_PRIVATE_PREVIEWS_RENDER_ENABLED"], "false")
        self.assertEqual(module.PREVIEW_ENV["web"]["VNS_WEB_PRIVATE_PREVIEW_RENDER_ENABLED"], "false")

    def test_candidate_enables_only_gallery_listing_and_rollback_clears_it(self):
        # Regression: the new overlay's default false feature switches must
        # be explicitly set true in the candidate-only Compose environment.
        base = {
            "VNS_ADMIN_ORIGIN": "https://studio.ap-pixels.com",
            "VNS_WEB_PRIVATE_PREVIEWS_ENABLED": "false",
            "VNS_PRIVATE_PREVIEWS_API_ENABLED": "false",
            "VNS_WEB_PRIVATE_PREVIEW_RENDER_ENABLED": "true",
            "VNS_PRIVATE_PREVIEWS_RENDER_ENABLED": "true",
        }
        candidate = module.image_environment(base, new=True)
        self.assertEqual(candidate["VNS_WEB_PRIVATE_PREVIEWS_ENABLED"], "true")
        self.assertEqual(candidate["VNS_PRIVATE_PREVIEWS_API_ENABLED"], "true")
        self.assertEqual(candidate["VNS_WEB_IMAGE"], module.NEW["web"][0])
        self.assertEqual(candidate["VNS_API_IMAGE"], module.NEW["api"][0])
        self.assertEqual(candidate["VNS_ADMIN_ORIGIN"], base["VNS_ADMIN_ORIGIN"])
        # Rendering is forcibly OFF by the overlay, irrespective of
        # parent shell variables. Never pass through untrusted ON toggles.
        self.assertNotEqual(candidate.get("VNS_WEB_PRIVATE_PREVIEW_RENDER_ENABLED"), "true")
        self.assertNotEqual(candidate.get("VNS_PRIVATE_PREVIEWS_RENDER_ENABLED"), "true")
        old = module.image_environment(candidate, new=False)
        self.assertEqual(old["VNS_WEB_IMAGE"], module.OLD["web"][0])
        self.assertEqual(old["VNS_API_IMAGE"], module.OLD["api"][0])
        for keys in module.PREVIEW_ENV.values():
            for key in keys:
                self.assertNotIn(key, old)
        self.assertEqual(old["VNS_ADMIN_ORIGIN"], base["VNS_ADMIN_ORIGIN"])

    def test_new_compose_accepts_only_private_api_bind(self):
        self.validate(synthetic_conf())

    def test_new_compose_refuses_web_video_mount(self):
        conf = synthetic_conf()
        conf["services"]["web"]["volumes"] = conf["services"]["api"]["volumes"]
        with self.assertRaises(RuntimeError):
            self.validate(conf)

    def test_new_compose_refuses_mount_autocreation(self):
        conf = synthetic_conf()
        conf["services"]["api"]["volumes"][0]["bind"]["create_host_path"] = True
        with self.assertRaises(RuntimeError):
            self.validate(conf)

    def test_new_compose_refuses_public_port(self):
        conf = synthetic_conf()
        conf["services"]["web"]["ports"] = [{"published": "3000", "target": 3000}]
        with self.assertRaises(RuntimeError):
            self.validate(conf)

    def test_new_compose_refuses_renderer_enabled(self):
        for name, key in [
            ("api", "VNS_PRIVATE_PREVIEWS_RENDER_ENABLED"),
            ("web", "VNS_WEB_PRIVATE_PREVIEW_RENDER_ENABLED"),
        ]:
            conf = synthetic_conf()
            conf["services"][name]["environment"][key] = "true"
            with self.assertRaises(RuntimeError):
                self.validate(conf)

    def test_new_compose_keeps_prior_secret_mounts(self):
        conf = synthetic_conf()
        self.records["api"]["Mounts"] = [{
            "Type": "bind",
            "Destination": "/run/secrets/vns_editor_credentials",
            "Source": "/home/ap/private-editor-credentials",
            "RW": False,
        }]
        conf["services"]["api"]["volumes"].append({
            "type": "bind",
            "target": "/run/secrets/vns_editor_credentials",
            "source": "/home/ap/private-editor-credentials",
            "read_only": True,
        })
        self.validate(conf)
        conf["services"]["api"]["volumes"][-1]["source"] = "/home/ap/other"
        with self.assertRaises(RuntimeError):
            self.validate(conf)

    def test_rollback_omits_preview_overlay_and_never_starts_dependencies(self):
        args = []
        with patch.object(module, "run", side_effect=lambda cmd, **kwargs: args.append(cmd) or ""):
            base = {"VNS_WEB_IMAGE": module.OLD["web"][0], "VNS_API_IMAGE": module.OLD["api"][0]}
            module.apply_services(base, "api")
            self.assertNotIn("deploy/compose.private-previews.yaml", args[-1])
            self.assertIn("--no-deps", args[-1])
            self.assertIn("--no-build", args[-1])
            self.assertIn("never", args[-1])
            self.assertEqual(args[-1][-1], "api")

            proposed = {"VNS_WEB_IMAGE": module.NEW["web"][0],
                        "VNS_API_IMAGE": module.NEW["api"][0]}
            module.apply_services(proposed, "web")
            self.assertIn("deploy/compose.private-previews.yaml", args[-1])
            self.assertEqual(args[-1][-1], "web")
            self.assertNotIn("postgres", args[-1])
            self.assertNotIn("redis", args[-1])
            self.assertNotIn("worker", args[-1])

    def test_mixed_new_old_flags_refused(self):
        with patch.object(module, "run") as run:
            env = {"VNS_WEB_IMAGE": module.OLD["web"][0],
                   "VNS_API_IMAGE": module.NEW["api"][0]}
            # Mixed refs use candidate overlay rather than accidentally
            # taking the rollback path.
            module.apply_services(env, "api")
            self.assertIn("deploy/compose.private-previews.yaml", run.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
