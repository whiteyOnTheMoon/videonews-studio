#!/usr/bin/env bash
# Read-only GitHub package metadata check with an authenticated GitHub Actions token.
set -euo pipefail
: "${GHCR_TOKEN:?GitHub Actions token required for Packages metadata read}"
for package in videonews-studio-web videonews-studio-api; do
  status="$(curl --silent --show-error --location --output /dev/null \
    --write-out '%{http_code}' --max-time 15 \
    -H 'Accept: application/vnd.github+json' \
    -H "Authorization: Bearer ${GHCR_TOKEN}" \
    "https://api.github.com/users/whiteyOnTheMoon/packages/container/${package}")"
  case "$status" in
    404) echo "No public package detected for ${package}; private/absent not distinguishable" ;;
    200) echo "BLOCKED: ${package} is publicly visible" >&2; exit 1 ;;
    *) echo "BLOCKED: visibility check failed (HTTP ${status})" >&2; exit 1 ;;
  esac
done
echo 'Authenticated public-package check passed; manual Packages review still required'
