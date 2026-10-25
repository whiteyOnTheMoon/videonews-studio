#!/usr/bin/env python3
"""Read-only failed editorial job report via the scoped status-sync SQL account."""
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SECRET = ROOT / "secrets" / "pg_job_status_sync_password"
NETWORK = "videonews-studio_backend"
POSTGRES = "videonews-studio-postgres-1"

QUERY = """
SELECT 'TOTAL|' || count(*)::text FROM vns.jobs WHERE status='failed';
SELECT 'JOB|' || id::text || '|' || kind || '|' || attempt_count::text || '|' ||
       max_attempts::text || '|' ||
       CASE WHEN error_code = 'bullmq_failed' THEN 'bullmq_failed' ELSE 'other' END
FROM vns.jobs WHERE status='failed'
ORDER BY updated_at DESC, id DESC LIMIT 20;
"""

CLIENT = r"""
set -eu
umask 077
export PGPASSFILE=/tmp/vns-pgpass
export PGCONNECT_TIMEOUT=5
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000'
test -r /run/secrets/status_password
printf 'postgres:5432:videonews:vns_job_status_sync_login:%s\n'   "$(cat /run/secrets/status_password)" > "$PGPASSFILE"
chmod 600 "$PGPASSFILE"
test "$(psql -X -w -A -t -q -v ON_ERROR_STOP=1 -h postgres   -U vns_job_status_sync_login -d videonews   -c "SELECT CASE WHEN current_user = 'vns_job_status_sync_login' AND
                    inet_client_addr() IS NOT NULL AND
                    inet_client_addr()::text NOT IN ('127.0.0.1','::1')
               THEN 'PASS' ELSE 'NO' END;")" = PASS
psql -X -w -A -t -q -v ON_ERROR_STOP=1 -h postgres   -U vns_job_status_sync_login -d videonews -c "$1"
"""


def run(args: list[str], timeout: int = 20) -> str:
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError("guarded command failed")
    return result.stdout.strip()


def validate_secret() -> None:
    if os.geteuid() != 1000 or SECRET.parent.is_symlink():
        raise PermissionError("operator ownership rejected")
    fd = os.open(SECRET.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != 1000 or stat.S_IMODE(info.st_mode) != 0o700:
            raise PermissionError("unsafe secret directory")
        child = os.open(SECRET.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            info = os.fstat(child)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 1000
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise PermissionError("unsafe secret file")
        finally:
            os.close(child)
    finally:
        os.close(fd)


def preflight() -> str:
    if run(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError("wrong branch")
    if run(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError("unreviewed changes")
    if run(["docker", "network", "inspect", "-f", "{{.Internal}}", NETWORK]) != "true":
        raise RuntimeError("unexpected network")
    observed = run([
        "docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        "{{.State.Health.Status}}|{{.Image}}", POSTGRES,
    ]).split("|")
    if len(observed) != 4 or observed[:3] != ["videonews-studio", "postgres", "healthy"]:
        raise RuntimeError("unexpected Postgres container")
    if run(["docker", "port", POSTGRES]):
        raise RuntimeError("published database port")
    run(["docker", "image", "inspect", observed[3]])
    return observed[3]


def render(raw: str) -> list[str]:
    rows = raw.splitlines()
    if not rows or not re.fullmatch(r"TOTAL\|[0-9]{1,12}", rows[0]):
        raise ValueError("invalid count receipt")
    total = int(rows[0].split("|")[1])
    if len(rows) - 1 != min(total, 20):
        raise ValueError("inconsistent count receipt")
    out = [f"FAILED_JOBS: {total}, showing {len(rows)-1}"]
    for record in rows[1:]:
        fields = record.split("|")
        if (len(fields) != 6 or fields[0] != "JOB"
                or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", fields[1])
                or fields[2] not in ("research", "script", "render", "upload")
                or not fields[3].isdigit() or not fields[4].isdigit()
                or fields[5] not in ("bullmq_failed", "other")):
            raise ValueError("invalid job receipt")
        attempts, maximum = int(fields[3]), int(fields[4])
        if not (0 <= attempts <= maximum <= 20 and maximum >= 1):
            raise ValueError("invalid attempt count")
        out.append(f"JOB: {fields[1]} | {fields[2]} | {attempts}/{maximum} | {fields[5]}")
    return out


def main() -> None:
    if sys.argv[1:] != ["--list"]:
        raise RuntimeError("explicit --list required")
    validate_secret()
    image = preflight()
    response = run([
        "docker", "run", "--rm", "--pull=never", "--network", NETWORK,
        "--user", "1000:1000", "--read-only", "--cap-drop=ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "32",
        "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.25",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=0700,uid=1000,gid=1000,size=2m",
        "--mount", f"type=bind,src={SECRET},dst=/run/secrets/status_password,readonly",
        "--entrypoint", "/bin/sh", image, "-ec", CLIENT, "vns-failure-report", QUERY,
    ], timeout=45)
    for line in render(response):
        print(line)
    print("PASS: status-sync SQL identity, read-only report, no services modified")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
        raise SystemExit("REFUSED: read-only failure report unavailable, no secrets displayed")
