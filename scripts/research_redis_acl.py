#!/usr/bin/env python3
"""Offline-only Redis ACL candidate renderer; never modifies running Redis.

This does not provision, rotate, or install passwords. The caller must provide
independently generated SHA-256 digests after separate authorization.
"""
import re

HEX = re.compile(r"[0-9a-f]{64}\Z")


def render_isolated_acl(worker_digest: str, research_digest: str) -> str:
    """Render an ACL candidate for CI review, not a deployment artifact."""
    if not HEX.fullmatch(worker_digest) or not HEX.fullmatch(research_digest):
        raise ValueError("expected two SHA-256 hex digests")
    if worker_digest == research_digest:
        raise ValueError("research and probe credentials must be distinct")
    return (
        "user default off\n"
        f"user vns_worker on #{worker_digest} resetkeys ~bull:vns:vns-jobs:* "
        "resetchannels &bull:vns:vns-jobs:* +@all -@admin -@dangerous +info\n"
        f"user vns_research on #{research_digest} resetkeys ~bull:vns:vns-research:* "
        "resetchannels &bull:vns:vns-research:* +@all -@admin -@dangerous +info\n"
    )
