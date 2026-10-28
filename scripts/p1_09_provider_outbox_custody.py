#!/usr/bin/env python3
"""Operator-only outbox custody. Never changes a running Redis ACL or starts a job.

--stage: create only new private producer files and offline ACL candidate.
--preflight: read-only audit, requires exact migrations 0001-0048.
--apply: independently approved PostgreSQL CREATE LOGIN only, SCRAM verifier.
No provider keys, AI transport, budgets, Redis edits, container restarts or logs.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys

from provision_pg_runtime_logins import scram_verifier

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT / "secrets" / "vns-outbox"
CONTAINER = "videonews-studio-postgres-1"
LOGIN = "vns_provider_outbox_login"
READER = "vns_provider_outbox_reader"
REDIS_USER = "vns_provider_producer"
PG_FILE = "provider-outbox-db-password"
REDIS_FILE = "provider-outbox-redis-password"
KEY_FILE = "provider-prompt-key"
ACL_CANDIDATE = "provider-outbox-acl-candidate"
APPROVAL = "VNS_P1_OUTBOX_LOGIN_PROVISION_APPROVED"
REFUSED = "REFUSED: provider outbox custody invariant failed"
PW = re.compile(rb"[A-Za-z0-9_-]{40,128}\n")
MIGRATION = re.compile(r"00[0-4][0-9]_[a-z][a-z0-9_]+")


def run(argv: list[str], *, payload: str | None = None) -> str:
    result = subprocess.run(
        argv, input=payload, capture_output=True, text=True,
        timeout=40, check=False,
    )
    if result.returncode:
        # Never expose PostgreSQL verifier or password text on failure.
        raise RuntimeError(REFUSED)
    return result.stdout.strip()


def check_operator() -> None:
    if os.geteuid() != 1000:
        raise PermissionError(REFUSED)
    if run(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(REFUSED)
    if run(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(REFUSED)
    label = run([
        "docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}', CONTAINER,
    ])
    if label != "videonews-studio|postgres|healthy":
        raise RuntimeError(REFUSED)


def directory_fd(expected_uid: int = 1000) -> int:
    fd = os.open(DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if (os.geteuid() != expected_uid
            or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != expected_uid
            or stat.S_IMODE(info.st_mode) != 0o700):
        os.close(fd)
        raise PermissionError(REFUSED)
    return fd


def secure_read(parent: int, name: str, expected_uid: int) -> bytes:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode)
                or info.st_uid != expected_uid
                or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_size > 256):
            raise PermissionError(REFUSED)
        data = os.read(fd, 257)
        if len(data) != info.st_size:
            raise RuntimeError(REFUSED)
        return data
    finally:
        os.close(fd)


def read_files(expected_uid: int = 1000) -> tuple[str, str, bytes]:
    d = directory_fd(expected_uid)
    try:
        pg = secure_read(d, PG_FILE, expected_uid)
        redis = secure_read(d, REDIS_FILE, expected_uid)
        key = secure_read(d, KEY_FILE, expected_uid)
        candidate = secure_read(d, ACL_CANDIDATE, expected_uid)
    finally:
        os.close(d)
    if not PW.fullmatch(pg) or not PW.fullmatch(redis) or pg == redis or len(key) != 32:
        raise ValueError(REFUSED)
    line = candidate.decode("ascii")
    if line != acl_line(redis[:-1].decode("ascii")):
        raise ValueError(REFUSED)
    return pg[:-1].decode("ascii"), redis[:-1].decode("ascii"), key


def acl_line(password: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{40,128}", password):
        raise ValueError(REFUSED)
    digest = hashlib.sha256(password.encode("ascii")).hexdigest()
    return (
        f"user {REDIS_USER} on #{digest} resetkeys "
        "~bull:vns:vns-provider-text:* resetchannels "
        "&bull:vns:vns-provider-text:* +@all -@dangerous "
        "+info +acl|whoami\n"
    )


def stage(expected_uid: int = 1000) -> None:
    if os.geteuid() != expected_uid:
        raise PermissionError(REFUSED)
    if run(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(REFUSED)
    if run(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(REFUSED)
    d = directory_fd(expected_uid)
    created: list[str] = []
    old_umask = os.umask(0o077)
    try:
        # Refuse partial old state, never silently overwrite or rotate.
        for name in (PG_FILE, REDIS_FILE, KEY_FILE, ACL_CANDIDATE):
            try:
                os.stat(name, dir_fd=d, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise FileExistsError(REFUSED)
        pg = secrets.token_urlsafe(48)
        redis = secrets.token_urlsafe(48)
        if pg == redis:
            raise RuntimeError(REFUSED)
        contents = (
            (PG_FILE, (pg + "\n").encode("ascii")),
            (REDIS_FILE, (redis + "\n").encode("ascii")),
            (KEY_FILE, os.urandom(32)),
            (ACL_CANDIDATE, acl_line(redis).encode("ascii")),
        )
        for name, data in contents:
            fd = os.open(
                name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600, dir_fd=d,
            )
            created.append(name)
            try:
                if os.write(fd, data) != len(data):
                    raise OSError(REFUSED)
                os.fsync(fd)
            finally:
                os.close(fd)
        os.fsync(d)
    except BaseException:
        # Only files newly created in this invocation, never pre-existing.
        for name in created:
            os.unlink(name, dir_fd=d)
        raise
    finally:
        os.umask(old_umask)
        os.close(d)


def owner_sql(sql: str, *, read_only: bool = True) -> str:
    options = "-c statement_timeout=12s -c lock_timeout=4s"
    if read_only:
        options += " -c default_transaction_read_only=on"
    return run([
        "docker", "exec", "-i", "-e", f"PGOPTIONS={options}",
        CONTAINER, "psql", "-X", "-w", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-U", "vns", "-d", "videonews",
    ], payload=sql)


STATUS_SQL = """
SELECT current_user || '|' || current_database() || '|' ||
 current_setting('server_version_num') || '|' ||
 current_setting('password_encryption') || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname='vns_provider_outbox_reader'
   AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
   AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls) || '|' ||
 (SELECT count(*) FROM pg_roles WHERE rolname='vns_provider_outbox_login') || '|' ||
 (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON m.roleid=r.oid
   WHERE r.rolname='vns_provider_outbox_reader') || '|' ||
 (SELECT count(*) FROM vns.ai_provider_settings WHERE enabled) || '|' ||
 (SELECT count(*) FROM vns.provider_live_budget_policy WHERE enabled OR halted) || '|' ||
 (SELECT count(*) FROM vns.provider_live_eur_policy WHERE enabled) || '|' ||
 has_function_privilege('vns_provider_outbox_reader',
   'vns.read_authorized_provider_outbox(integer)','EXECUTE') || '|' ||
 has_function_privilege('vns_provider_outbox_reader',
   'vns.ack_provider_outbox_delivery(uuid)','EXECUTE') || '|' ||
 has_table_privilege('vns_provider_outbox_reader',
   'vns.provider_named_job_sealed_prompts','SELECT');
