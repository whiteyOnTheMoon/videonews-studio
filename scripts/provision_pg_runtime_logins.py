#!/usr/bin/env python3
"""Operator-gated PostgreSQL LOGIN provisioning. Never log passwords or verifiers.

No Docker Compose up, schema migrations, runtime activation or secret rotation.
Passwords remain on the operator host; only derived SCRAM verifiers reach SQL.
"""

import base64
import hashlib
import hmac
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
CONTAINER = "videonews-studio-postgres-1"
SERVICES = (
    ("vns_outbox_dispatch_login", "vns_outbox_dispatch", "pg_outbox_dispatch_password"),
    ("vns_job_status_sync_login", "vns_job_status_sync", "pg_job_status_sync_password"),
    ("vns_research_writer_login", "vns_research_writer", "pg_research_writer_password"),
)


def read_passwords(directory: Path, expected_uid: int = 1000) -> list[str]:
    if os.geteuid() != expected_uid:
        raise PermissionError("unexpected operator UID")
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != 0o700:
            raise PermissionError("unsafe secrets directory")
        passwords = []
        for _, _, name in SERVICES:
            secret_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                secret_info = os.fstat(secret_fd)
                if (
                    not stat.S_ISREG(secret_info.st_mode)
                    or secret_info.st_uid != expected_uid
                    or stat.S_IMODE(secret_info.st_mode) != 0o600
                    or secret_info.st_nlink != 1
                ):
                    raise PermissionError("unsafe secret file")
                raw = os.read(secret_fd, 258)
            finally:
                os.close(secret_fd)
            if not re.fullmatch(rb"[A-Za-z0-9_-]{40,128}\n", raw):
                raise ValueError("unexpected password format")
            passwords.append(raw[:-1].decode("ascii"))
        if len(set(passwords)) != len(SERVICES):
            raise ValueError("passwords must be different")
        return passwords
    finally:
        os.close(fd)


def scram_verifier(password: str, salt: bytes) -> str:
    if len(salt) != 16:
        raise ValueError("SCRAM salt must be 16 bytes")
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("ascii"), salt, 4096)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    encode = lambda value: base64.b64encode(value).decode("ascii")
    return f"SCRAM-SHA-256$4096:{encode(salt)}${encode(stored_key)}:{encode(server_key)}"


# No caller-provided SQL identifiers; the three login/group names are fixed literals.
PREFLIGHT = """
SELECT current_user || '|' ||
  (SELECT count(*) FROM vns.schema_migrations) || '|' ||
  (SELECT count(*) FROM pg_roles
   WHERE rolname IN ('vns_outbox_dispatch','vns_job_status_sync','vns_research_writer')
     AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
     AND NOT rolcreaterole AND NOT rolcreatedb) || '|' ||
  (SELECT count(*) FROM pg_roles
   WHERE rolname IN ('vns_outbox_dispatch_login','vns_job_status_sync_login','vns_research_writer_login')) || '|' ||
  (SELECT count(*) FROM pg_hba_file_rules
   WHERE error IS NOT NULL OR
     (type = 'host' AND auth_method = 'trust'
      AND COALESCE(address,'') NOT IN ('127.0.0.1','::1'))) || '|' ||
  (SELECT count(*) FROM pg_hba_file_rules
   WHERE type='host' AND auth_method='scram-sha-256' AND address='all'
     AND database=ARRAY['all']::text[] AND user_name=ARRAY['all']::text[]) || '|' ||
  current_setting('password_encryption');
"""


