# P2-02 – Make the real one-shot observer use the same-VPS anchor

The former one-shot `feed-observe-once.ts` still forced database
`vns_source_anchor` with pinned external TLS, even after the P2-01
same-VPS runtime option had been added to the separate persistent worker.
This would refuse the first real one-VPS observation, despite a correctly
installed and audited local SQL anchor.

The one-shot observer and persistent consumer now use a single
`feedAnchorPoolConfig` factory **after** `readFeedRuntimeAdmission`
has independently validated every operator approval and endpoint. It
rejects the wrong database, hostname, authorization mode or SQL login.
`same_vps` permits only `postgres:5432/videonews` on the private
Compose backend, without reading a TLS CA, while `separate_tls` still
requires a distinct domain and a pinned, verified TLS connection. There
is no network retry, downgrade or fallback.

This is **not** an authorization to start a live feed. The same-VPS
authority shares the application's backup, administrator and restore
domain: coordinated VPS rollback is not prevented. After a restore,
reconcile signed exports and checkpoint before any new feed request.

A one-time production observation still requires the operator to
confirm exact current 3–5 source usage rights and license conditions,
an approved host allowlist, the newly provisioned anchor credential,
runtime DB/Redis access, signed inbox and pinned public key, an empty
checkpoint for first bootstrap, a rebuilt/digest-pinned worker image,
and the explicit `feed-observation` profile and operator acknowledgements.
No automatic feed poll, checkpoint or publication is performed by this
code change. The PostgreSQL projectors, ranked events and authenticated
Admin GET must be checked separately after a successful one-shot pass.
