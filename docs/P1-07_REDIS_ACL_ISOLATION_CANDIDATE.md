# P1-07 – Redis ACL isolation candidate (offline only)

This branch introduces a **pure, offline ACL candidate renderer**, not an
operational migration. The existing `provision_redis_secrets.py`, local secret
files, running Redis, worker, dispatcher, and Compose deployments are unchanged.

The proposed key/channel namespaces are:
- Probe: `vns_worker` → `bull:vns:vns-jobs:*`
- Research: `vns_research` → `bull:vns:vns-research:*`

Passwords must be independent. No password or hash is stored in the repository.
The current production ACL still uses `~bull:vns:*` and must not be silently
replaced by this candidate. The generator rejects identical credentials.

## Required before rollout

1. Run offline unit tests with `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_research_redis_acl.py' -v`.
2. Test the candidate against disposable Redis/BullMQ with real worker, Queue,
   QueueEvents, dispatcher and status-sync command paths. Verify both positive
   lifecycle behavior and **NOPERM** on cross-queue keys and channels.
3. Inspect BullMQ auxiliary keys, pub/sub channels, scripts and Redis versions.
   Tighten command categories and key patterns where proven safe.
4. Change application credentials to select named identities per service,
   and provide new secrets with separate approval. Current `readQueueConfig`
   still uses `vns_worker`; this branch does **not** wire live research auth.
5. Prepare backups, a tested rollback, secret permissions, operational
   monitoring and a maintenance window. Obtain explicit operator approval.
6. Only after all gates, perform a separately reviewed production migration.

Do not copy this ACL into the live secrets directory or run `ACL LOAD`.
No publishing, external source fetch or production research work is authorized.
