# P2-04 to P2-08: conservative offline editorial integration and checkpoint audit

This feature adds a deterministic source-provenance-aware ranking function, bounded mock script scaffolds for **briefing, analysis and explainer**, and an independent structural QA path. Sources, publication groups, scoring weights, blocked terms, language-specific text scaffolds, format and budgets are **injected configuration**. No news provider, live feed, AI key, price schedule or production profile is built in.

The ranking distinguishes **publisher groups** from mere source IDs. Unknown publisher provenance, blocked topics, stale/future articles and unapproved rights block scoring. Passing the metadata gate **does not attest to true publisher independence** or source truth.

The script provider is a purely deterministic **offline mock**. It never writes new factual prose from headline content: each generated section contains administrator-supplied scaffold text and an explicit candidate claim reference. Revision count, character count, mock token and cost budgets are enforced by the generator. **The separate structural checker also requires its own trusted `ScriptLimits` input**: it recomputes the actual character/token counts and exact mock micro-USD cost from the script's narration, checks the independently configured limits and revision ceiling, and refuses malformed or tampered estimates before allowing even human-review triage. The checker does not trust a script's own claims about its budget. It detects missing references, stale metadata, disputed/rejected claims, rights omissions and simplistic verbatim headline reuse. It is deliberately **not** a semantic verifier, legal opinion or independently authenticated human reviewer. Every report has `approvedForPublication: false`, even when suitable for human review.

## Migration 0030: durable personally attributed checkpoints

A new append-only PostgreSQL table records bounded digest-only metadata for stages `ranking`, `claim_review`, `freshness`, `script_revision` and `quality`. Records are CAS-versioned per event and hash-chained inside the database. The only callable write/read functions require DBA-approved **personal PostgreSQL session_user** mapping from migration 0029, active accounts and role checking. QA requires a reviewer distinct from the latest script author. Outcomes cannot be `approved` or `published` under the schema.

No full article text, prompts, secrets, API outputs or protected source content are inserted into the checkpoint ledger: only artifact SHA-256 digests, limited reason codes, optional numeric score, actor and immutable chronology. The hash chain is **not independently anchored** and a database owner/superuser may still undermine it; offsite independent monotone anchoring remains a separate security requirement.

A default-disabled `DormantEditorialCheckpointStore` injects an existing PostgreSQL client and only uses parameterized SQL. **Do not** inject the shared API database connection: it would represent a shared `session_user`, not a personally authenticated reviewer. An operational login/connection broker, secret custody and Admin web integration remain unimplemented until independently reviewed.

CI uses synthetic article data and isolated PostgreSQL role/auth-version, revision, independent QA, chain and rollback tests. No VPS migration, real news fetch, AI payment or publishing occurs.

## Unmet acceptance criteria

Real independently verified publisher provenance and rights; semantic/foreign-text and fact verification; authenticated source checking; attribution for externally generated scripts; independent provider integration; native Admin screens for policy, decisions and export; production story-to-event linkage; external immutable audit anchoring; personally authenticated PostgreSQL connection brokering; real fully wired Postgres/Redis/worker run; signed recovery and actual VPS rollout. Issues #19–#23 and #25 remain open.
