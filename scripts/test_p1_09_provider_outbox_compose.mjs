import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import yaml from "js-yaml";

const manifestPath = new URL("../deploy/compose.provider-outbox.yaml", import.meta.url);
const manifest = yaml.load(readFileSync(manifestPath, "utf8"));

export function verifyProviderOutboxCompose(source) {
  assert.deepEqual(Object.keys(source), ["services"]);
  assert.deepEqual(Object.keys(source.services), ["provider-outbox-once"]);
  const service = source.services["provider-outbox-once"];
  assert.deepEqual(service.profiles, ["provider-outbox"]);
  assert.equal(
    service.image,
    "${VNS_PROVIDER_OUTBOX_WORKER_IMAGE:?Pinned reviewed GHCR worker image required}",
  );
  assert.equal(service.build, undefined);
  assert.equal(service.ports, undefined);
  assert.equal(service.privileged, undefined);
  assert.equal(service.network_mode, undefined);
  assert.equal(service.restart, "no");
  assert.equal(service.init, true);
  assert.equal(service.read_only, true);
  assert.equal(service.user, "1000:1000");
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
  assert.ok(service.pids_limit <= 32 && service.mem_limit && service.cpus);
  assert.deepEqual(service.networks, ["backend"]);
  assert.deepEqual(service.depends_on, {
    postgres: { condition: "service_healthy" },
    redis: { condition: "service_healthy" },
  });
  assert.deepEqual(service.entrypoint, [
    "node",
    "apps/worker/dist/provider-outbox-once.js",
    "--once",
  ]);
  assert.equal(service.command, undefined);
  assert.equal(service.secrets, undefined);
  assert.equal(service.volumes.length, 1);
  const mount = service.volumes[0];
  assert.equal(mount.type, "bind");
  assert.equal(
    mount.source,
    "${VNS_PROVIDER_OUTBOX_SECRET_HOST_DIR:?Private producer secret directory required}",
  );
  assert.equal(mount.target, "/run/secrets/vns");
  assert.equal(mount.read_only, true);
  assert.equal(mount.bind.create_host_path, false);
  const env = service.environment;
  assert.equal(
    env.VNS_PROVIDER_OUTBOX_PRODUCER_ENABLED,
    "${VNS_PROVIDER_OUTBOX_PRODUCER_ENABLED:-false}",
  );
  assert.equal(
    env.VNS_PROVIDER_OUTBOX_OPERATOR_ACK,
    "${VNS_PROVIDER_OUTBOX_OPERATOR_ACK:-false}",
  );
  assert.equal(env.VNS_PROVIDER_OUTBOX_QUEUE_NAME, "vns-provider-text");
  assert.equal(env.VNS_PROVIDER_OUTBOX_PG_USER, "vns_provider_outbox_login");
  assert.equal(env.VNS_PROVIDER_OUTBOX_REDIS_USER, "vns_provider_producer");
  assert.equal(env.VNS_PROVIDER_OUTBOX_DB_NAME, "videonews");
  assert.equal(env.VNS_PROVIDER_OUTBOX_KEY_FILE, "/run/secrets/vns/provider-prompt-key");
  assert.equal(
    env.VNS_PROVIDER_OUTBOX_PG_PASSWORD_FILE,
    "/run/secrets/vns/provider-outbox-db-password",
  );
  assert.equal(
    env.VNS_PROVIDER_OUTBOX_REDIS_PASSWORD_FILE,
    "/run/secrets/vns/provider-outbox-redis-password",
  );
  assert.equal(env.VNS_P1_PROVIDER_LIVE_DISPATCH_ENABLED, "false");
  assert.equal(env.VNS_P1_PROVIDER_CANARY_ENABLED, "false");
}

test("opt-in Compose contract fails closed and isolates queue producer", () => {
  verifyProviderOutboxCompose(manifest);
});

test("weakening any critical lifecycle or credential restriction is rejected", () => {
  const cases = [
    (s) => { s.profiles = []; },
    (s) => { s.restart = "always"; },
    (s) => { s.entrypoint = ["node", "apps/worker/dist/index.js"]; },
    (s) => { s.environment.VNS_PROVIDER_OUTBOX_OPERATOR_ACK = "true"; },
    (s) => { s.environment.VNS_P1_PROVIDER_CANARY_ENABLED = "true"; },
    (s) => { s.volumes[0].read_only = false; },
    (s) => { s.volumes[0].bind.create_host_path = true; },
    (s) => { s.networks = ["frontend", "backend"]; },
    (s) => { s.image = "vns-worker:local"; },
    (s) => { s.ports = ["4001:4001"]; },
  ];
  for (const modify of cases) {
    const bad = structuredClone(manifest);
    modify(bad.services["provider-outbox-once"]);
    assert.throws(() => verifyProviderOutboxCompose(bad));
  }
});

test("Docker Compose resolves an isolated, default-off service without starting it", () => {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const dummyDigest = "a".repeat(64);
  const config = JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "-f",
        "compose.yaml",
        "-f",
        "deploy/compose.provider-outbox.yaml",
        "--profile",
        "provider-outbox",
        "config",
        "--format",
        "json",
      ],
      {
        env: {
          ...process.env,
          VNS_PROVIDER_OUTBOX_WORKER_IMAGE:
            "ghcr.io/whiteyonthemoon/videonews-studio-worker@sha256:" + dummyDigest,
          VNS_PROVIDER_OUTBOX_SECRET_HOST_DIR: "/ci/nonexistent/private-secrets",
          VNS_PROVIDER_OUTBOX_OPERATOR_ACK: "false",
          VNS_PROVIDER_OUTBOX_PRODUCER_ENABLED: "false",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const service = config.services["provider-outbox-once"];
  assert.equal(service.environment.VNS_PROVIDER_OUTBOX_PRODUCER_ENABLED, "false");
  assert.equal(service.environment.VNS_PROVIDER_OUTBOX_OPERATOR_ACK, "false");
  assert.equal(service.environment.VNS_P1_PROVIDER_CANARY_ENABLED, "false");
  assert.equal(service.environment.VNS_P1_PROVIDER_LIVE_DISPATCH_ENABLED, "false");
  assert.equal(service.restart, "no");
  assert.equal(service.networks.length, 1);
  assert.equal(service.volumes[0].read_only, true);
  assert.equal(service.volumes[0].bind.create_host_path, false);
  assert.match(service.image, /@sha256:[a-f0-9]{64}$/);
});
