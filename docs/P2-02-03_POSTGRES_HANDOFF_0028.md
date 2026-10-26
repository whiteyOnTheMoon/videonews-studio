# P2-02 → P2-03: Dormant PostgreSQL candidate projection (migration 0028)

**Evidence scope:** disposable, actual PostgreSQL database migration and rollback, SQL idempotency and privilege tests; TypeScript adapter unit tests. This is *not* a VPS rollout or a live-source acceptance.

The feed poller in migration 0019 persists unverified metadata to `vns.feed_poll_candidates`. Migration 0028 adds `vns.project_feed_candidates(source, limit)` to project eligible dated, canonical HTTPS candidate rows into the existing migration-0026 `vns.research_articles`, `vns.research_events` and `vns.research_event_articles` tables in a single database statement. The process is idempotent; bounded calls skip articles already linked and resume on the next candidate batch. It does not create claims or mark articles verified.

The implementation intentionally uses a conservative SQL normalized-title SHA-256 for **exact SQL metadata grouping only**. It is not equivalent to the richer worker lexical candidate-clustering helper, does not infer source independence, does not merge different rewritten headlines semantically and never automatically approves publication. Already-registered URLs with inconsistent source, fingerprint or timestamp are left unchanged rather than overwritten, pending manual conflict handling. Undated, future-dated, query-string URLs and articles already linked to an event are excluded.

**Privileged boundary:** `vns_feed_project_executor` is NOLOGIN/NOINHERIT, receives only metadata SELECT and article/event/link SELECT+INSERT, owns the SECURITY DEFINER function and is *not* granted to a runtime login. Function EXECUTE is revoked from PUBLIC, including the feed writer and API runtime. There is no scheduler, Docker container, timer, new database login, secret or deployment. The optional `DormantFeedCandidateProjector` has separately required opt-in flags, an injected pool, bounded parameterized SQL and redacted errors, but is not imported by any running worker.

The isolated CI migration harness executes migration 0028 up + its SQL tests, then down, twice, together with existing prior migrations. Rollback deletes the disposable function and role, **not** any research articles. Production database rollback or migration **must never** be performed using this CI-only sequence without an approved backup and migration-specific operational plan.

## Remaining acceptance blockers

- Approved rights and host allowlists with independent custodians (#16), named minimal-login database users, true source-to-poll admission, independent monotonic revision anchors and restored signature keys.
- A real deployed, paused scheduler/queue/worker pipeline including Redis and PostgreSQL recovery and privilege tests (#17).
- Stable persisted event identities across article revisions; source syndication/provenance; different-headline semantic grouping, ambiguity review and publication gate (#18).
- Persisted ranking, identity-bound claim verification, freshness rechecks, versioned script/QA and timeline export (#19–#25).
- Offsite restore (#228), alert delivery (#229), repo governance (#2), and separate VPS rollout approval.

**All P2 issues stay open** until their independent original acceptance criteria are met.
