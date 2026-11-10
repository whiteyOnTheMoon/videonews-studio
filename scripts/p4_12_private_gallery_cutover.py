#!/usr/bin/env python3
"""P4-12: scoped, fail-closed live API/Web private preview gallery cutover.

Default --preflight is read-only. --apply additionally requires an explicit
operator approval argument. Uses the six approved Compose overlays for new
images and exactly the prior five for scoped rollback; never edits other
projects, secrets, containers, ingress or video data. Does not render videos.
"""
from __future__ import annotations

import argparse
import hashlib
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
IMAGE_REV = "a51336ed708bbc0055b1f7722a2da47f4e817bfc"
OLD = {
    "web": (
        "vns-web:internal-6b7902c93d8c",
        "sha256:75e2f6156a20061d73644857c193a8ea52fff0517576a6a8cdd66f82f219ea9a",
    ),
    "api": (
        "vns-api:internal-6b7902c93d8c",
        "sha256:473c3c994957d368a5eadec16502908e72358655f1c9925fec9643cc3aac424a",
    ),
}
NEW = {
    "web": (
        "ghcr.io/whiteyonthemoon/videonews-studio-web@sha256:6b077023c71caf5c16fdc41e48ae4791f6acc21636b92e0529570bc740af8136",
        None,
    ),
    "api": (
        "ghcr.io/whiteyonthemoon/videonews-studio-api@sha256:88af6d3348dab85aaf287e2ffde433fda1cc39df2c6f4a78824dfea1e568af02",
        None,
    ),
}
OLD_OVERLAYS = [
    "compose.yaml",
    "deploy/compose.images.yaml",
    "deploy/compose.admin.yaml",
    "deploy/compose.provider-admin.yaml",
    "deploy/compose.personal-editorial-admin.yaml",
]
OVERLAYS = OLD_OVERLAYS + ["deploy/compose.private-previews.yaml"]
PREVIEW = "/home/ap/videonews-previews"
VIDEO = (
    "earth-climate-explained-ozone-2026-en-"
    "20261109-232840-9419cf83.mp4"
)
VIDEO_SHA = "52e9990d3c77d0bad5dd42df6bdd265e871add6fa8d3a961295ca06f49b96eed"
PREVIEW_ENV = {
    "web": {
        "VNS_WEB_PRIVATE_PREVIEWS_ENABLED": "true",
        "VNS_WEB_PRIVATE_PREVIEW_RENDER_ENABLED": "false",
    },
    "api": {
        "VNS_PRIVATE_PREVIEWS_API_ENABLED": "true",
        "VNS_PRIVATE_PREVIEWS_ROOT": PREVIEW,
        "VNS_PRIVATE_PREVIEWS_RENDER_ENABLED": "false",
    },
}
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
DENIED = "REFUSED: private gallery cutover not admitted; existing data and publication untouched"


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
    # Registry digests are immutable and already pulled through the
    # credential-isolated GHCR helper; never resolve mutable tags.
    for service in SWITCH_SERVICES:
        image, _ = NEW[service]
        records = json.loads(
            run(["docker", "image", "inspect", image], max_stdout=100000)
        )
        if not isinstance(records, list) or len(records) != 1:
            raise RuntimeError(DENIED)
        record = records[0]
        actual_id = record.get("Id")
        digests = record.get("RepoDigests") or []
        if (not isinstance(actual_id, str)
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", actual_id)
                or image not in digests
                or (record.get("Config") or {}).get("Labels", {}).get(
                    "org.opencontainers.image.revision") != IMAGE_REV
                or record.get("Architecture") != "amd64"):
            raise RuntimeError(DENIED)
        # User identity is non-root in both release images.
        if (record.get("Config") or {}).get("User") not in ("1000", "1000:1000", "node"):
            raise RuntimeError(DENIED)
        NEW[service] = (image, actual_id)
        old_ref, old_id = OLD[service]
        previous = json.loads(run(
            ["docker", "image", "inspect", old_ref], max_stdout=100000
        ))
        if (not isinstance(previous, list) or len(previous) != 1
                or previous[0].get("Id") != old_id):
            raise RuntimeError(DENIED)

