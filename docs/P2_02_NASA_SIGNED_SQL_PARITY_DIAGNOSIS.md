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
