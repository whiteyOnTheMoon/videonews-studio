#!/usr/bin/env python3
"""P2-02: stage three private feed credentials and explicitly enroll limited DB LOGINs.

No worker, feed, Docker Compose, migration, source approval or network activation.
Password plaintext never enters SQL, environment variables, command-line arguments,
GitHub or diagnostic output. SQL receives only salted SCRAM-SHA-256 verifiers.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys

from provision_pg_runtime_logins import scram_verifier

ROOT = Path(__file__).resolve().parent.parent
SECRET_DIR = ROOT / "secrets" / "p2-feed-login-custody"
CONTAINER = "videonews-studio-postgres-1"
APPROVAL = "VNS_P2_FEED_LOGINS_OPERATOR_APPROVED"
REQUIRED_APPROVAL = "CREATE_THREE_RESTRICTED_FEED_LOGINS"
FAIL = "REFUSED: P2 feed login custody step failed; inspect state before any retry"
SERVICES = (
    ("vns_source_export_login_prod", "vns_source_export_reader",
     "vns_source_export_db_password"),
    ("vns_feed_login_prod", "vns_feed_poll_writer",
     "vns_feed_db_password"),
    ("vns_feed_project_login_prod", "vns_feed_project_client",
     "vns_feed_project_db_password"),
)
PASSWORD_RE = re.compile(rb"[A-Za-z0-9_-]{40,128}\n")
SHA_RE = re.compile(r"[0-9a-f]{40}")


def command(argv: list[str], *, stdin: str | None = None, timeout: int = 45) -> str:
    result = subprocess.run(
        argv, input=stdin, capture_output=True, text=True,
        timeout=timeout, check=False,
    )
    # PostgreSQL might echo a derived verifier if it fails. Never expose stderr.
    if result.returncode != 0:
        raise RuntimeError(FAIL)
    return result.stdout.strip()


def psql(sql: str, *, read_only: bool = True) -> str:
    options = "-c statement_timeout=10000 -c lock_timeout=3000"
    if read_only:
        options += " -c default_transaction_read_only=on"
    return command([
        "docker", "exec", "-i", "-e", "PGOPTIONS=" + options, CONTAINER,
        "psql", "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
        "-U", "vns", "-d", "videonews",
    ], stdin=sql)


def check_release(expected_sha: str) -> None:
    if not SHA_RE.fullmatch(expected_sha) or os.geteuid() != 1000:
        raise PermissionError(FAIL)
    if command(["git", "-C", str(ROOT), "branch", "--show-current"]) != "main":
        raise RuntimeError(FAIL)
    if command(["git", "-C", str(ROOT), "rev-parse", "HEAD"]) != expected_sha:
        raise RuntimeError(FAIL)
    if command(["git", "-C", str(ROOT), "status", "--porcelain"]):
        raise RuntimeError(FAIL)
    state = command([
        "docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}',
        CONTAINER,
    ])
    if state != "videonews-studio|postgres|healthy":
        raise RuntimeError(FAIL)


PREFLIGHT_CONDITION = """
    current_user='vns'
    AND current_database()='videonews'
    AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999
    AND current_setting('password_encryption')='scram-sha-256'
    AND (SELECT count(*) FROM vns.schema_migrations)=61
    AND (SELECT count(*) FROM vns.schema_migrations
         WHERE version='0061_single_owner_review_policy')=1
    AND (SELECT count(*) FROM pg_roles
         WHERE rolname IN ('vns_source_export_reader','vns_feed_poll_writer',
                           'vns_feed_project_client')
           AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
           AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls)=3
    AND NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname IN (
          'vns_source_export_login_prod','vns_feed_login_prod',
          'vns_feed_project_login_prod'))
    AND NOT EXISTS (
        SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
        WHERE r.rolname IN ('vns_source_export_reader',
                            'vns_feed_poll_writer','vns_feed_project_client'))
    AND NOT EXISTS (
        SELECT 1 FROM pg_hba_file_rules
         WHERE error IS NOT NULL OR
           (type='host' AND auth_method='trust'
            AND COALESCE(address,'') NOT IN ('127.0.0.1','::1')))
    AND EXISTS (
        SELECT 1 FROM pg_hba_file_rules WHERE type='host'
        AND auth_method='scram-sha-256' AND address='all'
        AND database=ARRAY['all']::text[] AND user_name=ARRAY['all']::text[])
    AND has_function_privilege(
        'vns_source_export_reader','vns.read_approved_source_export()','EXECUTE')
    AND has_function_privilege(
        'vns_feed_poll_writer',
        'vns.claim_feed_poll_authorized(jsonb,integer)','EXECUTE')
    AND has_function_privilege(
        'vns_feed_poll_writer',
        'vns.commit_feed_poll_authorized(jsonb,uuid,jsonb,text,text)','EXECUTE')
    AND has_function_privilege(
        'vns_feed_project_client',
        'vns.project_approved_feed_candidates(text,integer)','EXECUTE')
    AND NOT has_table_privilege(
        'vns_source_export_reader','vns.admin_source_registry','SELECT')
    AND NOT has_table_privilege(
        'vns_feed_poll_writer','vns.feed_poll_candidates','SELECT')
    AND NOT has_function_privilege(
        'vns_feed_project_client','vns.project_feed_candidates(text,integer)','EXECUTE')
