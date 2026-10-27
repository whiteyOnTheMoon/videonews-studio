#!/usr/bin/env python3
"""One-time P1-09 personal operator/admin bootstrap. No backups or provider calls."""
from __future__ import annotations
import hashlib
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
from uuid import uuid4
from provision_pg_runtime_logins import scram_verifier

ROOT = Path(__file__).resolve().parent.parent
PROVISIONER = "vns_owner_provision_login"
GOVERNOR = "vns_owner_governance_login"
ACCOUNT = "vns_owner_admin"

def abort(reason: str) -> None:
    raise RuntimeError(reason)

def trusted_ci() -> bool:
    if not os.getenv("VNS_P109_BOOTSTRAP_CI_PROJECT"):
        return False
    if not (os.getenv("VNS_P109_BOOTSTRAP_CI_PROJECT") == "vns-p109-bootstrap-ci"
        and os.getenv("GITHUB_ACTIONS") == "true" and os.getenv("CI") == "true"
        and os.getenv("GITHUB_REPOSITORY") == "whiteyOnTheMoon/videonews-studio"
        and re.fullmatch(r"[0-9]+", os.getenv("GITHUB_RUN_ID", ""))):
        abort("untrusted CI override")
    return True

def run(args: list[str], *, payload: str | None = None) -> str:
    result = subprocess.run(args, input=payload, capture_output=True,
                            text=True, timeout=50, check=False)
    if result.returncode:
        abort("guarded command failed; do not retry")
    return result.stdout.strip()

def database() -> str:
    project = "vns-p109-bootstrap-ci" if trusted_ci() else "videonews-studio"
    if not trusted_ci():
        if os.geteuid() != 1000 or run(["git","-C",str(ROOT),"branch","--show-current"]) != "main":
            abort("expected owner UID 1000 on main")
    if run(["git","-C",str(ROOT),"status","--porcelain"]):
        abort("dirty checkout")
    container = project + "-postgres-1"
    actual = run(["docker","inspect","-f",
      '{{index .Config.Labels "com.docker.compose.project"}}|'
      '{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Health.Status}}',
      container])
    if actual != project + "|postgres|healthy":
        abort("unexpected PostgreSQL instance")
    return container

def sql(container: str, statement: str) -> str:
    return run(["docker","exec","-i",container,"psql","-X","-w","-q","-A","-t",
      "-v","ON_ERROR_STOP=1","-U","vns","-d","videonews"],payload=statement)

def actor_sql(container: str, login: str, password: str, statement: str) -> str:
    if login not in (GOVERNOR, PROVISIONER) or not re.fullmatch(r"[A-Za-z0-9_-]{40,128}",password):
        abort("unexpected login")
    # Authenticates over Docker bridge TCP, never over trusted local socket.
    # Password passed via stdin, not process command-line arguments.
    shell = ("set -eu; IFS= read -r PGPASSWORD; export PGPASSWORD; "
             "exec psql -X -w -q -A -t -v ON_ERROR_STOP=1 "
             '-h postgres -U "$1" -d videonews')
    return run(["docker","exec","-i",container,"sh","-c",shell,"sh",login],
               payload=password+"\n"+statement)

PREFLIGHT = """
SELECT session_user||'|'||current_database()||'|'||
 current_setting('server_version_num')||'|'||
 (SELECT count(*) FROM vns.schema_migrations)||'|'||
 (SELECT max(version) FROM vns.schema_migrations)||'|'||
 (SELECT count(*) FROM vns.editor_accounts)||'|'||
 (SELECT count(*) FROM vns.editor_operator_registry)||'|'||
 (SELECT count(*) FROM pg_roles WHERE rolname IN
 ('vns_owner_provision_login','vns_owner_governance_login'))||'|'||
 (SELECT count(*) FROM pg_roles WHERE rolname IN
 ('vns_editor_provisioner','vns_operator_governor') AND NOT rolcanlogin
 AND NOT rolsuper AND NOT rolcreaterole)||'|'||
 (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
 WHERE r.rolname IN ('vns_editor_provisioner','vns_operator_governor'))||'|'||
 (SELECT count(*) FROM pg_hba_file_rules WHERE type='host'
 AND auth_method='scram-sha-256' AND address='all'
 AND database=ARRAY['all']::text[] AND user_name=ARRAY['all']::text[]);
"""
def preflight(container: str) -> None:
    fields=sql(container,PREFLIGHT).split("|")
    if len(fields)!=11 or fields[:2]!=["vns","videonews"] or not re.fullmatch(r"17[0-9]{4}",fields[2]) or fields[3:]!=["18","0018_ai_provider_named_audit","0","0","0","2","0","1"]:
        abort("database not at the exact first-owner baseline")
    if not trusted_ci():
        fs=os.statvfs(ROOT)
        if fs.f_bavail*fs.f_frsize < 15*1024**3:
            abort("insufficient disk space")
    print("PASS: empty accounts/operators, schema 0018, no privileged logins, SCRAM")

