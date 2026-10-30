#!/usr/bin/env python3
"""P2: default-off, operator-gated enrollment of ONE existing personal owner.

Never creates an editor account, approves sources/hosts, starts a worker,
modifies P1 credentials, replays SQL, or activates an API. Only the single
existing, active P1 owner may be bound to one dedicated, non-superuser LOGIN.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys

from provision_pg_runtime_logins import scram_verifier

ROOT = Path(__file__).resolve().parent.parent
CONTAINER = "videonews-studio-postgres-1"
OWNER = "vns_owner_admin"  # Fixed one-time P1 owner bootstrap identity.
LOGIN = "editor_" + OWNER
ROLE = "vns_p2_named_client"
SECRET_DIR = ROOT / "secrets" / "p2-editorial-personal"
SECRET_FILE = LOGIN + ".password"
SHA_APPROVAL = "VNS_P2_OWNER_DB_EXPECTED_SHA"
ACK = "VNS_P2_OWNER_DB_OPERATOR_APPROVED"
ACK_VALUE = "ENROLL_EXISTING_OWNER_ONLY"
FAIL = "REFUSED: personal owner PostgreSQL enrollment prerequisites not met"
SHA = re.compile(r"^[a-f0-9]{40}$")
SCRAM = re.compile(r"^SCRAM-SHA-256\\$4096:[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$")

READ_SQL = """
SELECT current_user || '|' || current_database() || '|' ||
 current_setting('is_superuser') || '|' ||
 current_setting('server_version_num') || '|' ||
 (SELECT count(*) FROM vns.schema_migrations) || '|' ||
 (SELECT max(version) FROM vns.schema_migrations) || '|' ||
 (SELECT count(*) FROM vns.editor_accounts WHERE role='admin') || '|' ||
 (SELECT count(*) FROM vns.editor_accounts
   WHERE role='admin' AND active=true) || '|' ||
 (SELECT count(*) FROM vns.editor_accounts
   WHERE username='vns_owner_admin' AND role='admin'
     AND active=true AND auth_version>=0) || '|' ||
 (SELECT count(*) FROM vns.editor_db_principals) || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname='editor_vns_owner_admin') || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname='vns_p2_named_client'
   AND NOT rolcanlogin AND NOT rolsuper) || '|' ||
 (SELECT count(*) FROM vns.admin_source_audit) || '|' ||
 (SELECT count(*) FROM vns.admin_source_host_audit);
""".strip()

# This constant intentionally excludes passwords, usernames and UUIDs.
EXPECTED_PARTS = (
    "vns", "videonews", "on", "17",
    "59", "0059_canonical_event_title_fingerprint",
    "1", "1", "1", "0", "0", "1", "0", "0",
)


def run(argv: list[str], *, payload: str | None = None, timeout: int = 40) -> str:
    try:
        result = subprocess.run(
            argv, input=payload, capture_output=True, text=True,
            check=False, timeout=timeout,
        )
        if result.returncode != 0 or len(result.stdout) > 4096:
            raise RuntimeError(FAIL)
        return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(FAIL) from None


def git_state() -> str:
    if os.geteuid() != 1000:
        raise RuntimeError(FAIL)
    if run(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(FAIL)
    if run(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(FAIL)
    sha = run(["git", "-C", str(ROOT), "rev-parse", "--verify", "HEAD"])
    if not SHA.fullmatch(sha):
        raise RuntimeError(FAIL)
    return sha


def db_container() -> str:
    actual = run([
        "docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}',
        CONTAINER,
    ])
    if actual != "videonews-studio|postgres|healthy":
        raise RuntimeError(FAIL)
    return CONTAINER


def db_sql(query: str, *, readonly: bool) -> str:
    if query != READ_SQL and readonly:
        raise RuntimeError(FAIL)
    settings = "-c lock_timeout=3s -c statement_timeout=15000"
    if readonly:
        settings += " -c default_transaction_read_only=on"
    return run([
        "docker", "exec", "-i", "-e", "PGOPTIONS=" + settings,
        CONTAINER, "psql", "-X", "-w", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews",
    ], payload=query + "\n", timeout=35)


def check_baseline(payload: str) -> None:
    fields = payload.split("|")
    if (
        len(fields) != len(EXPECTED_PARTS)
        or fields[:3] != list(EXPECTED_PARTS[:3])
        or not re.fullmatch(r"17[0-9]{4}", fields[3])
        or tuple(fields[4:]) != EXPECTED_PARTS[4:]
    ):
        raise RuntimeError(FAIL)


def check_secret_parent(*, for_apply: bool) -> None:
    # The top-level secrets/ location must already be private and owned by ap.
    parent = SECRET_DIR.parent
    if parent.is_symlink():
        raise RuntimeError(FAIL)
    parent_info = parent.lstat()
    if (
        not stat.S_ISDIR(parent_info.st_mode)
        or parent_info.st_uid != os.geteuid()
        or stat.S_IMODE(parent_info.st_mode) != 0o700
    ):
        raise RuntimeError(FAIL)
    if SECRET_DIR.is_symlink() or SECRET_DIR.exists():
        # Deliberately NO automatic retry or credential reuse.
        raise RuntimeError(FAIL)
    if not for_apply:
        return
    space = os.statvfs(ROOT)
    if space.f_bavail * space.f_frsize < 1024**3:
        raise RuntimeError(FAIL)


def create_one_secret() -> str:
    """Only callable after operator approval and exact local SQL preflight.

    Exclusive directory and file creation. On any database error, deliberately
    leave them in place and require manual reconciliation; never rotate/retry.
    """
    os.mkdir(SECRET_DIR, mode=0o700)
    directory_fd = os.open(SECRET_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory_fd)
        if (info.st_uid != os.geteuid() or
            stat.S_IMODE(info.st_mode) != 0o700):
            raise RuntimeError(FAIL)
        credential = secrets.token_urlsafe(48)
        if not re.fullmatch(r"[A-Za-z0-9_-]{40,256}", credential):
            raise RuntimeError(FAIL)
        file_fd = os.open(
            SECRET_FILE,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600, dir_fd=directory_fd,
        )
        try:
            content = (credential + "\n").encode("ascii")
            if os.write(file_fd, content) != len(content):
                raise RuntimeError(FAIL)
            os.fsync(file_fd)
        finally:
            os.close(file_fd)
        os.fsync(directory_fd)
        return credential
    finally:
        os.close(directory_fd)


def transaction(verifier: str) -> str:
    if not SCRAM.fullmatch(verifier):
        raise RuntimeError(FAIL)
    # Every SQL identifier and owner account is fixed in code.
    # A verifier, never a plaintext password, is sent over Docker stdin.
    return f"""BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
