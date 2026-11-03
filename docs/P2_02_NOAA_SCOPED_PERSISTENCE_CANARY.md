# P2-02 – Operator-selected NOAA persistence canary (code only)

This change adds a **separately authorized one-shot diagnostic subset**, not
a change to an approved source, the signed export, publisher key, high-water
checkpoint, Poll-Lease, Redis ACL, or scheduled production polling.

The full three-source registry is still verified against signed publisher
export and current PostgreSQL Source/Host grants. The minimum 3–5 source
requirement and Queue slot identity remain intact. The manually invoked
`feed-observer` may optionally poll **only** `noaa_news` while it is an
approved, RSS, `metadata_only` source on `www.noaa.gov`. The nonselected
sources receive **no** authority SQL query, Poll-Lease, DNS, HTTPS request or
metadata write.

## Fail-closed gates

All existing observer admission flags, trust-policy revision, initial
checkpoint admission, distinct PostgreSQL/Redis logins, signed source
verification, reviewed host allowlist and operator rights attestations
remain mandatory. Additionally, the operator must set precisely:

- `VNS_FEED_RUNTIME_MODE=single_pass`
- `VNS_FEED_SOURCE_BOOTSTRAP=false` (existing checkpoint must be preserved)
- `VNS_FEED_CANARY_SOURCE_ID=noaa_news`
- `VNS_FEED_CANARY_OPERATOR_ACK=NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY`

These are an **opt-in**, not a substitute for independent operator
authorization of the actual production release and Source/Host rights.
There is no fallback to any other source if NOAA is denied. A selector
without the exact acknowledgement, or in a persistent worker, scheduler or
producer, is rejected before opening any secrets or network connections.

The `feed-observer` retains a single bounded BullMQ job, 45-second job
wait, one per-source SQL lease subject to the existing interval, bounded
HTTPS and metadata-only SQL commit. A repeated run while NOAA's lease is
ineligible may return no new candidates. Never clear the existing lease or
checkpoint to force a retry. No AI research or publication is enabled.

## Operator review before permission to run

1. Verify the exact release SHA, current signed source revision 8, approved
   host revision 7, pinned trust policy revision, checkpoint state and the
   independently approved NOAA rights and URL. Reconcile any revisions
   that changed since the last operator inventory; do not blindly assume
   that old revisions remain current.
2. Read the pre-existing NOAA Poll-Lease and verify that it is eligible.
   Check isolated feed BullMQ queue status and reject if a current or
   failed job would conflict with the intended one-shot 15-minute slot.
3. Separately confirm the operator's authorization for **one NOAA-only
   metadata persistence** canary and its exact host/network/write scope.
4. Invoke only the existing `feed-observation` Compose profile, with
   approved runtime secrets and the gates above. Do not run any bounded or
   continuous producer/consumer and never enable bootstrap.
5. Verify PostgreSQL counts and source authority audit, projection,
   ranking and authenticated Admin views separately. A successful
   observation count is not proof of persisted projection or editorial
   approval; zero newly inserted candidates can be normal after
   deduplication.

Do not run this from CI or with an unsigned/fabricated source snapshot.
No API/publishing access, unsafe feed shortcuts or source revision resets
are included. Enabling this mode requires a separate, current
operator-reviewed VPS command.
