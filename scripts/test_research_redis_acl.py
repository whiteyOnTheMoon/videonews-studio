import hashlib
import unittest

from research_redis_acl import render_isolated_acl


class IsolatedAclTests(unittest.TestCase):
    def setUp(self):
        self.worker = hashlib.sha256(b"offline-fixture-worker").hexdigest()
        self.research = hashlib.sha256(b"offline-fixture-research").hexdigest()

    def test_disjoint_key_and_channel_namespaces(self):
        acl = render_isolated_acl(self.worker, self.research)
        self.assertEqual(len(acl.splitlines()), 3)
        self.assertIn("user default off\n", acl)
        probe, research = acl.splitlines()[1:]
        self.assertIn("user vns_worker on", probe)
        self.assertIn("~bull:vns:vns-jobs:*", probe)
        self.assertIn("&bull:vns:vns-jobs:*", probe)
        self.assertNotIn("vns-research", probe)
        self.assertIn("user vns_research on", research)
        self.assertIn("~bull:vns:vns-research:*", research)
        self.assertIn("&bull:vns:vns-research:*", research)
        self.assertNotIn("vns-jobs", research)
        self.assertNotIn("~bull:vns:*", acl)
        self.assertNotIn("+@admin", acl)
        self.assertNotIn("+@dangerous", acl)

    def test_refuses_same_identity(self):
        with self.assertRaises(ValueError):
            render_isolated_acl(self.worker, self.worker)

    def test_refuses_invalid_digests(self):
        for bad in ("", "abc", "A" * 64, "z" * 64):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    render_isolated_acl(bad, self.research)
                with self.assertRaises(ValueError):
                    render_isolated_acl(self.worker, bad)


if __name__ == "__main__":
    unittest.main()
