#!/usr/bin/env python3
"""P2-04: replace ONLY live API/Web with locally built inbox images.

Default: read-only admission. An explicit --apply recreates API and Web
individually, with no dependencies/build/pull. On a catchable failure it
attempts a single scoped rollback to their original, pinned image digests.
Never calls any editorial publication endpoint.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path("/home/ap/www/videonews-studio")
IMAGE_REV = "6b7902c93d8c05efc7d97affe8fcf17ef268a6fc"
OLD = {
    "web": (
        "ghcr.io/whiteyonthemoon/videonews-studio-web@sha256:"
        "777931025f8be88787c887f1940c57dbf702427685045d580c1ca00c963f0024",
        "sha256:e77fd2058dfca6244500254752637523bf70eaae78eea6a14c138659dd0d0518",
    ),
    "api": (
        "ghcr.io/whiteyonthemoon/videonews-studio-api@sha256:"
        "856fcedb79d9b3a1fe34709406a7869e7c7e8671668ccd3bbb080f8a119b52df",
        "sha256:a3d4eab25fde4c3cd0c017d872ca964fd0d87663b1a80b8b26977cb722eafd32",
    ),
}
NEW = {
    "api": ("vns-api:internal-6b7902c93d8c",
            "sha256:473c3c994957d368a5eadec16502908e72358655f1c9925fec9643cc3aac424a"),
    "web": ("vns-web:internal-6b7902c93d8c",
            "sha256:75e2f6156a20061d73644857c193a8ea52fff0517576a6a8cdd66f82f219ea9a"),
}
OVERLAYS = [
    "compose.yaml",
    "deploy/compose.images.yaml",
    "deploy/compose.admin.yaml",
    "deploy/compose.provider-admin.yaml",
    "deploy/compose.personal-editorial-admin.yaml",
]
LIVE_SERVICES = ("web", "api", "postgres", "redis", "worker")
SWITCH_SERVICES = ("api", "web")
# These are operator flags, not credentials; reproduce exact live values.
BOOLEANS = {
    "web": (
        "VNS_WEB_EDITORIAL_ADMIN_ENABLED",
        "VNS_WEB_SOURCE_REGISTRY_ENABLED",
        "VNS_WEB_HOST_APPROVAL_ENABLED",
    ),
    "api": (
        "VNS_P2_SOURCE_ADMIN_ENABLED",
        "VNS_P2_SOURCE_ADMIN_OPERATOR_ACK",
        "VNS_P2_HOST_ADMIN_ENABLED",
        "VNS_P2_HOST_ADMIN_OPERATOR_ACK",
        "VNS_EDITORIAL_PERSONAL_DB_ENABLED",
        "VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK",
    ),
}
DENIED = "REFUSED: private Admin image cutover not admitted; no publication"


def run(args: list[str], *, env: dict[str, str] | None = None,
        timeout: int = 40, max_stdout: int = 250000) -> str:
    try:
        result = subprocess.run(
            args, text=True, capture_output=True, check=False, timeout=timeout,
            cwd=ROOT, env=env if env is not None else os.environ,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(DENIED) from None
    # Never echo a subprocess error. Docker/Compose may include sensitive
    # runtime environment or secret host paths in its error diagnostics.
    if result.returncode or len(result.stdout) > max_stdout:
        raise RuntimeError(DENIED)
    return result.stdout.strip()


def inspect_objects(*names: str) -> list[dict]:
    raw = run(["docker", "inspect", *names], max_stdout=500000)
    result = json.loads(raw)
    if not isinstance(result, list) or len(result) != len(names):
        raise RuntimeError(DENIED)
    return result


def inspect_images() -> None:
    for service in SWITCH_SERVICES:
        image, image_id = NEW[service]
        raw = run(["docker", "image", "inspect", image], max_stdout=100000)
        records = json.loads(raw)
        if (not isinstance(records, list) or len(records) != 1
                or records[0].get("Id") != image_id
                or (records[0].get("Config") or {}).get("Labels", {}).get(
                    "org.opencontainers.image.revision") != IMAGE_REV
                or records[0].get("Architecture") != "amd64"):
            raise RuntimeError(DENIED)
        old_ref, old_id = OLD[service]
        previous = json.loads(
            run(["docker", "image", "inspect", old_ref], max_stdout=100000)
        )
        if (not isinstance(previous, list) or len(previous) != 1
                or previous[0].get("Id") != old_id):
            raise RuntimeError(DENIED)


def live() -> dict[str, dict]:
    records = inspect_objects(*[
        "videonews-studio-" + name + "-1" for name in LIVE_SERVICES
    ])
    out = dict(zip(LIVE_SERVICES, records))
    for name, rec in out.items():
        labels = (rec.get("Config") or {}).get("Labels") or {}
        state = rec.get("State") or {}
        if (labels.get("com.docker.compose.project") != "videonews-studio"
                or labels.get("com.docker.compose.service") != name
                or state.get("Status") != "running"):
            raise RuntimeError(DENIED)
        if name in ("web", "api", "postgres"):
            if (state.get("Health") or {}).get("Status") != "healthy":
                raise RuntimeError(DENIED)
    for service in SWITCH_SERVICES:
        labels = (out[service].get("Config") or {}).get("Labels") or {}
        paths = labels.get("com.docker.compose.project.config_files", "")
        observed = [Path(x).name for x in paths.split(",") if x]
        if observed != [Path(f).name for f in OVERLAYS]:
            raise RuntimeError(DENIED)
        if (out[service].get("HostConfig") or {}).get("PortBindings") not in (
            None, {},
        ):
            raise RuntimeError(DENIED)
    return out


def environment(records: dict[str, dict]) -> dict[str, str]:
    def extract(service: str) -> dict[str, str]:
        raw = (records[service].get("Config") or {}).get("Env") or []
        env = {}
        for item in raw:
            key, sep, value = item.partition("=")
            if not sep or key in env:
                raise RuntimeError(DENIED)
            env[key] = value
        return env

    web, api = extract("web"), extract("api")
    origin = web.get("VNS_ADMIN_ORIGIN")
    if not origin or origin != api.get("VNS_ADMIN_ORIGIN"):
        raise RuntimeError(DENIED)
    parsed = urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname
            or parsed.username or parsed.password or parsed.path
            or parsed.query or parsed.fragment):
        raise RuntimeError(DENIED)
    if (web.get("VNS_WEB_ADMIN_ENABLED") != "true"
            or web.get("VNS_WEB_EDITORIAL_ADMIN_ENABLED") != "true"
            or api.get("VNS_ADMIN_AUTH_ENABLED") != "true"
            or api.get("VNS_EDITORIAL_PERSONAL_DB_ENABLED") != "true"
            or api.get("VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK") != "true"):
        raise RuntimeError(DENIED)

    editor = [m for m in records["api"].get("Mounts", [])
              if m.get("Destination") == "/run/secrets/vns_editor_credentials"]
    if (len(editor) != 1 or editor[0].get("Type") != "bind"
            or editor[0].get("RW") is not False):
        raise RuntimeError(DENIED)
    source = editor[0].get("Source")
    # The root-owned credential mount can be deliberately unstatable by ap.
    # Trust only the already active Docker bind identity; Compose's
    # create_host_path:false prevents synthesizing a replacement directory.
    if (not isinstance(source, str) or not source.startswith("/")
            or source in ("/", "/tmp", "/run", "/var/lib")):
        raise RuntimeError(DENIED)

    result = dict(os.environ)
    result.update({
        "COMPOSE_PROFILES": "",
        "VNS_ADMIN_ORIGIN": origin,
        "VNS_P2_EDITORIAL_PERSONAL_CREDENTIALS_DIR": source,
    })
    for service, candidate in (("web", web), ("api", api)):
        for flag in BOOLEANS[service]:
            if candidate.get(flag) not in ("true", "false"):
                raise RuntimeError(DENIED)
            result[flag] = candidate[flag]
    return result


def compose_args() -> list[str]:
    args = ["docker", "compose", "--project-name", "videonews-studio"]
    for path in OVERLAYS:
        args += ["-f", path]
    return args + ["--profile", "preview"]


def image_environment(base: dict[str, str], *, new: bool) -> dict[str, str]:
    result = dict(base)
    for service in SWITCH_SERVICES:
        key = "VNS_WEB_IMAGE" if service == "web" else "VNS_API_IMAGE"
        result[key] = NEW[service][0] if new else OLD[service][0]
    return result


def validate_compose(records: dict[str, dict],
                     env: dict[str, str]) -> None:
    conf = json.loads(run(
        compose_args() + ["config", "--format", "json"],
        env=env, timeout=50, max_stdout=600000,
    ))
    if conf.get("name") != "videonews-studio":
        raise RuntimeError(DENIED)
    services = conf.get("services") or {}
    for service in SWITCH_SERVICES:
        expected = NEW[service][0]
        item = services.get(service) or {}
        if (item.get("image") != expected
                or item.get("pull_policy") != "never"
                or item.get("read_only") is not True
                or "build" in item or item.get("ports")
                or item.get("privileged") is True
                or item.get("cap_drop") != ["ALL"]):
            raise RuntimeError(DENIED)
        networks = item.get("networks") or {}
        allowed = {"videonews-studio_frontend"} if service == "web" else {
            "videonews-studio_frontend", "videonews-studio_backend"
        }
        # Compose's JSON network names can use logical keys rather than full IDs.
        if set(networks) not in (allowed, {
            x.removeprefix("videonews-studio_") for x in allowed
        }):
            raise RuntimeError(DENIED)
        current = {}
        for entry in (records[service].get("Config") or {}).get("Env") or []:
            key, sep, value = entry.partition("=")
            if sep:
                current[key] = value
        for key, value in (item.get("environment") or {}).items():
            if current.get(key) != str(value):
                raise RuntimeError(DENIED)
        old_mounts = {
            m.get("Destination") for m in records[service].get("Mounts") or []
            if m.get("Type") == "bind"
        }
        requested = {
            v.get("target") for v in item.get("volumes") or []
        }
        requested.update({
            (s.get("target") if str(s.get("target") or "").startswith("/")
             else "/run/secrets/" + str(s.get("target") or s.get("source") or ""))
            for s in item.get("secrets") or []
        })
        if old_mounts != requested:
            raise RuntimeError(DENIED)
    # No service other than API/Web can be brought up by the selected call,
    # because --no-deps and exact service names are mandatory below.


def unchanged(baseline: dict[str, dict]) -> None:
    now = live()
    for service in ("postgres", "redis", "worker"):
        before, after = baseline[service], now[service]
        if (before.get("Id") != after.get("Id")
                or (before.get("State") or {}).get("StartedAt")
                != (after.get("State") or {}).get("StartedAt")):
            raise RuntimeError(DENIED)


def check_app_states(expect_new: bool) -> None:
    records = live()
    for service in SWITCH_SERVICES:
        expected_image = NEW[service] if expect_new else OLD[service]
        if ((records[service].get("Config") or {}).get("Image")
                != expected_image[0] or records[service].get("Image")
                != expected_image[1]):
            raise RuntimeError(DENIED)


def apply_services(env: dict[str, str], service: str) -> None:
    if service not in SWITCH_SERVICES:
        raise RuntimeError(DENIED)
    run(
        compose_args() + [
            "up", "--no-deps", "--no-build", "--pull", "never",
            "--detach", "--wait", "--wait-timeout", "120", service,
        ],
        env=env, timeout=165, max_stdout=15000,
    )


def release(expected: str) -> None:
    if (not re.fullmatch(r"[a-f0-9]{40}", expected)
            or os.geteuid() != 1000
            or pwd.getpwuid(os.getuid()).pw_name != "ap"):
        raise RuntimeError(DENIED)
    idx = (ROOT / ".git/index").lstat()
    if (not stat.S_ISREG(idx.st_mode) or idx.st_nlink != 1
            or idx.st_uid != 1000 or idx.st_gid != 1000
            or stat.S_IMODE(idx.st_mode) != 0o600):
        raise RuntimeError(DENIED)
    def git(*args: str) -> str:
        return run(["git", "--no-optional-locks", *args], max_stdout=10000)
    if (git("branch", "--show-current") != "main"
            or git("rev-parse", "HEAD") != expected
            or git("status", "--porcelain") != ""):
        raise RuntimeError(DENIED)
    run(["git", "merge-base", "--is-ancestor", IMAGE_REV, expected])


def main(args: list[str]) -> None:
    parser = argparse.ArgumentParser(description="P2-04 private local Admin cutover")
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--preflight", action="store_true")
    actions.add_argument("--apply", action="store_true")
    actions.add_argument("--status", action="store_true")
    parser.add_argument("--expected-operator-sha", required=True)
    options = parser.parse_args(args)

    release(options.expected_operator_sha)
    current = live()
    env = environment(current)
    # New images are verified against actual config SHA digests from the
    # operator's successful local BuildKit build, not just mutable names.
    inspect_images()
    candidate = image_environment(env, new=True)
    validate_compose(current, candidate)

    if options.status:
        check_app_states(expect_new=True)
        print("PASS: both local inbox images healthy; data/worker running")
        print("INFO: Admin browser verification remains separate")
        return
    check_app_states(expect_new=False)
    if options.preflight:
        print("PASS: five existing overlays, auth flags, secrets and local images")
        print("INFO: read-only; no Compose up, publisher or feed request")
        return

    # The only intentional changes are API and Web container replacement.
    # Old immutable digest images must already be available locally.
    print("=== RECREATE API ONLY (NO DEPENDENCIES OR PULL) ===", flush=True)
    try:
        apply_services(candidate, "api")
        unchanged(current)
        print("=== RECREATE WEB ONLY (NO DEPENDENCIES OR PULL) ===", flush=True)
        apply_services(candidate, "web")
        unchanged(current)
        check_app_states(expect_new=True)
        release(options.expected_operator_sha)
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired):
        print("WARNING: scoped API/Web cutover failed; attempt one rollback",
              file=sys.stderr, flush=True)
        old_env = image_environment(env, new=False)
        restored = True
        for service in SWITCH_SERVICES:
            try:
                apply_services(old_env, service)
            except (OSError, RuntimeError, ValueError):
                restored = False
        try:
            unchanged(current)
            check_app_states(expect_new=False)
        except (OSError, RuntimeError, ValueError):
            restored = False
        if not restored:
            print("WARNING: rollback incomplete; inspect ONLY API/Web state",
                  file=sys.stderr)
        raise RuntimeError(DENIED) from None
    print("PASS: API/Web healthy on local P2-04 inbox images")
    print("PASS: PostgreSQL, Redis and Worker IDs and start times unchanged")
    print("INFO: Sign in to Admin again; API session may have been invalidated")
    print("INFO: No news/video publication authorized")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError, IndexError, KeyError,
            PermissionError, json.JSONDecodeError):
        raise SystemExit(DENIED) from None
