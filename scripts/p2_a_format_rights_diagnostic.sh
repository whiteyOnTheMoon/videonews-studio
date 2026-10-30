#!/usr/bin/env bash
set -euo pipefail
echo P2_RIGHTS_MD_START
./node_modules/.bin/prettier docs/P2_A_OFFICIAL_FEED_RIGHTS_REVIEW_2026-10-29.md | base64 -w0
echo
echo P2_RIGHTS_MD_END
exit 1
