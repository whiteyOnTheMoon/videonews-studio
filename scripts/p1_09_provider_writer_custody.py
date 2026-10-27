#!/usr/bin/env python3
"""One-time P1-09 provider writer LOGIN and local 32-byte master-key custody.

Default-off and exact-baseline-gated. Never sends provider requests, changes a
service, alters provider settings or makes backups. On any apply failure STOP.
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
LOGIN = "vns_provider_config_login"
WRITER = "vns_provider_config_writer"
KEY_DIR = ROOT / "secrets" / "vns"
PASSWORD_PATH = ROOT / "secrets" / "pg_provider_admin_password"
KEY_PATH = KEY_DIR / "provider-master-key"


def fail(reason: str) -> None:
    raise RuntimeError(reason)


def ci_only() -> bool:
    override = os.getenv("VNS_P109_WRITER_CI_PROJECT")
    if not override:
        return False
    if not (
        override == "vns-p109-writer-ci"
        and os.getenv("GITHUB_ACTIONS") == "true"
        and os.getenv("CI") == "true"
        and os.getenv("GITHUB_REPOSITORY") == "whiteyOnTheMoon/videonews-studio"
        and re.fullmatch(r"[0-9]+", os.getenv("GITHUB_RUN_ID", ""))
    ):
        fail("untrusted CI override")
    return True


def run(args: list[str], payload: str | None = None) -> str:
    result = subprocess.run(
        args, input=payload, text=True, capture_output=True, timeout=45, check=False
    )
    # Never return SQL diagnostic fragments, which can contain verifiers.
    if result.returncode:
        fail("guarded operation failed; stop without retry")
    return result.stdout.strip()


def connection() -> str:
    ci = ci_only()
    if not ci:
        if os.geteuid() != 1000:
            fail("unexpected operator UID")
        if run(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
            fail("expected main checkout")
    if run(["git", "-C", str(ROOT), "status", "--porcelain"]):
        fail("repository not clean")
    project = "vns-p109-writer-ci" if ci else "videonews-studio"
    container = project + "-postgres-1"
    label = run(
        [
            "docker", "inspect", "-f",
            '{{index .Config.Labels "com.docker.compose.project"}}|'
            '{{index .Config.Labels "com.docker.compose.service"}}|'
            '{{.State.Health.Status}}',
            container,
        ]
    )
    if label != project + "|postgres|healthy":
        fail("untrusted PostgreSQL target")
    return container


def owner_sql(container: str, command: str) -> str:
    return run(
        [
            "docker", "exec", "-i", container, "psql", "-X", "-w", "-A", "-t",
            "-q", "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews",
        ],
        payload=command,
    )


def writer_sql(container: str, password: str, command: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{40,128}", password):
        fail("unexpected writer credential")
    # Explicit TCP SCRAM login; password supplied over stdin rather than
    # process arguments or the user's environment.
    shell = (
        "set -eu; IFS= read -r PGPASSWORD; export PGPASSWORD; "
        'exec psql -X -w -q -A -t -v ON_ERROR_STOP=1 -h postgres -U "$1" -d videonews'
    )
    return run(
        ["docker", "exec", "-i", container, "sh", "-c", shell, "sh", LOGIN],
        payload=password + "\n" + command,
    )


PREFLIGHT = """
SELECT session_user || '|' || current_database() || '|' ||
 current_setting('server_version_num') || '|' ||
 (SELECT count(*) FROM vns.schema_migrations) || '|' ||
 (SELECT max(version) FROM vns.schema_migrations) || '|' ||
 (SELECT count(*) FROM vns.editor_accounts WHERE role='admin' AND active) || '|' ||
 (SELECT count(*) FROM vns.editor_operator_registry WHERE active) || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname='vns_provider_config_login') || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname IN
 ('vns_provider_config_executor','vns_provider_config_writer')
 AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole) || '|' ||
 (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
 WHERE r.rolname IN
 ('vns_provider_config_executor','vns_provider_config_writer')) || '|' ||
 (SELECT count(*) FROM vns.ai_provider_sealed_credentials) || '|' ||
 (SELECT count(*) FROM vns.ai_provider_settings WHERE enabled) || '|' ||
 (SELECT count(*) FROM pg_hba_file_rules WHERE
 type='host' AND auth_method='scram-sha-256' AND address='all'
 AND database=ARRAY['all']::text[] AND user_name=ARRAY['all']::text[]);
