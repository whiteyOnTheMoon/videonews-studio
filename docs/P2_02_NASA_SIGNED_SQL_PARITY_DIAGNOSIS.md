# P2-02 NASA: Read-only signed-source / SQL parity diagnosis

**Operator observation (2026-11-06):** The VPS installed main release
`27effc313484ba7bcf25b9e1956d3106a5ccf225`, and the independent
publisher export passed the existing stage-signature verification at
source/host revision 10/10. The subsequently supplied inline
worker-inbox/checkpoint/SQL check stopped with only
`REFUSED: Signatur-/SQL-Abgleich nicht bestaetigt; keinen Feed starten`.
Because its exception handler hid the first failing check, **the cause
is unknown** and neither the current SQL anchor nor worker checkpoint
parity is presumed broken. The Redis queue inspection was **not reached**
and the previous approval did not authorize a live NASA GET.

## Diagnostic repair: do not require full database list equality

`prepareDormantSourceExport` in
`apps/worker/src/source-registry-export.ts` deliberately exports the
subset of database sources whose article base host is independently
approved. It validates all entries but omits those on hosts outside the
approved host list, including pending/blocked records.

Thus `full_db_sources == signed_registry_sources`, used by the earlier
one-off VPS script, is **too restrictive**. It can fail for a valid
database containing other unapproved-host sources. The correct
subset comparison is:

- Every database record whose `baseUrl` host is in the signed,
  approved host list appears in the signed registry, including
  blocked child scopes, with exact source metadata.
- No `approved` database source has a host outside that host list.
- Signed and database host approvals match, with correct SQL source and
  host revisions, matching independent Ed25519 verified source stage,
  worker inbox, monotonic checkpoint SHA-256, pinned SQL high-water
  anchor digest and trust-policy approval.

**Important:** This is one possible explanation of the previous
failure, not a confirmed diagnosis.

## New no-write witness

`scripts/p2_02_nasa_signed_sql_readonly_witness.py` is root-only,
requires an exact SHA-pinned clean `main` checkout, repeats the
independent signature/stage verifier, uses `O_NOFOLLOW` and expected
UID/GID/mode checks on the three protected files, and queries the
existing Compose PostgreSQL **only** with
`PGOPTIONS=default_transaction_read_only=on`, timeouts and a fixed
read-only SQL statement. It does not print raw SQL results, registry
entries, URL paths, file bytes, checkpoints, account names, key
fingerprints, credentials, or subprocess exception text.

Its redacted JSON distinguishes:
`publisher_signature_stage_valid`, the three private-file checks,
`stage_equals_worker_inbox`,
`checkpoint_matches_inbox_10_10`, `database_readable`,
the SQL source/host revision booleans, high-water anchor digest and
trust-policy checks, signed-host equality and both full/host-filtered
source-list comparison booleans.

`sql_full_registry_equal_signed=false` **alone is not an error**.
`status=parity_reviewable` requires the actual host-filtered list
match plus all signature, checkpoint, host, policy and anchor checks.
Otherwise `status=blocked` and **no live feed may start**.

The helper's output is a read-only momentary witness, **not** an
operator authorization, reservation of an available BullMQ slot, lease
claim, NASA GET or publication permit. The queue preflight remains a
separate action after understanding the mismatch. Historical failed
jobs, source revisions, SQL grants, lease and checkpoint must never
be silently repaired, retried or reset.

Synthetic CI confirms that a database extra on an unapproved host
does not invalidate valid signed subset parity, while an omitted
blocked child scope, off-host approved source, altered checkpoint,
wrong policy/anchor digest, SQL error and missing authorization do
fail closed.

## Python protected-file witness correction — 2026-11-06

The first live invocation of the new read-only helper on VPS release
`b9157b0902cc0ba75c09f27b4ab2ee588e50f7a4` crashed during the
protected-file `fstat` check with an `AttributeError` for
`os.stat_result.dev`. The helper had mistakenly used the unprefixed
names `.dev`, `.ino`, `.size`, `.mtime_ns`, and `.ctime_ns` rather
than Python's actual `st_dev`, `st_ino`, `st_size`,
`st_mtime_ns`, and `st_ctime_ns`.

**Impact:** the new helper failed before it could produce file-parity
or SQL evidence. This is a bug in the read-only diagnostic code, not
proof of checkpoint corruption or stale SQL anchor. The existing
publisher-stage signature check had already passed independently.
No Redis queue inventory or NASA GET was reached.

This fix uses the correct `stat_result` attributes and adds a real
temporary regular-file read regression test (previous tests mocked
`protected_read` and therefore missed this bug), plus negative
symlink and file-metadata-change checks. The same file/SQL/Redis
read-only boundaries and separate live NASA authorization remain
unchanged.


## Post-canary read-only witness fix — 2026-11-06

The operator ran exactly one signed, NASA-only persistence canary on release
`72f0605a5163325d0b2c979bdef0f61d9abc8131`. Its live HTTPS transport
refused the NASA RSS response because the received body exceeded the existing
128-KiB cap (`response_size_refused`, `response_body`,
`declaredLengthBand=missing`). No NASA metadata persisted. The fourth failed
BullMQ job and the exited one-shot observer container were preserved for audit.

The subsequent read-only NASA witness unexpectedly reported
`publisher_signature_stage_valid=false`, `database_readable=false`,
`checkpoint_matches_inbox_10_10=false`. Code inspection established a
specific false-negative path: the witness previously delegated signature
checking to `p2_02_signed_source_stage_refresh.mjs --verify`, whose CLI
`release()` disallows **any existing** container labeled `feed-observer`,
including a **stopped historical** container. The witness then skipped
checkpoint evaluation and the SQL query entirely. Thus those reported false
fields did **not** prove loss of signed parity, SQL access or integrity.

The corrected witness now calls the already exported, pure
`verifyRefreshedStage()` implementation from the signed refresh module via
an isolated, fixed `node --input-type=module --eval` invocation. It still
requires root and an exact pinned clean `main` before the verifier, and still
validates the independently pinned Ed25519 key, publisher bytes, protected
stage, approved revision 10/10 and equality, checkpoint, SQL grants, source
subset and anchor/trust policy. **The staging CLI's existing conservative
no-containers gate is not changed** and remains in effect for its own
operations.

This is a diagnosis-only change. It performs no HTTPS request, Docker
create/start/stop/remove, queue/lease alteration, checkpoint rewrite, SQL
mutation, source rights update or publishing. It does **not** retroactively
establish whether the actual post-canary SQL and checkpoint are healthy:
run the updated read-only witness after the operator updates to a clean,
SHA-pinned release. Never delete the evidence container or replay the
failed job to make a diagnosis pass.
