#!/usr/bin/env python3
"""P1-09: operator-only distinct PostgreSQL provider worker LOGINS.

--stage     exclusively create two private host password files (no SQL).
--preflight read-only PostgreSQL inventory (no DDL or provider call).
--apply     one guarded CREATE ROLE transaction (no runtime activation).
Never call this tool automatically during tests or a running worker.
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
SECRET_DIR = ROOT / "secrets"
CONTAINER = "videonews-studio-postgres-1"
SERVICES = (
    ("vns_provider_usage_login", "vns_provider_usage_writer",
     "vns_provider_usage_db_password"),
    ("vns_provider_secret_login", "vns_provider_secret_reader",
     "vns_provider_secret_db_password"),
)
APPROVAL = "VNS_P1_WORKER_LOGIN_PROVISION_APPROVED"
PASSWORD = re.compile(rb"[A-Za-z0-9_-]{40,128}\n")
VERSION = re.compile(r"00[0-4][0-9]_[a-z][a-z0-9_]+")
FAIL = "REFUSED: isolated provider worker login operation failed"


def checked_command(argv: list[str], *, payload: str | None = None) -> str:
    result = subprocess.run(
        argv, input=payload, capture_output=True, text=True,
        timeout=45, check=False,
    )
    # Never print stdout/stderr on failure: PostgreSQL may echo SCRAM verifiers.
    if result.returncode:
        raise RuntimeError(FAIL)
    return result.stdout.strip()


def check_operator() -> None:
    if os.geteuid() != 1000:
        raise PermissionError(FAIL)
    if checked_command(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(FAIL)
    if checked_command(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(FAIL)
    expected = "videonews-studio|postgres|healthy"
    actual = checked_command([
        "docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}',
        CONTAINER,
    ])
    if actual != expected:
        raise RuntimeError(FAIL)


def owner_sql(sql: str, *, read_only: bool = True) -> str:
    options = "-c statement_timeout=10s -c lock_timeout=4s"
    if read_only:
        options += " -c default_transaction_read_only=on"
    return checked_command([
        "docker", "exec", "-i", "-e", f"PGOPTIONS={options}",
        CONTAINER, "psql", "-X", "-w", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews",
    ], payload=sql)


def secret_directory(expected_uid: int = 1000) -> int:
    fd = os.open(SECRET_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if (
        os.geteuid() != expected_uid
        or info.st_uid != expected_uid
        or not stat.S_ISDIR(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        os.close(fd)
        raise PermissionError(FAIL)
    return fd


def read_passwords(expected_uid: int = 1000) -> list[str]:
    directory = secret_directory(expected_uid)
    try:
        values = []
        for _, _, name in SERVICES:
            fd = os.open(
                name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
            )
            try:
                info = os.fstat(fd)
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_uid != expected_uid
                    or info.st_nlink != 1
                    or stat.S_IMODE(info.st_mode) != 0o600
                    or not 41 <= info.st_size <= 129
                ):
                    raise PermissionError(FAIL)
                raw = os.read(fd, 130)
                if not PASSWORD.fullmatch(raw):
                    raise ValueError(FAIL)
                values.append(raw[:-1].decode("ascii"))
            finally:
                os.close(fd)
        if len(set(values)) != 2:
            raise ValueError(FAIL)
        return values
    finally:
        os.close(directory)


def stage(expected_uid: int = 1000) -> None:
    if os.geteuid() != expected_uid:
        raise PermissionError(FAIL)
    if checked_command(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(FAIL)
    if checked_command(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(FAIL)
    directory = secret_directory(expected_uid)
    created = []
    old_umask = os.umask(0o077)
    try:
        for _, _, name in SERVICES:
            # O_EXCL | O_NOFOLLOW refuses existing files and symlinks.
            fd = os.open(
                name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600, dir_fd=directory,
            )
            created.append(name)
            value = (secrets.token_urlsafe(48) + "\n").encode("ascii")
            if not PASSWORD.fullmatch(value):
                raise RuntimeError(FAIL)
            try:
                os.write(fd, value)
                os.fsync(fd)
            finally:
                os.close(fd)
        os.fsync(directory)
    except BaseException:
        # Only remove files created by this invocation, never older secrets.
        for name in created:
            os.unlink(name, dir_fd=directory)
        raise
    finally:
        os.umask(old_umask)
        os.close(directory)


ROLE_STATE_SQL = """
SELECT current_user || '|' || current_database() || '|' ||
 current_setting('server_version_num') || '|' ||
 current_setting('password_encryption') || '|' ||
 (SELECT count(*) FROM pg_roles
  WHERE rolname IN ('vns_provider_usage_writer','vns_provider_secret_reader')
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND
    NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls) || '|' ||
 (SELECT count(*) FROM pg_roles
  WHERE rolname IN ('vns_provider_usage_login','vns_provider_secret_login')) || '|' ||
 (SELECT count(*) FROM pg_auth_members membership
  JOIN pg_roles group_role ON group_role.oid=membership.roleid
  WHERE group_role.rolname IN
     ('vns_provider_usage_writer','vns_provider_secret_reader')) || '|' ||
 (SELECT count(*) FROM vns.ai_provider_settings WHERE enabled) || '|' ||
 (SELECT count(*) FROM vns.ai_provider_sealed_credentials) || '|' ||
 (SELECT count(*) FROM vns.provider_live_budget_policy WHERE enabled OR halted) || '|' ||
 (SELECT count(*) FROM vns.provider_live_eur_policy WHERE enabled) || '|' ||
 (SELECT count(*) FROM pg_hba_file_rules
  WHERE error IS NOT NULL OR
    (type='host' AND auth_method='trust' AND
     coalesce(address,'') NOT IN ('127.0.0.1','::1'))) || '|' ||
 (SELECT count(*) FROM pg_hba_file_rules
  WHERE type='host' AND auth_method='scram-sha-256' AND address='all'
    AND database=ARRAY['all']::text[] AND user_name=ARRAY['all']::text[]);
