#!/usr/bin/env bash
# Temporary CI-only output of Prettier-formatted public source for review.
set -euo pipefail
for file in \
  apps/api/src/personal-editorial-admin.test.ts \
  apps/api/src/personal-editorial-admin.ts \
  apps/web/src/app/admin/editorial-admin.test.tsx \
  apps/web/src/app/admin/editorial-ranking-policy.tsx \
  apps/web/src/lib/admin-editorial-proxy.test.ts \
  apps/web/src/lib/admin-editorial-proxy.ts \
  apps/web/src/lib/editorial-ranking-policy.ts; do
  echo "P2_FORMAT_START:${file}"
  ./node_modules/.bin/prettier "$file" | base64 -w0
  echo
  echo "P2_FORMAT_END:${file}"
done
exit 1
