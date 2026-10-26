# P2-09/P2-10: Personal Admin UI, profile revision handling and read-only exports

Migration **0031** adds `named_current_editor()` to attest the PostgreSQL `session_user` mapping against an active editor account and matching auth version. It also adds `named_timeline_page(story,after_time,after_id,limit)`, providing a cursor-ordered read-only export instead of silently truncating timelines at the first 100 events. Both functions remain inaccessible to the shared API role and require explicit DBA-enrolled **personal PostgreSQL LOGINs**.

`DormantPersonalEditorialAdmin` handles GET/POST of **editorial profiles** and cursor reads of **editorial checkpoints** and the **editorial timeline**. Every request checks the personal editor cookie, role, and the database-attested ID/auth version from `named_current_editor()`. A request with a mismatched PostgreSQL login is rejected. Config edits use the existing atomic `named_profile_commit` revision+actor audit from migration 0029. Export data is read only, bounded to at most 100 records per page and protected from unknown endpoints, unchecked browser URLs and unverified upstream identities.

A `NamedEditorialSessionFactory` must provide one **separately authenticated** personal PostgreSQL connection per request and close it after use. This factory intentionally has no production implementation or credential provisioning. A shared API PostgreSQL account, generic `SET ROLE`, injected actor ID, browser password collection or stored browser secret **must never** substitute for a real personal login.

Next.js includes opt-in BFF routes and two new Admin panels: a structured editor for the existing seven-field niche/language profile schema, and a paginated JSON exporter for script/QA checkpoints and editorial timeline. The exporter fails instead of emitting a partial file when any page, cursor, or identity validation fails. No publishers, keys or concrete language profiles are embedded in the UI. The **current production entrypoint does not mount the Admin handler**; setting only the UI flag is insufficient to activate it.

## Important remaining gaps

- The first Admin profile form supports the existing schema (identity, language, keywords, block terms, source-count threshold, age and format). **Source-to-profile assignments, weighted ranking/risk policy, language scaffolds and provider budgets are not yet editable through it.** Worker profile-v2 persistence and Admin policy settings remain open.
- Actual independent credential issuance, connection brokering and verified real password/MFA login tests are still required. Migration 0031 includes fail-closed CI permission tests, not live personal DB authentication tests.
- Signed and externally anchored exports, complete claim-evidence recording, genuine independent QA, publisher rights and licensed feeds have not been verified.
- Database 0031 is **CI only**. No production migration, personal database login, source polling, scheduler, paid AI, Docker or VPS changes were made.
- Repository governance (#2), real independent signers (#16), full Postgres/Redis/worker runtime (#17), external backup restore (#228), alert delivery (#229), real AI keys (#227) and cost accounting (#230) continue to block production acceptance.

Until the operational controls and role-enrollment process are reviewed, no P2 issue is closed solely by this package. A code-only rollout with feeds disabled still requires a concrete independently approved deployment/rollback plan.
