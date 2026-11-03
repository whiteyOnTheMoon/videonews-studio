#!/usr/bin/env python3
"""Explicit, one-time same-VPS SQL anchor enrollment. Default OFF.

--preflight and --verify are read-only. --install writes an isolated SQL
schema, minimal LOGIN and one local secret, under an exact release/approval.
--handoff copies that already created secret into a root-private runtime mount.
No service, network feed, checkpoint, publisher or application row is changed.
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
CONTAINER = "videonews-studio-postgres-1"
DIR = ROOT / "secrets" / "p2-anchor-login-custody"
FILE = "vns_feed_source_anchor_password"
RUNTIME_PARENT = Path("/var/lib/videonews-studio")
RUNTIME_DIR = RUNTIME_PARENT / "p2-anchor-runtime-secret"
OWNER = "vns_source_anchor_owner"
LOGIN = "vns_anchor_login_prod"
ACK = "VNS_P2_SAME_VPS_ANCHOR_OPERATOR_APPROVED"
ACK_VALUE = "INSTALL_ONE_LOCAL_SOURCE_ANCHOR_ONLY"
ACK_SHA = "VNS_P2_SAME_VPS_ANCHOR_EXPECTED_SHA"
HANDOFF_ACK = "HANDOFF_ONE_EXISTING_ANCHOR_PASSWORD_ONLY"
REFUSED = "REFUSED: local source anchor admission unsafe; inspect state, do not retry"
SHA = re.compile(r"[a-f0-9]{40}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
PASSWORD = re.compile(rb"[A-Za-z0-9_-]{40,128}\n\Z")
SCRAM = re.compile(r"SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+\Z")
SQL_FILES = (
    "001_high_water.sql",
    "002_server_admission.sql",
    "003_trust_policy_admission.sql",
    "004_preapproved_trust_policy.sql",
)


def command(args: list[str], payload: str | None = None, timeout: int = 45) -> str:
    try:
        done = subprocess.run(
            args, input=payload, capture_output=True, text=True,
            check=False, timeout=timeout,
        )
        if done.returncode != 0 or len(done.stdout) > 8192:
            raise RuntimeError(REFUSED)
        return done.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(REFUSED) from None


def release(expected_sha: str, *, root: bool = False, remote: bool = False) -> None:
    if not SHA.fullmatch(expected_sha) or os.geteuid() != (0 if root else 1000):
        raise RuntimeError(REFUSED)
    git = [
        "git", "-c", "safe.directory=" + str(ROOT),
        "-C", str(ROOT),
    ]
    if (
        command(git + ["branch", "--show-current"]) != "main"
        or command(git + ["rev-parse", "HEAD"]) != expected_sha
        or command(git + ["status", "--porcelain"]) != ""
    ):
        raise RuntimeError(REFUSED)
    if remote and command(git + ["ls-remote", "origin", "refs/heads/main"]).split() != [
        expected_sha, "refs/heads/main"
    ]:
        raise RuntimeError(REFUSED)
    if command([
        "docker", "inspect", "-f",
        '{{index .Config.Labels "com.docker.compose.project"}}|'
        '{{index .Config.Labels "com.docker.compose.service"}}|'
        '{{.State.Health.Status}}', CONTAINER,
    ]) != "videonews-studio|postgres|healthy":
        raise RuntimeError(REFUSED)


def psql(sql: str, *, readonly: bool = True) -> str:
    opts = "-c lock_timeout=3s -c statement_timeout=30000"
    if readonly:
        opts += " -c default_transaction_read_only=on"
    return command([
        "docker", "exec", "-i", "-e", "PGOPTIONS=" + opts, CONTAINER,
        "psql", "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
        "-U", "vns", "-d", "videonews",
    ], payload=sql + "\n", timeout=40)


def validate_values(args: argparse.Namespace) -> None:
    if (
        not 1 <= args.source_revision <= 1000000000000
        or not 1 <= args.host_revision <= 1000000000000
        or not 1 <= args.policy_revision <= 1000000000000
        or not HASH.fullmatch(args.envelope_sha256)
        or not HASH.fullmatch(args.policy_sha256)
    ):
        raise ValueError(REFUSED)


def candidate_condition(args: argparse.Namespace) -> str:
    # Only validated integer and lowercase SHA-256 literals reach SQL.
    return f"""
      (SELECT revision={args.source_revision}
         AND jsonb_array_length(sources) BETWEEN 3 AND 5
         AND (SELECT count(*) FROM jsonb_array_elements(sources) item
              WHERE item->>'status'='approved') BETWEEN 3 AND 5
       FROM vns.admin_source_registry WHERE singleton)
      AND
      (SELECT revision={args.host_revision}
         AND jsonb_array_length(approved_hosts) BETWEEN 1 AND 5
       FROM vns.admin_source_host_approvals WHERE singleton)
      AND (SELECT count(*)={args.source_revision}
           FROM vns.admin_source_audit)
      AND (SELECT count(*)={args.host_revision}
           FROM vns.admin_source_host_audit)
      AND (SELECT count(*) FROM vns.feed_event_rankings
           WHERE approved_for_publication)=0
    """


def baseline_sql(args: argparse.Namespace) -> str:
    return f"""SELECT (
        current_user='vns' AND current_database()='videonews'
        AND current_setting('is_superuser')='on'
        AND current_setting('password_encryption')='scram-sha-256'
        AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999
        AND (SELECT count(*) FROM vns.schema_migrations)=61
        AND (SELECT max(version) FROM vns.schema_migrations)
          ='0061_single_owner_review_policy'
        AND NOT EXISTS(SELECT 1 FROM pg_hba_file_rules WHERE error IS NOT NULL
          OR (type='host' AND auth_method='trust'
              AND coalesce(address,'') NOT IN ('127.0.0.1','::1')))
        AND to_regnamespace('vns_source_anchor') IS NULL
        AND NOT EXISTS(SELECT 1 FROM pg_roles
          WHERE rolname IN ('{OWNER}','{LOGIN}'))
        AND (SELECT count(*) FROM vns.single_owner_review_policy
             WHERE singleton AND enabled)=1
        AND ({candidate_condition(args)})
    );"""


def sql_parts() -> str:
    data = []
    for name in SQL_FILES:
        path = ROOT / "db" / "independent-anchor" / name
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or path.is_symlink()
                or not 200 <= info.st_size <= 10000):
            raise RuntimeError(REFUSED)
        sql = path.read_text("utf8")
        if len(re.findall(r"(?m)^BEGIN;$", sql)) != 1 or len(
            re.findall(r"(?m)^COMMIT;$", sql)
        ) != 1 or not sql.rstrip().endswith("COMMIT;"):
            raise RuntimeError(REFUSED)
        # Combine four individually guarded authority files into ONE atomic
        # SQL transaction; no half-installed DDL or trust policy on failure.
        sql = re.sub(r"(?m)^BEGIN;$", "", sql, count=1)
        sql = re.sub(r"(?m)^COMMIT;\s*\Z", "", sql, count=1)
        data.append(sql)
    return "\n".join(data)


def secret_baseline() -> None:
    parent = DIR.parent
    meta = parent.lstat()
    if (parent.is_symlink() or not stat.S_ISDIR(meta.st_mode)
            or meta.st_uid != 1000 or stat.S_IMODE(meta.st_mode) != 0o700):
        raise RuntimeError(REFUSED)
    if DIR.is_symlink() or DIR.exists():
        raise RuntimeError(REFUSED)


def ensure_no_feed_containers() -> None:
    names = command([
        "docker", "ps", "--all", "--filter",
        "label=com.docker.compose.project=videonews-studio",
        "--format", '{{.Label "com.docker.compose.service"}}',
    ]).splitlines()
    forbidden = {
        "feed-observer", "feed-scheduler", "feed-consumer",
        "feed-producer", "feed-producer-continuous",
        "feed-project-once", "feed-project-continuous",
    }
    if forbidden.intersection(names):
        raise RuntimeError(REFUSED)


def create_secret() -> str:
    secret_baseline()
    os.mkdir(DIR, 0o700)
    fd = os.open(DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        credential = secrets.token_urlsafe(48)
        data = (credential + "\n").encode("ascii")
        if not PASSWORD.fullmatch(data):
            raise RuntimeError(REFUSED)
        handle = os.open(FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=fd)
        try:
            if os.write(handle, data) != len(data):
                raise RuntimeError(REFUSED)
            os.fsync(handle)
        finally:
            os.close(handle)
        os.fsync(fd)
        return credential
    finally:
        os.close(fd)


def installation_sql(args: argparse.Namespace, verifier: str) -> str:
    if not SCRAM.fullmatch(verifier):
        raise ValueError(REFUSED)
    return f"""BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(721214,62);
