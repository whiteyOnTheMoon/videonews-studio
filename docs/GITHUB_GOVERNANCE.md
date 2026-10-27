> **Verbindliche Betreiberentscheidung (27.10.2026):** GitHub-Branchschutz wird nicht kostenpflichtig freigeschaltet. Die fehlende technische Erzwingung ist als dauerhafte Betreiber-Ausnahme für Phase 1 akzeptiert. Stattdessen gelten manuelle Issue-/Feature-Branch-/PR-/CI-/Merge-Freigaben. Details: [P1-Betreiberentscheidungen](P1_OPERATOR_DECISIONS_2026-10-27.md). Nachfolgende historische Pläne und offene Schutz-Häkchen sind nicht mehr verbindliche P1-Blocker; die technischen Kontrollen werden nicht als aktiviert ausgegeben.

> **Aktueller Status (25.10.2026; Audit-Nachtrag zu #152):** Die nachfolgende Datei enthält einen historischen P1-02-Einführungsplan aus dem 23.10.2026. Auf `main` sind inzwischen `backlog/issues.json`, die Import-/Governance-Skripte, die Issue-/PR-Vorlagen, CODEOWNERS und der PR-Metadatenworkflow vorhanden. Der Betreiberbericht bestätigt 69 importierte Issues, Labels und Meilensteine. P1-08-CI-Workflows sind hinzugekommen; ihre Existenz erzwingt **keine** Merge-Sperre. Der Branchschutz für das private Repository wurde laut Betreiberprüfung mit HTTP 403 verweigert. Es gibt **keinen nachgewiesenen technisch erzwungenen Pflichtreview oder Pflichtstatuscheck**. Die ausdrücklich dokumentierte P1-Ausnahme von unabhängigem Review ist kein durchgeführtes Review. P1-02 ist als Betreiber-Ausnahme geschlossen, nicht als vollständig technisch durchgesetzt. Dies ist ein Dokumentationsabgleich, keine neue technische Freigabe oder Live-Prüfung.

# P1-02 — GitHub project governance

This is the **proposed configuration**, not a claim that GitHub settings were already applied.

## Scope

- Use one stable project identifier, `P1-02`, in the issue and PR title.
- `type:`, `area:`, `priority:`, `phase:`, `status:` labels organize the backlog.
- Milestones: P0 Vorprüfung, P1 Basis, P2 Redaktion, P3 Medien, P4 Render, P5 Upload, P6 QA, P7 Pilot.
- Workflow states: Backlog → Ready → In Progress → In Review → Blocked → Done.
- Each coding task requires an issue before implementation, a feature branch, a PR with issue link, tests and independent review.
- The pull request template documents risks, budget, license and evidence checks.
- CODEOWNERS names the repository owner, but this does **not** count as independent review by another person or agent.

## Safe automated labels/milestones/issue metadata

The script needs an authenticated `gh` CLI and Python 3.10+. No token is entered into scripts or committed.

**Important dependency:** `backlog/issues.json` is currently proposed in **P1-01 PR #70**, not yet on `main`. Run the governance script only after the backlog file and this script have been merged into the checked-out branch, or deliberately supply an existing local copy via `--file`.

Inspect with **dry run**:

```bash
python3 scripts/github_governance.py \
  --repo whiteyOnTheMoon/videonews-studio \
  --file backlog/issues.json
```

Apply explicitly:

```bash
python3 scripts/github_governance.py \
  --repo whiteyOnTheMoon/videonews-studio \
  --file backlog/issues.json --apply
```

Re-run dry run to confirm no pending changes. The script:

1. Reads the canonical 69-issue backlog and validates stable IDs.
2. Discovers existing labels and all milestones; creates only missing entries.
3. Matches all open and closed GitHub issues by stable project ID, never GitHub issue number.
4. Adds missing issue labels and milestone where absent, preserving existing status and milestones.
5. Starts in dry-run mode; `--apply` is required to perform any write. Partial runs can be resumed safely.
6. Stops if any expected issue is missing or duplicated; does not modify unrelated repositories.

Note that initial labels/milestones are not automatically applied by adding this script to a PR.

## Tests and PR checks

```bash
python3 -m unittest discover -s scripts -p 'test_github_governance.py'
node --test scripts/test_check_pr.mjs
```

The minimal `PR metadata policy` workflow validates project ID in PR title and issue reference in PR body. This is **not** the full CI from P1-08; full build, type-check, lint, integration and test enforcement come later. GitHub-hosted workflow minutes should be monitored against plan quotas and do not authorize paid overages.

## Main branch rules — not yet enforced

Desired rules when supported by the repository plan:

- Pull requests required for `main`; no direct push.
- One independent approving review.
- Passing required status checks (after P1-08 workflow exists, with exact discovered check names).
- Resolve conversations before merge, prevent force pushes and deletions.
- No unilateral reviewer self-approval; do not claim CODEOWNERS alone makes reviews independent.

**Plan constraint:** GitHub Free permits branch protection/rulesets on public repositories, but GitHub documents private repository protection as requiring an eligible paid plan (GitHub Pro/Team/Enterprise). The current GitHub subscription is not verified. We will **not** upgrade, convert this private repo to public, or represent the desired rules as active without explicit approval.

If protection is supported, configure it under `Settings → Branches` or `Settings → Rules → Rulesets` after P1-08 checks exist. Do not configure a required check name until it has run successfully or it can block every PR. Until then follow the issue-first workflow manually, leave unreviewed PRs in draft, and never claim an unverified merge is approved.

## Acceptance snapshot

- [x] Source templates, CODEOWNERS and automation proposals committed to feature branch
- [x] Minimal PR metadata workflow prepared
- [ ] Run tests and independent review on P1-02 PR
- [ ] Merge P1-01 backlog prerequisite, then P1-02 once approved
- [ ] Execute governance script; verify labels/milestones on GitHub
- [ ] Confirm branch protection capability and enable required checks when available
- [ ] Formal CI and status requirements completed in P1-08

## Verifizierte Einschränkung im GitHub-Konto (23.10.2026)

Die Betreiberprüfung mit authentifizierter GitHub CLI auf dem VPS hat ergeben:

- \`gh api user --jq '.plan.name'\` lieferte \`nicht angezeigt\`; daraus lässt sich kein Tarifname ableiten.
- \`GET /repos/whiteyOnTheMoon/videonews-studio/branches/main/protection\` lieferte **HTTP 403** mit dem Hinweis: \`Upgrade to GitHub Pro or make this repository public to enable this feature.\`
- \`GET /repos/whiteyOnTheMoon/videonews-studio/rulesets\` lieferte **HTTP 403** mit demselben Hinweis. Der tatsächliche Ruleset-Bestand lässt sich aufgrund der verweigerten API-Abfrage nicht auslesen.

**Betreiberentscheidung aus P0:** Das Repository bleibt privat, und es gibt ohne gesonderte ausdrückliche Freigabe keine neuen kostenpflichtigen Dienste oder Tarif-Upgrades.

**Konsequenz:** Verpflichtende PR-Reviews, Statuschecks und Branch-Schutz können aktuell nicht als aktiv oder technisch erzwungen ausgewiesen werden. Die Issue-First-/PR-/Test-/Review-Regeln gelten als manuelle Arbeitsanweisung. Kein PR darf ohne dokumentierte Testnachweise und unabhängigen Review als abgenommen gekennzeichnet werden.

**P1-02 Restpunkt:** Branch-Schutz bleibt wegen Tarifbeschränkung offen. Vor einer formalen Erledigung entweder eine von der Betreiberseite ausdrücklich akzeptierte Abweichung dokumentieren oder eine zulässige kostenlose technische Absicherung nachweisen. Kein automatisches Upgrade; kein Wechsel zu Public.
