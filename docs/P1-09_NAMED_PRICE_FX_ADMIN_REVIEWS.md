# P1-09: Named Admin Price and FX Reviews (Offline / Opt-In)

Migration `0041_named_live_price_fx_reviews` adds individually attributable,
immutable price and exchange-rate reviews. The price/version/currency and
upper-bound FX numbers are **entered by the operator**. Nothing is
hardcoded as an actual provider price, and no FX rate is inferred.

## Personal review contract

The API accepts two strict actions:

- `review_price`: provider, model, priceVersion, three USD-per-million-token
  prices expressed as integer micro-USD, expiry, verified HTTPS source
- `review_fx`: conservative EUR-per-USD upper-bound expressed as an
  integer number of nanounits, expiry, verified HTTPS source

The Admin form accepts a decimal FX ratio and converts it exactly to
nanos. For example, the synthetic decimal `1.150000000` is stored as
`1150000000`. That value is **only an example**, not a real FX quote.

The server authenticates an active personal admin on every request,
requires the exact Admin origin, uses the existing shared PostgreSQL
mutation rate gate, rejects unexpected fields and limits JSON to 1024
bytes. The dedicated provider-config writer can invoke only audited SQL
functions. Each function locks the current editor's account and
revalidates `role=admin`, `active`, and `auth_version`. An insert and
its named audit row are committed atomically. No API key is submitted
or returned from the review path.

Neither review function can change the active provider setting, enable
the USD/EUR budget policies, modify existing price/FX rows, or issue a
dispatch claim. Policy activation must remain a separate reviewed
operator decision.

## Explicit default-off runtime gates

The API runtime needs the existing secure provider Admin writer login
plus `VNS_PROVIDER_PRICE_REVIEW_ENABLED=true`. The browser BFF/Admin
needs `VNS_WEB_AI_PRICING_REVIEW_ENABLED=true`, with the normal
personal editor-auth and provider writer prerequisites.

**Both new switches default OFF.** Merely merging or deploying this
branch does not expose the new form or authorize price mutations. The
operator must explicitly decide to enable the reviews after the actual
VPS schema 0019–0041, named-login permissions and authentication checks
have been verified. They are intentionally not switched on by the
regular provider Admin Compose overlay.

The Admin UI lives under **Admin → Geprüfte KI-Preise und Wechselkurse**
once both switches are separately authorized. It is not a billable-job
or budget activation interface.

## Trust boundaries and limitations

A syntactically valid HTTPS source **does not prove** that the amounts
on that page are accurate or current. There is no automated independent
vendor price verification, official-domain guarantee, FX price source
fetching or invoice reconciliation. A personally logged review is
operator attribution, not an independent countersignature. The
provider-config DB login must be kept private: SQL checks the supplied
active-admin ID and auth version but cannot, alone, prove an upstream
HTTP session. Real credentials need a separate permission/recovery
review.

New rates are bounded to a seven-day review validity for model prices
and 24 hours for FX; the existing dispatch gate requires FX reviewed
within 24 hours and not expired. Changing FX prices does not
automatically activate or update EUR policy.

## Validation

`db/tests/0041_named_live_price_fx_reviews.test.sql` covers:
default-off, least-privilege executor and writer, invalid input,
revoked and stale admin identity, append-only reviews, duplicate
price-version refusal, audit attribution and no provider activation.

API and BFF unit tests cover origin, personal admin role, strict
payloads, content limits, SQL parameterization, generic errors and
shared admission denials. CI applies and reverts migrations 0001–0041
twice against isolated PostgreSQL 17.

No provider keys, paid calls or VPS migration are authorized.
Issue #230 remains open pending real vendor transport, trusted pricing,
budget operator controls and an explicitly approved ≤1 EUR canary.
