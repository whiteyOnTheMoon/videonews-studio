# P1-09 / #230: Offline EUR FX Gate

Migration `0040_provider_offline_eur_fx_guard` adds a reversible SQL-only currency gate.

There is no provider transport, API credential, seeded FX rate, or spending authorization.

## Admission

The EUR policy defaults to disabled, zero allowance, and no active FX snapshot.

A budget reservation requires a manually reviewed, conservative USD-to-EUR ceiling rate.

The rate must be no more than 24 hours old and must remain valid at admission time.

PostgreSQL converts the full reserved USD amount upward into micro-EUR using numeric arithmetic.

The global cap cannot exceed 1,000,000 micro-EUR, equivalent to 1 EUR at the approved ceiling.

All reserved EUR exposure is append-only and remains charged even after settlement or timeouts.

A policy-row lock serializes simultaneous requests, independently of the existing USD budget lock.

Historical USD reservations without matching EUR evidence freeze new admissions and dispatch claims.

## Dispatch

A one-shot dispatch claim requires a current FX snapshot and matching reservation evidence.

Changing the active FX snapshot never silently reprices an unclaimed reservation.

An expired FX review, disabled policy, missing record, or exhausted cap rejects the claim.

The runtime writer cannot edit the EUR policy, reviewed FX snapshots, or admissions.

## Limits

This cap applies to estimates under a reviewed upper-bound FX rate, not actual provider invoices.

Unexpected FX movement, tax, pricing changes, and unmeasured modalities remain risks.

A live provider client and an independent admin review path have not been implemented.

No live-provider test is permitted without separate operator approval and billing reconciliation.

No SQL migration has been applied to the VPS, whose last confirmed ledger version was 0018.

Never install 0040 alone; all previous migrations through 0039 are required.

## Verification

The SQL tests cover default-off behavior, ACLs, stale FX, cost limits, FX rotation, and immutability.

Two independent PostgreSQL sessions compete for one remaining 300 micro-EUR slot.

Exactly one request may pass when the USD cap would allow both.

CI applies and rolls back the full 0001-0040 schema sequence twice.
