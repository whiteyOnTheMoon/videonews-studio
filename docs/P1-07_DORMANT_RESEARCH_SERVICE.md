# P1-07 – Dormant isolated research service

This change adds **code only**. It does not modify any running VPS service,
start a worker, schedule work, approve any news provider, or authorize external
network access. It must not be used to claim full editorial pipeline acceptance.

## Separation from the live probe

The running probe worker consumes `vns-jobs`. The new research-only CLI
`npm run research-service --workspace @vns/worker` is programmed to consume
**only `vns-research`**, a different BullMQ queue. The opt-in outbox dispatcher and status reconciler now require an explicit
`VNS_EDITORIAL_QUEUE_NAME=vns-research` plus a separate
`VNS_RESEARCH_OPERATOR_APPROVED=true` flag and their own component gates.
Missing these flags blocks startup; they can no longer route editorial jobs to
the probe queue `vns-jobs`. The SQL/Redis end-to-end lifecycle for this new
queue is exercised only inside disposable CI fixtures. This does not authorize
operational use or deployment.

No Docker Compose profile or deployed container starts the new entrypoint.

## Explicit source and activation gates

The service refuses to start unless all the following are set **exactly**:

- `VNS_RESEARCH_WORKER_ENABLED=true`
- `VNS_RESEARCH_OPERATOR_APPROVED=true`
- `VNS_WORKER_ENABLED=true`
- `VNS_PG_RUNTIME_IDENTITIES_ENABLED=true`
- `VNS_SOURCE_FETCH_ENABLED=true`
- `VNS_RESEARCH_QUEUE_NAME=vns-research`
- `VNS_RESEARCH_CATALOG_FILE=/run/secrets/approved_research_sources.json`

Existing mandatory settings also apply: dedicated research Redis secret mounted at
`/run/secrets/redis_research_password` with `VNS_REDIS_RESEARCH_PASSWORD_FILE` set to that exact path, research-writer-only database secret at
`/run/secrets/pg_research_writer_password`, and explicit
`VNS_ALLOWED_SOURCE_HOSTS` (1–5 approved HTTPS hosts). No owner DB password
or source-provider API credential is accepted.

The catalog is **operator-supplied and not part of this repository**. It must
be injected as a separately reviewed, private read-only file. Example schema
with placeholders, not approved hosts:

```json
{
  "version": 1,
  "topics": [
    {
      "topic": "Specific approved editorial research topic",
      "candidates": [
        {
          "sourceUrl": "https://www.example.org/reports/example",
          "publisher": "Example Organization",
          "headline": "Approved publication title",
          "claim": "An unverified candidate claim for editorial inspection."
        }
      ]
    }
  ]
}
```

This example is **not** an authorization to contact example.org. A source is
eligible only if its full HTTPS URL appears in the exact-topic catalog and its
hostname is in the explicit host allowlist. The catalog allows at most
10 exact topics and 1–3 candidates per topic, with strict field bounds and no
extra fields; unknown topics fail rather than triggering automatic discovery.
Network fetching uses the existing DNS/IP pinned HTTPS implementation with
size, type, redirect, and deadline limits. Fetch results become
`candidate` evidence only; no claim is automatically verified or published.

## Limits and future acceptance

The research CLI creates a pool authenticated as
`vns_research_writer_login` with only its dedicated password, runs
concurrency 1, and never writes review verdicts or media. The worker is
instantiated dormant (`autorun=false`) and is run only by the dedicated
explicit entrypoint. It redacts connection failures.

There is **no approved sources catalog on the VPS**, no reviewed outbound
network arrangement or deployed Redis ACL proof for `vns-research`, and no
separate operator approval to activate the CLI, dispatcher or synchronizer. The current backend network is intentionally internal and
cannot be assumed to provide outside HTTPS access. Do not deploy or run this
entrypoint on the VPS yet.

CI tests use only local JSON and mocked source metadata. They do not contact
any news website or run live production jobs. Full P1-07 recovery and backups
remain unverified.

## P1-07 isolated dispatch and status routing (CI-only)

The existing dispatcher and reconciler now fail closed unless their individual
component enable flag, `VNS_RESEARCH_OPERATOR_APPROVED=true`, and the exact
`VNS_EDITORIAL_QUEUE_NAME=vns-research` are all set. They still require
distinct PostgreSQL runtime logins and the dedicated `vns_research` Redis
identity with its own `redis_research_password` secret. No CLI
can choose the active probe queue via environment flags. The optional Compose
overlay leaves each service OFF and the operator-approval flag set to false.

The existing disposable research E2E now exercises authenticated scoped
PostgreSQL outbox → `vns-research` BullMQ → isolated dormant research worker
→ evidence candidate / bounded failure → PostgreSQL status. It checks that
the corresponding IDs do not appear in `vns-jobs` and that probe queue counts
are not changed. These are **not** VPS jobs, real news retrieval or deployment.

Before any future live authorization, explicitly check that Redis ACL grants
only the required isolated queue keys and that the operator-approved network
policy permits only the approved HTTPS source hosts. No public port, Compose
restart, DB writes, backup changes or production research runs are part of
this PR.
