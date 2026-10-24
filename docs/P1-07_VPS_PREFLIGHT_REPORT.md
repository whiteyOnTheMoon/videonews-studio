# P1-07 — Operator-supplied VPS preflight and staged activation proposal

**Status: read-only preflight evidence, NOT a deployment authorization.** Reported by the operator on 2026-10-24; no direct VPS access or independent live verification was performed by the assistant. The operator has chosen **no backups and zero backup budget**, but any experimental operation without backups still needs a **new, explicit activation approval**. All twelve recovery gates in [the existing plan](p1-07-recovery-plan.json) remain false.

## Evidence provided

- Ubuntu Linux kernel 6.8 on x86_64, up 73 days, low instantaneous load (0.20 / 0.48 / 0.53).
- Host memory: 7.8 GiB total, 4.6 GiB used and 3.2 GiB available at the instant measured; 2.0 GiB swap with 828 MiB used.
- Root filesystem: 116 GB total, 93 GB used, 23 GB free (**81% used**); inode usage 19%, so inode count is not the current issue.
- Docker 29.1.3 and Compose 2.40.3. Forty containers running across multiple independent projects at the snapshot. VideoNews web/API were healthy; its tunnel was running. VideoNews web, API and tunnel consumed about 58.2 MiB, 38.47 MiB and 15.26 MiB respectively (roughly 112 MiB total) in a single `docker stats --no-stream` reading.
- No VideoNews-specific PostgreSQL, Redis or worker container appeared in the operator-supplied running-container list; this is not proof that none exists stopped or under another name. The listed local volumes also contained no recognizable VideoNews PostgreSQL/Redis names; no volumes were inspected.
- `docker system df` reported 377 images (49.29 GB total, 31.82 GB potentially reclaimable) and 47.36 GB of build cache (17.11 GB potentially reclaimable). **Reclaimable estimates must not be summed**, and cleanup was **not** approved or performed.
- The checked-out VPS repository reported `7070098` with clean `git status --short` and a 1.7 MB working directory. GitHub `main` was `5d97ad19ff9a595712903ab28d30e8f0bd141f78` at preflight review. The live web/API use GHCR images and are **not proven to be built from the local checkout**. Do not interpret Git HEAD as the running container image digest.

## Resource budget — planning numbers, not tested reservations

The GitHub `compose.yaml` currently specifies PostgreSQL at 320 MiB / 0.4 CPU, Redis at 144 MiB / 0.3 CPU and worker at 768 MiB / 1.0 CPU. Together the container memory limits are about **1,232 MiB (1.20 GiB)** and CPU limits sum to 1.7 CPUs. Actual use, host contention, tmpfs use, Redis AOF, PostgreSQL WAL and other projects' spikes are **not measured by these limits**. The worker is strictly probe-only and does not render or research.

**Assessment:** Host RAM and instant CPU load make an isolated, guarded PostgreSQL/Redis preflight plausible. The 23 GB disk headroom and existing swap use warrant heightened caution; a successful `docker stats --no-stream` snapshot is not a load test. No automatic image/cache deletion or service activation is justified by these metrics.

## Confirmed repository blockers before any live start

1. **Worker uses a deliberate two-file Compose configuration.** The base `compose.yaml` does not provide `VNS_WORKER_ENABLED=true` or the `redis_password` secret, and **would fail closed if started alone**. The already checked-in, opt-in `deploy/compose.worker.yaml` supplies these settings, the worker-mounted password secret and Redis health dependency. This overlay must be deliberately included in a separately approved deployment, tested as a merged Compose configuration and paired with operator-provisioned matching Redis ACL/password credentials. `redis_acl` and `redis_password` are distinct files and may never be conflated. The overlay does not authorize running the worker.
2. PostgreSQL `postgres_password` and Redis `redis_acl` are file-backed secrets that require separately authorized provisioning and access control. Their values must never be shared in GitHub, chat logs or diagnostic output.
3. The live deployment uses GHCR images and a separately running Cloudflare tunnel, while the repository Compose scaffold declares local images and an optional Caddy ingress. Do **not** run a blanket `docker compose up`, `pull`, `build` or full-stack replacement over the existing live deployment.
4. The production runnable worker in `apps/worker/src/queue.ts` only accepts `probe` jobs. Do not activate editorial job dispatch or present the setup as full research/render/publishing functionality.

## Proposed stages, each requiring its own approval

1. **GitHub-only review and readiness:** verify both `compose.yaml` and the already available `deploy/compose.worker.yaml` together using existing CI-only readiness tests. Confirm their secret references and non-public networks; no activation or new secret provision is authorized. Keep profiles off on the VPS.
2. **Risk-acceptance/go-no-go:** explicitly acknowledge possible permanent loss of PostgreSQL/Redis/editorial state without backups, choose whether the scope is only disposable experimental data, and decide suitable disk/RAM monitoring/stop criteria. This is a deviation from the current backup-dependent recovery gate; do not flip gate booleans or call the installation fully recoverable.
3. **Operator-approved deployment plan:** name exact services, tested image digests, secret creation/custody, SQL migrations, ingress isolation, storage volumes, healthchecks and staged stop/reversal steps. Account for existing Web/API/tunnel and other projects.
4. **After a _separate_ specific approval**, introduce _only_ isolated data services, verify PostgreSQL/Redis health and resource trends, and stop if capacity or access controls are unsafe. Preserve existing volumes even if rollout is aborted.
5. **Additional approval** is required before any worker launch, editor identity enablement, API data flag, public route change or external publication. Never enable an editorial worker against production data while it is probe-only.

**No backup means no guaranteed rollback of data:** stopping a newly started service, disabling flags and returning to a previous image can revert software behavior but cannot reconstruct deleted/corrupted database state. Never run `docker compose down -v`, `docker volume rm`, `docker system prune` or destructive migration as part of an automatic rollback.

## Next requested operator approval (not granted)

After GitHub-only readiness fixes and an explicit no-backup experimental risk acknowledgement, present a bounded plan for **isolated PostgreSQL + Redis only**, leaving Web/API/Cloudflare and worker unchanged. Require the operator to explicitly approve that precise deployment before giving state-changing commands. Existing approval covers read-only checks only.

The worker overlay is described in [backend readiness](P1-07_BACKEND_READINESS.md) and is separate from the repository-only base Compose recovery inventory. A green CI configuration test is not evidence that live VPS secrets exist or that the live GHCR deployment uses the reviewed Compose definitions.

See [operator no-backup decision](P1-07_OPERATOR_NO_BACKUP_DECISION.md), [recovery inventory](P1-07_RECOVERY_INVENTORY.md) and [full recovery runbook](P1-07_RECOVERY_RUNBOOK.md).
