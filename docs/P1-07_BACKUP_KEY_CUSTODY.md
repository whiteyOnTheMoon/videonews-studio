# P1-07 — Backup encryption and independent key-custody design

**Status: GitHub Actions-only cryptographic rehearsal. Not production-ready.**
There is no approved external backup service, storage owner, encryption
key store, secure signing service, retention duration, RPO/RTO or off-host
recovery record for VideoNews Studio. Nothing in this document authorizes
purchase, real backup export, new VPS containers, migrations, worker startup
or a public cutover.

## Separate the three trust domains

| Trust domain | Intended role | Status |
| --- | --- | --- |
| Backup archive | Store encrypted copies outside the VPS with restricted access, retention and deletion rules | No external destination approved |
| Encryption key custody | Recover ciphertext with an independently held 256-bit data-encryption key, not stored beside the archive | CI creates memory-only synthetic keys; no key store approved |
| Signature and freshness trust | Verify a trusted signing key, authenticated backup identity, expected generation and completeness anchor obtained independently of the archive | CI pins an in-memory public key and generation; no real independent anchor |

The recovery reader **must not accept a public key, revocation status,
backup sequence, expected backup ID or decryption key merely because the
same archive supplies it**. A self-contained signature and checksum can
be rewritten by anyone holding the signing private key; encryption
does not prove the original database was complete or that there are no
missing/newer backups. Off-host storage and an independently retained
monotonic generation/freshness ledger are separate requirements.

## What the synthetic CI protocol proves

The `scripts/ci_sealed_backup.mjs` helper is restricted to
`GITHUB_ACTIONS=true` with repository, run-ID and explicit fixture
guard. It accepts **only small disposable in-memory buffers**, generates
a fresh 96-bit nonce per seal and encrypts via AES-256-GCM with a
fixed application AAD domain. It writes an owner-only
`sealed.json` containing a ciphertext, authentication tag, nonce,
synthetic backup ID, sequence and Ed25519 signing-key fingerprint;
the exact envelope bytes are covered by a domain-separated detached
`sealed.sig`. The signing and encryption keys are passed separately;
neither key is serialized to the archive, environment files, GitHub
Secrets or logs. Existing files are not overwritten.

Before decrypting, the verifier checks exactly two regular, owner-only
archive files and a maximum size. It requires the independently supplied
expected backup ID and **exact generation**, checks that the key ID
matches the separately pinned Ed25519 public key and that this signer
is still active, and validates the detached signature. Only then is
AES-GCM decryption attempted. GCM rejects a wrong decryption key or
a modified ciphertext/authentication tag.

The test copies ciphertext and signature to another isolated runner
temporary directory, then verifies correct plaintext using the
out-of-band in-memory key registry. Adversarial tests cover wrong keys,
key-substitution, revocation, signer rotation, stale generation and
rollback, wrong archive identity, changed ciphertext, corrupted
signature, unexpected files, symbolic links, and changed GCM tag even
when a synthetic signing key is used to resign the envelope.
All ephemeral directories are deleted after tests. No cloud upload or
GitHub Actions artifact is created.

**Scope limit:** this is a protocol test on a synthetic string,
not a stream-safe full database/Redis/media archive format. It does
not select a production encryption algorithm suite or key service,
restore PostgreSQL, verify Redis AOF, encrypt real private data, set
or measure RPO/RTO, or prove loss-resilient external retention.

## Operator decisions required before implementing a real backup

1. Identify an **independent off-VPS destination** and named access
   owners. Define a realistic budget, access revocation, encryption,
   monitoring, restore permissions and retention/privacy rules.
2. Choose **independent key custody** for decryption and signing.
   Protect key creation, backup/recovery, operator authorization, rotation
   and loss/revocation. Do not commit any plaintext private keys, recovery
   codes or passwords to GitHub or place them inside an export.
3. Establish a **separate verification trust store**, recording each
   approved key fingerprint, permitted signing epoch, revocations,
   expected archive identity, archive generation and timestamp/freshness
   anchor. Archive contents cannot update this store.
4. Document failure behavior: inaccessible offsite copy, missing key,
   wrong/compromised signer, revoked key, old generation, corrupted
   ciphertext, missing dependencies or replayed archive **must block**
   any recovery cutover. A new key alone must not automatically forgive
   a rolled-back archive.
5. Perform a **human-approved restore exercise** into an isolated
   infrastructure target. Recover PostgreSQL globals/data, Redis,
   uploaded media, configuration, identity and audit proofs; reconcile
   the outbox before any Worker or public ingress starts.
6. After the exercise, approve an explicit backup schedule, RPO/RTO,
   budget and deletion/retention policy. Only then could a separate
   production implementation be reviewed and deployed.

If no safe, funded off-VPS destination or external key recovery
arrangement exists, **leave all 12 P1-07 recovery release gates closed**.
Code stored on GitHub cannot recover lost PostgreSQL records, Redis
queue history, media or secret material.

See [P1-07 full-stack recovery runbook](P1-07_RECOVERY_RUNBOOK.md) and
[`p1-07-recovery-plan.json`](p1-07-recovery-plan.json).
