# P2: Safely gated feed observation (not a production rollout)

**Status: dormant, code-only.** No VPS change, timer, feed call, AI call, publisher rights or publication approval is part of this change.

## What is implemented

The standalone `apps/worker/src/feed-observe-once.ts` can execute **one** operator-approved feed tick using the real DNS-pinned HTTPS adapter, reviewed file registry, a dedicated PostgreSQL LOGIN and Redis ACL user, and an isolated BullMQ queue. It emits only aggregate results and closes resources. `feed-runtime-admission.ts` rejects unapproved runs *before* reading secrets or opening connections. It requires ten affirmative operator/feature gates, `single_pass` mode, fixed secret paths, restricted service hosts, and an explicit host allowlist. PostgreSQL proves its actual `session_user` is the intended limited login: polling functions available; candidate SELECT, projection, editor UPDATE, DDL, superuser and replication denied. CI tests this against a disposable real PostgreSQL role.

The optional `compose.feed-observation.yaml` is **never included automatically**. It has `restart: no`, no published ports, read-only filesystem, capabilities dropped, separate egress network, bounded resources and three runtime secrets. The regular worker, research service and API entrypoints remain unchanged and never mount this runner.

## Manual approval requirements before any real run

1. Independently review and approve 3–5 real sources: exact feed URLs, rights/ToS/robots, polling frequency, provenance, DNS/TLS and availability. A source's `approved` text and an environment acknowledgement are **not** independent rights evidence.
2. Create one new non-superuser PostgreSQL LOGIN matching `vns_feed_login_...` with membership **only** in `vns_feed_poll_writer` and prove privileged functions, direct candidate reads and admin/editor operations are denied. Create a distinct Redis ACL user `vns_feed_...`, scoped to `bull:vns:feed:*`, and prove it cannot access the probe/research queues.
3. Provision non-repository Docker secrets locally with restrictive access: `secrets/vns_feed_db_password`, `secrets/vns_feed_redis_password`, `secrets/reviewed_research_sources.json`. Passwords must be long random values; never paste them into GitHub/chat/logs. Admin-approved source revisions must be safely exported to the file; that export is **not** automated by this PR.
4. Complete offsite restore, key custody, monitoring/alert delivery, PostgreSQL migration rehearsal, independent audit signing, personally authenticated admin acceptance and immutable image-digest verification.
5. Obtain **separate operator consent for a specific release SHA**, source set and network access before combining `compose.yaml` and `compose.feed-observation.yaml` with the `data` and `feed-observation` profiles. The observer remains disabled unless all environment gates are deliberately set. The single observation must be reviewed before authorizing another one. Any failure means stop, revoke gates, and use the separately approved rollback/restore procedure.

## Not yet done

There is no automated periodic scheduler, operational rate/error alerting, real source rights attestation, live VPS acceptance, Admin→file registry synchronization, personally provisioned editorial database broker, independent claim verification, real QA second agent, full profile/ranking/risk Admin UI, external audit-chain anchoring or complete production timeline export. P2-01 through P2-10 must remain open until their original operational acceptance criteria are met. Synthetic CI green is not operational proof.
