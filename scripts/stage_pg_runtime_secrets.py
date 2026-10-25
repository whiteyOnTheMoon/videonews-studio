#!/usr/bin/env python3
"""Stage three independent PostgreSQL secret files; never touch PostgreSQL.

Operator action is explicit, and never prints or overwrites credentials.
No LOGIN roles, Docker services or production config are changed here.
"""

import os
from pathlib import Path
import secrets
import stat
import sys

NAMES = (
    "pg_outbox_dispatch_password",
    "pg_job_status_sync_password",
    "pg_research_writer_password",
)


def stage(directory: Path, expected_uid: int = 1000) -> None:
    if os.geteuid() != expected_uid:
        raise PermissionError("expected reviewed operator UID")
    if directory.is_symlink():
        raise PermissionError("secrets directory must not be a symlink")
    if not directory.exists():
        directory.mkdir(mode=0o700)
    info = directory.stat()
    if (
        not directory.is_dir()
        or stat.S_IMODE(info.st_mode) != 0o700
        or info.st_uid != expected_uid
    ):
        raise PermissionError("secrets directory ownership or mode invalid")
    # Refuse partial/existing deployments rather than rotating any password.
    if any((directory / name).exists() or (directory / name).is_symlink() for name in NAMES):
        raise FileExistsError("one or more PostgreSQL secrets already exist")

    created = []
    previous_umask = os.umask(0o077)
    try:
        for name in NAMES:
            password = (secrets.token_urlsafe(48) + "\n").encode("ascii")
            fd = os.open(
                directory / name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
            created.append(directory / name)
            with os.fdopen(fd, "wb") as handle:
                handle.write(password)
                handle.flush()
                os.fsync(handle.fileno())
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except BaseException:
        for path in created:
            path.unlink(missing_ok=True)
        raise
    finally:
        os.umask(previous_umask)


if __name__ == "__main__":
    if sys.argv[1:] != ["--stage"]:
        raise SystemExit("REFUSED: explicit --stage action required")
    target = Path(__file__).resolve().parent.parent / "secrets"
    try:
        stage(target)
    except (OSError, ValueError):
        raise SystemExit("REFUSED: PostgreSQL secret staging preflight failed")
    print("PASS: three different PostgreSQL secret files staged (0600); values not printed")
    print("No PostgreSQL LOGIN, migration, Docker service or runtime flag changed")
