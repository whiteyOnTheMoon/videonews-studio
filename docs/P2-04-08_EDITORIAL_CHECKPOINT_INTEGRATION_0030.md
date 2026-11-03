# P2-04 to P2-08: conservative offline editorial integration and checkpoint audit

This feature adds a deterministic source-provenance-aware ranking function, bounded mock script scaffolds for **briefing, analysis and explainer**, and an independent structural QA path. Sources, publication groups, scoring weights, blocked terms, language-specific text scaffolds, format and budgets are **injected configuration**. No news provider, live feed, AI key, price schedule or production profile is built in.

The ranking distinguishes **publisher groups** from mere source IDs. Unknown publisher provenance, blocked topics, stale/future articles and unapproved rights block scoring. Passing the metadata gate **does not attest to true publisher independence** or source truth.

**Cross-path integrity update (28 October 2026):** Both the simple metadata ranker and the weighted publisher-aware P2-04 ranker now rederive each candidate article's canonical ID and title fingerprint and verify that the displayed headline belongs to an included article. Both apply the **same** Unicode-normalized whole-word/phrase comparison as the P2-09 profile validation. This prevents a metadata forgery or a substring such as `war` in `award` from silently affecting separate ranking paths. The independent P2-08 structural script QA also checks this article/headline boundary and refuses human-review triage with `event_metadata_mismatch` if a caller passes altered candidate metadata. These are only **internal consistency** checks; no source rights or factual accuracy is proven.

**P2-07 generator boundary (28 October 2026):** Script creation now rechecks every article's canonical ID and headline fingerprint before creating sections; each unverified candidate claim must reference only actual event article IDs without duplicates. Already disputed or rejected claims are refused **at generation time**, not only after later QA. These guards do not turn mock scaffolds into factual scripts or authorize any real provider call.

The script provider is a purely deterministic **offline mock**. It never writes new factual prose from headline content: each generated section contains administrator-supplied scaffold text and an explicit candidate claim reference. Revision count, character count, mock token and cost budgets are enforced by the generator. **The separate structural checker also requires its own trusted `ScriptLimits` input**: it recomputes the actual character/token counts and exact mock micro-USD cost from the script's narration, checks the independently configured limits and revision ceiling, and refuses malformed or tampered estimates before allowing even human-review triage. The checker does not trust a script's own claims about its budget. It detects missing references, stale metadata, disputed/rejected claims, rights omissions and simplistic verbatim headline reuse. It is deliberately **not** a semantic verifier, legal opinion or independently authenticated human reviewer. Every report has `approvedForPublication: false`, even when suitable for human review.

## Migration 0030: durable personally attributed checkpoints

A new append-only PostgreSQL table records bounded digest-only metadata for stages `ranking`, `claim_review`, `freshness`, `script_revision` and `quality`. Records are CAS-versioned per event and hash-chained inside the database. The only callable write/read functions require DBA-approved **personal PostgreSQL session_user** mapping from migration 0029, active accounts and role checking. QA requires a reviewer distinct from the latest script author. Outcomes cannot be `approved` or `published` under the schema.

No full article text, prompts, secrets, API outputs or protected source content are inserted into the checkpoint ledger: only artifact SHA-256 digests, limited reason codes, optional numeric score, actor and immutable chronology. The hash chain is **not independently anchored** and a database owner/superuser may still undermine it; offsite independent monotone anchoring remains a separate security requirement.

A default-disabled `DormantEditorialCheckpointStore` injects an existing PostgreSQL client and only uses parameterized SQL. **Do not** inject the shared API database connection: it would represent a shared `session_user`, not a personally authenticated reviewer. An operational login/connection broker, secret custody and Admin web integration remain unimplemented until independently reviewed.

CI uses synthetic article data and isolated PostgreSQL role/auth-version, revision, independent QA, chain and rollback tests. No VPS migration, real news fetch, AI payment or publishing occurs.

## Unmet acceptance criteria

Real independently verified publisher provenance and rights; semantic/foreign-text and fact verification; authenticated source checking; attribution for externally generated scripts; independent provider integration; native Admin screens for policy, decisions and export; production story-to-event linkage; external immutable audit anchoring; personally authenticated PostgreSQL connection brokering; real fully wired Postgres/Redis/worker run; signed recovery and actual VPS rollout. Issues #19–#23 and #25 remain open.

## P2-08: independently supplied scaffold and stricter mock QA (code-only)

The deterministic QA function now requires an **independently supplied,
trusted** `ScriptScaffold` before it may label a generated mock as
`acceptedForHumanReview: true`. The scaffold must come from a separately
reviewed operator configuration, never be copied uncritically from the
untrusted script. Without the independent input it returns
`trusted_scaffold_missing_or_invalid`, even for otherwise clean metadata.

For every unverified candidate claim the mock generator emits one scripted
section. QA now rechecks that every claim appears in exactly one corresponding
section, sections contain no extra keys, claim references are neither
duplicated nor foreign, the script envelope has only expected fields and the
narration matches the independently supplied format scaffold **byte-for-byte**.
Changing narration to inject an invented numerical claim is denied even if
the author adjusts reported token and mock-cost totals to be mathematically
consistent. Rejected/duplicated/foreign claim references also block triage.

This is a narrow **structural** guarantee about offline mock templates, not
semantic fact checking: a malicious or incorrectly approved scaffold could
still contain false claims, and an independently authenticated reviewer is
not yet enrolled. The flag is **only for subsequent human review**, not
publication. `approvedForPublication: false` is unconditional; no provider,
real news source, application database, queue or VPS deployment is activated.
Full independent AI QA, cited evidence, publisher rights, human identity,
revisions backed by production data, and end-to-end release acceptance remain
open under P2-07/P2-08.

## P2-08: independent review-task binding (code-only)

A valid independent scaffold is not enough to establish that a script belongs
to the actual review assignment. The structural QA now additionally requires
a separately approved `TrustedScriptReviewAssignment` containing **event ID,
format and language**. The caller must obtain this from its trusted editorial
assignment, not copy it from the script or its author. If the assignment is
missing, malformed or has extra fields, QA refuses review triage. If a script
switches to another otherwise valid template/language, or an event and script
ID are both swapped, QA also refuses triage even with mathematically correct
costs. Synthetic regression tests cover these cases.

This protects only metadata routing for an offline mock. It is **not** a
cryptographic assignment signature, independent factual evaluation, human
identity verification or a real script-review agent. Until independently
stored assignments and live reviewer authorization are integrated, QA can
only mark a matching mock as suitable for later human review, never for
publication. No deployment or external services are activated.
