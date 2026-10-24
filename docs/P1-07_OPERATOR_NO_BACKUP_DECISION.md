# P1-07 — Operator decision: no backups and read-only VPS preflight (2026-10-24)

**Decision status:** Operator chooses **no backups** and **zero backup budget**. The operator is willing to **consider a separate production authorization despite the lack of backups**, but has **not granted activation approval**. The operator authorized drafting commands for a **manually executed, read-only VPS inspection** only.

This is **not** evidence that the recovery gates in [the machine-readable recovery plan](p1-07-recovery-plan.json) have passed. Leave all twelve gates false and all `data`, `worker`, and `ingress` production profiles disabled. The existing [recovery runbook](P1-07_RECOVERY_RUNBOOK.md) remains the baseline for any future fully recoverable production acceptance.

## Explicit risk acknowledgement required for a later exception

Without an independent off-VPS copy, complete VPS loss, disk failure, destructive human error or credential compromise may permanently destroy editorial records, queued work, audit trails and media. GitHub source code does not preserve this state. Neither a same-host volume nor a rebuild from source proves data recovery. Real restore RPO/RTO remain unverified. A future operator risk exception must name the services/data allowed to run experimentally, describe which losses are accepted, distinguish this from a backup-compliant release, and approve a specific reversible deployment and rollback plan. No blanket exception is granted by the present decision.

## Approved scope now

Only manually executed read-only inspection of VPS operating-system resources, Docker container/volume _names_, image disk usage and Git working-tree status. Do not read or share secret values, container environment, Docker inspect output, private configuration contents, database content or SSH material. No `docker compose up`, `docker run`, `pull`, `build`, `restart`, `prune`, `volume rm`, secret generation, migrations, backup export or external requests.

Suggested command groups:

```bash
uname -srm
uptime
free -h
df -hT / /home
docker --version
docker compose version
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
docker volume ls --format '{{.Name}}'
docker system df
cd /home/ap/www/videonews-studio && git rev-parse --short HEAD && git status --short
```

Report: available RAM and disk headroom, existing container conflicts, live worker/database presence, Docker version and Git tree state. Any later changes to the existing VPS require separate explicit operator approval. No costs are authorized.
