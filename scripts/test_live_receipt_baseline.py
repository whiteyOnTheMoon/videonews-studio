import unittest
from pathlib import Path

class ReceiptPolicyTest(unittest.TestCase):
    def test_version_and_logins(self):
        source = (Path(__file__).parent / "p1_07_live_probe_receipt.sh").read_text()
        self.assertIn("12|0012_runtime_least_privilege|0|0|0|3|3|3|3", source)
        self.assertIn("default_transaction_read_only=on", source)
        self.assertIn("pg_auth_members", source)
        self.assertNotIn("11|0|0|0", source)
