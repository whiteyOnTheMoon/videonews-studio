#!/usr/bin/env python3
"""Offline per-job token-cost estimates with explicit integer USD micro-rates.

Neither calls providers nor stores data; real provider usage/price wiring
requires a separately approved integration.
"""
import argparse
import json
import re
import sys

UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
REQUEST = re.compile(r"^[A-Za-z0-9_-]{12,80}$")
FIELDS = frozenset({
    "jobId", "requestId", "provider", "model", "inputTokens",
    "outputTokens", "inputMicroUsdPerMillion", "outputMicroUsdPerMillion",
})
MAX_TOKENS = 100_000_000
MAX_RATE = 1_000_000_000_000
MAX_MICRO_USD = 10 ** 15


def bounded_integer(value, maximum):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError("Invalid bounded usage component")
    return value


def calculate_usage(event):
    """Strict envelope disallows prompts, credentials, URLs and arbitrary text."""
    if not isinstance(event, dict) or set(event) != FIELDS:
        raise ValueError("Invalid usage fields")
    if (
        not isinstance(event["jobId"], str)
        or not UUID.fullmatch(event["jobId"])
        or not isinstance(event["requestId"], str)
        or not REQUEST.fullmatch(event["requestId"])
        or any(not isinstance(event[key], str) or not NAME.fullmatch(event[key])
               for key in ("provider", "model"))
    ):
        raise ValueError("Invalid usage identity")
    inp = bounded_integer(event["inputTokens"], MAX_TOKENS)
    out = bounded_integer(event["outputTokens"], MAX_TOKENS)
    rate_in = bounded_integer(event["inputMicroUsdPerMillion"], MAX_RATE)
    rate_out = bounded_integer(event["outputMicroUsdPerMillion"], MAX_RATE)
    # Round the combined total up to one micro-USD; no floating-point money.
    amount = (inp * rate_in + out * rate_out + 999_999) // 1_000_000
    if amount > MAX_MICRO_USD:
        raise ValueError("Cost bound exceeded")
    return {
        "jobId": event["jobId"],
        "requestId": event["requestId"],
        "provider": event["provider"],
        "model": event["model"],
        "inputTokens": inp,
        "outputTokens": out,
        "estimatedCostMicroUsd": amount,
        "currency": "USD",
        "estimated": True,
    }


def summarize_usage(events):
    """Identical retries count once; conflicting duplicates fail closed."""
    if not isinstance(events, list) or len(events) > 100:
        raise ValueError("Invalid event batch")
    seen = {}
    for event in events:
        receipt = calculate_usage(event)
        key = (receipt["jobId"], receipt["requestId"])
        if key in seen and seen[key] != receipt:
            raise ValueError("Conflicting duplicate provider request")
        seen[key] = receipt
    totals = {}
    for receipt in seen.values():
        job_id = receipt["jobId"]
        if job_id not in totals:
            totals[job_id] = {
                "jobId": job_id, "requests": 0, "inputTokens": 0,
                "outputTokens": 0, "estimatedCostMicroUsd": 0,
                "currency": "USD", "estimated": True,
            }
        total = totals[job_id]
        total["requests"] += 1
        for key in ("inputTokens", "outputTokens", "estimatedCostMicroUsd"):
            total[key] += receipt[key]
        if total["estimatedCostMicroUsd"] > MAX_MICRO_USD:
            raise ValueError("Cost total exceeds safe bound")
    return [totals[key] for key in sorted(totals)]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--calculate", action="store_true")
    mode.add_argument("--summarize", action="store_true")
    args = parser.parse_args(argv)
    try:
        raw = sys.stdin.buffer.read(131073)
        if len(raw) > 131072:
            raise ValueError("Usage batch too large")
        parsed = json.loads(raw)
        result = calculate_usage(parsed) if args.calculate else summarize_usage(parsed)
    except (ValueError, TypeError, UnicodeError):
        print("REFUSED: invalid offline usage input", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
