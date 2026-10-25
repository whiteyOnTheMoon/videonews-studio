import json
import sys

config = json.load(sys.stdin)
for name, flag, secret in [
    ("outbox-dispatch", "VNS_OUTBOX_DISPATCH_ENABLED", "pg_outbox_dispatch_password"),
    ("job-status-sync", "VNS_STATUS_RECONCILE_ENABLED", "pg_job_status_sync_password"),
]:
    service = config["services"][name]
    assert service["profiles"] == ["editorial-ops"]
    assert service["environment"][flag] == "false"
    assert service["environment"]["VNS_PG_RUNTIME_IDENTITIES_ENABLED"] == "false"
    assert service["environment"]["VNS_POSTGRES_RUNTIME_PASSWORD_FILE"] == "/run/secrets/" + secret
    assert not service.get("ports")
    assert service["read_only"] is True
    assert service["restart"] == "no"
    assert "frontend" not in service["networks"]
    assert service["environment"]["VNS_RESEARCH_OPERATOR_APPROVED"] == "false"
    assert service["environment"]["VNS_EDITORIAL_QUEUE_NAME"] == "vns-research"
    assert (
        service["environment"]["VNS_REDIS_RESEARCH_PASSWORD_FILE"]
        == "/run/secrets/redis_research_password"
    )
    assert {item["source"] for item in service["secrets"]} == {
        secret,
        "redis_research_password",
    }
    print("PASS:", name)
