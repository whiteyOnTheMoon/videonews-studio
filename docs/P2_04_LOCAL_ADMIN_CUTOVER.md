# P2-04 – Private API/Web cutover to the local news inbox images

**Technical deployment only. Publishing news, videos, posts or other
editorial content remains strictly forbidden.** There is no feed request,
publisher job, media upload, registry push or public routing change.

## Existing VPS evidence

- Current source release used to build the two local images:
  6b7902c93d8c05efc7d97affe8fcf17ef268a6fc.
- New API: vns-api:internal-6b7902c93d8c; exact image configuration
  SHA256:473c3c994957d368a5eadec16502908e72358655f1c9925fec9643cc3aac424a.
- New Web: vns-web:internal-6b7902c93d8c; exact image configuration
  SHA256:75e2f6156a20061d73644857c193a8ea52fff0517576a6a8cdd66f82f219ea9a.
- Existing Web and API are healthy and digest-pinned in private GHCR;
  their **prior** digests and image IDs are built into the operator helper
  solely for exact match and rollback. Existing PostgreSQL 0063 has passed
  a read-only status check. Redis and the placeholder Worker remain running.
- Compose overlays in their observed exact order: compose.yaml,
  deploy/compose.images.yaml, deploy/compose.admin.yaml,
  deploy/compose.provider-admin.yaml,
  deploy/compose.personal-editorial-admin.yaml.

## What the helper verifies

- Clean exact current operator Git SHA under ap (UID 1000), strict
  0600 Git index and ancestry from the existing **image** release SHA.
  It does NOT falsely require newly built app images to be from the later
  deployment-helper-only commit.
- Existing live Web, API and PostgreSQL healthy and all five named
  app/data/worker containers running under the expected Compose project.
- Exact old Web/API GHCR digest and image ID; exact new local Web/API
  image IDs, architecture, and OCI source revision.
- All five actual Compose overlay paths, no host-published ports,
  no new build steps or pulls, expected private networks, read-only rootfs
  and dropped capabilities.
- Active feature flags, existing exact HTTPS Admin origin and the
  root-owned personal credential directory are taken from the current
  running containers, **never copied into Git, a new .env file or output**.
  The rendered Compose environment and bind/secret mount _destinations_
  must match the existing runtime configuration. Secret contents are not
  inspected or printed.
- The preview Compose call is restricted to named API and Web services,
  one at a time, with --no-deps, --no-build, --pull never and health wait.
  Neither PostgreSQL, Redis nor the Worker is a selected dependency.
  Their container IDs and start timestamps must remain unchanged.
- On catchable failure, the helper attempts exactly one scoped API/Web
  rollback to the old GHCR digests. It never prunes images or volumes.
  A failed rollback is reported without printing credentials or runtime
  config.

## Operator sequence

After GitHub review and merge, fast-forward only the Git checkout from
the image source SHA to the new **operator-tool** main SHA. The two
previously locally built images are not rebuilt or retagged.

First, as ap, after verifying the source checkout and schema 0063:

    python3 scripts/p2_04_local_admin_cutover.py \
      --preflight --expected-operator-sha EXACT_CURRENT_MAIN_SHA

On PASS, the separately intentional one-time **internal** app cutover:

    python3 scripts/p2_04_local_admin_cutover.py \
      --apply --expected-operator-sha EXACT_CURRENT_MAIN_SHA

Afterward:

    python3 scripts/p2_04_local_admin_cutover.py \
      --status --expected-operator-sha EXACT_CURRENT_MAIN_SHA

Recreating API usually invalidates in-memory Admin sessions; sign in again.
Open the internal personal Admin page, scroll to the separate news inbox,
and compare NASA/NOAA metadata with PostgreSQL read-only witnesses.
Unranked metadata is not a verified story, a current multi-source event
or permission to publish. Rankings and editorial provenance must still be
accepted separately.

**No automatic retry** after an ambiguous/failed deployment: inspect
actual Web/API IDs, health, old/new pinned image references and Admin
login. Existing other services must not be restarted to correct a failure.
