# P3-02 – Commercial media license precheck (2026-11-08)

Issue: #27. Related asset provenance schema: P3-01 / #26 (PR #470).

## Status and non-goals

This change introduces a **pure, offline, deterministic precheck** in
`packages/shared/src/asset-license-policy.ts`. It deliberately makes
**no rendering, downloading, uploading, publishing, licensing or legal
clearance decision**. `renderAllowed` and `uploadAllowed` are literal
`false` in **every** returned result, including
`READY_FOR_NAMED_REVIEW`. That status only means the synthetic metadata
is ready for a named human's later verification.

The catalog schema from P3-01 remains a prerequisite for eventual
persistence and integration. This PR is independent of its database
deployment and can be tested while #470 awaits review. No API, worker
or Admin write route calls this module yet.

## Narrow, conservative allowlist

| Proposed license metadata | Precheck outcome |
| --- | --- |
| CC0 1.0 | `READY_FOR_NAMED_REVIEW` when evidence and rights flags are complete |
| CC BY 4.0 | `READY_FOR_NAMED_REVIEW` only with complete attribution and modification notice as needed |
| CC BY-SA 4.0 | `REVIEW_REQUIRED` for individual share-alike compatibility review |
| Any CC BY-NC variant | `BLOCKED` for the planned commercial-video use |
| Any CC BY-ND variant | `BLOCKED` as a conservative project policy for video edits (not a claim that every unmodified ND use is unlawful) |
| Unknown or unrecognized version | `BLOCKED` |
| Editorial-only asset | `BLOCKED` |
| Identifiable people, brands/trademarks, third-party property, unknown flags | `REVIEW_REQUIRED` unless another hard block already applies |

Even a CC0/CC BY precheck requires a HTTPS origin, creator, official
license URL, recorded matching version/snapshot, timestamp, SHA-256
digest of media and captured terms, and a recorded attribution line.
For CC BY this line must include creator, source URL and license link;
modified media additionally needs a recorded change notice. These are
**project precheck conditions**, not a claim that CC0 legally requires
attribution. Credentials, non-HTTPS, spoofed license hosts, absent
metadata and mismatched snapshots all block.

The structured `rightsFlags` values are claims supplied by upstream
metadata, **not** independently verified releases or permissions.
`false` cannot prove there is no person, trademark, property or
separate rights restriction. `READY_FOR_NAMED_REVIEW` therefore is
never the final rights verdict. Future P3-08 must check actual
human-reviewed, immutable asset rights at the render **and** upload
entrypoints rather than trusting this preliminary value.

## Official primary references

- CC BY 4.0:
  https://creativecommons.org/licenses/by/4.0/
- CC BY-SA 4.0:
  https://creativecommons.org/licenses/by-sa/4.0/
- CC BY-NC 4.0:
  https://creativecommons.org/licenses/by-nc/4.0/
- License family / ND limits:
  https://creativecommons.org/cc-licenses/
- Attribution and modification:
  https://creativecommons.org/faq/

The CC deeds state that separate publicity, privacy, moral and similar
rights may still restrict media. A license name or URL by itself never
proves that a specific photograph, audio or clip is covered.

## Test and safety contract

`packages/shared/src/asset-license-policy.test.ts` covers:
CC0, CC BY, CC BY-SA, NC, ND, name/URL mismatches, missing/forged
provenance, incomplete credit, modification notices, people, brands,
property, unknown flags and explicit/compound blocks.

The module does not make HTTP requests or install a provider, access
real images, modify PostgreSQL, grant editor privileges, initiate a
render, or enable publication. GitHub's existing P1-03 monorepo
build/typecheck/lint/format/unit suite validates the code in CI.

A successful CI/merge is not an independent human rights review and
does not authorize production-media use. No VPS command is required.
