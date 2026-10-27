# P2-01/P2-02 – Signed-only live feed observation

This change removes the legacy **unsigned** registry read from the existing,
explicitly invoked `feed-observe-once --once` entrypoint. No cron process,
provider or production settings are activated by merging it.

## Startup admission

Before reaching Redis or network fetching, the observer must:

1. Pass **all** existing one-shot, rights, queue and network operator gates.
2. Require `VNS_FEED_SIGNED_EXPORT_ENABLED=true` and
   `VNS_FEED_SOURCE_ANCHOR_APPROVED=true`.
3. Read the pinned Ed25519 **public** key only from
   `/run/secrets/vns_feed_source_public_key`; no key is generated or
   obtained from the publisher-supplied export.
4. Require a separate anchor login matching `vns_anchor_login_*`, over
   certificate-validated PostgreSQL TLS using a separately mounted CA
   and the explicit approved anchor hostname.
5. Require the anchor login to execute
   `vns_source_anchor.advance(bigint,bigint,text)` but not read its
   underlying `high_water` table or have superuser/DB-admin powers.
6. Verify the source file in `/var/lib/vns/feed-source-inbox` against its
   detached publisher signature, the independently configured current
   HTTPS host policy, and the local monotonic checkpoint in
   `/var/lib/vns/feed-source-checkpoint`.
7. Atomically advance the **separate PostgreSQL high-water authority**
   before advancing the worker checkpoint and returning a source list.
8. Pass only the accepted registry to the existing scheduler composition.
   `/run/secrets/reviewed_research_sources.json` is now a compatibility
   selector but is **never opened** by the live one-shot observer.

No implicit checkpoint bootstrapping is allowed: initial enrollment requires
both `VNS_FEED_SOURCE_BOOTSTRAP=true` and
`VNS_FEED_SOURCE_BOOTSTRAP_OPERATOR_ACK=true`, together with the already
required explicit overall operator gates. Normally set bootstrap to
`false`. Initial anchor high-water creation is a **separate operator
ceremony** before any startup, not performed by the feed worker.

## Runtime secrets and paths

Required environment fields are **exactly** the path constants in the
module; they are not user-supplied paths:

- `VNS_FEED_SIGNED_SOURCE_INBOX=/var/lib/vns/feed-source-inbox`
- `VNS_FEED_SOURCE_CHECKPOINT_DIR=/var/lib/vns/feed-source-checkpoint`
- `VNS_FEED_SOURCE_PUBLIC_KEY_FILE=/run/secrets/vns_feed_source_public_key`
- `VNS_FEED_SOURCE_ANCHOR_PASSWORD_FILE=/run/secrets/vns_feed_source_anchor_password`
- `VNS_FEED_SOURCE_ANCHOR_CA_FILE=/run/secrets/vns_feed_source_anchor_ca`
- `VNS_FEED_SOURCE_ANCHOR_HOST`: separately approved, TLS-verifiable FQDN
- `VNS_FEED_SOURCE_ANCHOR_USER`: separately provisioned least-privilege LOGIN

The secret files are **not** committed and are not created here. The
publisher's Ed25519 **private** key must remain outside the worker image.
The anchor service and its trust/backup domain must be separately operated,
not simply a new schema in the same mutable application PostgreSQL cluster.

## Production blockers and safety limitations

- The exporter/publisher service is not yet deployed. A secure, authenticated
  cross-UID transfer is still required from the private signer output into
  the worker-owned 0700 inbox; do not use a world-readable shared volume.
- The independent anchor login, CA, certificate, initial row, network ACL,
  recovery test and rights-based operator approvals are not provisioned.
- There is no deployed Docker Compose source-anchor service or provisioning
  workflow. Do not infer productive operability from the CI fixture alone.
- No continuous scheduler exists. No real provider, API key, payable AI model,
  editorial release or publishing action is enabled.
- A revoke may race with a request _already being sent_ to HTTPS. Migration
  0033 atomically protects the final PostgreSQL candidate write, not every
  remote HTTP byte. A revocation-aware transport lease remains open work.
- Keeping the legacy `VNS_FEED_REGISTRY_FILE` selector only preserves
  strict pre-existing configuration compatibility; it is not a second
  source of truth for live operation.

The CI scripts use synthetic sources, disposable keys and a simulated anchor
callback to exercise the handoff. Those are not independent production trust
proofs. Human approval of external authority and key custody must precede
any VPS deployment.