def build_transaction(passwords: list[str], salts: list[bytes]) -> str:
    if len(passwords) != 3 or len(salts) != 3:
        raise ValueError("three credentials required")
    statements = [
        "BEGIN;",
        "SET LOCAL lock_timeout = '5s';",
        "SET LOCAL statement_timeout = '15s';",
        "SET LOCAL password_encryption = 'scram-sha-256';",
        """DO $guard$
BEGIN
  IF (SELECT count(*) FROM vns.schema_migrations) <> 12
    OR NOT EXISTS (SELECT 1 FROM vns.schema_migrations
                   WHERE version='0012_runtime_least_privilege')
    OR (SELECT count(*) FROM pg_roles
        WHERE rolname IN ('vns_outbox_dispatch','vns_job_status_sync','vns_research_writer')
          AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
          AND NOT rolcreaterole AND NOT rolcreatedb) <> 3
    OR (SELECT count(*) FROM pg_roles
        WHERE rolname IN ('vns_outbox_dispatch_login',
                          'vns_job_status_sync_login','vns_research_writer_login')) <> 0
  THEN
    RAISE EXCEPTION 'runtime login provisioning preflight rejected';
  END IF;
END $guard$;""",
    ]
    for (login, group, _), password, salt in zip(SERVICES, passwords, salts):
        if not re.fullmatch(r"[A-Za-z0-9_-]{40,128}", password):
            raise ValueError("invalid password")
        verifier = scram_verifier(password, salt)
        statements.append(
            f'CREATE ROLE "{login}" LOGIN INHERIT NOSUPERUSER NOCREATEDB '
            f'NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \'{verifier}\';'
        )
        statements.append(f'GRANT "{group}" TO "{login}";')
    statements.append("COMMIT;")
    return "\n".join(statements) + "\n"


POSTCHECK = """
SELECT
  (SELECT count(*) FROM pg_roles
   WHERE rolname IN ('vns_outbox_dispatch_login','vns_job_status_sync_login','vns_research_writer_login')
     AND rolcanlogin AND rolinherit AND NOT rolsuper AND NOT rolcreatedb
     AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  || '|' ||
  (SELECT count(*) FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid
   JOIN pg_roles u ON u.oid=m.member
   WHERE (g.rolname,u.rolname) IN (
    ('vns_outbox_dispatch','vns_outbox_dispatch_login'),
    ('vns_job_status_sync','vns_job_status_sync_login'),
    ('vns_research_writer','vns_research_writer_login'))
    AND m.inherit_option)
  || '|' ||
  (SELECT count(*) FROM pg_auth_members m JOIN pg_roles u ON u.oid=m.member
   WHERE u.rolname IN ('vns_outbox_dispatch_login','vns_job_status_sync_login',
                      'vns_research_writer_login'));
"""


def command(args: list[str], *, sql: str | None = None, timeout: int = 20) -> str:
    # Never surface raw subprocess stderr/stdout on failures; could contain SQL
    # or credential-derived material if an environment behaves unexpectedly.
    result = subprocess.run(
        args, input=sql, capture_output=True, text=True, timeout=timeout, check=False
    )
    if result.returncode:
        raise RuntimeError("guarded command failed")
    return result.stdout.strip()


def psql(sql: str, *, read_only: bool) -> str:
    options = "-c statement_timeout=10s"
    if read_only:
        options += " -c default_transaction_read_only=on"
    return command(
        ["docker", "exec", "-i", "-e", f"PGOPTIONS={options}",
         CONTAINER, "psql", "-X", "-w", "-q", "-A", "-t",
         "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews"],
        sql=sql,
        timeout=45,
    )


def preflight() -> None:
    if command(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError("expected main")
    if command(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError("dirty checkout")
    if command(["docker", "inspect", "-f",
                '{{index .Config.Labels "com.docker.compose.project"}}|'
                '{{index .Config.Labels "com.docker.compose.service"}}|'
                '{{.State.Health.Status}}', CONTAINER]) != "videonews-studio|postgres|healthy":
        raise RuntimeError("unexpected PostgreSQL container")
    if psql(PREFLIGHT, read_only=True) != "vns|12|3|0|0|1|scram-sha-256":
        raise RuntimeError("database or HBA preflight rejected")


def main() -> None:
    if sys.argv[1:] != ["--apply"]:
        raise RuntimeError("explicit --apply required")
    passwords = read_passwords(ROOT / "secrets")
    preflight()
    salts = [os.urandom(16) for _ in SERVICES]
    transaction = build_transaction(passwords, salts)
    del passwords
    # Only password-derived SCRAM verifiers are sent via STDIN, never CLI args.
    psql(transaction, read_only=False)
    if psql(POSTCHECK, read_only=True) != "3|3|3":
        raise RuntimeError("post-commit verification failed; do not retry")
    print("PASS: three isolated SCRAM LOGIN roles created and grant memberships verified")
    print("No secrets disclosed; no Docker services, migrations or flags changed")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        raise SystemExit("REFUSED: PostgreSQL LOGIN step failed; do not retry without read-only inventory")