"""


ACL_STATE_SQL = """
SELECT
 has_function_privilege('vns_provider_usage_writer',
   'vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint)',
   'EXECUTE')
 AND has_function_privilege('vns_provider_usage_writer',
   'vns.claim_provider_live_dispatch(uuid)', 'EXECUTE')
 AND has_function_privilege('vns_provider_usage_writer',
   'vns.record_provider_usage_evidence(uuid,text,text,text,text,text,bigint,bigint,bigint,bigint)',
   'EXECUTE')
 AND has_function_privilege('vns_provider_secret_reader',
   'vns.claimed_provider_sealed_key(uuid,text)', 'EXECUTE')
 AND NOT has_function_privilege('vns_provider_usage_writer',
   'vns.claimed_provider_sealed_key(uuid,text)', 'EXECUTE')
 AND NOT has_function_privilege('vns_provider_secret_reader',
   'vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint)',
   'EXECUTE')
 AND NOT has_table_privilege('vns_provider_usage_writer',
   'vns.ai_provider_sealed_credentials', 'SELECT')
 AND NOT has_table_privilege('vns_provider_secret_reader',
   'vns.ai_provider_sealed_credentials', 'SELECT')
 AND NOT has_table_privilege('vns_provider_usage_writer',
   'vns.provider_live_budget_policy', 'UPDATE')
 AND NOT has_table_privilege('vns_provider_secret_reader',
   'vns.provider_live_budget_policy', 'UPDATE');
