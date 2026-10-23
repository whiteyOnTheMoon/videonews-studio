"""Offline unit tests for the governance planner (no GitHub credentials needed)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from github_governance import (
    label_definitions, plan_issue_update, project_id,
    validate_backlog, index_remote_issues,
)


def task():
    return {
        "id": "P1-02",
        "title": "[P1-02] GitHub governance",
        "milestone": "P1",
        "labels": ["type:task", "area:github", "priority:P1", "phase:P1"],
    }


class GovernanceTests(unittest.TestCase):
    def test_project_ids(self):
        self.assertEqual(project_id("[P1-02] Test"), "P1-02")
        self.assertIsNone(project_id("[BUG] Test"))

    def test_source_validation(self):
        item = task()
        self.assertEqual(len(validate_backlog({"issues": [item]})), 1)
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            validate_backlog({"issues": [item, item]})

    def test_definitions_cover_phases_and_statuses(self):
        defs = label_definitions({"P1-02": task()})
        self.assertIn("phase:P7", defs)
        self.assertIn("status:In Review", defs)
        self.assertIn("area:github", defs)

    def test_plan_adds_only_missing_metadata(self):
        item = task()
        existing = {"labels": [{"name": "type:task"}], "milestone": None}
        labels, ms = plan_issue_update(item, existing, {"P1": 2})
        self.assertIn("status:In Progress", labels)
        self.assertIn("phase:P1", labels)
        self.assertEqual(ms, 2)

    def test_noop_after_successful_setup(self):
        item = task()
        existing = {
            "labels": [{"name": x} for x in item["labels"] + ["status:In Progress"]],
            "milestone": {"number": 2},
        }
        self.assertEqual(plan_issue_update(item, existing, {"P1": 2}), ([], None))

    def test_preserves_custom_status_and_existing_milestone(self):
        item = task()
        existing = {
            "labels": [{"name": "status:Blocked"}],
            "milestone": {"number": 9},
        }
        labels, ms = plan_issue_update(item, existing, {"P1": 2})
        self.assertFalse(any(x.startswith("status:") for x in labels))
        self.assertIsNone(ms)

    def test_remote_duplicate_id_aborts(self):
        with self.assertRaisesRegex(ValueError, "Duplicate remote ID"):
            index_remote_issues([
                {"title": "[P1-02] First"},
                {"title": "[P1-02] Duplicate"},
            ])

    def test_pr_not_treated_as_issue(self):
        self.assertEqual(index_remote_issues([
            {"title": "[P1-02] PR", "pull_request": {"url": "some-url"}}
        ]), {})


if __name__ == "__main__":
    unittest.main()
