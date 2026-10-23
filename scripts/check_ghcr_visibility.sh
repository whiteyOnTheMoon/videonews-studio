#!/usr/bin/env bash
# Read-only GitHub package metadata check using an authenticated GitHub Actions token.
# 200 does NOT mean public: authenticated requests can return PRIVATE package metadata.
# A 200 response must be parsed and its explicit "visibility" field must be "private".
set -euo pipefail
: "${GHCR_TOKEN:?GitHub Actions token required for Packages metadata read}"

response_file="$(mktemp)"
trap 'rm -f -- "$response_file"' EXIT

for package in videonews-studio-web videonews-studio-api; do
  : > "$response_file"
  status="$(curl --silent --show-error --location --output "$response_file" \
    --write-out '%{http_code}' --max-time 15 \
    -H 'Accept: application/vnd.github+json' \
    -H "Authorization: Bearer ${GHCR_TOKEN}" \
    "https://api.github.com/users/whiteyOnTheMoon/packages/container/${package}")"

  case "$status" in
    404)
      # This cannot distinguish absence from lack of visibility; operator check is mandatory.
      echo "No visible metadata for ${package}; manually confirm no public package exists"
      ;;
    200)
      # Treat malformed JSON and unknown visibility as BLOCKED, never silently allow.
      visibility="$(python3 -c '
import json
import sys
try:
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        raise ValueError("Unexpected package payload")
    print(data.get("visibility", "unknown"))
except (ValueError, TypeError):
    print("unknown")
' < "$response_file")"
      case "$visibility" in
        private) echo "Verified private GHCR package: ${package}" ;;
        public) echo "BLOCKED: package ${package} is publicly visible" >&2; exit 1 ;;
        *) echo "BLOCKED: unknown package visibility for ${package}" >&2; exit 1 ;;
      esac
      ;;
    *)
      echo "BLOCKED: cannot verify GHCR package visibility (HTTP ${status})" >&2
      exit 1
      ;;
  esac
done
echo 'Authenticated package visibility check passed; manual Packages review still required'
