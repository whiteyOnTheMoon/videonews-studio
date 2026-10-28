# P1-09 / #230 — reversible, default-off EUR ceiling before SQL provider dispatch

**Offline-only; never a spending, provider transport, or VPS authorization.**
Migration `0040_provider_offline_eur_fx_guard` extends the proven USD
reservation/one-shot claim ledger from migrations 0037–0039. There are
**no predefined FX prices**, no request transport, no API credentials
and **no automatic activation**. Applying the migration to a running
instance defaults the additional EUR gate to **disabled and 0 EUR**.

## Strict ordering and semantics

- The existing USD row-locked budget reservation must succeed first.
- Its INSERT fires an atomic PostgreSQL AFTER INSERT trigger that requires
  a separately reviewed **upper-bound USD → EUR conversion**, at most
  24 hours old and still valid. It binds the immutable FX snapshot to the
  reservation and rounds the **full worst-case USD reservation upward** to
  micro-EUR using PostgreSQL `numeric`:
  `ceil(reserved_micro_usd * rate_nanos / 1_000_000_000)`.
- The EUR policy hard-restricts the **global planned exposure** to
  `1_000_000` micro-EUR (1 EUR) even if the USD cap would admit more.
  All reservations, including settled/unknown/failed ones, permanently
  count the original EUR estimate. No refunds on retries or settlement.
- Before a one-shot dispatch claim, a second trigger verifies the EUR
  policy is still enabled, the active FX snapshot is current, the
  reservation holds matching immutable FX evidence, and the total
  booked exposure remains within the cap. A rate rotation cannot silently
  reprice an unclaimed reservation: it blocks that claim.
- All concurrent admissions serialize using a locked EUR policy row; the
  existing USD policy row also serializes request reservations.
- If the migration is installed over historical SQL reservations **without**
  corresponding EUR admission evidence, every new reservation and claim
  fails closed. Existing USD-only history is NOT retroactively treated as
  zero EUR and cannot be ignored. A separately reviewed recovery/migration
  plan is required.
- The runtime usage writer cannot edit prices, rates, policy or evidence.
  Trigger logic executes as the dedicated NOLOGIN role. Rollback removes
  the EUR gate only through the ordered down migration.

## Important limitations before any real-provider test

This bounds *calculated exposure relative to a trusted conservative
manually reviewed USD/EUR rate*. It does **not** guarantee the provider's
actual EUR invoice, tax, pricing changes or unknown modalities. A market
movement beyond the reviewed upper bound can exceed the estimate. The
operator must review source, timestamp, margin and validity and must
never use an unverified mid-market quote as a worst-case ceiling.

There is currently **no live admin path to set independent FX or price
reviews**, nor a production vendor transport constrained by these SQL
gates. No enable command is provided. A genuine <=1 EUR provider canary
remains prohibited pending separate operator approval of provider,
credentials, total spend, model and current rate, followed by vendor
billing reconciliation and audited recovery behavior.

## Tests

`db/tests/0040_provider_offline_eur_fx_guard.test.sql` checks default-off
and ACL boundaries, expired FX, idempotent reservation, cap exhaustion
while the USD cap has spare headroom, claim uniqueness, FX rotation,
expired-quote dispatch denial and immutable evidence. A separate
PostgreSQL 17 two-session race starts two 300 micro-EUR requests with
**exactly 300 micro-EUR headroom** after prior synthetic reservations;
exactly one may persist. The entire 0001–0040
migration sequence is applied and rolled back twice in isolated CI.

The **last reported VPS schema version was 0018**. Never apply 0040
alone; it depends on every intermediate migration 0019–0039, and the
VPS requires a new reviewed, separately authorized rollout preflight.
