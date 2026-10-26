# P2-01 — Dormant Ed25519 signing key rotation policy

This increment adds **offline-only** verification against an explicitly operator-pinned list of public Ed25519 keys, each with bounded source/host revision windows. Keys are identified locally by SHA-256 of their SPKI DER public key. No untrusted signed bundle may supply a new key, key URL or automatic trust update. Exactly one pinned key must be authorized for the stated revisions; ambiguity, gaps, duplicate identities, invalid signatures and disallowed hosts fail closed.

## Operator rotation / recovery protocol (not active)

1. Separately authorize the next signing public key and independently verify its fingerprint out-of-band. Private key custody, file/process permissions, rotation and recovery require an operator-approved design and separate backup decision; never put private keys in GitHub/CI.
2. Select **nonoverlapping** source- and host-revision windows and document the new trust policy as an independently distributed, reviewable artifact. Both revisions must advance together across a changeover; divergent revision increments may produce gaps and must be designed before rollout.
3. Stage the future public key with an explicit activation revision. Sign new exports only with the authorized private key after the revision transition, preserving the independently held high-water anchor. Do not reset checkpoints.
4. Remove the old key from future authorization once transition verification succeeds. Lost keys, suspected compromise, expired trust or ambiguous recovery **halt publication**, require dual human review and an independently audited recovery; never silently re-enable an old signer.
5. Test key rollover, rollback of trust configuration, key compromise response, concurrent workers and actual filesystem isolation before production. **This standalone policy is not yet wired into the file consumer or runtime and does not protect against rollback of the pinned trust configuration itself.** A separately protected monotonic trust-policy revision is required before mounting.

No new secrets, live keys, provider calls, network requests, worker mount, database credentials, VPS or scheduler changes. This is **not** completion of #16.