"""


def expected_versions() -> list[str]:
    names = [p.name.removesuffix(".up.sql")
             for p in sorted((ROOT / "db" / "migrations").glob("*.up.sql"))]
    if (len(names) != 48 or [int(n[:4]) for n in names] != list(range(1, 49))
            or not all(MIGRATION.fullmatch(n) for n in names)
            or names[-1] != "0048_provider_outbox_delivery_receipt"):
        raise RuntimeError(REFUSED)
    return names


def preflight() -> None:
    check_operator()
    versions = owner_sql("SELECT version FROM vns.schema_migrations ORDER BY version;")
    if versions.splitlines() != expected_versions():
        raise RuntimeError(REFUSED)
    values = owner_sql(STATUS_SQL).split("|")
    if (len(values) != 13 or values[:2] != ["vns", "videonews"]
            or not re.fullmatch(r"17[0-9]{4}", values[2])
            or values[3:] != ["scram-sha-256", "1", "0", "0", "0", "0", "0",
                              "t", "t", "f"]):
        raise RuntimeError(REFUSED)
    read_files()


def role_sql(password: str, salt: bytes) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{40,128}", password):
        raise ValueError(REFUSED)
    verifier = scram_verifier(password, salt)
    return (
        "BEGIN;\n"
        "SET LOCAL statement_timeout='15s';\n"
        "SET LOCAL lock_timeout='4s';\n"
        "DO $guard$ BEGIN\n"
        " IF (SELECT count(*) FROM vns.schema_migrations)<>48\n"
        " OR (SELECT max(version) FROM vns.schema_migrations)<>"
        "'0048_provider_outbox_delivery_receipt'\n"
        " OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vns_provider_outbox_login')\n"
        " OR (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON m.roleid=r.oid"
        " WHERE r.rolname='vns_provider_outbox_reader')<>0\n"
        " OR EXISTS (SELECT 1 FROM vns.ai_provider_settings WHERE enabled)\n"
        " OR EXISTS (SELECT 1 FROM vns.provider_live_budget_policy WHERE enabled OR halted)\n"
        " OR EXISTS (SELECT 1 FROM vns.provider_live_eur_policy WHERE enabled)\n"
        " THEN RAISE EXCEPTION 'provider outbox login refused'; END IF;\n"
        "END $guard$;\n"
        f"CREATE ROLE {LOGIN} LOGIN INHERIT NOSUPERUSER NOCREATEDB "
        f"NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{verifier}';\n"
        f"GRANT {READER} TO {LOGIN} WITH INHERIT TRUE, SET FALSE;\n"
        "COMMIT;\n"
    )


POSTCHECK_SQL = """
SELECT
 (SELECT count(*) FROM pg_roles WHERE rolname='vns_provider_outbox_login'
  AND rolcanlogin AND rolinherit AND NOT rolsuper AND NOT rolcreatedb
  AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) || '|' ||
 (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
  JOIN pg_roles u ON u.oid=m.member
  WHERE r.rolname='vns_provider_outbox_reader'
   AND u.rolname='vns_provider_outbox_login'
   AND m.inherit_option AND NOT m.set_option) || '|' ||
 (SELECT count(*) FROM pg_auth_members m JOIN pg_roles u ON u.oid=m.member
  WHERE u.rolname='vns_provider_outbox_login');
"""


def main(args: list[str]) -> None:
    if args == ["--stage"]:
        stage()
        print("PASS: private outbox secrets and offline Redis ACL candidate staged")
    elif args == ["--preflight"]:
        preflight()
        print("PASS: strict migration 0048, private secrets, no live dispatch")
    elif args == ["--apply"]:
        if os.getenv(APPROVAL) != "CREATE_OUTBOX_LOGIN_ONLY":
            raise RuntimeError(REFUSED)
        preflight()
        password, _, _ = read_files()
        owner_sql(role_sql(password, os.urandom(16)), read_only=False)
        if owner_sql(POSTCHECK_SQL) != "1|1|1":
            raise RuntimeError(REFUSED)
        print("PASS: only the restricted PostgreSQL outbox LOGIN was provisioned")
        print("Redis ACL, Compose, budgets, provider activation and transport unchanged")
    else:
        raise ValueError(REFUSED)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, UnicodeError, ValueError, PermissionError, RuntimeError,
            subprocess.TimeoutExpired):
        raise SystemExit(REFUSED)
