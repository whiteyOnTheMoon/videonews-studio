# P2-09 — Offline profile configuration gate

A strict, versioned JSON loader now accepts 1–20 dynamic editorial profiles with niche identifier, language, keyword/block terms, article-age threshold, source-count threshold and draft format. No bundled default profile or hardcoded news provider is used. The selected profile can change without editing code. Invalid/unknown fields, duplicate identities and oversized inputs are refused.

This is unmounted and offline only. **Still required for P2-09 acceptance:** personally authenticated admin UI and database CRUD/CAS/audit; risk class, source allowlist, publishing approval mode and video structure fields; integration with scheduler and scripts; migration/restore, authorization tests and live operator acceptance. No profile is auto-activated, no feed is fetched and no worker is restarted.
