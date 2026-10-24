#!/usr/bin/env python3
"""Read-only, operator-run verification of P1-07 Redis ACL authentication.

No secret is supplied on the command line, in Docker environment variables,
or in logs. Redis receives AUTH only through redis-cli standard input.
No keys are written and no Docker/Compose service is modified.
"""
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
EXPECTED_ACL_PREFIX = "user vns_worker on #"
EXPECTED_ACL_SUFFIX = " ~bull:vns:* +@all -@admin -@dangerous +info"


def refuse(message: str) -> None:
    raise RuntimeError(message)


def run(*args: str, input_text: str | None = None) -> str:
    try:
        result = subprocess.run(
            args,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        refuse("Docker probe unavailable or timed out")
    if result.returncode != 0:
        # Docker stderr may contain confidential local information. Do not echo.
        refuse("Docker command failed; verify engine access and container state")
    return result.stdout.strip()


def inspect(container: str, template: str) -> str:
    return run("docker", "inspect", "--format", template, container)


def check_target(project: str, container: str) -> None:
    label_project = inspect(container, '{{index .Config.Labels "com.docker.compose.project"}}')
    label_service = inspect(container, '{{index .Config.Labels "com.docker.compose.service"}}')
    health = inspect(container, "{{.State.Health.Status}}")
    if (label_project, label_service, health) != (project, "redis", "healthy"):
        refuse("Redis does not match the healthy isolated Compose service")

    port_list = run("docker", "port", container)
    if port_list:
        refuse("Redis has an unexpected published host port")

    networks = inspect(
        container,
        '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}',
    ).split()
    if networks != [project + "_backend"]:
        refuse("Redis must use only the private project backend network")


def load_secret() -> str:
    directory = ROOT / "secrets"
    if directory.is_symlink() or not directory.is_dir():
        refuse("local secrets directory missing or is a symlink")
    if stat.S_IMODE(directory.stat().st_mode) != 0o700:
        refuse("secrets directory must be mode 0700")

    password_file = directory / "redis_password"
    acl_file = directory / "redis_acl"
    for file in (password_file, acl_file):
        if file.is_symlink() or not file.is_file():
            refuse("Redis credential file missing or symlinked")
    if stat.S_IMODE(password_file.stat().st_mode) != 0o600:
        refuse("Redis password must be mode 0600")

    try:
        password = password_file.read_text(encoding="ascii").strip()
        acl_lines = acl_file.read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeError):
        refuse("Redis credential file unreadable")
    if len(password) < 40 or not re.fullmatch(r"[A-Za-z0-9_-]+", password):
        refuse("Redis password format invalid")

    digest = hashlib.sha256(password.encode("ascii")).hexdigest()
    if acl_lines != [
        "user default off",
        EXPECTED_ACL_PREFIX + digest + EXPECTED_ACL_SUFFIX,
    ]:
        refuse("ACL does not match worker password or expected restrictions")
    return password


def validate(project: str) -> None:
    container = project + "-redis-1"
    check_target(project, container)
    password = load_secret()
    anonymous = run("docker", "exec", container, "redis-cli", "ping")
    if "NOAUTH" not in anonymous:
        refuse("Unauthenticated Redis request did not fail closed")

    # The sole permitted key command below is EXISTS, which cannot mutate data.
    # A foreign key must be denied by the Redis ACL without executing it.
    script = (
        "AUTH vns_worker " + password + "\n"
        "PING\n"
        "EXISTS bull:vns:p107-auth-read-only-test\n"
        "EXISTS outside-vns-auth-test\n"
        "QUIT\n"
    )
    try:
        result = subprocess.run(
            ["docker", "exec", "-i", container, "redis-cli", "--raw"],
            input=script,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        refuse("Authenticated Redis probe failed or timed out")
    if result.returncode != 0:
        refuse("Authenticated Redis probe returned an error")
    lines = result.stdout.strip().splitlines()
    if len(lines) < 4 or lines[:3] != ["OK", "PONG", "0"]:
        refuse("Redis worker authentication, PING or safe namespace check failed")
    if not any("NOPERM" in line for line in lines[3:] + result.stderr.splitlines()):
        refuse("Redis ACL did not deny a foreign namespace read")
    print("PASS: healthy isolated Redis, matched worker secret/ACL, named-user PING")
    print("PASS: allowed namespace is readable; foreign namespace is denied")
    print("PASS: read-only, no keys written and no secrets printed")


def main() -> None:
    if len(sys.argv) != 1:
        refuse("no command-line arguments accepted")
    project = "videonews-studio"
    ci_override = os.environ.get("VNS_CI_REDIS_PROJECT")
    if ci_override is not None:
        if not (
            os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("CI") == "true"
            and os.environ.get("GITHUB_REPOSITORY") == "whiteyOnTheMoon/videonews-studio"
            and re.fullmatch(r"[0-9]+", os.environ.get("GITHUB_RUN_ID", ""))
            and ci_override == "vns-p107-auth-ci"
        ):
            refuse("CI Redis target override requires trusted disposable GitHub Actions")
        project = ci_override
    validate(project)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        print("REFUSED: " + str(exc), file=sys.stderr)
        raise SystemExit(1) from None
