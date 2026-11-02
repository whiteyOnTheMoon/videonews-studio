# P2-01 – Read-only source and trust anchor bootstrap candidate

**Status: GitHub-only code; not an independent anchor, not a live approval, not a production feed release.**

After the separately reviewed one-time signed publisher export has been
copied into the protected staging directory and imported into the private
worker inbox, the new p2_01_anchor_bootstrap_candidate.mjs script prepares
the exact **candidate** values for an independently administered PostgreSQL
authority.

## Operator report on the existing VideoNews Studio VPS

Run as the normal ap operator with interactive sudo, from the clean main
checkout whose SHA was already independently reviewed:

    cd /home/ap/www/videonews-studio
    sudo node scripts/p2_01_anchor_bootstrap_candidate.mjs \
      --report --expected-sha REVIEWED_40_CHARACTER_MAIN_SHA \
      --policy-revision 1

Revision 1 is only the *candidate* initial signing-policy revision. No
script chooses an authoritative policy revision or remotely approves it.

The root-only script checks the pinned checkout, Git worktree, existing
publisher signature, independently pinned Ed25519 public key, staged bytes,
private worker inbox and empty worker checkpoint directory. The publisher,
staging and inbox must contain **exactly the same canonical signed JSON
bytes**, with strict ownership, modes and no symlinks. It recomputes:

- Source and host approval revisions from the signed export.
- The envelope SHA-256 from the **complete signed JSON envelope**. This
  matches the production worker's hash of JSON.stringify(signedEnvelope),
  **not** the separate export.sha256 body checksum.
- The public-key fingerprint (SHA-256 of public SPKI DER) and production
  trust-policy digest for the chosen revision.
- The initial single-public-key epoch start revisions.

The output is explicitly labelled bootstrap_candidate_only,
externalAnchorVerified=false, independentlyApproved=false and
checkpointCreated=false. It does not print the registry, article contents,
approved hosts, passwords or any private signing key.

If the worker checkpoint already exists, the command intentionally refuses:
**never use a first-bootstrap report to reset an existing high-water anchor**.
Any failure is generic and must be diagnosed read-only. Do not delete
checkpoints, staging files or authority rows to force success.

## Separate independent-authority work remains mandatory

The report does **not** create a remote database, verify its TLS identity,
read its high-water state, install SQL, grant roles, approve source rights or
start feeds. The VideoNews Studio PostgreSQL container and the Kurvenfunk
containers on the same VPS **cannot** serve as an independent anti-rollback
authority merely by choosing another database or schema.

After establishing a genuinely separate administration and rollback domain,
an independently authorized operator must:

1. Review the pinned signing key out of band, its fingerprint, exact
   source/host revisions, usage rights and approval audit. Independently
   compare the complete hashes against the intended signed export.
2. Provision the external PostgreSQL authority with verified TLS, a minimal
   runtime LOGIN and a separate non-login owner. Install
   db/independent-anchor/001_high_water.sql through
   004_preapproved_trust_policy.sql **only on that external authority**.
3. Independently authorize and bootstrap exactly one source-export
   high-water row and one signing-trust high-water row, and insert the
   matching trust_policy_approvals record under separate owner custody.
   No worker may write approvals or raw high-water rows.
4. Verify runtime login's denial of direct table writes, owner membership,
   unknown/stale policies and missing/unavailable authority, plus the
   required narrow EXECUTE permissions.
5. Separately authorize first runtime/checkpoint admission, feed canary,
   restart and failure-alarm evidence and authenticated Admin checks.

An operator-approved report **never** replaces external controls.
Existing IONOS backups and Beszel monitoring remain unchanged.

## Disposable CI verification

The workflow exercises synthetic signed Ed25519 bundles under actual Linux
numeric UIDs: exact envelope hashing, pinned public-key digest, mismatched
inbox, altered staging, wrong ownership/mode, symlink, changed signer,
noncanonical JSON bytes, existing checkpoint, and CLI refusal without
hash disclosure. Passing CI does not prove a production authority exists.