def new_credentials() -> tuple[str,str,str]:
    folder=ROOT/"secrets"/"p1-owner-bootstrap"
    folder.mkdir(mode=0o700)
    descriptor=os.open(folder,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        info=os.fstat(descriptor)
        if info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o700:
            abort("unsafe credential directory")
        result=tuple(secrets.token_urlsafe(36) for _ in range(3))
        for name,value in zip(("owner_provision_password","owner_governance_password","owner_admin_password"),result):
            fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=descriptor)
            try:
                os.write(fd,(value+"\n").encode("ascii"))
                os.fsync(fd)
            finally:
                os.close(fd)
        os.fsync(descriptor)
        return result
    finally:
        os.close(descriptor)

def role_transaction(credentials: tuple[str,str,str]) -> str:
    a=scram_verifier(credentials[0],os.urandom(16))
    b=scram_verifier(credentials[1],os.urandom(16))
    return f"""BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $guard$ BEGIN
 IF (SELECT count(*) FROM vns.schema_migrations)<>18
 OR (SELECT max(version) FROM vns.schema_migrations)<>'0018_ai_provider_named_audit'
 OR EXISTS (SELECT 1 FROM vns.editor_accounts)
 OR EXISTS (SELECT 1 FROM vns.editor_operator_registry)
 OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('{PROVISIONER}','{GOVERNOR}'))
 THEN RAISE EXCEPTION 'bootstrap state changed'; END IF;
END $guard$;
CREATE ROLE {PROVISIONER} LOGIN INHERIT NOSUPERUSER NOCREATEDB
 NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{a}';
CREATE ROLE {GOVERNOR} LOGIN INHERIT NOSUPERUSER NOCREATEDB
 NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{b}';
GRANT vns_editor_provisioner TO {PROVISIONER};
GRANT vns_operator_governor TO {GOVERNOR};
COMMIT;
"""

def registry_transaction(operator_id: str) -> str:
    return f"""BEGIN;
SET LOCAL ROLE vns_operator_governor;
DO $check$ BEGIN
 IF session_user <> '{GOVERNOR}' THEN
 RAISE EXCEPTION 'governance identity mismatch'; END IF;
END $check$;
SELECT vns.register_editor_operator('{PROVISIONER}','{operator_id}'::uuid,
 'Primary VideoNews Owner',
 'Initial project owner enrollment after verified personal database login.');
COMMIT;
"""

def account_transaction(password: str) -> str:
    salt=os.urandom(16)
    digest=hashlib.scrypt(password.encode("ascii"),salt=salt,n=16384,
                          r=8,p=1,dklen=64,maxmem=64*1024*1024)
    verifier="scrypt$"+salt.hex()+"$"+digest.hex()
    return f"""BEGIN;
SET LOCAL ROLE vns_editor_provisioner;
DO $check$ BEGIN
 IF session_user <> '{PROVISIONER}' THEN
 RAISE EXCEPTION 'provisioner identity mismatch'; END IF;
END $check$;
INSERT INTO vns.editor_accounts(username,display_name,role,password_hash)
VALUES ('{ACCOUNT}','VideoNews Studio Owner','admin','{verifier}');
UPDATE vns.editor_accounts SET active=true
 WHERE username='{ACCOUNT}' AND role='admin' AND active=false;
COMMIT;
"""

POSTCHECK = """
SELECT (SELECT count(*) FROM vns.editor_accounts WHERE username='vns_owner_admin'
 AND role='admin' AND active)||'|'||
 (SELECT count(*) FROM vns.editor_operator_registry WHERE
 login_role='vns_owner_provision_login' AND active)||'|'||
 (SELECT count(*) FROM vns.editor_account_lifecycle_events WHERE
 operator_login='vns_owner_provision_login')||'|'||
 (SELECT count(*) FROM vns.editor_operator_registry_events WHERE
 login_role='vns_owner_provision_login' AND authorized_by='vns_owner_governance_login')||'|'||
 (SELECT count(*) FROM pg_roles WHERE rolname IN
 ('vns_owner_provision_login','vns_owner_governance_login')
 AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole);
"""

def main() -> None:
    if sys.argv[1:] not in (["--preflight"],["--apply"]):
        abort("only --preflight and --apply supported")
    if sys.argv[1:] == ["--apply"] and not trusted_ci() and os.getenv("VNS_P1_NO_BACKUP_RISK_ACCEPTED")!="I_ACCEPT_UNRECOVERABLE_LOSS":
        abort("explicit no-backup risk consent missing")
    container=database()
    preflight(container)
    if sys.argv[1:] == ["--preflight"]:
        return
    credentials=new_credentials()
    sql(container,role_transaction(credentials))
    actor_sql(container,GOVERNOR,credentials[1],registry_transaction(str(uuid4())))
    actor_sql(container,PROVISIONER,credentials[0],account_transaction(credentials[2]))
    if sql(container,POSTCHECK)!="1|1|2|1|2":
        abort("postcheck rejected; do not rerun")
    print("PASS: one active admin, one audited operator, two named nonprivileged logins")
    print("No credentials displayed, no provider calls, no container restart")
    print("Credentials are stored ONLY in ignored private secrets/p1-owner-bootstrap")

if __name__=="__main__":
    try:
        main()
    except (OSError,ValueError,RuntimeError,subprocess.TimeoutExpired):
        raise SystemExit("REFUSED: owner bootstrap failed; do not rerun blindly")
