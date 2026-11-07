#!/usr/bin/env python3
"""P2-04 multisource readiness tests: no live Docker, SQL or network."""
from __future__ import annotations

import json
import pathlib
import re
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import p2_04_multisource_readonly_readiness as witness


def fixture() -> dict:
    return {
        "read_only": True,
        "sources": [
            {
                "source_id": "nasa_news",
                "registered": True,
                "approved": True,
                "current_host_grant": True,
                "publisher_reviewed": False,
                "candidate_count": 1,
                "mapped_article_count": 1,
                "mapped_event_count": 1,
                "age_eligible_mapped_articles": 1,
            },
            {
                "source_id": "noaa_news",
                "registered": True,
                "approved": True,
                "current_host_grant": True,
                "publisher_reviewed": False,
                "candidate_count": 10,
                "mapped_article_count": 10,
                "mapped_event_count": 10,
                "age_eligible_mapped_articles": 0,
            },
            {
                "source_id": "usgs_news",
                "registered": True,
                "approved": True,
                "current_host_grant": True,
                "publisher_reviewed": False,
                "candidate_count": 0,
                "mapped_article_count": 0,
                "mapped_event_count": 0,
                "age_eligible_mapped_articles": 0,
            },
        ],
        "profile_count": 1,
        "recent_distinct_source_ids": 1,
        "shared_events": 0,
        "time_compatible_cross_source_pairs": 0,
        "ranked_events": 0,
        "publication_violations": 0,
    }


IDS = ("nasa_news", "noaa_news", "usgs_news")


class P204ReadinessTests(unittest.TestCase):
    def test_source_scope_is_strict_and_sorted(self):
        self.assertEqual(witness.parse_sources("usgs_news,noaa_news,nasa_news"), IDS)
        for bad in (
            "", "nasa_news", "nasa_news,noaa_news,nasa_news",
            "nasa_news,NOAA_news", "nasa_news,noaa_news;DROP TABLE x",
            "nasa_news, noaa_news", "nasa_news,noaa_news,",
            "nasa_news,noaa_news,usgs_news,a1,b1,c1",
        ):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                witness.parse_sources(bad)
        with self.assertRaises(ValueError):
            witness.readiness_sql(("noaa_news", "nasa_news"))
        with self.assertRaises(ValueError):
            witness.readiness_sql(IDS + ("z';DROP TABLE x",))

    def test_sql_reads_only_counted_metadata_and_cannot_edit_source_or_policy(self):
        sql = witness.readiness_sql(IDS)
        self.assertTrue(sql.lstrip().startswith("WITH chosen(source_id) AS"))
        self.assertTrue(sql.rstrip().endswith(";"))
        self.assertIn("FROM vns.feed_poll_candidates", sql)
        self.assertIn("vns.feed_publisher_provenance_reviews", sql)
        self.assertIn("vns.admin_source_host_audit", sql)
        self.assertIn("FROM vns.research_articles", sql)
        self.assertIn("FROM vns.feed_event_rankings", sql)
        self.assertIn("max_age*interval '1 hour'", sql)
        self.assertIn("<=172800", sql)
        self.assertIn("transaction_read_only", sql)
        self.assertIn("'nasa_news'", sql)
        self.assertNotIn("vns.feed_runtime_source_authorized(", sql)
        self.assertNotIn("FOR SHARE", sql)
        self.assertNotIn("article_url", sql.lower())
        self.assertNotIn("headline", sql.lower())
        for word in ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "ALTER", "DROP",
                     "CREATE", "LOCK", "GRANT", "REVOKE", "CALL", "EXECUTE"):
            self.assertIsNone(re.search(r"\b" + word + r"\b", sql, re.I))

    def test_production_fixture_correctly_blocks_fresh_multisource_readiness(self):
        row = witness.validate(fixture(), IDS)
        self.assertEqual(witness.status(row), "awaiting_recent_multisource_input")

    def test_distinguishes_independent_remaining_gates(self):
        row = fixture()
        row["sources"][1]["age_eligible_mapped_articles"] = 1
        row["recent_distinct_source_ids"] = 2
        self.assertEqual(witness.status(witness.validate(row, IDS)),
                         "awaiting_multisource_event_evidence")
        row["shared_events"] = 1
        self.assertEqual(witness.status(witness.validate(row, IDS)),
                         "awaiting_publisher_provenance_review")
        for s in row["sources"]:
            s["publisher_reviewed"] = True
        self.assertEqual(witness.status(witness.validate(row, IDS)),
                         "awaiting_ranked_persistence")
        row["ranked_events"] = 1
        self.assertEqual(witness.status(witness.validate(row, IDS)),
                         "requires_named_admin_and_human_acceptance")
        row["publication_violations"] = 1
        self.assertEqual(witness.status(witness.validate(row, IDS)),
                         "blocked_publication_invariant")
        row["publication_violations"] = 0
        row["sources"][0]["current_host_grant"] = False
        self.assertEqual(witness.status(witness.validate(row, IDS)),
                         "blocked_source_grant_snapshot")

    def test_rejects_forged_counts_metadata_and_empty_permissions(self):
        for mutate in (
            lambda x: x.update(read_only=False),
            lambda x: x.update(read_only=1),
            lambda x: x.update(publication_violations="0"),
            lambda x: x.update(recent_distinct_source_ids=2),
            lambda x: x.update(shared_events=-1),
            lambda x: x.update(profile_count=True),
            lambda x: x.update(token="leak"),
            lambda x: x.update(sources=x["sources"][:2]),
            lambda x: x["sources"][0].update(source_id="other"),
            lambda x: x["sources"][0].update(extra="secret"),
            lambda x: x["sources"][0].update(approved="true"),
            lambda x: x["sources"][0].update(registered=False),
            lambda x: x["sources"][0].update(mapped_event_count=2),
            lambda x: x["sources"][0].update(age_eligible_mapped_articles=2),
        ):
            row = fixture()
            mutate(row)
            with self.assertRaises(ValueError):
                witness.validate(row, IDS)

    @mock.patch.object(witness, "verify_release")
    @mock.patch.object(witness, "command")
    def test_live_invocation_is_readonly_and_omits_sensitive_fields(
        self, run, verify
    ):
        run.return_value = json.dumps(fixture())
        report = witness.inspect("b" * 40, IDS)
        self.assertEqual(report["status"], "awaiting_recent_multisource_input")
        self.assertFalse(report["feed_started"])
        self.assertFalse(report["database_changed"])
        self.assertFalse(report["queue_changed"])
        self.assertFalse(report["publication_authorized"])
        self.assertTrue(report["snapshot_not_runtime_authorization"])
        verify.assert_called_once_with("b" * 40)
        args, sql = run.call_args.args
        self.assertEqual(args[:3], ["docker", "exec", "-i"])
        self.assertIn("default_transaction_read_only=on", args[4])
        self.assertIn("statement_timeout=10000", args[4])
        self.assertIn("lock_timeout=3000", args[4])
        self.assertEqual(args[-4:], ["-U", "vns", "-d", "videonews"])
        self.assertEqual(sql, witness.readiness_sql(IDS))
        for forbidden in ("https://", "password", "headline", "article_url"):
            self.assertNotIn(forbidden, json.dumps(report))
        run.return_value = "unexpected sql diagnostic with password"
        with self.assertRaisesRegex(RuntimeError, "P2-04 read-only multisource"):
            witness.inspect("b" * 40, IDS)


if __name__ == "__main__":
    unittest.main()
