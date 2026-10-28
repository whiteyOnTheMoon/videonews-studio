# P1-09: reviewed model selection (migration 0042)

This is an offline-safe extension of the default-off provider administration
path. It removes the **hardcoded synthetic model allowlist** from model editing
and replaces it with a server-enforced, provider-specific, personally
attributed pricing-review gate. There are no new provider clients, token
charges, external endpoints, seeds or budget activation switches.

## Administrative path

An operator first records a versioned model price using the existing
Admin price review form and a source they personally verified. The provider
and model strings are exact; the review contains source, expiry, user ID
and auth version. From the separately gated Provider Admin form the
operator may then enter that model ID. The HTTP and BFF layers accept
only short model-identifier syntax (no URL, spaces, path, control
characters or unexpected request fields).

**PostgreSQL is authoritative.** The guarded `set_model` function
allows a selection only when an immutable price snapshot exists for the
same provider/model, is USD-denominated and unexpired, has a linked
personally attributed `model_price` review, and the original reviewer
still has an active administrator account with the same auth version.
Missing, stale, unreviewed, wrong-provider and revoked reviews are
rejected without model or audit changes. The provider remains disabled.
The private provider writer gets no direct table mutation privileges.
The previous set of synthetic IDs is not seeded as approved review data.

The read-only Admin preview now displays the selected DB model rather
than fictional built-in model options. A valid model ID is a **selection
candidate**, not proof that the vendor implements the model or has
published matching prices. Both provider administration and price
review still require their existing separate runtime gates; they
remain off unless independently enabled.

## Critical remaining blockers

A person-entered price source URL is not vendor-authenticated evidence.
An independent current availability/pricing check and vendor response
metering must pass before any paid job. Review does not release a
vendor credential, budget policy, dispatch claim or worker transport.
The Web/API surface never trusts a frontend model list. Model catalog
availability and capability validation against actual provider APIs,
including TTS units and non-text pricing, are **not implemented** by
this migration. No canary or VPS deployment is authorized.

## Verification

The disposable PostgreSQL 17 migration test covers unreviewed,
wrong-provider, expired and malformed model IDs, selection idempotency, active named review, reviewer revocation, SQL role permissions
and no provider activation. CI repeats the full 0001–0042 migration
and rollback sequence twice. API, Web BFF, and Admin component tests
verify strict model-ID syntax and preserve all secret/activation guards.

The live VPS last independently confirmed migration 0018. Never run
0042 alone or migrate the VPS without a separate operator preflight.
P1-09 #227 and #230 stay open until their actual live criteria pass.
