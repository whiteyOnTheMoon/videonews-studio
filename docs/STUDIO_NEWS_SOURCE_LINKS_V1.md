# Studio original source links – phase B increment

**Source code only.** This increment does not start a live feed. 'News recherchieren' still reads persisted candidates. It adds an original-article link and stable article URL identity to the private personal feed inbox. All news stays unverified, not renderable, and not approved for publication.

Migration 0065 introduces `vns.named_feed_inbox_sources_page(integer)` beside the 0063 function. It returns only the existing stored article URL and metadata. Current source/host and per-URL authorization, personal PostgreSQL `session_user`, active admin role and page limits are unchanged. There is no network request or data mutation in this reader. Execution is restricted to the named personal editor DB role, not PUBLIC.

API and BFF validate canonical HTTPS article links and strict response fields. UI links use `noopener noreferrer`; the URL is never server-fetched. Revoking an approved source continues to hide its candidates. Selection uses source article URL, not its result index.

**Live-operations gate:** migration 0065, API/Web deployment and any feed request need separate operator permission and schema backup/restore assessment. Apply migration 0065 before deploying new API/Web images. Absent migration, the new API refuses the request with 503; 0063 remains available to old clients. Independently test anonymous/non-admin access and live revocation before any cutover. No Docker or renderer changes are part of this PR.

Next: an explicitly gated P2 manual feed-slot producer using the existing signed-source boundary and durable completion/status evidence. Queue acceptance must never be shown as a completed news fetch.
