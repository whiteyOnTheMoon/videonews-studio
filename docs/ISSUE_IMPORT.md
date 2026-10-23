# P1-01 — GitHub issue bootstrap

Repository: `whiteyOnTheMoon/videonews-studio`

## Initial import (2026-10-23)

The project backlog was imported into GitHub from the original `GitHub_Issues_Backlog_VideoNews_Studio.json` (snapshot 2026-10-22). The canonical copy is `backlog/issues.json`.

- **69** planned issues across P0–P7 created.
- **69** unique stable project IDs (`P0-01` through `P7-07`).
- **0** missing IDs and **0** duplicate IDs in the post-import GitHub search.
- GitHub issue **#1** is **P1-01**; GitHub numeric issue numbers are not project IDs.
- Previously planned P0 work is still represented by open issues until its formal governance/acceptance status is reconciled.
- Labels, milestones, templates, branch rules and code review settings belong to **P1-02**. They were not configured by the initial import.

## Safe rerun

Requires Node.js **20+**, GitHub access with repository Issues read/write, and an authenticated GitHub CLI (`gh`) to supply a token at runtime. No token should be added to this repository, pasted into prompts, or committed.

Run tests:

```bash
node --test scripts/import-issues.test.mjs
```

Read-only dry run (default):

```bash
GH_TOKEN="$(gh auth token)" node scripts/import-issues.mjs \
  --repo whiteyOnTheMoon/videonews-studio
```

Explicitly create only **missing** IDs:

```bash
GH_TOKEN="$(gh auth token)" node scripts/import-issues.mjs \
  --repo whiteyOnTheMoon/videonews-studio --apply
```

This importer fetches **all** GitHub issues (open and closed, paginated), compares project IDs rather than numeric GitHub issue numbers, and aborts on duplicate IDs in either the source or repository. On an unchanged repository, the dry run and apply run both report `missing: 0` and create nothing.

The importer intentionally does **not** close existing issues, modify their bodies, or create labels/milestones. Those are separate governance decisions.

## Review and acceptance

- [x] Private GitHub repository exists
- [x] Full JSON backlog imported and unique project IDs verified
- [x] Importer and unit test sources proposed in a feature branch
- [ ] Run repository unit tests and independent code review
- [ ] Approve CI requirements and merge PR with P1-01 reference
- [ ] Mark P1-01 complete after the formal checks
