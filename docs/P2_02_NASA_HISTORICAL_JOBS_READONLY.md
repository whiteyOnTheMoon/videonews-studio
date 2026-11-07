# P2-02 NASA: bounded historical BullMQ job review (no writes)

**Code-only, dormant.** This is not NASA feed authorization and it does not
replace the signed-source/SQL parity witness or the queue/slot preflight.

## Why the additional witness exists

On 2026-11-06, the operator ran
`scripts/p2_02_nasa_queue_readonly_preflight.py` on pinned release
`c24568779e3ad9bdaf4e5f9d872bbda89662d753` and observed:

- `status=reviewable`, with both isolated feed ACL identities verified;
- zero active, waiting, delayed, repeat, paused, prioritized or stalled jobs;
- neither the previous nor current 15-minute slot key was present;
- three **historical failed** jobs and one **historical completed** job;
- no job, checkpoint, database or feed changes.

These past failures do **not** establish a current queue conflict, but must
not be deleted, retried, reset or dismissed without review. The previous
queue witness deliberately counted jobs without opening job records, so it
could not classify historical failed reasons or validate that their job
records still exist.

## New independent redacted inspection

After a reviewed SHA-pinned GitHub release and with the existing feed
services quiescent, the operator can run:

```sh
sudo python3 scripts/p2_02_nasa_historical_jobs_readonly.py --expected-sha <reviewed SHA>
```

The helper requires root, a clean pinned `main`, healthy private Redis, the
existing consumer-only credentials and verified ACL identity. It uses only
`AUTH`, `PING`, `ACL WHOAMI`, and the bounded read commands `ZCARD`, `ZRANGE`
and `HGET` under the fixed `bull:vns:feed:vns-feed-poll:` namespace.

For both `failed` and `completed`, it reads at most 20 historical members,
validates the deterministic `vns-feed-tick-<slot>` ID format and checks that
the associated job hash still has the exact `feed-tick` name. It reads the
`failedReason` field for failed jobs **only**, matches a small closed set of
known generic application error strings, and aggregates everything else as
`other_or_missing`. No unrecognized failure string is surfaced.

The output contains **only aggregate counts**, three fixed reason-class
counts, presence/format booleans and `status=needs_operator_review` when
historical failures exist. It never prints individual job IDs, error text,
stack traces, payloads, SQL data, source URLs, passwords, hashes or IPs.
Unexpected Redis responses, malformed job IDs, missing job hashes, oversized
fields, more than 20 entries in either state, insufficient ACL access, or
non-quiescent feed services fail closed. No broad key enumeration is used.

**Limits:** `Feed queue execution failed` is deliberately generic in the
worker; seeing this class does **not** prove why a feed failed. An
`other_or_missing` classification does **not** prove a security incident or
corrupt job. It means the evidence is insufficient and must be assessed by
the operator without widening data disclosure. This witness cannot identify
which source a historical job processed. No source GET, Redis mutation,
PostgreSQL query, lease, checkpoint write, scheduler start or publication is
performed. Historical review does not authorize a new NASA fetch.

Synthetic no-network tests cover all read commands, result redaction,
malformed IDs, absent job fields, oversize response rejection and absence
of any production authorization.
