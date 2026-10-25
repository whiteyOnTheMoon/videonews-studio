#!/usr/bin/env python3
"""P1-07: isolated, read-only PostgreSQL TCP acceptance on existing Docker network.

Operator-only --verify. Runs three *separate*, disposable psql client containers
sequentially, each bind-mounted with only its own host secret file read-only.
No existing container restart, no persistent SQL writes, no job enqueue.
"""
import os
from pathlib import Path
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
POSTGRES = "videonews-studio-postgres-1"
BACKEND = "videonews-studio_backend"
SERVICES = (
    # login, inherited group, own secret, different login for wrong-password test,
    # expected updates/jobs, updates/outbox, inserts/evidence, denied SELECT
    (
        "vns_outbox_dispatch_login", "vns_outbox_dispatch",
        "pg_outbox_dispatch_password", "vns_job_status_sync_login",
        "false|true|false", "SELECT publisher FROM vns.research_evidence LIMIT 0",
        "SELECT job_id FROM vns.job_outbox LIMIT 0",
    ),
    (
        "vns_job_status_sync_login", "vns_job_status_sync",
        "pg_job_status_sync_password", "vns_research_writer_login",
        "true|false|false", "SELECT publisher FROM vns.research_evidence LIMIT 0",
        "SELECT id FROM vns.jobs LIMIT 0",
    ),
    (
        "vns_research_writer_login", "vns_research_writer",
        "pg_research_writer_password", "vns_outbox_dispatch_login",
        "false|false|true", "SELECT job_id FROM vns.job_outbox LIMIT 0",
        "SELECT topic FROM vns.research_requests LIMIT 0",
    ),
)
EXPECTED = "PASS"

# Only static, reviewed command code appears in Docker process arguments.
# The password remains on the host file bind mount and in ephemeral /tmp/pgpass.
CLIENT_SCRIPT = r"""
set -eu
umask 077
LOGIN="$1"
GROUP="$2"
OTHER="$3"
GRANTS="$4"
DENIED="$5"
ALLOWED="$6"
export PGPASSFILE=/tmp/pgpass
export PGCONNECT_TIMEOUT=5
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=4000'

test -r /run/secrets/own_pg_password
printf 'postgres:5432:videonews:%s:%s\n' "$LOGIN" \
  "$(cat /run/secrets/own_pg_password)" > "$PGPASSFILE"
chmod 600 "$PGPASSFILE"

RESULT="$(psql -X -w -A -t -q -v ON_ERROR_STOP=1 \
  -h postgres -p 5432 -U "$LOGIN" -d videonews -c "
SELECT concat_ws('|',
  current_user,
  CASE WHEN inet_client_addr() IS NOT NULL
    AND inet_client_addr()::text NOT IN ('127.0.0.1','::1')
    THEN 'tcp' ELSE 'local' END,
  pg_has_role(current_user, '$GROUP', 'USAGE'),
  pg_has_role(current_user, 'vns', 'MEMBER'),
  has_column_privilege(current_user, 'vns.jobs', 'status', 'UPDATE'),
  has_column_privilege(current_user, 'vns.job_outbox', 'delivery_state', 'UPDATE'),
  has_table_privilege(current_user, 'vns.research_evidence', 'INSERT'),
  has_column_privilege(current_user, 'vns.research_evidence', 'review_status', 'UPDATE'),
  has_schema_privilege(current_user, 'vns', 'CREATE'));")"
test "$RESULT" = "$LOGIN|tcp|true|false|$GRANTS|false|false"

psql -X -w -A -t -q -v ON_ERROR_STOP=1 \
  -h postgres -U "$LOGIN" -d videonews -c "$ALLOWED" >/dev/null

if psql -X -w -A -t -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate \
  -h postgres -U "$LOGIN" -d videonews -c "$DENIED" \
  >/tmp/deny.out 2>/tmp/deny.err; then
  exit 10
fi
grep -q '42501' /tmp/deny.err || exit 11

# Same secret, *different* login: must be rejected over Docker TCP.
printf 'postgres:5432:videonews:%s:%s\n' "$OTHER" \
  "$(cat /run/secrets/own_pg_password)" > "$PGPASSFILE"
if psql -X -w -A -t -q -v ON_ERROR_STOP=1 \
  -h postgres -U "$OTHER" -d videonews -c 'SELECT 1' \
  >/tmp/wrong.out 2>/tmp/wrong.err; then
  exit 12
fi
grep -q 'password authentication failed' /tmp/wrong.err || exit 13

printf 'PASS\n'
"""


