# P2-04: Controlled local BuildKit app build (internal images only)

This operator tool builds API and Web from the reviewed source SHA into
local Docker tags, **without uploading or deploying images or publishing
any editorial content**. It does not start or replace running project
services. It is a separate plan from the prior unbounded 4 GiB build gate.

## Resource and security boundaries

- The executable operator is ap (UID 1000); main is clean and exactly
  pinned; the Git index has strict ownership and mode 0600.
- A new builder using the Docker container driver is limited to 2048 MiB
  RAM **including** a 2048 MiB total memory-plus-swap limit. Consequently,
  it cannot use additional swap. Its BuildKit TOML limits parallelism to 1.
- Before each stage, the host must have at least 16 GiB free Docker disk,
  3500 MiB MemAvailable and 256 MiB SwapFree. Insufficient capacity aborts
  without reducing the thresholds or switching to an unlimited builder.
- The helper checks all five existing container identities and start
  timestamps before and after the build. It never calls Compose up/down,
  container stop/restart, Docker push/login or any publication endpoint.
- Target images are locally tagged by commit SHA and checked for the exact
  OCI revision. They are not started. A catchable failure removes only
  the newly created dedicated BuildKit builder. Loaded images are preserved.
- The Docker engine may download a missing BuildKit builder and the pinned
  Node.js base images from Docker Hub; npm may download build dependencies.
  These are dependency downloads, never uploads of the project images.
- Node/Next.js may exceed the 2 GiB cap. Treat any OOM or unexpected failure
  as a stop condition, not an invitation to enlarge memory limits.

## After independently verified review and merge

Synchronize the reviewed new SHA to the VPS and run:

    bash scripts/p2_04_bounded_local_app_build.sh --expected-sha EXACT_MAIN_SHA

Do not use the previous main SHA. The script loads, but does not deploy,
local vns-api and vns-web images. Existing digest-pinned GHCR images and
secrets remain available.

After successful loading, a **separate** controlled Web/API-only cutover
must preserve the five existing Compose overlays and their order.
Render and inspect the full Compose configuration before deployment,
preserve the current API/Web digests for rollback, and ensure no other
services or host ports are changed. Personal Admin sign-in, inbox rows,
HTTP failures and cache behavior require independent browser acceptance.
NO editor-facing publishing or video-release operation is authorized.
