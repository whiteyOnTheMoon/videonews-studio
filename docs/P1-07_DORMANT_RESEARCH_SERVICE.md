# P1-07 – Dormant isolated research service

This change adds **code only**. It does not modify any running VPS service,
start a worker, schedule work, approve any news provider, or authorize external
network access. It must not be used to claim full editorial pipeline acceptance.

## Separation from the live probe

The running probe worker consumes `vns-jobs`. The new research-only CLI
`npm run research-service --workspace @vns/worker` is programmed to consume
**only `vns-research`**, a different BullMQ queue. The existing outbox
dispatcher and status synchronizer still target `vns-jobs`, **not**
`vns-research`. Accordingly this is deliberately not yet a working end-to-end
production dispatch configuration. Future routing and status tracking changes
require a separate PR and acceptance of queue isolation before starting anything.

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

Existing mandatory settings also apply: individual Redis secret mounted at
`/run/secrets/redis_password`, research-writer-only database secret at
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
network arrangement for the new service, no independent queue routing/status
synchronization for `vns-research`, and no separate operator approval to
activate this CLI. The current backend network is intentionally internal and
cannot be assumed to provide outside HTTPS access. Do not deploy or run this
entrypoint on the VPS yet.

CI tests use only local JSON and mocked source metadata. They do not contact
any news website or run live production jobs. Full P1-07 recovery and backups
remain unverified.