"""
PREFLIGHT_SQL = "SELECT (" + PREFLIGHT_CONDITION + ");"


def check_db() -> None:
    if psql(PREFLIGHT_SQL) != "t":
        raise RuntimeError(FAIL)


def open_private_dir(path: Path, *, expected_uid: int = 1000) -> int:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (os.geteuid() != expected_uid or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != expected_uid
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise PermissionError(FAIL)
        return fd
    except BaseException:
        os.close(fd)
        raise


def stage_secrets(expected_sha: str) -> None:
    check_release(expected_sha)
    check_db()
    parent_fd = open_private_dir(ROOT / "secrets")
    try:
        # Exclusive: a prior/partial run must be diagnosed, never overwritten.
        os.mkdir(SECRET_DIR.name, mode=0o700, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)
    folder_fd = open_private_dir(SECRET_DIR)
    try:
        for _, _, filename in SERVICES:
            password = secrets.token_urlsafe(48)
            if not PASSWORD_RE.fullmatch((password + "\n").encode("ascii")):
                raise RuntimeError(FAIL)
            fd = os.open(
                filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600, dir_fd=folder_fd,
            )
            try:
                os.write(fd, (password + "\n").encode("ascii"))
                os.fsync(fd)
            finally:
                os.close(fd)
        os.fsync(folder_fd)
    finally:
        os.close(folder_fd)


def read_secrets(*, expected_uid: int = 1000) -> list[str]:
    folder_fd = open_private_dir(SECRET_DIR, expected_uid=expected_uid)
    result = []
    try:
        for _, _, filename in SERVICES:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=folder_fd)
            try:
                info = os.fstat(fd)
                if (not stat.S_ISREG(info.st_mode)
                        or info.st_uid != expected_uid
                        or stat.S_IMODE(info.st_mode) != 0o600
                        or info.st_nlink != 1
                        or info.st_size < 41 or info.st_size > 129):
                    raise PermissionError(FAIL)
                raw = os.read(fd, 130)
            finally:
                os.close(fd)
            if not PASSWORD_RE.fullmatch(raw):
                raise ValueError(FAIL)
            result.append(raw[:-1].decode("ascii"))
    finally:
        os.close(folder_fd)
    if len(set(result)) != len(SERVICES):
        raise ValueError(FAIL)
    return result


def preflight(expected_sha: str) -> None:
    check_release(expected_sha)
    check_db()
    read_secrets()


def build_transaction(passwords: list[str], salts: list[bytes]) -> str:
    if (len(passwords) != 3 or len(salts) != 3
            or len(set(passwords)) != 3 or
            any(not re.fullmatch(r"[A-Za-z0-9_-]{40,128}", p) for p in passwords)
            or any(len(salt) != 16 for salt in salts)):
        raise ValueError(FAIL)
    statements = [
        "BEGIN;",
        "SET LOCAL statement_timeout='10000ms';",
        "SET LOCAL lock_timeout='3000ms';",
        "SET LOCAL password_encryption='scram-sha-256';",
        "DO $guard$ BEGIN",
        " IF NOT (" + PREFLIGHT_CONDITION + ") THEN",
        " RAISE EXCEPTION 'feed login enrollment refused'; END IF;",
        "END $guard$;",
    ]
    for (login, group, _), password, salt in zip(SERVICES, passwords, salts):
        verifier = scram_verifier(password, salt)
        statements.append(
            f'CREATE ROLE "{login}" LOGIN INHERIT NOSUPERUSER '
            f'NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS '
            f"PASSWORD '{verifier}';"
        )
        statements.append(f'GRANT "{group}" TO "{login}" WITH INHERIT TRUE, SET FALSE;')
    statements.append("COMMIT;")
    return "\n".join(statements) + "\n"


POSTCHECK_SQL = """
SELECT
 (SELECT count(*) FROM pg_roles WHERE
  rolname IN ('vns_source_export_login_prod','vns_feed_login_prod',
              'vns_feed_project_login_prod')
  AND rolcanlogin AND rolinherit AND NOT rolsuper
  AND NOT rolcreaterole AND NOT rolcreatedb
  AND NOT rolreplication AND NOT rolbypassrls) || '|' ||
 (SELECT count(*) FROM pg_auth_members m
  JOIN pg_roles g ON g.oid=m.roleid
  JOIN pg_roles u ON u.oid=m.member
  WHERE (g.rolname,u.rolname) IN (
    ('vns_source_export_reader','vns_source_export_login_prod'),
    ('vns_feed_poll_writer','vns_feed_login_prod'),
    ('vns_feed_project_client','vns_feed_project_login_prod'))
    AND m.inherit_option AND NOT m.set_option) || '|' ||
 (SELECT count(*) FROM pg_auth_members m JOIN pg_roles u ON u.oid=m.member
  WHERE u.rolname IN ('vns_source_export_login_prod',
                      'vns_feed_login_prod','vns_feed_project_login_prod')) || '|' ||
 (NOT has_table_privilege('vns_source_export_login_prod',
                           'vns.admin_source_registry','SELECT')
  AND NOT has_table_privilege('vns_feed_login_prod',
                               'vns.feed_poll_candidates','SELECT')
  AND NOT has_function_privilege('vns_feed_project_login_prod',
                                 'vns.project_feed_candidates(text,integer)',
                                 'EXECUTE'));
"""


def apply(expected_sha: str) -> None:
    if os.environ.get(APPROVAL) != REQUIRED_APPROVAL:
        raise PermissionError(FAIL)
    preflight(expected_sha)
    passwords = read_secrets()
    sql = build_transaction(passwords, [os.urandom(16) for _ in SERVICES])
    del passwords
    psql(sql, read_only=False)
    if psql(POSTCHECK_SQL) != "3|3|3|t":
        raise RuntimeError(FAIL)


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Default-deny P2 feed LOGIN custody")
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--stage", action="store_true")
    operation.add_argument("--preflight", action="store_true")
    operation.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args(argv)
    if args.stage:
        stage_secrets(args.expected_sha)
        print("PASS: three private credentials staged; database unchanged")
    elif args.preflight:
        preflight(args.expected_sha)
        print("PASS: source/export/feed/projector admission and private credentials verified")
    elif args.apply:
        apply(args.expected_sha)
        print("PASS: three restricted PostgreSQL SCRAM LOGINs enrolled and audited by postcheck")
        print("Feed services OFF; staged owner secrets still need separate runtime UID custody")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, PermissionError, RuntimeError,
            subprocess.TimeoutExpired):
        raise SystemExit(FAIL)
