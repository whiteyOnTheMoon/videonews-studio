# P2-03 to P2-10 — Initial offline editorial data model

This increment introduces a standalone, never-mounted metadata-only editorial pipeline with a validated per-niche/per-language profile, strict canonical URL handling, exact normalized-title grouping, transparent keyword/recency/source-count ranking, attributable claim references, format-specific **template** drafts, conservative verification, and a nonpublishing decision report.

Important constraints: exact-title grouping is **not** semantic/event-level deduplication. A distinct source ID is **not** proof of editorial independence. A title is **not** sufficient evidence to verify any factual claim. Drafts deliberately mark all claims uncertain and review deliberately blocks their approval. A second independent AI verifier, actual newsroom scripts, durable database model, operator-configured admin UI, full decision history, and tested runtime integrations remain outstanding. This is an incremental code baseline, **not** a completed acceptance of #18–#25.

No live feeds, model calls, keys, VPS/worker activation or publication. Follow-on work must test real authorization boundaries before active use.
