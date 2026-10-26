# P2-01: Dormant news sources Admin integration

The protected Admin page now includes a **default-off** news-source management section. Without the separate source registry flag (`VNS_WEB_SOURCE_REGISTRY_ENABLED=true`) no inputs, URLs, approval controls, or fetches are rendered. If explicitly enabled for a future review environment, the browser loads data **only** via the same-origin Next.js `/api/admin/news-sources` BFF, whose backend independently authenticates a real personal admin session; the shared Admin preview session cannot authorize writes.

The existing `NewsSourceEditor` receives a controlled revision snapshot and callback. No network calls live in the form itself. A mutation POST is sent once; after a successful, independently validated `feedActive:false` acknowledgement, the controller performs a fresh GET before rendering the next revision. Failed or ambiguous outcomes clear the form and require operator reloading; no automatic replay. No feed transport, BullMQ, or direct arbitrary network requests are triggered by the UI.

The `@vns/web` test command now explicitly includes both the news-sources proxy unit tests from PR #240 and the new client controller SSR/parser tests, which were previously missing from the test script.

**Not a deployment approval.** The API startup still does NOT inject the registry, PostgreSQL writer login is not provisioned, and the worker does not accept DB-managed sources. Real use requires authorized infrastructure rollout, source rights and scheduler acceptance. Normal source settings will ultimately be DB-managed from this UI, rather than manual VPS files.
