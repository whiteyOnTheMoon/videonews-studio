"""Synthetic, no-network tests for strictly read-only NASA BullMQ inventory."""
from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch

import p2_02_nasa_queue_readonly_preflight as m


class DummySocket:
    def __init__(self, replies: bytes):
        self.stream = io.BytesIO(replies)
        self.writes: list[bytes] = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def makefile(self, *_):
        return self.stream

    def settimeout(self, *_):
        pass

    def sendall(self, data: bytes):
        self.writes.append(data)


def counts(**changes):
    template = {name: 0 for name, _, _ in m.COUNTS}
    template.update(changes)
    return template


class NASAQueueTests(unittest.TestCase):
    def test_only_fixed_read_commands_are_allowed_and_bounds_are_enforced(self):
        for command, key in (
            (b"SET", m.PREFIX + b"wait"),
            (b"DEL", m.PREFIX + b"wait"),
            (b"EVAL", m.PREFIX + b"wait"),
            (b"LLEN", b"bull:vns:vns-jobs:wait"),
            (b"LLEN", m.PREFIX + b"wait:PRIVATE_VALUE"),
        ):
            sock = DummySocket(b":0\r\n")
            with self.subTest(command=command, key=key):
                with self.assertRaises(RuntimeError):
                    m.redis_integer(sock, sock.stream, command, key)
                self.assertEqual(sock.writes, [])

        for reply in (b":-1\r\n", b":100000001\r\n", b"+OK\r\n",
                      b"-NOPERM\r\n", b":1\n", b":none\r\n"):
            sock = DummySocket(reply)
            with self.subTest(reply=reply):
                with self.assertRaises(RuntimeError):
                    m.redis_integer(sock, sock.stream, b"ZCARD", m.PREFIX + b"failed")

        sock = DummySocket(b":2\r\n")
        with self.assertRaises(RuntimeError):
            m.redis_integer(sock, sock.stream, b"EXISTS", m.PREFIX + b"vns-feed-tick-123")
        sock = DummySocket(b":15\r\n")
        self.assertEqual(
            m.redis_integer(sock, sock.stream, b"ZCARD", m.PREFIX + b"failed"), 15
        )

    def test_inventory_uses_only_auth_whoami_read_only_cards_and_fixed_slot_exists(self):
        responses = (
            b"+OK\r\n+PONG\r\n$22\r\nvns_feed_consumer_prod\r\n"
            + b"".join(b":" + str(i).encode() + b"\r\n"
                       for i in [0, 0, 0, 0, 0, 0, 7, 12, 0, 0])
            + b":0\r\n:1\r\n"
        )
        sock = DummySocket(responses)
        with patch.object(m.socket, "create_connection", return_value=sock):
            actual = m.inspect_queue("172.20.0.9", b"SECRET_QUEUED_PASSWORD", 123)
        self.assertEqual(actual["counts"]["failed"], 7)
        self.assertEqual(actual["counts"]["completed"], 12)
        self.assertFalse(actual["current_slot_job_present"])
        self.assertTrue(actual["previous_slot_job_present"])
        self.assertEqual(len(sock.writes), 3 + len(m.COUNTS) + 2)
        self.assertIn(b"AUTH", sock.writes[0])
        self.assertIn(b"WHOAMI", sock.writes[2])
        self.assertTrue(all(
            any(b"$" + str(len(verb)).encode() + b"\r\n" + verb + b"\r\n" in command
                for verb in [b"LLEN", b"ZCARD", b"SCARD", b"EXISTS"])
            for command in sock.writes[3:]
        ))
        self.assertNotIn("SECRET_QUEUED_PASSWORD", json.dumps(actual))
        self.assertNotIn("172.20.0.9", json.dumps(actual))
        self.assertNotIn(b"SET", b"".join(sock.writes[3:]))
        self.assertNotIn(b"EVAL", b"".join(sock.writes[3:]))

    def test_feed_service_status_is_fail_closed(self):
        with patch.object(m.acl, "run", return_value=(
            "postgres|running\nredis|running\nfeed-observer|exited"
        )):
            self.assertTrue(m.quiescent_services())
        for docker_output in (
            "feed-consumer|running",
            "feed-producer|created",
            "source-publisher|paused",
        ):
            with patch.object(m.acl, "run", return_value=docker_output):
                self.assertFalse(m.quiescent_services())
        for bad in ("feed-consumer|unknown", "name-with-bad-slash/|running", "feed-consumer|running|oops"):
            with patch.object(m.acl, "run", return_value=bad):
                with self.assertRaises(RuntimeError):
                    m.quiescent_services()

    def test_read_only_result_preserves_historical_failures_without_retry(self):
        with (
            patch.object(m.acl, "verify_release"),
            patch.object(m.acl, "active_internal_redis_address", return_value="172.21.0.7"),
            patch.object(m.acl, "read_password", side_effect=[
                b"VERY_PRIVATE_PRODUCER", b"VERY_PRIVATE_CONSUMER",
            ]),
            patch.object(m.acl, "verify_identity") as verify_identity,
            patch.object(m, "quiescent_services", return_value=True),
            patch.object(m.time, "time", return_value=1800000000),
            patch.object(m, "inspect_queue", return_value={
                "counts": counts(failed=3, completed=9),
                "current_slot_job_present": False,
                "previous_slot_job_present": True,
            }) as inspect,
        ):
            result = m.verify("a" * 40)
            self.assertEqual(verify_identity.call_count, 2)
            self.assertEqual(inspect.call_count, 1)
        self.assertEqual(result["status"], "reviewable")
        self.assertEqual(result["counts"]["failed"], 3)
        self.assertFalse(result["production_authorized"])
        self.assertFalse(result["jobs_changed"])
        self.assertNotIn("VERY_PRIVATE", json.dumps(result))
        self.assertNotIn("172.21.0.7", json.dumps(result))

    def test_any_active_queue_or_current_slot_conflict_blocks_without_mutation(self):
        base = {"counts": counts(), "current_slot_job_present": False,
                "previous_slot_job_present": False}
        for state in (
            {"counts": counts(waiting=1)},
            {"counts": counts(active=1)},
            {"counts": counts(delayed=2)},
            {"counts": counts(repeat_schedules=1)},
            {"current_slot_job_present": True},
        ):
            with (
                patch.object(m.acl, "verify_release"),
                patch.object(m.acl, "active_internal_redis_address", return_value="172.21.0.7"),
                patch.object(m.acl, "read_password", side_effect=[b"producer", b"consumer"]),
                patch.object(m.acl, "verify_identity"),
                patch.object(m, "quiescent_services", return_value=True),
                patch.object(m, "inspect_queue", return_value={**base, **state}),
            ):
                result = m.verify("a" * 40)
                self.assertEqual(result["status"], "blocked")
        with (
            patch.object(m.acl, "verify_release"),
            patch.object(m.acl, "active_internal_redis_address", return_value="172.21.0.7"),
            patch.object(m.acl, "read_password", side_effect=[b"producer", b"producer"]),
            patch.object(m.acl, "verify_identity") as spy,
        ):
            with self.assertRaises(RuntimeError):
                m.verify("a" * 40)
            spy.assert_not_called()


if __name__ == "__main__":
    unittest.main()