def check_resources() -> None:
    disk = int(run(["df", "-Pk", "/var/lib/docker"]).splitlines()[-1].split()[3])
    with open("/proc/meminfo", encoding="utf-8") as stream:
        memory = {
            line.split(":", 1)[0]: int(line.split()[1])
            for line in stream if line.startswith(("MemAvailable:", "SwapFree:"))
        }
    # Runtime deployment does not build. Require a conservative
    # minimum margin without pretending the machine has healthy swap.
    if disk < 10 * 1024 * 1024 or memory["MemAvailable"] < 2500 * 1024:
        raise RuntimeError(DENIED)
    print("PASS: runtime disk and RAM reserve (no image build)", flush=True)

def verify_preview() -> None:
    root = Path(PREVIEW)
    info = root.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 1000
            or stat.S_IMODE(info.st_mode) != 0o700
            or root.resolve() != root):
        raise RuntimeError(DENIED)
    file = root / VIDEO
    info = file.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 1000
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size != 13625568):
        raise RuntimeError(DENIED)
    with file.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != VIDEO_SHA:
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
        # During the two-step cutover API can be on six overlays while
        # Web still runs on five. After success both must be on six.
        if observed not in (
                [Path(f).name for f in OLD_OVERLAYS],
                [Path(f).name for f in OVERLAYS]):
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
    if origin != "https://studio.ap-pixels.com":
        raise RuntimeError(DENIED)
    if (web.get("VNS_WEB_EDITOR_AUTH_ENABLED") != "true"
            or api.get("VNS_EDITOR_AUTH_ENABLED") != "true"):
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
    if new:
        # The optional sixth overlay defaults private gallery listing OFF.
        # Only the owner-approved API/Web listing gates may be enabled here.
        # Both rendering gates stay strictly OFF in the sixth overlay.
        result["VNS_WEB_PRIVATE_PREVIEWS_ENABLED"] = "true"
        result["VNS_PRIVATE_PREVIEWS_API_ENABLED"] = "true"
        result["VNS_WEB_PRIVATE_PREVIEW_RENDER_ENABLED"] = "false"
        result["VNS_PRIVATE_PREVIEWS_RENDER_ENABLED"] = "false"
    else:
        # Roll back with the original five overlays and without any
        # gallery-related feature toggles inherited from the caller.
        for flags in PREVIEW_ENV.values():
            for flag in flags:
                result.pop(flag, None)
    return result


def verify_overlay_source() -> None:
    """Pin the exact approved overlay, even if Compose JSON normalizes bind options.

    Docker Compose versions can omit create_host_path:false from config JSON.
    A missing marker is safe to tolerate only when the *literal committed*
    overlay is identical and the private host directory was verified.
    """
    data = (ROOT / "deploy/compose.private-previews.yaml").read_bytes()
    git_blob = hashlib.sha1(
        b"blob " + str(len(data)).encode("ascii") + b"\0" + data
    ).hexdigest()
    if git_blob != "d5ae35b9883164d80ea0e339cd2c1e5859690b28":
        raise RuntimeError(DENIED)