"""


def expected_versions() -> list[str]:
    paths = sorted((ROOT / "db" / "migrations").glob("*.up.sql"))
    names = [p.name.removesuffix(".up.sql") for p in paths]
    if len(names) != 43 or not all(VERSION.fullmatch(n) for n in names):
        raise RuntimeError(FAIL)
    if [int(n[:4]) for n in names] != list(range(1, 44)):
        raise RuntimeError(FAIL)
    if names[-1] != "0043_claimed_provider_secret_scope":
        raise RuntimeError(FAIL)
    return names


def preflight() -> None:
    check_operator()
    inventory = owner_sql(ROLE_STATE_SQL)
    fields = inventory.split("|")
    if (
        len(fields) != 13
        or fields[:2] != ["vns", "videonews"]
        or not re.fullmatch(r"17[0-9]{4}", fields[2])
        or fields[3:] != ["scram-sha-256", "2", "0", "0", "0",
                         "0", "0", "0", "0", "1"]
    ):
        raise RuntimeError(FAIL)
    versions = owner_sql("SELECT version FROM vns.schema_migrations ORDER BY version;")
    if versions.splitlines() != expected_versions():
        raise RuntimeError(FAIL)
    if owner_sql(ACL_STATE_SQL) != "t":
        raise RuntimeError(FAIL)
    read_passwords()


def role_transaction(passwords: list[str], salts: list[bytes]) -> str:
    if (
        len(passwords) != len(SERVICES)
        or len(salts) != len(SERVICES)
        or len(set(passwords)) != len(SERVICES)
        or any(not re.fullmatch(r"[A-Za-z0-9_-]{40,128}", p) for p in passwords)
    ):
        raise ValueError(FAIL)
    sql = [
        "BEGIN;",
        "SET LOCAL statement_timeout='15s';",
        "SET LOCAL lock_timeout='4s';",
        "DO $guard$ BEGIN",
        " IF (SELECT count(*) FROM vns.schema_migrations)<>43",
        " OR (SELECT max(version) FROM vns.schema_migrations)<>"
        "'0043_claimed_provider_secret_scope'",
        " OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN"
        " ('vns_provider_usage_login','vns_provider_secret_login'))",
        " OR (SELECT count(*) FROM pg_auth_members m JOIN pg_roles g"
        " ON g.oid=m.roleid WHERE g.rolname IN"
        " ('vns_provider_usage_writer','vns_provider_secret_reader'))<>0",
        " OR EXISTS (SELECT 1 FROM vns.ai_provider_settings WHERE enabled)",
        " OR EXISTS (SELECT 1 FROM vns.provider_live_budget_policy"
        " WHERE enabled OR halted)",
        " OR EXISTS (SELECT 1 FROM vns.provider_live_eur_policy WHERE enabled)",
        " OR EXISTS (SELECT 1 FROM vns.ai_provider_sealed_credentials)",
        " THEN RAISE EXCEPTION 'worker login enrollment refused'; END IF;",
        "END $guard$;",
    ]
    for (login, role, _), password, salt in zip(SERVICES, passwords, salts):
        verifier = scram_verifier(password, salt)
        sql.append(
            f'CREATE ROLE "{login}" LOGIN INHERIT NOSUPERUSER NOCREATEDB '
            f'NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \'{verifier}\';'
        )
        # Membership privilege inherited, no SET ROLE path for runtime.
        sql.append(f'GRANT "{role}" TO "{login}" WITH INHERIT TRUE, SET FALSE;')
    sql.append("COMMIT;")
    return "\n".join(sql) + "\n"


POSTCHECK_SQL = """
SELECT
 (SELECT count(*) FROM pg_roles WHERE
  rolname IN ('vns_provider_usage_login','vns_provider_secret_login')
  AND rolcanlogin AND rolinherit AND NOT rolsuper AND NOT rolcreatedb
  AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) || '|' ||
 (SELECT count(*) FROM pg_auth_members m
   JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member
   WHERE (r.rolname,u.rolname) IN (
     ('vns_provider_usage_writer','vns_provider_usage_login'),
     ('vns_provider_secret_reader','vns_provider_secret_login'))
     AND m.inherit_option AND NOT m.set_option) || '|' ||
 (SELECT count(*) FROM pg_auth_members m
    JOIN pg_roles u ON u.oid=m.member WHERE
    u.rolname IN ('vns_provider_usage_login','vns_provider_secret_login'));
"""


def main(args: list[str]) -> None:
    if args == ["--stage"]:
        stage()
        print("PASS: two independent host secrets staged; no database changed")
    elif args == ["--preflight"]:
        preflight()
        print("PASS: exact schema 0043, private independent secrets, runtime remains off")
    elif args == ["--apply"]:
        if os.getenv(APPROVAL) != "PROVISION_LOGINS_ONLY":
            raise RuntimeError(FAIL)
        preflight()
        passwords = read_passwords()
        transaction = role_transaction(passwords, [os.urandom(16) for _ in SERVICES])
        del passwords
        owner_sql(transaction, read_only=False)
        if owner_sql(POSTCHECK_SQL) != "2|2|2":
            raise RuntimeError(FAIL)
        print("PASS: two limited PostgreSQL SCRAM LOGINS provisioned")
        print("No service start, provider key read, provider request or budget activation")
    else:
        raise ValueError(FAIL)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, PermissionError, RuntimeError,
            subprocess.TimeoutExpired):
        raise SystemExit(FAIL)
