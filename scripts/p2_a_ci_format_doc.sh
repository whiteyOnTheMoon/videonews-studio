#!/usr/bin/env bash
set -euo pipefail
echo P2_DOC_FORMAT_START
./node_modules/.bin/prettier docs/P2_A_RANKED_READ_FRESHNESS_0056.md | base64 -w0
echo
echo P2_DOC_FORMAT_END
exit 1
