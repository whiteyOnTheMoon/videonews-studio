"""No-network tests of the active Redis preflight's fail-closed RESP contract."""
from __future__ import annotations

import io
import unittest
from unittest.mock import patch

import p2_02_live_redis_acl_readonly as m


class DummySocket:
    def __init__(self, replies: bytes):
        self.writes = []
        self.stream = io.BytesIO(replies)
        self.timeout = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def makefile(self, *_):
        return io.BytesIO(self.stream.getvalue())

    def settimeout(self, timeout):
        self.timeout = timeout

    def sendall(self, data):
        self.writes.append(data)


class PreflightTests(unittest.TestCase):
    def test_resp_encoding(self):
        self.assertEqual(
            m.encode(b"AUTH", b"user", b"secret"),
            b"*3\r\n$4\r\nAUTH\r\n$4\r\nuser\r\n$6\r\nsecret\r\n",
        )

    def test_reply_strictly_bounded(self):
        self.assertEqual(m.reply(io.BytesIO(b"+OK\r\n")), ("ok", b"OK"))
        self.assertEqual(m.reply(io.BytesIO(b"$5\r\nadmin\r\n")), ("bulk", b"admin"))
        self.assertEqual(m.reply(io.BytesIO(b"-NOPERM forbidden\r\n")),
                         ("error", b"NOPERM forbidden"))
        for malformed in (
            b"", b"+OK\n", b"$999999\r\n", b"$5\r\nabc\r\n",
            b":1\r\n", b"$-1\r\n", b"$0\r\n",
        ):
            with self.subTest(malformed=malformed):
                with self.assertRaises(RuntimeError):
                    m.reply(io.BytesIO(malformed))

    def test_actual_commands_are_read_only_and_denied_out_of_scope(self):
        response = (
            b"+OK\r\n" + b"+PONG\r\n" +
            b"$22\r\nvns_feed_producer_prod\r\n" +
            b"-NOPERM No permissions to access a key\r\n"
        )
        sock = DummySocket(response)
        with patch.object(m.socket, "create_connection", return_value=sock):
            m.verify_identity("172.25.0.2", "vns_feed_producer_prod", b"secret")
        self.assertEqual(len(sock.writes), 4)
        self.assertIn(b"AUTH", sock.writes[0])
        self.assertIn(b"PING", sock.writes[1])
        self.assertIn(b"WHOAMI", sock.writes[2])
        self.assertIn(b"GET", sock.writes[3])
        self.assertNotIn(b"SET", b"".join(sock.writes))
        self.assertNotIn(b"ACL SETUSER", b"".join(sock.writes))

    def test_failure_in_auth_or_acl_refuses(self):
        cases = (
            b"-WRONGPASS wrong user or password\r\n",
            b"+OK\r\n-PONG unavailable\r\n",
            b"+OK\r\n+PONG\r\n$5\r\nadmin\r\n",
            b"+OK\r\n+PONG\r\n$22\r\nvns_feed_producer_prod\r\n$-1\r\n",
        )
        for response in cases:
            with self.subTest(response=response):
                sock = DummySocket(response)
                with patch.object(m.socket, "create_connection", return_value=sock):
                    with self.assertRaises(RuntimeError):
                        m.verify_identity("172.25.0.2", "vns_feed_producer_prod", b"secret")

    def test_no_secret_or_container_address_in_report(self):
        with (
            patch.object(m, "verify_release"),
            patch.object(m, "active_internal_redis_address", return_value="172.25.0.7"),
            patch.object(m, "read_password", side_effect=[b"SECRET_PRODUCER", b"SECRET_CONSUMER"]),
            patch.object(m, "verify_identity") as verify,
        ):
            report = m.verify("a" * 40)
        self.assertEqual(verify.call_count, 2)
        self.assertTrue(report["producer_authenticated"])
        self.assertTrue(report["consumer_authenticated"])
        self.assertNotIn("172.25.0.7", str(report))
        self.assertNotIn("SECRET", str(report))


if __name__ == "__main__":
    unittest.main()
