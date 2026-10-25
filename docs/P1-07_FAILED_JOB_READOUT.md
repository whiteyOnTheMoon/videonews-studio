# P1-07 – Operator failure report (read-only)

The operator observed an empty live PostgreSQL editorial ledger on 2026-10-25:
0 total jobs, 0 failed, 0 open and no failed-job rows. This is a direct,
read-only database observation, not a live end-to-end failure rehearsal.

The new optional `scripts/report_failed_editorial_jobs.py --list` provides
a **bounded, redacted CLI failure list**, not a public browser dashboard.
It reads from `vns.jobs` using only the dedicated
`vns_job_status_sync_login` account, which inherited SELECT privileges
from the NOLOGIN group in migration 0012. It does not connect as owner
`vns`. Its SQL sessions set `default_transaction_read_only=on`.

The script requires UID 1000, a clean `main` checkout, the private network,
a healthy Compose-managed Postgres and the one pre-staged status-sync password
file owned by UID 1000 and mode 0600 under an owner-only directory. It runs
one throwaway `docker run --rm --pull=never` client from the already-local
PostgreSQL image, with no privileges, read-only filesystem, small RAM tmpfs,
resource limits and **only its own** read-only secret mount. No password goes
into Docker arguments, environment, Git or application logs.

The output contains only a total, at most 20 recent failed job UUIDs, bounded
attempt counts, enumerated job kinds and sanitized error classes
(`bullmq_failed` versus `other`). No raw PostgreSQL errors, arbitrary
error strings or secrets are emitted. Malformed results stop the report.

No existing Docker service is started, stopped or restarted. No editorial
job is enqueued or updated. The real operators still need a separately
approved live editorial service and recovery acceptance for full P1-07.
No offsite backup or restore proof exists. CI mocks the Docker commands and
verifies parsing, policy, and CLI syntax without touching the production VPS.