def validate_compose(records: dict[str, dict],
                     env: dict[str, str]) -> None:
    verify_overlay_source()
    conf = json.loads(run(
        compose_args() + ["config", "--format", "json"],
        env=env, timeout=50, max_stdout=600000,
    ))
    if conf.get("name") != "videonews-studio":
        raise RuntimeError(DENIED)
    services = conf.get("services") or {}
    for service in SWITCH_SERVICES:
        item = services.get(service) or {}
        if (item.get("image") != NEW[service][0]
                or item.get("pull_policy") != "never"
                or item.get("read_only") is not True
                or "build" in item or item.get("ports")
                or item.get("privileged") is True
                or item.get("cap_drop") != ["ALL"]
                or item.get("network_mode")
                or not any("no-new-privileges" in str(x)
                           for x in item.get("security_opt") or [])):
            raise RuntimeError(DENIED)
        allowed = {"frontend"} if service == "web" else {"frontend", "backend"}
        networks = set(item.get("networks") or {})
        if networks not in (allowed, {"videonews-studio_" + n for n in allowed}):
            raise RuntimeError(DENIED)

        active_env = {}
        for entry in (records[service].get("Config") or {}).get("Env") or []:
            key, sep, value = entry.partition("=")
            if sep:
                active_env[key] = value
        wanted_env = item.get("environment") or {}
        for key, value in wanted_env.items():
            if key in PREVIEW_ENV[service]:
                if str(value) != PREVIEW_ENV[service][key]:
                    raise RuntimeError(DENIED)
            elif active_env.get(key) != str(value):
                raise RuntimeError(DENIED)
        # No missing or extra preview feature flags.
        for key, value in PREVIEW_ENV[service].items():
            if wanted_env.get(key) != value:
                raise RuntimeError(DENIED)

        active_mounts = {
            m.get("Destination"): os.path.normpath(m.get("Source") or "")
            for m in (records[service].get("Mounts") or [])
            if m.get("Type") == "bind"
        }
        expected_mounts = {}
        for mount in item.get("volumes") or []:
            target = mount.get("target")
            source = mount.get("source")
            if not isinstance(target, str) or not isinstance(source, str):
                raise RuntimeError(DENIED)
            if target == PREVIEW:
                # Only the exact pinned source overlay can justify accepting
                # an omitted create_host_path field in normalized Compose JSON.
                # An explicit true or null is always rejected.
                bind = mount.get("bind") or {}
                if (service != "api" or source != PREVIEW
                        or mount.get("type") != "bind"
                        or mount.get("read_only") is not True
                        or (not isinstance(bind, dict))
                        or ("create_host_path" in bind
                            and bind["create_host_path"] is not False)):
                    raise RuntimeError(DENIED)
            expected_mounts[target] = os.path.normpath(source)
        for mounted in item.get("secrets") or []:
            name = mounted.get("source")
            location = mounted.get("target") or name
            if not str(location).startswith("/"):
                location = "/run/secrets/" + str(location)
            secret = (conf.get("secrets") or {}).get(name) or {}
            expected_mounts[location] = os.path.normpath(secret.get("file") or "")
        if service == "web":
            if PREVIEW in expected_mounts or PREVIEW in active_mounts:
                raise RuntimeError(DENIED)
        else:
            if expected_mounts.get(PREVIEW) != PREVIEW:
                raise RuntimeError(DENIED)
            # An existing preview bind is allowed only when already active
            # after a successful gallery cutover.
            if PREVIEW in active_mounts:
                matched = [m for m in records[service].get("Mounts") or []
                           if m.get("Destination") == PREVIEW]
                if (len(matched) != 1 or matched[0].get("RW") is not False
                        or active_mounts[PREVIEW] != PREVIEW):
                    raise RuntimeError(DENIED)
                active_mounts.pop(PREVIEW)
            expected_mounts.pop(PREVIEW)
        if active_mounts != expected_mounts:
            raise RuntimeError(DENIED)
    # Only API/Web may be recreated by apply_services; never dependencies.


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
        expected_ref, expected_id = NEW[service] if expect_new else OLD[service]
        actual_id = records[service].get("Image")
        if actual_id != expected_id:
            raise RuntimeError(DENIED)
        if expect_new:
            if (records[service].get("Config") or {}).get("Image") != expected_ref:
                raise RuntimeError(DENIED)
            mounts = [m for m in records[service].get("Mounts") or []
                      if m.get("Destination") == PREVIEW]
            if service == "api":
                if (len(mounts) != 1 or mounts[0].get("Type") != "bind"
                        or mounts[0].get("Source") != PREVIEW
                        or mounts[0].get("RW") is not False):
                    raise RuntimeError(DENIED)
            elif mounts:
                raise RuntimeError(DENIED)
            active = dict(
                item.split("=", 1)
                for item in (records[service].get("Config") or {}).get("Env") or []
                if "=" in item
            )
            if any(active.get(key) != value
                   for key, value in PREVIEW_ENV[service].items()):
                raise RuntimeError(DENIED)
            observed = [
                Path(x).name for x in (records[service].get("Config") or {})
                .get("Labels", {}).get("com.docker.compose.project.config_files", "").split(",")
                if x
            ]
            if observed != [Path(x).name for x in OVERLAYS]:
                raise RuntimeError(DENIED)

