# P1-09: Controlled schema upgrade from 0012 to 0018

Relates to #227 and #230. This does NOT complete live provider credential management or actual cost measurement.

## Operator scope

VideoNews Studio only. Existing VPS PostgreSQL, Redis, Web/API and Worker continue running. No Docker image rebuild, service restart, paid provider call, admin key entry or backup creation is performed by the helper.

Owner declined backups for budget reasons and accepts that migration failure can cause unrecoverable data loss. Per-file transactions do not mean the whole sequence can be undone.

## Preconditions

- The GitHub PR containing this helper passes disposable PostgreSQL CI.
- VPS uses clean main and reviewed exact Git revision.
- videonews-studio-postgres-1 is healthy: PostgreSQL 17; database videonews; superuser vns.
- Exactly migration 0012 is final in ledger; all twelve prior entries match the expected versions.
- Provider roles and target tables must not exist yet.
- Root disk has at least 15 GiB free and below 85% usage, with >=1800 MiB available RAM.
- No other database migration or concurrent operator session is running.

## Read-only preflight (after approved merge)

From /home/ap/www/videonews-studio:

    bash scripts/p1_09_provider_schema_upgrade.sh preflight

If PASS, operator may run the explicit risk-acknowledgement command:

    VNS_P1_NO_BACKUP_RISK_ACCEPTED=I_ACCEPT_UNRECOVERABLE_LOSS bash scripts/p1_09_provider_schema_upgrade.sh apply

This executes real SQL DDL; no backup and no full rollback are available. Never run db/scripts/test_migrations.sh or any .down.sql on the live database. On failure, stop; never rerun blindly, drop objects or destroy data.

After successful apply:

    bash scripts/p1_09_provider_schema_upgrade.sh status

Expected: 18 migrations, disabled OpenAI/Gemini settings, zero encrypted credentials and no LOGIN for provider writer. Neither paid provider calls nor provider key acceptance is enabled.

## Still open

#227 still needs least-privilege runtime login, secure KEK, personal named-editor browser→API→DB tests and separately released Admin UI. #230 still needs genuine vendor usage, idempotent durable billing receipts, versioned prices, atomic budget finalization and controlled live test. The operator's 1 EUR live-testing cap is NOT permission to incur costs before proper automated enforcement.
