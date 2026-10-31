# P2-01: Personal Single-Owner Governance – controlled activation

**Status:** Operator-controlled DBA enrollment only; it does not authorize any particular news source or website.

## Intended production state

VideoNews Studio currently has one accountable human owner, `vns_owner_admin`, and one personally enrolled PostgreSQL login, `editor_vns_owner_admin`. This person is authorized to make both source-rights and host-scope decisions as distinct, personally audited actions. No imaginary second reviewer is asserted.

PostgreSQL 0061 already provides the `single_owner_review_policy` table, default OFF. The source and host routes may be enabled in API and Web before this policy is activated; source/host registers must still be completely empty for enrollment.

## Read-only checks

From a clean `main` checkout at the exact approved GitHub SHA, as VPS Unix user `ap`:

```bash
python3 scripts/p2_01_single_owner_policy.py --status
python3 scripts/p2_01_single_owner_policy.py --preflight
```

The policy preflight requires: 61 migrations installed, exact active sole admin and personal role mapping matching current auth version, direct PostgreSQL LOGIN without superuser rights, registered named DB-client membership, owner policy OFF without an assigned owner, empty source and host registers/audits, no publication-enabled ranked candidates, and no policy UPDATE grant to named DB client.

Neither check modifies the database, Docker, credentials, or app configuration.

## Separate, explicit owner authorization

The owner personally authorizes the following **single DBA-only policy transaction** after confirming that their own authenticated Admin page displays source and host panels normally and no sources/hosts are present.

Set the **literal independently verified release SHA** (not a guessed, abbreviated or dynamically substituted SHA). Do not send credentials or database editor UUIDs to a chat.

```bash
(
  set -euo pipefail
  cd /home/ap/www/videonews-studio
  VNS_P2_01_SOLE_OWNER_APPROVED=AUTHORIZE_PERSONAL_OWNER_ONLY \
  VNS_P2_01_SOLE_OWNER_EXPECTED_MAIN_SHA=REPLACE_WITH_REVIEWED_40_CHAR_MAIN_SHA \
    python3 scripts/p2_01_single_owner_policy.py --apply
  python3 scripts/p2_01_single_owner_policy.py --status
)
```

No other SQL or bootstrap step is required. The helper refuses an unexpected operator acknowledgement, drifted remote main SHA, mismatched owner ID, existing sources, or policy activation already performed. It executes exactly one short database transaction with separate source/host locks, fixed owner identity, a descriptive operator reason and database timestamp. There is no password in the command and no second human identity created.

The policy update is **not** a license decision. The owner must still review each publisher's terms and metadata-use conditions, create the source as pending, approve it separately, and record a distinct host-reason before a feed runtime may use the host.

## Interpretation of proof

`PASS: Single-Owner policy status: SOLE_OWNER_ENABLED` confirms **only** the DBA governance setting and the existing personal account mapping. A complete P2-01 acceptance also needs authenticated browser and API GET/POST (audit) checks on actual permitted news sources. No feed polling, live producer/worker/ranking, or publication is started by this policy.

If the apply command exits after a database commit with ambiguous output, **do not retry**. Inspect `--status` first and reconcile manually. Never run a schema down-migration as a shortcut.