def apply_services(env: dict[str, str], service: str) -> None:
    if service not in SWITCH_SERVICES:
        raise RuntimeError(DENIED)
    # Restore the ORIGINAL five files on rollback, so the old API
    # cannot retain the new private directory mount or gallery flags.
    is_rollback = (
        env.get("VNS_WEB_IMAGE") == OLD["web"][0]
        and env.get("VNS_API_IMAGE") == OLD["api"][0]
    )
    paths = OLD_OVERLAYS if is_rollback else OVERLAYS
    if not is_rollback:
        # Do not attempt to bind a missing or altered host directory even
        # if the installed Compose version mishandles create_host_path:false.
        verify_preview()
        verify_overlay_source()
    args = ["docker", "compose", "--project-name", "videonews-studio"]
    for path in paths:
        args += ["-f", path]
    args += ["--profile", "preview"]
    run(args + [
        "up", "--no-deps", "--no-build", "--pull", "never",
        "--detach", "--wait", "--wait-timeout", "120", service,
    ], env=env, timeout=165, max_stdout=15000)


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
    parser = argparse.ArgumentParser(description="P4-12 private gallery Web/API cutover")
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--preflight", action="store_true")
    actions.add_argument("--apply", action="store_true")
    actions.add_argument("--status", action="store_true")
    parser.add_argument("--expected-operator-sha", required=True)
    parser.add_argument(
        "--operator-approval", choices=["PRIVATE_GALLERY_API_WEB_ONLY"],
        help="Required for actual live API/Web recreation; not for preflight/status",
    )
    options = parser.parse_args(args)

    release(options.expected_operator_sha)
    if options.apply and options.operator_approval != "PRIVATE_GALLERY_API_WEB_ONLY":
        raise RuntimeError(DENIED)
    check_resources()
    verify_preview()
    print("PASS: private video rights, size and SHA256", flush=True)
    current = live()
    env = environment(current)
    print("PASS: running container identities and personal auth", flush=True)
    # Verify immutable new GHCR images and the exact original local images.
    inspect_images()
    print("PASS: previous and candidate image identities", flush=True)
    candidate = image_environment(env, new=True)
    validate_compose(current, candidate)
    print("PASS: six-overlay Compose plan and preserved secrets/mounts", flush=True)

    if options.status:
        check_app_states(expect_new=True)
        print("PASS: both digest-pinned private gallery images healthy")
        print("PASS: data/worker remain running")
        print("INFO: authenticated browser and byte-range verification remains separate")
        return
    check_app_states(expect_new=False)
    if options.preflight:
        print("PASS: existing five overlays, new six-overlay plan, images and private mount")
        print("INFO: read-only; no Compose up, publication or rendering")
        return

    # The only intentional changes are API and Web container replacement.
    # Old immutable digest images must already be available locally.
    print("=== RECREATE PRIVATE GALLERY API ONLY (NO DEPENDENCIES OR PULL) ===", flush=True)
    try:
        apply_services(candidate, "api")
        unchanged(current)
        print("=== RECREATE PRIVATE GALLERY WEB ONLY (NO DEPENDENCIES OR PULL) ===", flush=True)
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
    print("PASS: API/Web healthy on private gallery GHCR images")
    print("PASS: PostgreSQL, Redis and Worker IDs and start times unchanged")
    print("INFO: Sign in to Admin again; API session may have been invalidated")
    print("INFO: Gallery LIST/STREAM only; render and publication OFF")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError, IndexError, KeyError,
            PermissionError, json.JSONDecodeError):
        raise SystemExit(DENIED) from None
