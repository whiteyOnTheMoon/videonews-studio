# P2-01: Read-only pinned signing trust policy report

**Purpose:** Provide the external independent PostgreSQL anchor's policy
revision and exact SHA-256 digest without exporting private signing keys,
writing PostgreSQL, changing file permissions or running any feed service.

This helper reads only the previously provisioned, root-owned,
GID-10002, mode-0440 public key at:

`/var/lib/videonews-studio/p2-signed-source/trust-material/signing-public.pem`

It verifies the root-owned private directories, exact file owner/mode/link count,
valid Ed25519 SPKI key, a clean `main` checkout at the explicitly approved SHA,
and the explicitly chosen positive policy revision.

## Operator command (only after release review and checkout)

```bash
cd /home/ap/www/videonews-studio
sudo node scripts/p2_01_pinned_trust_policy_report.mjs \
  --report --expected-sha APPROVED_40_CHARACTER_MAIN_SHA \
  --policy-revision 1
```

The output is one sanitized JSON object including
`publicKeyFingerprint` and `policySha256`. It explicitly states
`independent_anchor_verified: false`. The operator must independently
verify the public key's fingerprint, approve the exact policy revision,
and bootstrap the **separate remote PostgreSQL trust-policy high-water row**
with that digest using independently owned administrative tooling.
Do not copy an unreviewed key or digest from GitHub into the authoritative
store as a substitute for separate approval.

The runtime requires both
`VNS_FEED_TRUST_POLICY_APPROVED=true` and
`VNS_FEED_TRUST_POLICY_REVISION=1` (or the separately approved
revision). The remote login must have only EXECUTE for the two
monotonic anchor functions; revocation, direct-table privileges and
TLS trust must be checked separately. Never automatically increase a
policy revision or reset the external high-water row to make it accept
a mismatched local key.

The report is **read-only**, cannot detect an independent anchor compromise,
cannot approve source usage rights, and is **not** a production acceptance.
The CI test independently proves the hash is exactly identical to the
TypeScript runtime policy hash and that unsafe public key metadata fails
closed. The previously accepted single-key epoch remains the only live
model; multi-key rotation is a separate future approval.
