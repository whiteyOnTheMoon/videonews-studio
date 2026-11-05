#!/usr/bin/env python3
"""Isolated P2-03 witness tests; never access a live VPS or Docker."""
import json
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import p2_03_projection_readonly_evidence as witness


def fixture(**updates):
    base = {field: 0 for field in witness.COUNTERS}
    base.update(schema_ready=True, source_authorized=True)
    base.update(updates)
    return base


class P203WitnessTests(unittest.TestCase):
    def test_sql_is_fixed_read_only_and_source_id_is_a_strict_literal(self):
        sql = witness.evidence_sql("usgs_news")
        self.assertIn("FROM vns.feed_poll_candidates", sql)
        self.assertIn("vns.research_event_articles", sql)
        self.assertIn("vns.feed_event_rankings", sql)
        self.assertIn("vns.feed_runtime_source_authorized", sql)
        self.assertIn("time_spread>interval '48 hours'", sql)
        self.assertEqual(sql.count("'usgs_news'"), 2)
        self.assertTrue(sql.lstrip().startswith("WITH"))
        self.assertTrue(sql.rstrip().endswith(";"))
        for forbidden in ("INSERT ", "UPDATE ", "DELETE ", "TRUNCATE ",
                          "ALTER ", "DROP ", "CREATE ", "pg_advisory", "FOR UPDATE"):
            self.assertNotIn(forbidden, sql)
        for source in ("usgs_news';DROP TABLE x;--", "", "USGS", "a", "x" * 50):
            with self.assertRaises(ValueError):
                witness.evidence_sql(source)

    def test_all_milestones_remain_pending_until_actual_evidence(self):
        cases = [
            (fixture(schema_ready=False), "blocked_schema_or_source_approval"),
            (fixture(source_authorized=False), "blocked_schema_or_source_approval"),
            (fixture(immutable_metadata_conflicts=1), "blocked_persistence_invariant"),
            (fixture(event_window_violations=1), "blocked_persistence_invariant"),
            (fixture(publication_violations=1), "blocked_persistence_invariant"),
            (fixture(), "awaiting_p2_02_persistence"),
            (fixture(feed_candidates=1, eligible_candidates=1), "awaiting_or_incomplete_projector"),
            (fixture(feed_candidates=3, eligible_candidates=3, projected_articles=3,
                     projected_events=3, multi_article_events=0),
             "awaiting_multisource_duplicate_evidence"),
            (fixture(feed_candidates=3, eligible_candidates=3, projected_articles=3,
                     projected_events=1, multi_article_events=1, multi_source_events=1),
             "awaiting_ranked_admin_evidence"),
            (fixture(feed_candidates=3, eligible_candidates=3, projected_articles=3,
                     projected_events=1, multi_article_events=1,
                     multi_source_events=1, ranked_events=1),
             "requires_named_admin_and_provenance_review"),
        ]
        for row, expected in cases:
            with self.subTest(expected=expected):
                actual = witness.validate_evidence(row)
                self.assertEqual(witness.evidence_status(actual), expected)

    def test_refuses_forged_counts_and_extra_fields(self):
        good = fixture(feed_candidates=1, eligible_candidates=1)
        for invalid in (
            {**good, "feed_candidates": True},
            {**good, "feed_candidates": -1},
            {**good, "feed_candidates": "1"},
            {**good, "feed_candidates": 1000000001},
            {**good, "source_authorized": 1},
            {**good, "additional_secret": "x"},
            {**good, "eligible_candidates": 2},
            {**good, "projected_events": 1},
            {**good, "multi_source_events": 1},
            {**good, "unmapped_eligible_candidates": 2},
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    witness.validate_evidence(invalid)

    @mock.patch.object(witness, "verify_release")
    @mock.patch.object(witness, "command")
    def test_inspection_is_readonly_no_secret_and_never_claims_publication(
        self, command, verify_release
    ):
        row = fixture(feed_candidates=3, eligible_candidates=3, projected_articles=3,
                      projected_events=1, multi_article_events=1,
                      multi_source_events=1, ranked_events=1)
        command.return_value = json.dumps(row)
        report = witness.inspect("a" * 40, "usgs_news")
        self.assertEqual(report["status"], "requires_named_admin_and_provenance_review")
        self.assertFalse(report["publication_authorized"])
        self.assertFalse(report["database_changed"])
        self.assertFalse(report["queue_changed"])
        self.assertFalse(report["feed_started"])
        self.assertEqual(report["release"], "a" * 40)
        verify_release.assert_called_once_with("a" * 40)
        args, sql = command.call_args.args
        self.assertEqual(args[0:3], ["docker", "exec", "-i"])
        self.assertIn("default_transaction_read_only=on", args[4])
        self.assertIn("statement_timeout=10000", args[4])
        self.assertEqual(args[-4:], ["-U", "vns", "-d", "videonews"])
        self.assertEqual(sql, witness.evidence_sql("usgs_news"))
        self.assertNotIn("https://", json.dumps(report))
        command.return_value = "SQL ERROR: secret leak"
        with self.assertRaisesRegex(RuntimeError, "P2-03 read-only evidence unavailable"):
            witness.inspect("a" * 40, "usgs_news")

    @mock.patch.object(witness, "command")
    @mock.patch.object(witness.os, "geteuid", return_value=1000)
    @mock.patch.object(witness.os, "getuid", return_value=1000)
    @mock.patch.object(witness.pwd, "getpwuid", return_value=mock.Mock(pw_name="ap"))
    def test_release_requires_main_clean_sha_and_healthy_compose_postgres(
        self, getpwuid, getuid, geteuid, command
    ):
        valid = ["main", "a" * 40, "", "videonews-studio|postgres|healthy"]
        command.side_effect = valid
        witness.verify_release("a" * 40)
        self.assertEqual(command.call_count, 4)
        command.reset_mock()
        command.side_effect = ["main", "a" * 40, " M unsafe.txt"]
        with self.assertRaises(RuntimeError):
            witness.verify_release("a" * 40)
        self.assertEqual(command.call_count, 3)
        command.reset_mock()
        command.side_effect = ["main", "a" * 40, "", "videonews-studio|postgres|unhealthy"]
        with self.assertRaises(RuntimeError):
            witness.verify_release("a" * 40)
        with self.assertRaises(RuntimeError):
            witness.verify_release("not-a-sha")


if __name__ == "__main__":
    unittest.main()
