import hashlib
from pathlib import Path
import re
import stat
import tempfile
import unittest

from provision_redis_secrets import provision


class SecretTests(unittest.TestCase):
    def test_secret_format_and_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "secrets"
            provision(folder)
            password = (folder / "redis_password").read_text().strip()
            acl = (folder / "redis_acl").read_text()
            self.assertGreaterEqual(len(password), 40)
            self.assertNotIn(password, acl)
            self.assertIn("#" + hashlib.sha256(password.encode()).hexdigest(), acl)
            self.assertRegex(acl, r"(?m)^user default off$")
            self.assertRegex(acl, r"(?m)^user vns_worker on #")
            self.assertIn("~bull:vns:*", acl)
            self.assertIn("-@admin -@dangerous +info", acl)
            self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((folder / "redis_password").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((folder / "redis_acl").stat().st_mode), 0o644)

    def test_never_overwrite_password(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            provision(folder)
            old_password = (folder / "redis_password").read_bytes()
            old_acl = (folder / "redis_acl").read_bytes()
            with self.assertRaises(FileExistsError):
                provision(folder)
            self.assertEqual((folder / "redis_password").read_bytes(), old_password)
            self.assertEqual((folder / "redis_acl").read_bytes(), old_acl)

    def test_refuses_partial_secret_pair(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / "redis_acl").write_text("placeholder")
            with self.assertRaises(FileExistsError):
                provision(folder)
            self.assertFalse((folder / "redis_password").exists())


if __name__ == "__main__":
    unittest.main()
