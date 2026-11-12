# P2-03 — Google Drive encrypted off-host Redis backup design

**Status: design and metadata-only readiness checks. NO actual cloud or Redis backup and NO production permission.**
Baseline main SHA at preparation: 26f415a4962d29c838a64d3ec7897bbca9c7c72b.
The operator confirmed that the chosen object-like off-host destination is **Google Drive**, not Google Cloud Storage and not an S3 bucket.
A Google Drive account or folder is **not** proof of independent recovery access, safe retention or backup existence.

## Correct provider architecture

A verified, point-in-time consistent Redis 8.4.8 artifact (not yet authorized)
→ restic client-side encryption
→ rclone Google Drive backend over authenticated Google API/TLS
→ private Drive folder
→ independent credential + decryption-key custody
→ fetch and restore on an independent machine/account.

The restic repository backend is rclone:<remote>:<directory>, for example
`rclone:vns-drive:VNS-Redis-Backups/synthetic-lab`.
This syntax is **illustrative only**. Do not run restic init or create a remote until the storage identity, permissions, cost and key custody have been approved. The path is not a real endpoint and no actual Drive remote is verified.

This is **NOT** the restic "gs:" backend (native Google Cloud Storage), an AWS S3 endpoint, or an unencrypted `rclone copy` of the live AOF folder.
Restic encrypts archive bytes and metadata before rclone transports them. A separate rclone crypt remote is unnecessary for this restic repository and increases operational complexity. Sensitive plaintext staging requires separate review.

## Drive authorization and host custody

- Use a dedicated backup Google identity or a strictly controlled, dedicated Drive folder, not unrestricted access to the user's everyday personal documents.
- Prefer rclone OAuth scope `drive.file` for a new repository whose files/folders are created by rclone; this scope accesses only files created through that app. Validate that the same recovery identity can actually list and read the resulting repository. `drive.readonly` cannot upload, and default `drive` exposes unnecessarily broad user-file access.
- As of 2026, rclone's shared Google Drive OAuth client ID is being retired. Before activating a recurring job, register and validate a separate Google Drive OAuth client ID appropriate to the operator's Google account and consent configuration. OAuth setup can need a local browser on a different machine because the VPS is headless. See rclone remote_setup and drive documentation.
- The rclone configuration can contain OAuth access and refresh tokens. Keep it owner-only, with its encrypted-config password (if used) separately held. Never print `rclone config show`, `rclone config dump`, auth tokens or restic credentials in chats, CI or terminal transcripts.
- A restic repository password is **not** the same as a Google password or OAuth refresh token. Hold the recovery copy off the VPS (e.g., independently secured password manager), and prove decryption from another machine without the VPS. Never put the only decryption secret in Drive with the repository.
- Google Drive is not inherently immutable WORM storage. Do not claim Object Lock, bucket policy, guaranteed point-in-time retention or ransomware protection. Review account recovery, Google trash/retention behavior, quota, API rate limits and possible account suspension. An independently accessible second copy on separately administered storage is recommended for critical recovery.
- Restic repositories may contain many small files. Google Drive API operations can be rate limited; evaluate check/restore duration and avoid concurrent restic writers and unauthorized lifecycle or manual folder operations.

## Progression (separate approvals)

1. **Metadata inventory only:** run the SHA-pinned existing VPS preflight, which only reads Git and Docker inspect and reports presence of restic/rclone. It neither queries an authenticated Google account nor creates local files.
2. **Environment and ownership decision:** confirm personal Drive vs Workspace, ability to create an OAuth app/client, available quota, storage rights and independent recovery account. Do not send credentials, passwords, OAuth authorization output, personal account names or folder IDs to GitHub/chat.
3. **Install and auth approval:** install audited versions of restic/rclone, independently verify binary provenance, configure a private OAuth remote on the host without terminal tokens in transcripts, and verify least-privilege access without showing private content. This is NOT authorized by this design alone.
4. **Synthetic-only cloud exercise:** in a dedicated disposable test folder, initialize a new encrypted restic repository, back up only made-up bytes, run full `restic check --read-data`, and independently restore the bytes from an unrelated recovery environment. Explicit approval required for cloud uploads, cost and storage setup.
5. **Source-consistency decision:** review a bounded Redis 8.4.8 RDB transfer (possible fork/replication ACL/performance impact) or a trusted consistent storage snapshot. Live multipart AOF copy cannot be trusted without a consistency boundary. Redis's native BACKUP START applies to Redis 8.10+ and is not available in pinned Redis 8.4.8.
6. **Separate production backup approval:** only after source consistency, access, encryption keys, completeness/freshness, RPO/RTO, privacy/retention and independent restore gates are closed. Do not run `docker pause`, `CONFIG SET`, `BGSAVE`, ACL reload, RDB transfer, data export or restic backup of real Redis before that.

## Current fail-closed evidence (as of last operator output)

- Git clean at baseline SHA and production Redis healthy/unpaused.
- Production /data points to the pinned named Redis 8.4.8 volume.
- Tools: restic not installed; rclone was previously reported missing. The updated preflight only reports their present/absent status.
- Google Drive: operator reports using it; OAuth, storage quota, cloud account independence and any encrypted remote backup are **unverified**.
- No encryption key backup, snapshot consistency proof, remote repository integrity proof or independent Redis restore exists.
- Prior isolated Redis systemd unpause watchdog PASS does **not** authorize a production pause.

**PRODUCTION_REDIS_MODIFIED=false is a requirement, not an assertion about future unknown actions.**
**OFF_HOST_BACKUP_VERIFIED=false.**
**PRODUCTION_REDIS_PAUSE_AUTHORIZED=false.**
**FULL_STACK_RELEASE_GATES_CLOSED=true.**

Official references:
- https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html (other services via rclone)
- https://rclone.org/drive/ (Drive scopes, OAuth client ID and API behavior)
- https://rclone.org/remote_setup/ (headless OAuth)
- https://rclone.org/docs/ (configuration and credential custody)
- https://redis.io/docs/latest/management/persistence/ (AOF backup consistency)
- docs/P2_03_REDIS_ENCRYPTED_OFFHOST_CLOUD_PREPARATION_2026_11_12.md
- docs/P1-07_BACKUP_KEY_CUSTODY.md
