# P2-01 — PostgreSQL revision authority implementation (offline only)

The worker now has a concrete PostgreSQL compare-and-advance adapter that uses a **single conditional UPDATE ... RETURNING** against an already bootstrapped authority row. PostgreSQL's row lock on the targeted row serializes concurrent updates. A stale source revision, stale host revision, changed digest at identical revisions, missing row, query failure or ambiguous row count refuses source release. The adapter has no connection string, network setup, runtime import or implicit bootstrap. Tests are synthetic and do not establish live database availability.

The DDL in `db/independent-anchor/001_high_water.sql` is **deliberately not in the normal app migrations**. It must be applied to a separately operated authority with independent operator permissions and backup/recovery protections. A PostgreSQL database on the same host/volume/administrator rollback domain as the worker is **not an independent anti-rollback anchor**, even if it is a separate schema or database.

## Independent provisioning requirements

1. An authorized operator decides the independent trust boundary, separately managed credentials, TLS server identity, durable WAL/recovery arrangements and storage administration. Do not copy credentials to GitHub, source exports, CI or logs.
2. Apply the separate DDL manually after approval. The bootstrap row is **never** automatically inserted by a worker. Bootstrap must independently compare and record the approved signed envelope revision and digest, then insert the one `source-export` row under a privileged, logged human procedure.
3. Grant the runtime identity strictly the necessary table UPDATE and SELECT permissions in the independent authority (and schema USAGE). No INSERT, DELETE, TRUNCATE, ALTER, GRANT or schema ownership. This is a configuration requirement, **not** a claim that grants exist.
4. Verify atomic concurrent writes against a real isolated PostgreSQL authority, including equal revision/different digest, old source revision/new host revision, and vice versa; verify outages, credential revocation, concurrent workers, restore attempts and logs. Restrict all writer access to the compare-and-advance statement or a dedicated vetted server function as part of production hardening; raw table UPDATE rights alone do not prevent an independently authenticated but compromised worker from issuing arbitrary updates.
5. Maintain a separately authorized, fully audited recovery process. A restored snapshot is not automatically trusted. Reconcile high-water state against independent irreversible audit evidence and keys before reactivation.

## Security and implementation caveat

The conditional statement is atomic for **cooperating callers**, not a complete unforgeable authority: a raw table UPDATE role could circumvent the monotonic predicate. For production, enforce the predicate **inside the authority** using restricted EXECUTE on a SECURITY DEFINER function with hardened search_path and owner privileges, plus independent immutable logs and tested recovery. Until those controls are built and verified, this adapter remains an offline development component and must **not** be wired into the production worker or scheduler. P2-01 #16 remains open.

No live PostgreSQL connection, keys, real feeds, paid calls, container changes or VPS operations are included.