def safe_run(args: list[str], timeout: int = 20) -> str:
    # Never echo stderr: it can contain connection metadata or paths.
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError("guarded command failed")
    return result.stdout.strip()


def inspect_local_secret_paths(directory: Path) -> dict[str, Path]:
    if os.geteuid() != 1000 or directory.is_symlink():
        raise PermissionError("unexpected operator identity or secret path")
    folder = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(folder)
        if info.st_uid != 1000 or stat.S_IMODE(info.st_mode) != 0o700:
            raise PermissionError("secret directory ownership or mode refused")
        paths = {}
        for _, _, name, *_ in SERVICES:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=folder)
            try:
                info = os.fstat(fd)
                if (
                    not stat.S_ISREG(info.st_mode) or
                    info.st_uid != 1000 or
                    stat.S_IMODE(info.st_mode) != 0o600 or
                    info.st_nlink != 1
                ):
                    raise PermissionError("secret ownership or mode refused")
            finally:
                os.close(fd)
            paths[name] = directory / name
        return paths
    finally:
        os.close(folder)


def preflight() -> str:
    if safe_run(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError("unexpected Git branch")
    if safe_run(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError("unreviewed checkout")
    if safe_run(["docker", "network", "inspect", "-f", "{{.Internal}}", BACKEND]) != "true":
        raise RuntimeError("network is not internal")
    actual = safe_run([
        "docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        "{{.State.Health.Status}}|{{.Image}}", POSTGRES,
    ])
    parts = actual.split("|")
    if len(parts) != 4 or parts[:3] != ["videonews-studio", "postgres", "healthy"]:
        raise RuntimeError("unexpected PostgreSQL service")
    if safe_run(["docker", "port", POSTGRES]):
        raise RuntimeError("PostgreSQL unexpectedly publishes a port")
    safe_run(["docker", "image", "inspect", parts[3]])
    return parts[3]


def test_service(image: str, entry: tuple, secret: Path) -> None:
    login, group, _, other, grants, denied, allowed = entry
    args = [
        "docker", "run", "--rm", "--pull=never",
        "--network", BACKEND,
        "--user", "1000:1000",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "32",
        "--memory", "128m", "--memory-swap", "128m",
        "--cpus", "0.25",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=0700,uid=1000,gid=1000,size=2m",
        "--mount", f"type=bind,src={secret},dst=/run/secrets/own_pg_password,readonly",
        "--entrypoint", "/bin/sh",
        image, "-ec", CLIENT_SCRIPT, "vns-auth-test",
        login, group, other, grants, denied, allowed,
    ]
    if safe_run(args, timeout=55) != EXPECTED:
        raise RuntimeError("unexpected client receipt")


def main() -> None:
    if sys.argv[1:] != ["--verify"]:
        raise RuntimeError("explicit --verify required")
    secret_paths = inspect_local_secret_paths(ROOT / "secrets")
    image = preflight()
    for entry in SERVICES:
        test_service(image, entry, secret_paths[entry[2]])
        print(f"PASS: {entry[0]} authenticated, rights verified, wrong password denied")
    print("PASS: all three isolated Docker-network checks completed")
    print("No persistent SQL write, editorial activation or existing container restart")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
        raise SystemExit("REFUSED: isolated PostgreSQL network test failed; secrets not displayed")
