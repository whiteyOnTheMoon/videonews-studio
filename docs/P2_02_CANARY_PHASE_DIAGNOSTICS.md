# P2-02 – Stage-labeled canary diagnostics

The first production canary accepted the signed source revision 8 / host
revision 7 and created its valid private checkpoint. It claimed all three
normal PostgreSQL feed leases, but inserted no candidates. The existing
worker deliberately suppressed raw errors, so the source of failure has
not been proven.

An **optional**, side-effect-free poll callback now emits reviewed source
IDs and closed phase labels only: `source_grant`, `lease_claim`,
`lease_validation`, `source_grant_before_https`, `https_transport`,
`feed_decode`, `source_grant_before_commit`, `metadata_commit`.
No raw SQL, URLs, tokens, XML, HTTP bodies, IPs or errors appear in output.

Enable diagnostics for a *separately approved next single-pass canary*
with `VNS_FEED_POLL_STAGE_DIAGNOSTICS=true`. The flag is OFF by default
and silent for offline tests, persistent consumers and producers.
The original failed/unsuccessful outcome remains fail-closed even when
the diagnostic callback throws.

**Do not reset or delete** the checkpoint, the three feed leases, or
BullMQ jobs. A future attempt must use `VNS_FEED_SOURCE_BOOTSTRAP=false`,
wait until the existing SQL eligibility window has elapsed, use a fresh
queue slot, and separately confirm all source approval and rights gates.
Never describe this change as proof that HTTP or RSS works on the VPS.
