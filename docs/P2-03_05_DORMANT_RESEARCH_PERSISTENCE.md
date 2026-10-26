# P2-03 to P2-05 — Dormant editorial research persistence

Migration 0026 adds normalized article metadata, exact-fingerprint event groups, article-event membership, unverified claims and claim-to-article evidence references. It enforces canonical URL uniqueness, bounded metadata, foreign-key integrity and **no `verified` state** in this offline persistence layer. The default is unverified. Disposable PostgreSQL migration/rollback tests exercise duplicates, evidence linkage, default status and denied runtime write privileges.

This does not implement semantic or syndicated event deduplication, independent source verification, evidence excerpt provenance, immutable reviewer signatures, genuine article-freshness checks, ranking persistence, Admin UI, live news polling or production storage privileges. No background migration, worker mount, feed activation or rollout is performed. Issues #18–#20 remain open.