SELECT pg_advisory_xact_lock(721214,60);
DO $guard$
BEGIN
 IF (SELECT count(*) FROM vns.schema_migrations)<>59
 OR (SELECT max(version) FROM vns.schema_migrations)
    <>'0059_canonical_event_title_fingerprint'
 OR (SELECT count(*) FROM vns.editor_accounts WHERE role='admin')<>1
 OR (SELECT count(*) FROM vns.editor_accounts
     WHERE username='{OWNER}' AND role='admin' AND active=true)<>1
 OR EXISTS(SELECT 1 FROM vns.editor_db_principals)
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{LOGIN}')
 OR (SELECT count(*) FROM vns.admin_source_audit)<>0
 OR (SELECT count(*) FROM vns.admin_source_host_audit)<>0
 THEN RAISE EXCEPTION 'personal enrollment preconditions changed'; END IF;
END
$guard$;
CREATE ROLE {LOGIN}
  LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD '{verifier}';
GRANT {ROLE} TO {LOGIN} WITH INHERIT TRUE, SET FALSE;
INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
SELECT '{LOGIN}', id,auth_version,true FROM vns.editor_accounts
WHERE username='{OWNER}' AND role='admin' AND active=true;
COMMIT;
"""


def apply(*, sha: str) -> None:
    # Re-check all conditions immediately before creating the private file.
    if os.getenv(ACK) != ACK_VALUE or os.getenv(SHA_APPROVAL) != sha:
        raise RuntimeError(FAIL)
    if run(["git", "-C", str(ROOT), "ls-remote", "origin", "refs/heads/main"]).split()[0] != sha:
        raise RuntimeError(FAIL)
    db_container()
    check_baseline(db_sql(READ_SQL, readonly=True))
    check_secret_parent(for_apply=True)
    credential = create_one_secret()
    try:
        verifier = scram_verifier(credential, os.urandom(16))
        db_sql(transaction(verifier), readonly=False)
    finally:
        # Never expose the password or verifier to stdout, stderr or process args.
        credential = ""
    print("PASS: one existing personal owner bound to restricted PostgreSQL LOGIN")
    print("INFO: source, host and feed approvals remain inactive")
    print("INFO: credential remains private; API secret mount not enabled")


def main(args: list[str]) -> None:
    if args not in (["--preflight"], ["--apply"]):
        raise RuntimeError(FAIL)
    sha = git_state()
    if args == ["--apply"] and (
        os.getenv(ACK) != ACK_VALUE or os.getenv(SHA_APPROVAL) != sha
    ):
        raise RuntimeError(FAIL)
    db_container()
    check_baseline(db_sql(READ_SQL, readonly=True))
    check_secret_parent(for_apply=args == ["--apply"])
    if args == ["--preflight"]:
        print("PASS: exactly one existing P1 owner; no personal DB enrollment")
        print("INFO: read-only; no password or role created")
    else:
        apply(sha=sha)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, RuntimeError, PermissionError, UnicodeError,
            subprocess.TimeoutExpired):
        raise SystemExit(FAIL)
