#!/usr/bin/env bash
set -euo pipefail
for file in \
  apps/api/src/personal-editorial-admin.test.ts \
  apps/api/src/personal-editorial-admin.ts \
  apps/web/src/app/admin/editorial-admin.test.tsx \
  apps/web/src/app/admin/editorial-metadata-reviews.tsx \
  apps/web/src/lib/admin-editorial-proxy.test.ts \
  apps/web/src/lib/admin-editorial-proxy.ts \
  apps/web/src/lib/editorial-review-metadata.ts; do
  echo "P2_FORMAT_START:${file}"
  ./node_modules/.bin/prettier "$file" | base64 -w0
  echo
  echo "P2_FORMAT_END:${file}"
done
exit 1