DO $guard$
BEGIN
  IF NOT ({baseline_sql(args).removeprefix("SELECT (").removesuffix(");")})
  THEN RAISE EXCEPTION 'same-VPS anchor baseline changed'; END IF;
END
$guard$;
CREATE ROLE {OWNER} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
CREATE ROLE {LOGIN} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3 PASSWORD '{verifier}';
{sql_parts()}
ALTER SCHEMA vns_source_anchor OWNER TO {OWNER};
ALTER TABLE vns_source_anchor.high_water OWNER TO {OWNER};
ALTER TABLE vns_source_anchor.trust_policy_high_water OWNER TO {OWNER};
ALTER TABLE vns_source_anchor.trust_policy_approvals OWNER TO {OWNER};
ALTER FUNCTION vns_source_anchor.advance(bigint,bigint,text) OWNER TO {OWNER};
ALTER FUNCTION vns_source_anchor.advance_trust_policy(bigint,text) OWNER TO {OWNER};
INSERT INTO vns_source_anchor.high_water
  (anchor_id,source_revision,host_approval_revision,envelope_sha256)
  VALUES ('source-export',{args.source_revision},{args.host_revision},'{args.envelope_sha256}');
INSERT INTO vns_source_anchor.trust_policy_high_water
  (singleton,policy_revision,policy_sha256)
  VALUES (true,{args.policy_revision},'{args.policy_sha256}');
