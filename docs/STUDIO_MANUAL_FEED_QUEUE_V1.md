# Phase B – Operator-gated manual P2 feed slot from Studio (source-only)

This increment provides a **default-off** authenticated action:
Studio → Next.js BFF → API producer-only Redis ACL → existing `vns-feed-poll` BullMQ queue → separate P2 consumer → signed-source HTTPS/SQL policy. Browser inputs never select a source, URL or slot, and Web/API do not perform external feed HTTP requests or source database writes.

## Security and source scope

- Web feature gate: `VNS_WEB_STUDIO_FEED_REFRESH_ENABLED=true`. The BFF requires current administrator session, named administrator-editor session, same-origin POST and no browser-supplied request body.
- API gate: `VNS_STUDIO_FEED_REFRESH_API_ENABLED=true` plus `VNS_STUDIO_FEED_REFRESH_OPERATOR_ACK=true` and active admin/editor gates.
- Producer-only Redis: `VNS_STUDIO_FEED_REDIS_HOST=redis`, `VNS_STUDIO_FEED_REDIS_USER=vns_feed_producer_...`, and `VNS_STUDIO_FEED_REDIS_PASSWORD_FILE=/run/secrets/vns_studio_feed_producer_password`. Must provision a new narrowly scoped ACL granting exactly the queue producer operations; do not reuse root or consumer credentials. Secret file must be single-link, regular, expected owner and private mode.
- `VNS_FEED_SOURCE_BOOTSTRAP=false` is mandatory. No source bootstrap or signing grants are available to Web/API.
- Existing isolated queue identity: name `vns-feed-poll`, prefix `bull:vns:feed`, deterministic 15-minute job ID, one attempt and retained completed/failed records. Repeated clicks inside the same slot cannot produce different job IDs. Existing consumer reattests current source/host grants, signed export, trust anchor, restricted database identity and source poll lease. No worker, schedule or renderer is activated by the code change.
- Response `202` confirms only queue submission, **not** newly fetched results, processing success, freshness or fact verification. Existing private inbox remains the view of previously persisted articles; the UI states this explicitly. None of these candidates becomes renderable or publishable by submitting the job.

## Separate live-operations authorization required

This source-only merge does **not** authorize VPS Docker updates, Redis ACL changes, mounted credentials, a consumer start, migration 0065 or live HTTP requests. Before operator-approved activation, check and document the dedicated producer credential/ACL, current signed source approvals and rights, P2 consumer health, queue/idempotency state, capacity, backup/restore posture and exact digest-pinned API/Web image IDs. Keep unrelated Docker containers untouched. Never rebuild on the overloaded VPS or render video in GitHub Actions.

A later increment must expose independently verified durable per-slot completion/failure and persistently fresh feed-page reconciliation before the Studio can claim the full 'click → current researched news' acceptance criterion. Do not claim a completed live research pass from queue acceptance alone.
