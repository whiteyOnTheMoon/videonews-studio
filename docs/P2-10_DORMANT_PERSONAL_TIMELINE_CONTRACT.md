# P2-10 — Dormant timeline writer and reader

Migration 0025 introduces a transactional append function that validates an active named editor and its current auth-version before writing an immutable event, and a bounded story-specific query that requires a currently active reviewer/admin. The PostgreSQL CI test covers identity revocation, denied editor reads, append/read continuity and the absence of API runtime EXECUTE grants.

**Not active or suitable for deployment:** The function arguments are still caller-supplied identity claims. Function EXECUTE stays revoked from PUBLIC and all runtime roles. A future independently provisioned, named database login must bind the authenticated SQL session to the editor identity server-side (including role, revocation and credential rotation), then the API must enforce authenticated HTTPS editor sessions and operator approval before granting any EXECUTE. A table owner/superuser may still tamper with the timeline, so independently protected audit storage and a signed export are required for final P2-10 acceptance.

No provider credentials, VPS writes, feed access, AI calls or scheduler activation.