INSERT INTO vns_source_anchor.trust_policy_approvals
  (policy_revision,policy_sha256)
  VALUES ({args.policy_revision},'{args.policy_sha256}');
GRANT USAGE ON SCHEMA vns_source_anchor TO {LOGIN};
GRANT EXECUTE ON FUNCTION vns_source_anchor.advance(bigint,bigint,text) TO {LOGIN};
GRANT EXECUTE ON FUNCTION vns_source_anchor.advance_trust_policy(bigint,text) TO {LOGIN};
COMMIT;"""


def verify_sql(args: argparse.Namespace) -> str:
    return f"""SELECT (
      current_database()='videonews'
      AND (SELECT count(*) FROM vns.schema_migrations)=61
      AND (SELECT count(*) FROM vns_source_anchor.high_water
           WHERE anchor_id='source-export'
             AND source_revision={args.source_revision}
             AND host_approval_revision={args.host_revision}
             AND envelope_sha256='{args.envelope_sha256}')=1
      AND (SELECT count(*) FROM vns_source_anchor.trust_policy_high_water
           WHERE singleton AND policy_revision={args.policy_revision}
             AND policy_sha256='{args.policy_sha256}')=1
      AND (SELECT count(*) FROM vns_source_anchor.trust_policy_approvals
           WHERE policy_revision={args.policy_revision}
             AND policy_sha256='{args.policy_sha256}')=1
      AND (SELECT count(*) FROM pg_roles WHERE rolname='{OWNER}'
           AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole)=1
      AND (SELECT count(*) FROM pg_roles WHERE rolname='{LOGIN}'
           AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
           AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls)=1
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r
           ON r.oid=m.member WHERE r.rolname='{LOGIN}')
      AND has_schema_privilege('{LOGIN}','vns_source_anchor','USAGE')
      AND NOT has_schema_privilege('{LOGIN}','vns','USAGE')
      AND has_function_privilege('{LOGIN}',
           'vns_source_anchor.advance(bigint,bigint,text)','EXECUTE')
      AND has_function_privilege('{LOGIN}',
           'vns_source_anchor.advance_trust_policy(bigint,text)','EXECUTE')
      AND NOT has_table_privilege('{LOGIN}','vns_source_anchor.high_water',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege('{LOGIN}',
           'vns_source_anchor.trust_policy_high_water',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege('{LOGIN}','vns_source_anchor.trust_policy_approvals',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND (SELECT count(*)=3 AND bool_and(owner.rolname='{OWNER}')
           FROM pg_class t JOIN pg_roles owner ON owner.oid=t.relowner
           WHERE t.oid IN ('vns_source_anchor.high_water'::regclass,
               'vns_source_anchor.trust_policy_high_water'::regclass,
               'vns_source_anchor.trust_policy_approvals'::regclass))
      AND (SELECT count(*)=2 AND bool_and(owner.rolname='{OWNER}'
                 AND p.prosecdef
                 AND 'search_path=pg_catalog'=ANY(p.proconfig))
           FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
           WHERE p.oid IN ('vns_source_anchor.advance(bigint,bigint,text)'::regprocedure,
             'vns_source_anchor.advance_trust_policy(bigint,text)'::regprocedure))
    );"""


def private_file(path: Path, uid: int, mode: int) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != uid or stat.S_IMODE(info.st_mode) != mode
                or not 41 <= info.st_size <= 129):
            raise RuntimeError(REFUSED)
        value = os.read(fd, 130)
        if len(value) != info.st_size or not PASSWORD.fullmatch(value):
            raise RuntimeError(REFUSED)
        return value
    finally:
        os.close(fd)


def source_secret() -> bytes:
    info = DIR.lstat()
    if (DIR.is_symlink() or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 1000 or stat.S_IMODE(info.st_mode) != 0o700):
        raise RuntimeError(REFUSED)
    return private_file(DIR / FILE, 1000, 0o600)


def ensure_target() -> None:
    info = RUNTIME_PARENT.lstat()
    if (RUNTIME_PARENT.is_symlink() or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700):
        raise RuntimeError(REFUSED)


def handoff(args: argparse.Namespace) -> None:
    if args.approval != HANDOFF_ACK:
        raise RuntimeError(REFUSED)
    release(args.expected_sha, root=True)
    ensure_no_feed_containers()
    ensure_target()
    data = source_secret()
    if RUNTIME_DIR.is_symlink() or RUNTIME_DIR.exists():
        raise RuntimeError(REFUSED)
    os.mkdir(RUNTIME_DIR, 0o700)
    fd = os.open(RUNTIME_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        handle = os.open(FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o400, dir_fd=fd)
        try:
            os.fchown(handle, 10002, 10002)
            os.fchmod(handle, 0o400)
            if os.write(handle, data) != len(data):
                raise RuntimeError(REFUSED)
            os.fsync(handle)
        finally:
            os.close(handle)
        os.fsync(fd)
    finally:
        os.close(fd)


def verify_handoff() -> None:
    ensure_target()
    info = RUNTIME_DIR.lstat()
    if (RUNTIME_DIR.is_symlink() or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700
            or set(os.listdir(RUNTIME_DIR)) != {FILE}
            or private_file(RUNTIME_DIR / FILE, 10002, 0o400) != source_secret()):
        raise RuntimeError(REFUSED)


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Default-off same-VPS authority setup")
    modes = parser.add_mutually_exclusive_group(required=True)
    for mode in ("preflight", "install", "verify", "handoff", "verify-handoff"):
        modes.add_argument("--" + mode, action="store_true")
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--source-revision", type=int, default=0)
    parser.add_argument("--host-revision", type=int, default=0)
    parser.add_argument("--envelope-sha256", default="")
    parser.add_argument("--policy-revision", type=int, default=0)
    parser.add_argument("--policy-sha256", default="")
    parser.add_argument("--approval", default="")
    args = parser.parse_args(argv)
    if args.handoff or args.verify_handoff:
        if any((args.source_revision, args.host_revision, args.policy_revision,
                args.envelope_sha256, args.policy_sha256)):
            raise ValueError(REFUSED)
        if args.handoff:
            handoff(args)
        else:
            if args.approval:
                raise ValueError(REFUSED)
            release(args.expected_sha, root=True)
            verify_handoff()
        print("PASS: one existing anchor runtime secret custody verified")
        print("INFO: no feed services or checkpoints started")
        return

    if args.approval:
        raise ValueError(REFUSED)
    validate_values(args)
    release(args.expected_sha, remote=args.install)
    if args.verify:
        if psql(verify_sql(args)) != "t":
            raise RuntimeError(REFUSED)
        print("PASS: local authority SQL, preapprovals, owners and minimal LOGIN verified")
        return
    ensure_no_feed_containers()
    secret_baseline()
    if psql(baseline_sql(args)) != "t":
        raise RuntimeError(REFUSED)
    if args.preflight:
        print("PASS: empty local anchor and unchanged audited source/host baseline")
        print("INFO: read-only; no database changes or credentials created")
        return
    if (os.getenv(ACK) != ACK_VALUE or os.getenv(ACK_SHA) != args.expected_sha):
        raise RuntimeError(REFUSED)
    credential = create_secret()
    try:
        verifier = scram_verifier(credential, os.urandom(16))
        psql(installation_sql(args, verifier), readonly=False)
    finally:
        credential = ""
    if psql(verify_sql(args)) != "t":
        raise RuntimeError(REFUSED)
    print("PASS: local source anchor, pinned policy and minimal LOGIN installed")
    print("INFO: separate root runtime handoff still required; feeds remain OFF")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, RuntimeError, PermissionError,
            subprocess.TimeoutExpired, UnicodeError, KeyError):
        raise SystemExit(REFUSED)
