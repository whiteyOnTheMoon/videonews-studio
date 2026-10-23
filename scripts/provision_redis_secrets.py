#!/usr/bin/env python3
"""Create local Redis credentials, never print or commit either secret.

Run on the operator's machine; refuse existing files rather than silently
rotating credentials. Rotation needs an explicit data/worker rollout plan.
"""
from hashlib import sha256
from pathlib import Path
import os
import secrets
import sys


def provision(directory: Path) -> None:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    password_path = directory / "redis_password"
    acl_path = directory / "redis_acl"
    if password_path.exists() or acl_path.exists():
        raise FileExistsError("Redis secrets already exist; refusing to overwrite")

    # 48 random bytes; Redis ACL stores only SHA-256, never the plaintext.
    password = secrets.token_urlsafe(48)
    digest = sha256(password.encode("ascii")).hexdigest()
    acl = (
        "user default off\n"
        f"user vns_worker on #{digest} ~bull:vns:* +@all -@admin -@dangerous\n"
    )
    created = []
    try:
        for path, data, mode in (
            (password_path, password + "\n", 0o600),
            (acl_path, acl, 0o644),
        ):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
            created.append(path)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
            finally:
                os.chmod(path, mode)
    except BaseException:
        for path in created:
            path.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) == 2 else Path("secrets")
    try:
        provision(target)
    except (OSError, ValueError) as err:
        print(f"Redis provisioning refused: {type(err).__name__}", file=sys.stderr)
        raise SystemExit(1)
    print("Redis secret files created; plaintext is only in redis_password (0600).")
    print("Hashed ACL file redis_acl (0644) is readable by Redis container UID.")
    print("Do not start the data profile until separately approved.")
