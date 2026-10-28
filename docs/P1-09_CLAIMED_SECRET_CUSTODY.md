# P1-09: Post-claim encrypted credential custody (offline only)

Migration `0043_claimed_provider_secret_scope` creates a separate
`vns_provider_secret_executor` NOLOGIN function owner and an independent
`vns_provider_secret_reader` NOLOGIN role. Neither is a live LOGIN or
a member of the existing Admin provider writer or usage writer.

The SQL reader gets only EXECUTE on
`vns.claimed_provider_sealed_key(reservation_id,provider)`. It cannot
SELECT from the provider credential table, mutate provider settings,
read a different provider's key, submit reservations or make paid calls.
The function exposes only the encrypted AES-GCM envelope. It requires:

- A previously committed SQL reservation and one-shot dispatch claim
- Enabled, unhalted USD and enabled EUR policy, with valid capped exposure
- Current FX snapshot matching the immutable EUR admission
- Current reviewed price, selected model and active, unchanged price reviewer
- A stored key for the same provider, installed no later than that claim
- No earlier credential read for that reservation and no settlement

After these checks, it records one irreversible,
append-only access audit. It will not return a second copy for the
same reservation, including following timeouts, crashes, key rotations
or cross-session races. The only returned bytes are ciphertext,
nonce and authentication tag; no plaintext is stored or logged.

The default-disabled worker module
`provider-claimed-credential-scope.ts` reads the envelope with the
SQL function and only then loads a private 32-byte master key from a
no-symlink, UID-owned local file. It authenticates and decrypts the
envelope with AES-256-GCM and provider-scoped associated data,
delivers the key within a callback and discards temporary byte buffers.
The callback runs only after the claim-bound read. The coordinator's
credential interface now includes reservation ID, preventing a
generic provider-only secret lookup.

**No production import**, credential provisioning, login/bootstrap,
Docker overlay, environment activation or VPS migration is added.
A preexisting Admin-managed key cannot be used by this code alone.
The worker process and any future secure runtime must have a
separately reviewed, least-privilege Postgres login, confidential
master-key mount and outbound network policy; neither is installed.

Important residual risks: a JavaScript secret string cannot be reliably
memory-zeroed; a compromised worker process could retain it. Database
reader role isolation and access audits are necessary but not sufficient
to prevent unauthorized use. A completed SQL claim is not proof that
a vendor accepted the request. The reviewed FX ceiling is not an
invoice guarantee, and text input byte length is not a vendor token
bound. The provider's official price, model capability and
provider-authenticated usage still require independent checking.

Disposable CI validates two complete 0001-0043 migration/reversal
cycles, default ACLs, missing/duplicate/wrong-provider reads, a
valid once-only sealed envelope, key rotation and immutable audit.
Worker tests use only synthetic credentials, mocked SQL and locally
created temporary files. No paid or external vendor calls occur.

IONOS backups and Beszel monitoring remain as separately confirmed
operator controls and are unchanged. Issue #227 and #230 remain open;
this package is not a P1 production acceptance or spend authorization.
