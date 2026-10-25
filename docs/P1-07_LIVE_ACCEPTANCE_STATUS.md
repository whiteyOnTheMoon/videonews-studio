# P1-07 — Live infrastructure acceptance and residual gaps (2026-10-25)

**Evidence class:** Operator-supplied VPS console output, not direct SSH access by the assistant. **Disposition: experimental probe-only stack is operational; full P1-07 and disaster-recovery acceptance remain OPEN.**

## Confirmed live on the VideoNews VPS

1. **Isolated data services:** PostgreSQL 17 and ACL-protected Redis 7 launched under the VideoNews Compose project, healthy, with no host-published database ports. Web/API and Cloudflare continued running; other co-hosted projects were not recreated.
2. **Persistent schema:** The reviewed fresh-cluster migration bootstrap applied and subsequently listed migrations `0001`–`0011`. An independent read-only audit reported `11` migration rows and zero editorial jobs, zero outbox intents and zero operator registry accounts.
3. **Redis security:** Anonymous PING returned `NOAUTH`. Named `vns_worker` password and ACL hash matched, allowed `bull:vns:*` reads succeeded, foreign namespace reads were denied.
4. **Worker activation:** The separate `Dockerfile.worker` compiled a probe-only image, which was started as `videonews-studio-worker-1`, with concurrency 1, an internal-only network, no published worker ports, and the reviewed Git revision label.
5. **Live queue proof:** Exactly one harmless `probe` job (`p107-live-one-time-probe`) ran to `completed`. The stored result (`{ok:true}`), one attempt, correct payload and retained BullMQ entry were read back and validated without enqueueing another job. The subsequent bounded queue inventory confirmed exactly one completed probe, no waiting, active, delayed, prioritized or failed work.
6. **Controlled worker restart:** On the operator's VPS at checkout `2989974` (PR #148), preflight passed, **only the existing probe worker** was restarted. It emitted fresh authenticated readiness (`concurrency: 1`). The pre/post audit confirmed the same completed probe, no unfinished jobs, unchanged SQL ledger and unchanged container identities/start times for PostgreSQL, Redis, Web, API and Cloudflare. This proves an **idle worker-only restart with Redis running**, not recovery after database/Redis failure.

**Last observed resources following the restart:** root disk 116 GB total / 93 GB used / **24 GB free (80% used)**; available RAM **3.0 GiB** of 7.8 GiB; swap use about **830 MiB** of 2.0 GiB. Resource readings are operator snapshots, not capacity guarantees.

## Operator follow-up evidence: replayed controlled restart and read-only receipt (2026-10-25)

The operator supplied two terminal transcripts in chat, **not** direct assistant SSH observations:

1. At checkout `2989974`, `scripts/p1_07_worker_restart.sh preflight` reported PASS; then `scripts/p1_07_worker_restart.sh restart` restarted **only** `videonews-studio-worker-1` and reported PASS for unchanged dependencies and the retained probe. `scripts/p1_07_worker_canary.sh status` passed. The probe-only queue was idle, the one previously completed probe remained intact, PostgreSQL had 11 migrations, 0 editorial jobs, 0 outbox records and 0 operators, and Redis ACL checks passed. This repeats/clarifies the earlier controlled idle restart evidence; it is **not** Redis or PostgreSQL crash recovery.
2. The operator then fast-forwarded `main` from `2989974` to `03ec275` and executed **only** `scripts/p1_07_live_probe_receipt.sh`. It reported PASS for authenticated Redis, existing retained completed probe, isolation and unchanged PostgreSQL counts. **No additional restart or enqueue** was performed by this second command.

The displayed resource snapshot after the restart showed root volume **116 GB**, used **93 GB**, available **24 GB** (**80%** occupied); memory **7.8 GiB** total, **3.0 GiB available**; swap **2.0 GiB** total, **830 MiB used**. These are historical observed values, not current capacity guarantees.

**Evidence scope:** The successful operator checks confirm the existing probe-only deployed service and retained test record. They do **not** establish editorial outbox dispatch, status reconciler deployment, actual research/render/upload handlers, least-privilege SQL runtime access, offsite backup or restore. The operator transcripts are secondary evidence (no signed archive or direct independent inspection). Retain issues #7 and #87 as open.

## Acceptance matrix (do not overstate the evidence)

| Dimension                       | Current verified scope                                                                     | Still not verified or intentionally disabled                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data deployment and credentials | Live PostgreSQL/Redis with private network, healthy endpoints and Redis ACL                | Independent database restore, RPO/RTO, independent backup, real least-privilege SQL runtime LOGIN deployment                                                        |
| Database migrations             | 11 applied, empty editorial ledger at audit                                                | Production editorial job inserts, real service DB login and active API data integration                                                                             |
| Queue/worker                    | One harmless probe completed, retained and safely observed; concurrency 1                  | Real research/script/render/upload/publish worker handlers (runnable worker rejects non-probes)                                                                     |
| Restart and retries             | Targeted idle probe-worker restart passed; synthetic CI exercises bounded retries/failures | Live interrupted or stalled editorial work, cross-store recovery and external-effect idempotency                                                                    |
| Outbox dispatch                 | PostgreSQL schema/functions and opt-in dispatcher implementation exist; offline tests      | **Dispatcher not started**; no real PostgreSQL-to-Redis editorial deliveries. Starting dispatcher while worker only handles probes would enqueue unsupported kinds. |
| Status synchronization          | Opt-in status reconciler code and offline tests exist                                      | **Status reconciler not started**; no real PG↔BullMQ editorial state transition proven                                                                              |
| Operator access/audit           | API/browser design and database roles documented; registry empty                           | Named live editorial account onboarding, operator audit continuity, enabled feature flags                                                                           |
| Recovery                        | Disposable CI recovery rehearsal and operator no-backup risk decision                      | No off-VPS backup, complete restore test, signed independent audit archive or recoverability signoff                                                                |

## Decisions, limits and next steps

- **Existing permission:** On 2026-10-25, the operator expressly authorized P1-07 experimental deployment/container operations despite **no backups** and **0 € backup budget**. Potential permanent loss of accumulated SQL/Redis/media/audit state is accepted. This **does not** convert any of the **twelve** full-recovery gates from false to true or authorize fabricated restore evidence.
- **Do not rerun** the single-use live probe enqueue or delete its retained BullMQ record. Read-only receipt checks are repeatable. Never prune Docker caches/images or delete volumes to solve resource constraints.
- The old general prohibition on any P1-07 data/worker VPS startup has been **superseded for the explicitly approved experiment**, but ongoing enablement of unsupported editorial processing is blocked by technical limitations, not merely operator permission.
- **Next engineering work:** build an explicitly safe, testable _editorial_ worker handler and its service-side identities / authorization boundaries before enabling PostgreSQL outbox dispatcher and status reconciler. Require synthetic end-to-end tests with denial/retained failure, bounded attempts, replay/idempotency and operator-visible failed-job status. Keep publication and external side effects off until they have dedicated protections.
- Keep [issue #7](https://github.com/whiteyOnTheMoon/videonews-studio/issues/7) and [issue #87](https://github.com/whiteyOnTheMoon/videonews-studio/issues/87) open for full acceptance. Do not call a passed probe/restart a complete job-processing pipeline.
