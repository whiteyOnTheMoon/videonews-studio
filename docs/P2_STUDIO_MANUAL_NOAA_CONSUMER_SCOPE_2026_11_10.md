# P2: Studio manual NOAA-only consumer scope (code only)

**No production activation or authorization.** This narrowly scoped proposal keeps the
full signed-source registry and all existing source/host/anchor/database checks unchanged.
It allows only the already approved NOAA RSS metadata source to be polled by the
existing persistent **consumer** when a separate, exact runtime gate is enabled.

## Observed baseline

Production main `d33612d629901e63713ffa2453446a9d8ee0d613` has:

- NOAA one-shot successfully completed with two added candidates.
- 20 NOAA candidates, 18 projected, two old and outside the editorial age window.
- Four completed and six historical failed BullMQ jobs, no pending/repeating jobs.
- Correct running Web/API image references; no Studio producer/status secret mounts;
  no persistent feed consumer.
- All Studio producer/status flags false. Do not change these as part of this PR.
- Existing persistent worker insists on a three-to-five approved-source registry.
  A normal unselected tick polls all three approved sources. Historical NASA
  response size and USGS redirect behavior make unattended multi-source
  activation unsuitable without further scoped verification.

## New strictly optional consumer selection

`VNS_FEED_STUDIO_NOAA_ONLY_ENABLED=true`,
`VNS_FEED_STUDIO_NOAA_ONLY_OPERATOR_ACK=NOAA_STUDIO_MANUAL_METADATA_ONLY_CONSUMER_APPROVED`,
`VNS_FEED_STUDIO_SOURCE_ID=noaa_news` are required **together**, with
`VNS_FEED_RUNTIME_MODE=persistent_worker`, enabled restricted consumer gates and
`VNS_FEED_SOURCE_BOOTSTRAP=false`.

A partial or mismatched gate fails before protected file or network operations.
The existing single-pass canary flags remain forbidden in persistent mode.
The full signed source registry must still include 3–5 approved sources;
the new selector merely restricts _which signed and current SQL-approved source_
the poller can claim/fetch in the one job. NASA/USGS are not selected.
The producer carries no URLs/source IDs, and the slot remains unique with
one attempt and retained history.

## Required work before any live activation

- Review and pass new and existing Worker test suites and isolated PostgreSQL/
  Redis CI; inspect compiled pinned image identity and publish a separately
  authorized new immutable Worker image (never build on the constrained VPS).
- Provision **distinct** least-privilege Studio producer and status Redis ACLs,
  independent protected secrets, and verify isolated ACL commands and key scope.
- Prove exact gated consumer mounts, healthy process and controlled stop; no
  standalone feed producer, scheduler or observer may run concurrently.
- Check remaining disk, external backup/isolated restore, rights and source leases.
- Prove candidate-to-editorial projection separately; successful queue completion
  does not imply that newly polled candidates appear in the Studio inbox.
- Obtain separate operator permissions for secrets/ACL writes, Web/API deployment,
  worker startup, and each bounded manual live-feed test.

This change does **not** turn on Web/API flags, create a Redis job, start Docker,
modify PostgreSQL, execute an RSS GET, project candidates, render, or publish.
