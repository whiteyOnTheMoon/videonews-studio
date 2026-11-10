#!/usr/bin/env python3
"""P4-13: scoped, fail-closed private source-link Web/API update retaining gallery.

Default --preflight is read-only. --apply additionally requires an explicit
operator approval argument. Uses seven reviewed Compose overlays for new images and the exact existing six
for rollback (both retain the private gallery bind). Touches only API/Web,
never feeds, publication, workers, database, ingress, media or secrets.
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
IMAGE_REV = "129b7e4687464ce17d280dfca68e475756f5943e"
OLD_REV = "a51336ed708bbc0055b1f7722a2da47f4e817bfc"
OLD = {
    "web": (
        "ghcr.io/whiteyonthemoon/videonews-studio-web@sha256:6b077023c71caf5c16fdc41e48ae4791f6acc21636b92e0529570bc740af8136",
        "sha256:cc1c893b115eb569f927931d60abd75cb6ab910c48a63811c2a285366f0f5758",
    ),
    "api": (
        "ghcr.io/whiteyonthemoon/videonews-studio-api@sha256:88af6d3348dab85aaf287e2ffde433fda1cc39df2c6f4a78824dfea1e568af02",
        "sha256:5a9690d251b632544db8c1f4ffcf462cd4958c284a6cc0be0c2031c9de7994ea",
    ),
}
NEW = {
    "web": (
        "ghcr.io/whiteyonthemoon/videonews-studio-web@sha256:104ded920a528f9b53562a322108ff105345ad85410fe8a1ea8430133a406f5f",
        None,
    ),
    "api": (
        "ghcr.io/whiteyonthemoon/videonews-studio-api@sha256:86d5074acb56fd92c6fdb8b6deeaf703a3b487cbb1e10dd383a8a3c98cf94e37",
        None,
    ),
}
OLD_OVERLAYS = [
    "compose.yaml",
    "deploy/compose.images.yaml",
    "deploy/compose.admin.yaml",
    "deploy/compose.provider-admin.yaml",
    "deploy/compose.personal-editorial-admin.yaml",
    "deploy/compose.private-previews.yaml",
]
NEWS_OVERLAY = "deploy/compose.news-links-release.yaml"
OVERLAYS = OLD_OVERLAYS + [NEWS_OVERLAY]
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
NEWS_ENV = {
    "web": {
        "VNS_WEB_STUDIO_FEED_REFRESH_ENABLED": "false",
        "VNS_WEB_STUDIO_FEED_STATUS_ENABLED": "false",
    },
    "api": {
        "VNS_STUDIO_FEED_REFRESH_API_ENABLED": "false",
        "VNS_STUDIO_FEED_REFRESH_OPERATOR_ACK": "false",
        "VNS_STUDIO_FEED_STATUS_API_ENABLED": "false",
        "VNS_STUDIO_FEED_STATUS_OPERATOR_ACK": "false",
        "VNS_FEED_SOURCE_BOOTSTRAP": "false",
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
DENIED = "REFUSED: source-link Web/API cutover not admitted; data and media untouched"


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
    """Inspect immutable registry identity for BOTH old and new images."""
    for service in SWITCH_SERVICES:
        for old in (False, True):
            image, expected_id = (OLD if old else NEW)[service]
            records = json.loads(
                run(["docker", "image", "inspect", image], max_stdout=100000)
            )
            if not isinstance(records, list) or len(records) != 1:
                raise RuntimeError(DENIED)
            record = records[0]
            actual_id = record.get("Id")
            digests = record.get("RepoDigests") or []
            labels = (record.get("Config") or {}).get("Labels") or {}
            if (not isinstance(actual_id, str)
                    or not re.fullmatch(r"sha256:[a-f0-9]{64}", actual_id)
                    or image not in digests
                    or labels.get("org.opencontainers.image.revision") !=
                        (OLD_REV if old else IMAGE_REV)
                    or record.get("Architecture") != "amd64"
                    or (record.get("Config") or {}).get("User")
                        not in ("1000", "1000:1000", "node")
                    or (old and actual_id != expected_id)):
                raise RuntimeError(DENIED)
            if not old:
                NEW[service] = (image, actual_id)


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
        result[key] = (NEW if new else OLD)[service][0]
    # Both old six-overlay and new seven-overlay releases MUST keep the
    # already working private gallery enabled with rendering OFF.
    result["VNS_WEB_PRIVATE_PREVIEWS_ENABLED"] = "true"
    result["VNS_PRIVATE_PREVIEWS_API_ENABLED"] = "true"
    result["VNS_WEB_PRIVATE_PREVIEW_RENDER_ENABLED"] = "false"
    result["VNS_PRIVATE_PREVIEWS_RENDER_ENABLED"] = "false"
    if new:
        # No source feed is started by a Web/API image update.
        for flags in NEWS_ENV.values():
            result.update(flags)
    else:
        # Rollback uses original six overlays and original production flags.
        for flags in NEWS_ENV.values():
            for key in flags:
                result.pop(key, None)
    return result


def verify_overlay_source() -> None:
    """Pin all release overlays to the checked-out reviewed Git tree."""
    for rel in ("deploy/compose.private-previews.yaml", NEWS_OVERLAY):
        data = (ROOT / rel).read_bytes()
        git_blob = hashlib.sha1(
            b"blob " + str(len(data)).encode("ascii") + b"\0" + data
        ).hexdigest()
        tracked = run(["git", "rev-parse", "HEAD:" + rel])
        if git_blob != tracked:
            raise RuntimeError(DENIED)
    # Preserve the historical, operator-reviewed private preview overlay.
    if run(["git", "rev-parse", "HEAD:deploy/compose.private-previews.yaml"]) != (
        "d5ae35b9883164d80ea0e339cd2c1e5859690b28"
    ):
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
            if key in PREVIEW_ENV[service] or key in NEWS_ENV[service]:
                expected = (PREVIEW_ENV[service] | NEWS_ENV[service])[key]
                if str(value) != expected:
                    raise RuntimeError(DENIED)
            elif active_env.get(key) != str(value):
                raise RuntimeError(DENIED)
        # No missing or extra preview feature flags.
        for key, value in (PREVIEW_ENV[service] | NEWS_ENV[service]).items():
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
        expected_ref, expected_id = (NEW if expect_new else OLD)[service]
        record = records[service]
        if (record.get("Image") != expected_id
                or (record.get("Config") or {}).get("Image") != expected_ref):
            raise RuntimeError(DENIED)
        mounts = [m for m in record.get("Mounts") or []
                  if m.get("Destination") == PREVIEW]
        if service == "api":
            if (len(mounts) != 1 or mounts[0].get("Type") != "bind"
                    or mounts[0].get("Source") != PREVIEW
                    or mounts[0].get("RW") is not False):
                raise RuntimeError(DENIED)
        elif mounts:
            raise RuntimeError(DENIED)
        env = dict(
            item.split("=", 1)
            for item in (record.get("Config") or {}).get("Env") or []
            if "=" in item
        )
        if any(env.get(key) != value
               for key, value in PREVIEW_ENV[service].items()):
            raise RuntimeError(DENIED)
        for key, value in NEWS_ENV[service].items():
            if expect_new:
                if env.get(key) != value:
                    raise RuntimeError(DENIED)
            elif env.get(key, "false") != "false":
                raise RuntimeError(DENIED)
        observed = [
            Path(x).name for x in (record.get("Config") or {})
            .get("Labels", {}).get("com.docker.compose.project.config_files", "").split(",")
            if x
        ]
        chosen = OVERLAYS if expect_new else OLD_OVERLAYS
        if observed != [Path(x).name for x in chosen]:
            raise RuntimeError(DENIED)


def apply_services(env: dict[str, str], service: str) -> None:
    if service not in SWITCH_SERVICES:
        raise RuntimeError(DENIED)
    is_rollback = (
        env.get("VNS_WEB_IMAGE") == OLD["web"][0]
        and env.get("VNS_API_IMAGE") == OLD["api"][0]
    )
    # Unlike P4-12, rollback MUST retain the sixth private preview overlay.
    # Only the seventh news-specific gate is removed on rollback.
    paths = OLD_OVERLAYS if is_rollback else OVERLAYS
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
    remote = run(["git", "ls-remote", "origin", "refs/heads/main"], timeout=30)
    if remote.split() != [expected, "refs/heads/main"]:
        raise RuntimeError(DENIED)


def main(args: list[str]) -> None:
    parser = argparse.ArgumentParser(description="P4-13 private source-link Web/API cutover")
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--preflight", action="store_true")
    actions.add_argument("--apply", action="store_true")
    actions.add_argument("--status", action="store_true")
    parser.add_argument("--expected-operator-sha", required=True)
    parser.add_argument(
        "--operator-approval", choices=["SOURCE_LINKS_API_WEB_ONLY"],
        help="Required for actual live API/Web recreation; not for preflight/status",
    )
    options = parser.parse_args(args)

    release(options.expected_operator_sha)
    if options.apply and (options.operator_approval != "SOURCE_LINKS_API_WEB_ONLY"
            or os.environ.get("VNS_P4_13_RECOVERY_VERIFIED") !=
               "OPERATOR_VERIFIED_RESTORABLE_BACKUP_AND_GALLERY_ROLLBACK"):
        raise RuntimeError(DENIED)
    # Schema 0065 must already be installed, with private grants validated.
    run(["python3", "scripts/p2_04_schema_0064_to_0065.py",
         "--status", "--expected-sha", options.expected_operator_sha])
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
    print("PASS: seven-overlay Compose plan and preserved secrets/mounts", flush=True)

    if options.status:
        check_app_states(expect_new=True)
        print("PASS: both new source-link images healthy; gallery intact")
        print("PASS: data/worker remain running")
        print("INFO: authenticated browser and byte-range verification remains separate")
        return
    check_app_states(expect_new=False)
    if options.preflight:
        print("PASS: existing six overlays, new seven-overlay plan, images and private gallery")
        print("INFO: read-only; no Compose up, publication or rendering")
        return

    # The only intentional changes are API and Web container replacement.
    # Old immutable digest images must already be available locally.
    print("=== RECREATE SOURCE-LINK API ONLY (NO DEPENDENCIES OR PULL) ===", flush=True)
    try:
        apply_services(candidate, "api")
        unchanged(current)
        print("=== RECREATE SOURCE-LINK WEB ONLY (NO DEPENDENCIES OR PULL) ===", flush=True)
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
    print("PASS: API/Web healthy on source-link GHCR images")
    print("PASS: PostgreSQL, Redis and Worker IDs and start times unchanged")
    print("INFO: Sign in to Admin again; API session may have been invalidated")
    print("INFO: private gallery retained; feed, render and publication OFF")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError, IndexError, KeyError,
            PermissionError, json.JSONDecodeError):
        raise SystemExit(DENIED) from None
