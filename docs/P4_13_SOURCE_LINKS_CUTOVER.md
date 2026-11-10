# P4-13 – Private source-link API/Web cutover

**Status: GitHub-only preparation. NO VPS cutover is approved by this PR.**

## Exactly pinned new release

GitHub Actions run [42858472557](https://github.com/whiteyOnTheMoon/videonews-studio/actions/runs/42858472557), successful manual private `WEB_AND_API` build, image provenance revision `129b7e4687464ce17d280dfca68e475756f5943e`.

- Web: `ghcr.io/whiteyonthemoon/videonews-studio-web@sha256:104ded920a528f9b53562a322108ff105345ad85410fe8a1ea8430133a406f5f`
- API: `ghcr.io/whiteyonthemoon/videonews-studio-api@sha256:86d5074acb56fd92c6fdb8b6deeaf703a3b487cbb1e10dd383a8a3c98cf94e37`

Old live private-gallery images (rollback target):

- Web: `ghcr.io/whiteyonthemoon/videonews-studio-web@sha256:6b077023c71caf5c16fdc41e48ae4791f6acc21636b92e0529570bc740af8136`
- API: `ghcr.io/whiteyonthemoon/videonews-studio-api@sha256:88af6d3348dab85aaf287e2ffde433fda1cc39df2c6f4a78824dfea1e568af02`

Operator confirmed new digest images are locally pulled, matching release revision, old live images healthy, unchanged containers, schema 0065 installed and personal rights validated. **The new source links will only appear after a separately approved Web/API cutover.** Even after cutover they show existing previously persisted articles, NOT fresh live research.

## Security scope

`scripts/p4_13_source_links_cutover.py` is read-only by default, requiring an exact, clean, personally owned main release and matching remote main. The **preflight** checks immutable old and new images, enough disk/memory, the original private MP4 file's SHA-256/permissions, preserved existing read-only gallery API bind, personal editor credential bind, schema-65 status, exact six existing Compose overlays, and proposed seven-overlay config. No credentials, source URLs, env dumps or Compose JSON are printed.

Seventh overlay `deploy/compose.news-links-release.yaml` explicitly disables Web manual refresh, Web job status, API Redis producer, API status reader, all API acknowledgments, and source bootstrap. The existing six overlays are preserved, including `deploy/compose.private-previews.yaml`. Both render feature flags stay **false**, gallery LIST/STREAM stays **true**, and Web never receives the MP4 bind. No ports, database DDL, Redis ACL/secret changes, consumer start, paid requests, rendering or publication.

**Rollback:** existing six overlays, both original P4-12 digest images, private preview overlay retained and gallery flags enabled. This deliberately fixes the older P4-12 operator's inappropriate rollback-to-five-overlays behavior for the already migrated live baseline.

## After merge: controlled admission ONLY

At the freshly verified exact merged main SHA `EXACT_P4_13_MAIN_SHA` on the VPS as `ap`:

```bash
python3 scripts/p4_13_source_links_cutover.py --preflight --expected-operator-sha EXACT_P4_13_MAIN_SHA
```

`--preflight` performs no Docker mutation. Do not run against the previous checkout or a dirty checkout.

**Separate authorization to execute `--apply` is mandatory.** Before applying: operator verifies fresh restorable off-host backup and media rollback, previous and new image digests locally accessible, a scheduled brief API/Web interruption, protected Cloudflare/admin login, source rights, and independently tested recovery. Operators must review release PR and run successful preflight before granting a new specific VPS authorization.

The `--apply` mode is disabled unless BOTH an explicit exact argument `--operator-approval SOURCE_LINKS_API_WEB_ONLY` and an operator-owned environment assertion `VNS_P4_13_RECOVERY_VERIFIED=OPERATOR_VERIFIED_RESTORABLE_BACKUP_AND_GALLERY_ROLLBACK` are supplied. It changes ONLY API, then Web, with `docker compose up --no-deps --no-build --pull never --detach --wait`; unchanged IDs and start times of PostgreSQL/Redis/Worker are checked after each change. A catchable failure attempts one bounded rollback of API/Web to the old digest images with all six original overlays, INCLUDING the gallery. No auto-retry on ambiguous result.

A hard interruption (SIGKILL, SSH loss, VPS restart) can leave mixed old/new API/Web; inspect exact running images and Compose labels before any manual recovery. Do not blindly re-run an `--apply` command. Existing browser sessions may need renewed authentication.

## Acceptance before new feed activation

After cutover verify `--status`, signed-in owner and named editor, stored article original link, revocation hiding articles, private MP4 list/stream/range 206/download, anonymous and non-admin access denial, and unchanged Postgres/Redis/Worker containers. **No live feed producer/consumer, status Redis ACL, new secret mounts, renderer or publication may be enabled by this change.** Live manual source research is a later separately operator-approved increment.
