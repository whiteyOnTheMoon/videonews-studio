"""Synthetic P2-A VPS preflight tests; no host Docker, database or keys used."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from p2_a_readonly_acceptance import (
    AGGREGATE_SQL, EXPECTED_LAST, MIGRATION_SQL,
    expected_migrations, inspect_package_a, postgres_read_only,
)


SHA = "a" * 40
VERSIONS = [f"{n:04d}_test_migration" for n in range(1, 59)] + [EXPECTED_LAST]
COUNTS = {
    "source_entries": 3,
    "approved_source_entries": 3,
    "runtime_authorized_sources": 3,
    "reviewed_publisher_groups": 3,
    "ranking_policies": 1,
    "event_factor_reviews": 2,
    "weighted_candidates": 1,
    "unexpected_published_rankings": 0,
}


def stage():
    return {
        "stage_a_readiness": "reviewable",
        "release": {
            "checkout_sha": SHA, "expected_sha": SHA,
            "tracked_worktree_clean": True,
        },
        "checks": {
            "expected_checkout_sha": True,
            "tracked_worktree_clean": True,
            "docker_inventory_accessible": True,
            "no_feed_host_ports": True,
            "no_competing_feed_producers": True,
        },
        "docker": {
            "project": "videonews-studio",
            "services": {
                "postgres": {
                    "state": "running", "health": "healthy",
                    "host_ports_published": False,
                }
            },
        },
    }


def reader(data=None, installed=None, calls=None):
    def query(container, sql):
        if calls is not None:
            calls.append((container, sql))
        if container != "videonews-studio-postgres-1":
            raise ValueError("Wrong Compose container")
        if sql == MIGRATION_SQL:
            return "\n".join(VERSIONS if installed is None else installed)
        if sql == AGGREGATE_SQL:
            return json.dumps(COUNTS if data is None else data)
        raise AssertionError("Unexpected SQL")
    return query


class P2APreflight(unittest.TestCase):
    def test_release_manifest_is_complete_on_checked_out_branch(self):
        actual = expected_migrations()
        self.assertEqual(len(actual), 59)
        self.assertEqual(actual[-1], EXPECTED_LAST)
        self.assertEqual([v[:4] for v in actual],
                         [f"{n:04d}" for n in range(1, 60)])

    def test_release_manifest_refuses_missing_version_and_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(ValueError):
                expected_migrations(root)
            for i in range(1, 60):
                (root / (f"{i:04d}_test_migration.up.sql" if i < 59 else EXPECTED_LAST + ".up.sql")).write_text("BEGIN; COMMIT;")
            self.assertEqual(len(expected_migrations(root)), 59)
            last = root / (EXPECTED_LAST + ".up.sql")
            last.unlink()
            last.symlink_to(root / "0058_test_migration.up.sql")
            with self.assertRaises(ValueError):
                expected_migrations(root)

    def test_only_reviewable_state_is_unpublished_and_restricted(self):
        calls = []
        report = inspect_package_a(stage(), VERSIONS, reader(calls=calls))
        self.assertEqual(report["operator_e2e_preflight"], "reviewable")
        self.assertEqual(report["totals"], COUNTS)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1], MIGRATION_SQL)
        self.assertEqual(calls[1][1], AGGREGATE_SQL)
        self.assertEqual(report["production_authorized"], False)
        self.assertEqual(report["independent_evidence"]["source_legal_rights"], "not_verified")
        self.assertEqual(
            report["independent_evidence"]["personally_authenticated_admin_read"],
            "not_verified",
        )

    def test_dirty_wrong_sha_and_docker_problem_skip_database_completely(self):
        for change in (
            lambda s: s["release"].update(checkout_sha="b" * 40),
            lambda s: s["release"].update(tracked_worktree_clean=False),
            lambda s: s.update(stage_a_readiness="blocked"),
            lambda s: s["docker"]["services"]["postgres"].update(health="starting"),
            lambda s: s["docker"]["services"]["postgres"].update(
                host_ports_published=True
            ),
            lambda s: s["checks"].update(no_competing_feed_producers=False),
        ):
            sample = stage()
            change(sample)
            calls = []
            report = inspect_package_a(sample, VERSIONS, reader(calls=calls))
            self.assertEqual(report["operator_e2e_preflight"], "blocked")
            self.assertEqual(calls, [])
            self.assertIsNone(report["totals"])
            self.assertIs(report["production_authorized"], False)

    def test_schema_drift_refuses_aggregate_probe(self):
        for changed in (VERSIONS[:-1], VERSIONS[:-1] + ["0059_wrong"], VERSIONS + ["0060_extra"]):
            calls = []
            report = inspect_package_a(stage(), VERSIONS, reader(installed=changed, calls=calls))
            self.assertEqual(report["operator_e2e_preflight"], "blocked")
            self.assertEqual(len(calls), 1)
            self.assertIsNone(report["totals"])

    def test_missing_rights_and_evidence_block_operator_preflight(self):
        for key, value in (
            ("approved_source_entries", 2),
            ("approved_source_entries", 6),
            ("runtime_authorized_sources", 2),
            ("reviewed_publisher_groups", 2),
            ("ranking_policies", 0),
            ("event_factor_reviews", 0),
            ("weighted_candidates", 0),
            ("unexpected_published_rankings", 1),
        ):
            data = {**COUNTS, key: value}
            report = inspect_package_a(stage(), VERSIONS, reader(data=data))
            self.assertEqual(report["operator_e2e_preflight"], "blocked", key)
            self.assertFalse(report["production_authorized"])

    def test_bad_json_negative_counts_and_leaked_fields_fail_closed(self):
        for data in (
            {**COUNTS, "source_entries": -1},
            {**COUNTS, "source_entries": True},
            {**COUNTS, "article_title": "secret headline"},
            {key: value for key, value in COUNTS.items() if key != "source_entries"},
        ):
            report = inspect_package_a(stage(), VERSIONS, reader(data=data))
            self.assertIsNone(report["totals"])
            self.assertEqual(report["operator_e2e_preflight"], "blocked")
        report = inspect_package_a(stage(), VERSIONS,
                                   lambda _container, _sql: "not json")
        self.assertEqual(report["operator_e2e_preflight"], "blocked")

    def test_docker_queries_are_fixed_read_only_and_never_print_stderr(self):
        fake = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="0001_test_migration\n", stderr="PASSWORD=private"
        )
        with patch("p2_a_readonly_acceptance.subprocess.run", return_value=fake) as run:
            self.assertEqual(
                postgres_read_only("videonews-studio-postgres-1", MIGRATION_SQL),
                "0001_test_migration",
            )
            args, kwargs = run.call_args
            self.assertEqual(args[0][:3], ["docker", "exec", "-i"])
            self.assertIn("default_transaction_read_only=on", args[0][4])
            self.assertIn("-w", args[0])
            self.assertEqual(kwargs["input"], MIGRATION_SQL + "\n")
            self.assertEqual(kwargs["timeout"], 15)
        with patch("p2_a_readonly_acceptance.subprocess.run") as run:
            for container, sql in (
                ("another-postgres-1", MIGRATION_SQL),
                ("videonews-studio-postgres-1", "DELETE FROM vns.sources"),
            ):
                with self.assertRaises(ValueError):
                    postgres_read_only(container, sql)
            run.assert_not_called()
        bad = subprocess.CompletedProcess(
            args=[], returncode=2, stdout="", stderr="secret=really_secret"
        )
        with patch("p2_a_readonly_acceptance.subprocess.run", return_value=bad):
            with self.assertRaisesRegex(ValueError, "probe unavailable"):
                postgres_read_only("videonews-studio-postgres-1", AGGREGATE_SQL)


if __name__ == "__main__":
    unittest.main()
