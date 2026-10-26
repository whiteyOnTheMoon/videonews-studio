# P2-01 – Independent host approval and dormant source export

This PR adds a **pure, unmounted export preparation and reader contract** within the worker workspace. It has **no filesystem IO, network IO, database connection, queue, activation flags or runtime imports**. No actual publisher is registered.

The source Admin database snapshot is not permission to fetch. A second separately trusted and personally audited host approval snapshot must name exactly the hosts of currently approved sources. Extra host grants and approved sources whose hosts lack independent approval fail closed. The worker file remains in the strict existing `version:1` format. `pending` and `blocked` entries are included for approved hosts, preserving the longest-path deny override; entries for unapproved, pending-only hosts are omitted. Entries are validated before filtering, to prevent hiding malformed database records.

The deterministic export bundle carries source revision, host-approval revision, a sorted host list, v1 registry JSON and an integrity SHA-256. SHA-256 is **NOT** a signature or source of authorization. The reader additionally requires an independent trusted host policy and monotonic revision checkpoints. These are explicit interfaces, not a working publication mechanism. The existing worker entrypoint remains file- and environment-gated with its separate host allowlist.

Still missing before live deployment: a personally authorized and audited host-approval admin workflow, an authenticated DB snapshot reader, a sealed/atomic publication writer and consumer with durable monotonic revisions and real restore tests, independent host/URL rights review, and feed Scheduler acceptance under #17. Do not take a source status of `approved` to mean the ToS permits ingestion.

No VPS change, production DB login, real feed, secret, timer or paid API activity.