"""


def secure_parent() -> None:
    root = ROOT / "secrets"
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            fail("secrets directory must belong to the owner with mode 0700")
    finally:
        os.close(descriptor)


def preflight(container: str) -> None:
    fields = owner_sql(container, PREFLIGHT).split("|")
    if (
        len(fields) != 13
        or fields[:2] != ["vns", "videonews"]
        or not re.fullmatch(r"17[0-9]{4}", fields[2])
        or fields[3:] != [
            "18", "0018_ai_provider_named_audit", "1", "1", "0", "2", "0", "0", "0", "1"
        ]
    ):
        fail("unexpected DB state, permissions or provider activation")
    secure_parent()
    if PASSWORD_PATH.exists() or PASSWORD_PATH.is_symlink():
        fail("writer password already provisioned")
    if KEY_DIR.exists() or KEY_DIR.is_symlink():
        fail("master key directory already provisioned")
    if not ci_only():
        fs = os.statvfs(ROOT)
        if fs.f_bavail * fs.f_frsize < 15 * 1024**3:
            fail("insufficient free disk")
    print("PASS: personal admin present, exact schema 0018, writer closed, no provider keys")


def make_files() -> str:
    secure_parent()
    password = secrets.token_urlsafe(48)
    if not re.fullmatch(r"[A-Za-z0-9_-]{40,128}", password):
        fail("invalid generated credential")
    master_key = secrets.token_bytes(32)
    # Exclusive file creation: never replace credentials or rotate key.
    fd = os.open(
        PASSWORD_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    try:
        os.write(fd, (password + "\n").encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.mkdir(KEY_DIR, 0o700)
    descriptor = os.open(KEY_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            fail("master key directory permission error")
        fd = os.open(
            "provider-master-key",
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600, dir_fd=descriptor
        )
        try:
            os.write(fd, master_key)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return password


def grant_sql(password: str) -> str:
    verifier = scram_verifier(password, os.urandom(16))
    return f"""BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $guard$ BEGIN
  IF (SELECT count(*) FROM vns.schema_migrations) <> 18
   OR (SELECT max(version) FROM vns.schema_migrations) <> '0018_ai_provider_named_audit'
   OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='{LOGIN}')
   OR EXISTS (SELECT 1 FROM pg_auth_members m
      JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname='{WRITER}')
   OR (SELECT count(*) FROM vns.editor_accounts WHERE role='admin' AND active)<>1
   OR (SELECT count(*) FROM vns.ai_provider_sealed_credentials)<>0
  THEN RAISE EXCEPTION 'provider LOGIN enrollment rejected'; END IF;
END $guard$;
CREATE ROLE {LOGIN} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
 NOREPLICATION NOBYPASSRLS PASSWORD '{verifier}';
GRANT {WRITER} TO {LOGIN};
COMMIT;
"""


POSTCHECK = """
SELECT (SELECT count(*) FROM pg_roles WHERE rolname='vns_provider_config_login'
 AND rolcanlogin AND rolinherit AND NOT rolsuper AND NOT rolcreatedb
 AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) || '|' ||
 (SELECT count(*) FROM pg_auth_members m
 JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member
 WHERE r.rolname='vns_provider_config_writer' AND
 u.rolname='vns_provider_config_login' AND m.inherit_option) || '|' ||
 (SELECT count(*) FROM pg_auth_members m
 JOIN pg_roles u ON u.oid=m.member
 WHERE u.rolname='vns_provider_config_login') || '|' ||
 (SELECT count(*) FROM vns.ai_provider_sealed_credentials) || '|' ||
 (SELECT count(*) FROM vns.ai_provider_settings WHERE enabled);
"""


def main() -> None:
    if sys.argv[1:] not in (["--preflight"], ["--apply"]):
        fail("use --preflight or --apply")
    if (
        sys.argv[1:] == ["--apply"]
        and not ci_only()
        and os.getenv("VNS_P1_NO_BACKUP_RISK_ACCEPTED") != "I_ACCEPT_UNRECOVERABLE_LOSS"
    ):
        fail("explicit no-backup risk acceptance required")
    container = connection()
    preflight(container)
    if sys.argv[1:] == ["--preflight"]:
        return
    password = make_files()
    print("STEP: private files exclusively created")
    owner_sql(container, grant_sql(password))
    print("STEP: dedicated PostgreSQL role transaction completed")
    if owner_sql(container, POSTCHECK) != "1|1|1|0|0":
        fail("unexpected writer role membership; do not retry")
    print("STEP: restricted role membership verified")
    proof = writer_sql(
        container, password,
        "SELECT session_user || '|' || pg_has_role(session_user,"
        "'vns_provider_config_writer','MEMBER') || '|' || "
        "(SELECT count(*) FROM vns.admin_list_ai_providers())",
    )
    print("STEP: isolated named SQL proof returned (credential-free)")
    if proof != LOGIN + "|t|2":
        print("CHECK: identity=" + str(proof.startswith(LOGIN+"|")) + ", role=" + str("|t|" in proof) + ", two_providers=" + str(proof.endswith("|2")))
        fail("SCRAM writer role authentication failed; stop without retry")
    print("PASS: dedicated SCRAM login, least-privilege writer membership, private 32-byte key")
    print("No API/Web restart, no provider enabled, no secrets printed")
    print("No backups: loss of the master key makes previously sealed credentials unrecoverable")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        raise SystemExit("REFUSED: provider writer provisioning failed; do not retry without inspection")
