# P1-07: isolated PostgreSQL TCP acceptance

Operator evidence (2026-10-25): migration 0012 and three restricted LOGIN roles were created and the correct group memberships were verified via read-only PostgreSQL SQL. The live authentication and permission checks from the private Docker network are the next acceptance gate. The three secret files remain private to UID 1000 (0600).

Use `scripts/verify_pg_runtime_tcp_isolated.py --verify` only after reviewing its code and a clean `main` checkout. This is a separately operator-run diagnostic, not a deployment or runtime service.

The checker requires the existing backend Docker network (internal), a healthy Compose-labelled PostgreSQL 17 container and a locally available image. It uses that already local image in three sequential `docker run --rm --pull=never` clients. Each has read-only root filesystem, restricted capabilities, resource limits, its own temporary RAM-backed password file, and a read-only bind mount of **only that client's own secret**. No other service's credentials are mounted. The credential itself is never supplied in Docker command arguments, environment variables or logs.

Each client authenticates to `postgres:5432` using its own login, asserts a real non-loopback TCP connection and the expected inherited permissions, checks a permitted read and a denied cross-service read, then confirms another account refuses its own password. Read-only sessions and SQL statements only. Any mismatch fails closed without printing the secret or diagnostic command output.

This operation creates short-lived diagnostic containers, but does not restart/reconfigure the running Postgres, Redis, Web, API, Cloudflare or probe worker; it does not create editorial jobs or enable editorial workers. It is **not** a disaster-recovery test or full P1-07 acceptance. The three LOGIN roles must not be provisioned a second time. Avoid running it concurrently with unrelated production maintenance.
