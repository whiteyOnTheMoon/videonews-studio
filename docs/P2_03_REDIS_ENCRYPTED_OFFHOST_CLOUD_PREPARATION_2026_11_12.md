# P2-03 – Redis 8.4.8 encrypted off-host cloud backup preparation

**Status: design and read-only metadata preflight. No production backup or restore permit.**

Confirmed source VPS main SHA: 2ab4639ff3cbe0ca35fd258bd446a0547c29cc54. The user subsequently clarified that the destination is **Google Drive (not Google Cloud Storage)**. Account authorization, Drive folder scope, remote configuration, independent custody, retention and recovery rights have **not** been verified. See docs/P2_03_GOOGLE_DRIVE_ENCRYPTED_REDIS_BACKUP_2026_11_12.md. Read-only checks observed the active Redis 8.4.8 AOF volume with three multipart files (~9 MiB); restic was missing when last inventoried. Cloud ownership is not evidence of an off-host backup.

## Architecture and non-negotiable boundaries

1. **Source:** Redis 8.4.8, exact Docker ID, pinned image and active /data volume. Never copy live multipart AOF without a point-in-time consistency boundary. Redis BACKUP START requires Redis 8.10.0 or later. An RDB transfer via redis-cli --rdb is an *option*, not an authorized step: replication-based SYNC may trigger fork/disk I/O and require replication permissions. Assess RDB cutoff, resource impact, ACL rights and exact source identity first. No CONFIG SET, BGSAVE, ACL LOAD, BGREWRITEAOF, Docker pause/restart or RDB capture is authorized by this design.
2. **Sensitive snapshot staging:** fresh unique private path outside webroot, Git, live Docker data and published volumes; owner-only permissions; no symlinks. Prefer suitably sized tmpfs or encrypted local disk after size/capacity review. Plaintext may contain Redis job data; never put it in GitHub, logs, chat or CI artifacts. Its local presence is not off-host recovery.
3. **Encryption and transport:** maintained restic client-side encrypted repository over validated TLS. An S3-compatible service can use a repository URL of the form s3:https://PROVIDER-ENDPOINT/BUCKET/PREFIX. **Google Drive is NOT S3 or GCS**. Google Drive requires the supported restic rclone backend with a separately authorized Google Drive remote. Native Azure or Google Cloud storage use different restic backends. Never invent endpoints. Store RESTIC_PASSWORD_FILE and cloud credentials in independently controlled, private stores rather than flags, chat, Git, process arguments or public files. Do not put the *only* recovery password on the VPS.
4. **Cloud access and retention:** independent private account or bucket, limited prefix, separate backup identity and recovery identity, access logging and no anonymous reads. Review provider-supported object versioning/immutability and object-lock retention, lifecycle and restic lock/prune compatibility. Deletion authority should not be granted to the unattended uploader where avoidable; recovery rights, costs and egress need separate approval.
5. **Independent restore:** separately held decryption secret and scoped recovery credentials; independent freshness/generation record. The restic check --read-data operation checks archived data integrity, not live Redis consistency or application recovery. Download and restore on a separate machine/account into isolated networkless, portless Redis 8.4.8 with NO workers, NO public ingress and NO production volume. Compare redacted key/queue structural invariants against an independently kept baseline and reconcile PostgreSQL/queue ledgers before any future cutover.

## Mandatory gates: all currently OPEN

- [x] Provider type identified: Google Drive via restic + rclone (reported by operator).
- [ ] Google Drive account/folder scope, OAuth remote and separate recovery access verified.
- [ ] Private Drive folder/repository path, independent owner, quota, rate limits and costs approved.
- [ ] Versioning/immutable retention compatibility and lifecycle policy reviewed.
- [ ] Least-privilege upload principal and independently tested recovery principal ready.
- [ ] Encryption secret independently recoverable from another device/account.
- [ ] RPO, RTO, retention, privacy and key rotation agreed.
- [ ] Production consistency boundary approved without unsafe AOF read.
- [ ] Provenance, cutoff timestamp and protected freshness generation established.
- [ ] Encrypted off-host backup created by a separate authorized operator.
- [ ] Remote integrity full read verified with restic check --read-data.
- [ ] Independent networkless Redis restore and P1/P2 ledger parity verified.
- [ ] Explicit production backup scheduling and Redis maintenance decisions signed off separately.

All previous P1-07 release gates remain closed. **No productive Redis pause is authorized.**

## Provided read-only readiness script

scripts/p2_03_redis_cloud_offhost_readonly_preflight.sh accepts one exact 40-character clean-main SHA. It reads Git metadata, Docker inspect metadata and the presence of local tools. It performs **no** cloud requests, Redis commands, Docker mutations, password reads, file writes, backups, systemd changes or restores. A PASS means a safe inventory, **not** a verified backup.

## Safe phased rollout

A. **This draft:** validate only the no-side-effect script, existing project rules and CI tests. Establish the cloud provider/API and budget without disclosing secrets.

B. **Separately approved cloud-only rehearsal:** after provider, bucket and permission review, use a new private test prefix to initialize a restic encrypted repository, upload synthetic bytes, check --read-data, and restore on a separate machine with independently held credentials. This may incur costs; do not run automatically. No Redis contact.

C. **Production-source design approval:** choose a bounded RDB transfer or consistent storage snapshot under an explicit new operator permit. Assess fork memory, rate, running worker effects, image and data volume, time cutoff, ACL, and RPO.

D. **Independently verified backup and restore:** authorized data capture to protected temporary staging, client-side encryption/upload, full remote read, independent restore/replay. No data goes to GitHub. Scheduling, automatic retention and production maintenance require separate subsequent approval.

References: https://redis.io/docs/latest/management/persistence/ ; https://redis.io/docs/latest/develop/tools/cli/ ; https://redis.io/docs/latest/commands/backup-start/ ; https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html ; https://restic.readthedocs.io/en/stable/045_working_with_repos.html . Related internal policies: docs/P1-07_BACKUP_KEY_CUSTODY.md ; docs/P2_02_REDIS8_OFFLINE_ARCHIVE_2026_11_11.md ; docs/P2_02_REDIS8_CAPTURE_WINDOW_2026_11_11.md .
