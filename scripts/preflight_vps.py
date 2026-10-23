#!/usr/bin/env python3
"""Read-only safety assessment before any VideoNews Studio VPS action.

No Docker mutating commands, no process changes and no secrets are read.
A passing preflight does not authorize a container start.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

GIB = 1024 ** 3
MIB = 1024 ** 2
PROJECT = "videonews-studio"
DEFAULT_PATH = "/home/ap/www/videonews-studio"


def assess(snapshot, mode):
    """Pure preflight policy: (success: bool, findings: list[str])."""
    if mode not in ("preview", "build"):
        raise ValueError("Unknown mode")
    minimum_disk = (15 if mode == "preview" else 30) * GIB
    minimum_memory = (2 if mode == "preview" else 3) * GIB
    max_swap_use = 0.75 if mode == "preview" else 0.50
    messages = []
    def gate(condition, explanation):
        messages.append(("PASS" if condition else "BLOCK") + ": " + explanation)
        return condition
    passed = True
    passed &= gate(snapshot["disk_free"] >= minimum_disk,
                   f"disk free {snapshot['disk_free'] / GIB:.1f} GiB; minimum {minimum_disk / GIB:.0f} GiB")
    passed &= gate(snapshot["mem_available"] >= minimum_memory,
                   f"available RAM {snapshot['mem_available'] / GIB:.1f} GiB; minimum {minimum_memory / GIB:.0f} GiB")
    total = snapshot["swap_total"]
    used = snapshot["swap_used"]
    ratio = used / total if total else 0
    passed &= gate(ratio <= max_swap_use,
                   f"swap used {ratio:.0%}; maximum {max_swap_use:.0%}")
    passed &= gate(snapshot["checkout"], "expected repository checkout exists")
    passed &= gate(not snapshot["name_collision"], "no existing Compose project with the same name")
    return bool(passed), messages


def read_meminfo(path="/proc/meminfo"):
    entries = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            entries[key] = int(value.strip().split()[0]) * 1024
    required = {"MemAvailable", "SwapTotal", "SwapFree"}
    if not required.issubset(entries):
        raise ValueError("Missing memory metrics: " + ", ".join(sorted(required - entries.keys())))
    return entries


def existing_projects():
    # docker compose ls reads metadata only; it must never start/stop anything.
    command = ["docker", "compose", "ls", "--all", "--format", "json"]
    result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=15)
    if result.returncode:
        raise RuntimeError("Could not inspect Docker Compose projects: " + result.stderr.strip()[:200])
    records = json.loads(result.stdout)
    if not isinstance(records, list):
        raise ValueError("Unexpected Docker Compose project list")
    return {record.get("Name") for record in records}


def snapshot(path):
    root = Path(path)
    if not root.is_dir():
        raise ValueError("Project folder does not exist: " + str(root))
    memory = read_meminfo()
    return {
        "disk_free": shutil.disk_usage(root).free,
        "mem_available": memory["MemAvailable"],
        "swap_total": memory["SwapTotal"],
        "swap_used": memory["SwapTotal"] - memory["SwapFree"],
        "checkout": (root / ".git").exists(),
        "name_collision": PROJECT in existing_projects(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", default=DEFAULT_PATH)
    parser.add_argument("--mode", choices=("preview", "build"), default="preview")
    args = parser.parse_args()
    print("VideoNews Studio READ-ONLY VPS preflight; no deployment authorization.")
    try:
        ok, findings = assess(snapshot(args.path), args.mode)
    except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        print("BLOCK: could not complete preflight: " + str(error), file=sys.stderr)
        return 1
    for finding in findings:
        print(finding)
    print("Preflight gate: " + ("PASS (separate permission still required)" if ok else "BLOCK (do not build/start)"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
