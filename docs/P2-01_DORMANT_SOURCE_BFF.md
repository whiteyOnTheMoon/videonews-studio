# P2-01 – Dormant personal-admin API and BFF route

This increment reuses the named-editor source contract from #237 and the PostgreSQL adapter from #238. The API server now permits **explicit injection** of a `DormantNamedSourceAdmin`, requiring personal editor and shared infrastructure gates. `apps/api/src/index.ts` deliberately does **not** inject one and creates no new database pool, writer LOGIN or rate-admission instance.

The Next.js `/api/admin/news-sources` GET/POST handler is gated by a distinct, default-off `VNS_WEB_SOURCE_REGISTRY_ENABLED=true` setting **and** existing editor-auth feature gates. The browser's shared-admin cookie cannot authorize writes. The BFF resolves a server-side personal admin profile and forwards only the personal editor cookie to the internal API, which independently resolves the session, validates the command and checks the origin, rate admission, and database CAS. It rejects extra or dangerous client fields, unsafe protocols, oversized bodies, unexpected upstream fields, redirects, and any `feedActive=true` response.

**Important:** A BFF feature flag alone cannot enable ingestion: API runtime has no source registry mount; Worker registry/allowlist, BullMQ timers and feed queues remain completely disconnected. New and revised sources remain pending, even if a synthetic offline test explicitly approves one.

Before an operator may switch this on: DB-level transition/URL semantics validation, scoped writer LOGIN + secret, personally authenticated end-to-end deployment test, UI integration, safe registry/host allowlist export, license approvals, monitoring and actual scheduler acceptance. The configuration flag here is only a technical default-off gate; normal publisher settings must eventually be editable in the Admin UI.
