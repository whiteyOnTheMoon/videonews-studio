#!/usr/bin/env python3
"""Read-only disk pressure check for optional P1-09 monitoring."""
import argparse
from dataclasses import dataclass
from pathlib import Path
import shutil
import sys

GIB = 1024 ** 3
DEFAULT_PATH = "/home/ap/www/videonews-studio"


@dataclass(frozen=True)
class DiskAssessment:
    level: str
    free_bytes: int
    free_percent: float

    @property
    def exit_code(self):
        return {"OK": 0, "WARN": 2, "CRITICAL": 3}[self.level]


def assess_disk(total, free):
    """The more severe of absolute and relative thresholds wins."""
    if type(total) is not int or type(free) is not int or total <= 0 or not 0 <= free <= total:
        raise ValueError("Disk measurements unavailable")
    fraction = free / total
    if free < 10 * GIB or fraction < 0.08:
        level = "CRITICAL"
    elif free < 20 * GIB or fraction < 0.15:
        level = "WARN"
    else:
        level = "OK"
    return DiskAssessment(level, free, 100 * fraction)


def check_disk(path=DEFAULT_PATH, usage=shutil.disk_usage):
    """No Docker commands, network, writes, file contents or credentials."""
    if not Path(path).is_dir():
        raise ValueError("Monitored directory unavailable")
    reading = usage(path)
    return assess_disk(reading.total, reading.free)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", default=DEFAULT_PATH)
    args = parser.parse_args(argv)
    try:
        assessment = check_disk(args.path)
    except (OSError, ValueError):
        print("DISK_STATUS=UNKNOWN")
        return 4
    print(
        f"DISK_STATUS={assessment.level} "
        f"FREE_GIB={assessment.free_bytes / GIB:.1f} "
        f"FREE_PERCENT={assessment.free_percent:.1f}"
    )
    return assessment.exit_code


if __name__ == "__main__":
    sys.exit(main())
