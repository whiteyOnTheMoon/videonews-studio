"""Synthetic, no-network regression tests for read-only historical feed review."""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

# Isolate the new module from host Docker/Redis. The underlying ACL helper
# and queue-preflight helper have their own tests in this repository.
acl = types.ModuleType("p2_02_live_redis_acl_readonly")
queue = types.ModuleType("p2_02_nasa_queue_readonly_preflight")
queue.PREFIX = b"bull:vns:feed:vns-feed-poll:"


def encode(*values):
    return b"*" + str(len(values)).encode() + b"\r\n" + b"".join(
        b"$" + str(len(value)).encode() + b"\r\n" + value + b"\r\n"
        for value in values
    )


def ask(sock, stream, *values):
    sock.sendall(encode(*values))
    line = stream.readline()
    if line.startswith(b"+"):
        return "ok", line[1:-2]
    if line.startswith(b"$"):
        n = int(line[1:-2])
        return "bulk", stream.read(n + 2)[:-2]
    raise RuntimeError("unsupported test Redis response")


def redis_integer(sock, stream, cmd, key):
    if cmd != b"ZCARD" or key not in (queue.PREFIX + b"failed", queue.PREFIX + b"completed"):
        raise RuntimeError("unexpected command")
    sock.sendall(encode(cmd, key))
    raw = stream.readline()
    if not raw.startswith(b":") or not raw.endswith(b"\r\n"):
        raise RuntimeError("bad integer")
    return int(raw[1:-2])


acl.encode = encode
acl.ask = ask
queue.redis_integer = redis_integer
queue.quiescent_services = lambda: True

spec = importlib.util.spec_from_file_location(
    "nasa_history_readonly_under_test",
    Path(__file__).with_name("p2_02_nasa_historical_jobs_readonly.py"),
)
assert spec and spec.loader
m = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {
    "p2_02_live_redis_acl_readonly": acl,
    "p2_02_nasa_queue_readonly_preflight": queue,
}):
    spec.loader.exec_module(m)


def bulk(value: bytes | None) -> bytes:
    if value is None:
        return b"$-1\r\n"
    return b"$" + str(len(value)).encode() + b"\r\n" + value + b"\r\n"


def arr(values: list[bytes]) -> bytes:
    return b"*" + str(len(values)).encode() + b"\r\n" + b"".join(bulk(v) for v in values)


class DummySocket:
    def __init__(self, replies: bytes):
        self.replies = io.BytesIO(replies)
        self.writes = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def makefile(self, *_):
        return self.replies

    def settimeout(self, *_):
        pass

    def sendall(self, payload):
        self.writes.append(payload)


def replies(*, malformed_id=False, missing_record=False, oversized_reason=False):
    return (
        b"+OK\r\n+PONG\r\n" + bulk(b"vns_feed_consumer_prod")
        + b":3\r\n" + arr([b"vns-feed-tick-1", b"BAD" if malformed_id else b"vns-feed-tick-2", b"vns-feed-tick-3"])
        + b":1\r\n" + arr([b"vns-feed-tick-4"])
        + bulk(None if missing_record else b"feed-tick")
        + bulk(b"Feed queue execution failed")
        + bulk(b"feed-tick")
        + bulk(b"private database connection error: SECRET_SHOULD_NOT_APPEAR" if not oversized_reason else b"x" * 3000)
        + bulk(b"feed-tick")
        + bulk(b"Feed queue delivery refused")
        + bulk(b"feed-tick")
    )


class ReadOnlyHistoryTests(unittest.TestCase):
    def test_historical_records_are_classified_without_disclosing_raw_values(self):
        sock = DummySocket(replies())
        with patch.object(m.socket, "create_connection", return_value=sock):
            result = m.inspect_history("172.20.1.9", b"private_redis_password")
        self.assertEqual(result["status"], "needs_operator_review")
        self.assertEqual(result["historical_failed_jobs"], 3)
        self.assertEqual(result["historical_completed_jobs"], 1)
        self.assertEqual(result["failed_reason_classes"], {
            "feed_queue_execution_failed": 1,
            "feed_queue_delivery_refused": 1,
            "other_or_missing": 1,
        })
        serialized = json.dumps(result)
        for forbidden in ("SECRET_SHOULD_NOT_APPEAR", "private_redis_password", "172.20.1.9", "vns-feed-tick-1"):
            self.assertNotIn(forbidden, serialized)
        wire = b"".join(sock.writes)
        self.assertEqual(len(sock.writes), 3 + 2 + 2 + 3 * 2 + 1)
        self.assertIn(b"ZRANGE", wire)
        self.assertIn(b"ZCARD", wire)
        self.assertIn(b"HGET", wire)
        for forbidden in (b"EVAL", b"SET", b"DEL", b"HGETALL", b"SCAN", b"HSET", b"RETRY"):
            self.assertNotIn(b"\r\n" + forbidden + b"\r\n", wire)
        for forbidden in (b"data", b"stacktrace", b"returnvalue"):
            self.assertNotIn(b"\r\n" + forbidden + b"\r\n", wire)

    def test_malformed_job_ids_stop_before_reading_untrusted_job_hashes(self):
        sock = DummySocket(replies(malformed_id=True))
        with patch.object(m.socket, "create_connection", return_value=sock):
            with self.assertRaises(RuntimeError):
                m.inspect_history("172.20.1.9", b"secret")
        self.assertNotIn(b"HGET", b"".join(sock.writes))

    def test_missing_job_hash_and_large_failure_reason_fail_closed(self):
        for kw in ({"missing_record": True}, {"oversized_reason": True}):
            sock = DummySocket(replies(**kw))
            with patch.object(m.socket, "create_connection", return_value=sock):
                with self.subTest(kw=kw), self.assertRaises(RuntimeError):
                    m.inspect_history("172.20.1.9", b"secret")

    def test_read_only_commands_enforce_fixed_keys_fields_and_bounds(self):
        sock = DummySocket(b"")
        for state, count in ((b"other", 1), (b"failed", 21)):
            with self.assertRaises(RuntimeError):
                m.historical_ids(sock, sock.replies, state, count)
        for job_id, field in ((b"something:else", b"name"), (b"vns-feed-tick-1", b"data")):
            with self.assertRaises(RuntimeError):
                m.job_field(sock, sock.replies, job_id, field)
        self.assertEqual(sock.writes, [])

    def test_approval_and_moving_further_remain_disabled(self):
        acl.verify_release = lambda sha: None
        acl.active_internal_redis_address = lambda: "172.20.1.9"
        acl.read_password = lambda key: b"private"
        acl.verify_identity = lambda *_: None
        with patch.object(m, "inspect_history", return_value={
            "status": "needs_operator_review", "historical_failed_jobs": 3,
        }):
            actual = m.verify("c" * 40)
        self.assertFalse(actual["production_authorized"])
        self.assertFalse(actual["jobs_changed"])
        self.assertFalse(actual["checkpoint_changed"])
        self.assertFalse(actual["database_changed"])
        self.assertFalse(actual["feed_started"])


if __name__ == "__main__":
    unittest.main()
