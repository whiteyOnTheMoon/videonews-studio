#!/usr/bin/env python3
"""Static fail-closed inbox checks; no database or network operations."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
UP = ROOT / "db/migrations/0063_named_feed_inbox.up.sql"
DOWN = ROOT / "db/migrations/0063_named_feed_inbox.down.sql"
API = ROOT / "apps/api/src/personal-editorial-admin.ts"
BFF = ROOT / "apps/web/src/lib/admin-editorial-proxy.ts"
ROUTE = ROOT / "apps/web/src/app/api/admin/editorial-feed-inbox/route.ts"


class InboxContract(unittest.TestCase):
    def test_named_guard_and_source_revalidation(self):
        text = UP.read_text()
        for fragment in (
            "SECURITY DEFINER", "session_user",
            "p.active=true", "a.active=true",
            "p.auth_version=a.auth_version", "a.role='admin'",
            "p_limit NOT BETWEEN 1 AND 25",
            "vns.feed_runtime_source_authorized(src.value)",
            "src.value->>'status'='approved'",
            "feed.review_status='candidate'",
            "NOT EXISTS (", "registry.sources",
            "vns.named_feed_inbox_page", "REVOKE ALL", "FROM PUBLIC",
            "vns_p2_named_client", "approved_for_publication boolean",
        ):
            self.assertIn(fragment, text)
        self.assertNotIn("UPDATE vns.", text)
        self.assertNotIn("DELETE FROM vns.feed_poll_candidates", text)
        self.assertNotIn("INSERT INTO vns.research_events", text)
        self.assertNotIn("approved_for_publication=true", text)

    def test_login_does_not_receive_candidate_table_rights(self):
        text = UP.read_text()
        self.assertIn("GRANT SELECT ON vns.feed_poll_candidates TO vns_p2_named_executor", text)
        self.assertNotIn("GRANT SELECT ON vns.feed_poll_candidates TO vns_p2_named_client", text)
        self.assertIn("GRANT EXECUTE ON FUNCTION vns.named_feed_inbox_page(integer)", text)

    def test_rollback_removes_only_scoped_grants(self):
        text = DOWN.read_text()
        self.assertIn("DROP FUNCTION vns.named_feed_inbox_page(integer)", text)
        self.assertIn("REVOKE SELECT ON vns.feed_poll_candidates FROM vns_p2_named_executor", text)
        self.assertNotIn("DROP TABLE", text)
        self.assertNotIn("DROP ROLE", text)

    def test_http_surface_is_personal_get_only(self):
        route = ROUTE.read_text()
        api = API.read_text()
        bff = BFF.read_text()
        self.assertIn("export async function GET", route)
        self.assertNotIn("export async function POST", route)
        self.assertIn("named_current_editor()", api)
        self.assertIn('"/admin/editorial-feed-inbox"', api)
        self.assertIn("named_feed_inbox_page", api)
        self.assertIn("approved_for_publication !== false", api)
        self.assertIn('endpoint === "feed-inbox"', bff)
        self.assertIn("parseFeedInboxPage", bff)
        self.assertIn('"feed-inbox": "/admin/editorial-feed-inbox"', bff)


if __name__ == "__main__":
    unittest.main()
