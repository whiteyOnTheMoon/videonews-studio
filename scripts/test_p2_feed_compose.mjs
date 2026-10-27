import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import yaml from "js-yaml";

function must(condition, message) {
  assert.ok(condition, message);
}

export function verifySignedFeedOverlay(data) {
  must(data && typeof data === "object", "Feed overlay YAML missing");
  const services = data.services;
  assert.deepEqual(Object.keys(services).sort(), [
    "feed-consumer",
    "feed-observer",
    "feed-producer",
    "feed-scheduler",
    "source-handoff-import",
    "source-publisher",
  ]);
  assert.deepEqual(Object.keys(data.networks), ["feed_egress"]);
  const profiles = {
    "source-publisher": "source-signing",
    "source-handoff-import": "source-handoff",
    "feed-observer": "feed-observation",
    "feed-scheduler": "feed-scheduler",
    "feed-producer": "feed-producer",
    "feed-consumer": "feed-consumer",
  };
  for (const [name, service] of Object.entries(services)) {
    assert.deepEqual(service.profiles, [profiles[name]]);
    must(!service.ports && !service.privileged && !service.pid, name + " exposed ports");
    must(service.restart === "no", name + " restarts automatically");
    must(service.read_only === true, name + " writable root");
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
    const roleArgs = {
      "feed-scheduler": "--bounded",
      "feed-producer": "--bounded-producer",
      "feed-consumer": "--persistent-worker",
    };
    assert.equal(service.entrypoint.at(-1), roleArgs[name] ?? "--once");
    assert.equal(service.image, "vns-worker:local");
    assert.equal(service.build.target, "worker");
    must(service.mem_limit && service.memswap_limit && service.cpus, name + " uncapped");
    must(!service.secrets, name + " unknown Docker secret defaults");
    for (const mount of service.volumes) {
      assert.equal(mount.type, "bind");
      assert.equal(mount.bind.create_host_path, false);
      must(
        mount.source.startsWith("${VNS_P2_") && mount.source.includes(":?"),
        name + " unprovisioned host bind",
      );
    }
  }
  const publisher = services["source-publisher"];
  const importer = services["source-handoff-import"];
  const observer = services["feed-observer"];
  const scheduler = services["feed-scheduler"];
  const producer = services["feed-producer"];
  const consumer = services["feed-consumer"];
  assert.equal(publisher.user, "10001:10001");
  assert.equal(importer.user, "10002:10002");
  assert.equal(observer.user, "10002:10002");
  assert.equal(scheduler.user, "10002:10002");
  assert.equal(producer.user, "10002:10002");
  assert.equal(consumer.user, "10002:10002");
  assert.deepEqual(publisher.networks, ["backend"]);
  assert.equal(importer.network_mode, "none");
  must(!importer.networks && !importer.depends_on, "importer has network connections");
  assert.deepEqual(observer.networks, ["backend", "feed_egress"]);
  assert.deepEqual(scheduler.networks, ["backend", "feed_egress"]);
  assert.deepEqual(producer.networks, ["backend"]);
  assert.deepEqual(consumer.networks, ["backend", "feed_egress"]);
  assert.deepEqual(consumer.volumes, observer.volumes);
  assert.equal(producer.volumes.length, 1);
  assert.equal(producer.volumes[0].target, "/run/secrets/vns_feed_redis_password");
  assert.equal(producer.environment.VNS_FEED_RUNTIME_MODE, "bounded_producer");
  assert.equal(consumer.environment.VNS_FEED_RUNTIME_MODE, "persistent_worker");
  assert.deepEqual(scheduler.volumes, observer.volumes);
  assert.deepEqual(scheduler.depends_on, observer.depends_on);
  must(!publisher.network_mode && !observer.network_mode, "unexpected network override");
  const mountTargets = (name) => services[name].volumes.map((x) => x.target);
  const signer = "/run/secrets/vns_source_export_signing_key";
  assert.deepEqual(mountTargets("source-publisher"), [
    "/var/lib/vns/source-publisher",
    "/run/secrets/vns_source_export_db_password",
    signer,
  ]);
  must(!mountTargets("source-handoff-import").includes(signer), "importer has signer key");
  must(!mountTargets("feed-observer").includes(signer), "observer has signer key");
  must(!mountTargets("feed-scheduler").includes(signer), "scheduler has signer key");
  must(!mountTargets("feed-producer").includes(signer), "producer has signer key");
  must(!mountTargets("feed-consumer").includes(signer), "consumer has signer key");
  must(
    !mountTargets("feed-producer").some((x) => x.includes("db_password") || x.includes("anchor")),
    "producer received DB or anchor secret",
  );
  assert.deepEqual(mountTargets("source-handoff-import"), [
    "/var/lib/vns/source-handoff",
    "/var/lib/vns/feed-source-inbox",
    "/run/secrets/vns_feed_source_public_key",
  ]);
  const stage = importer.volumes.find((x) => x.target === "/var/lib/vns/source-handoff");
  assert.equal(stage.read_only, true);
  const inbox = observer.volumes.find((x) => x.target === "/var/lib/vns/feed-source-inbox");
  assert.equal(inbox.read_only, true);
  must(
    observer.volumes.some(
      (x) => x.target === "/var/lib/vns/feed-source-checkpoint" && !x.read_only,
    ),
    "observer lacks private writable checkpoint",
  );
  assert.equal(
    importer.volumes.find((x) => x.target === "/var/lib/vns/feed-source-inbox").source,
    inbox.source,
  );
  assert.equal(
    importer.volumes.find((x) => x.target === "/run/secrets/vns_feed_source_public_key").source,
    observer.volumes.find((x) => x.target === "/run/secrets/vns_feed_source_public_key").source,
  );
  for (const [name, flags] of [
    ["source-publisher", ["VNS_SOURCE_PUBLISHER_ENABLED", "VNS_SOURCE_PUBLISHER_OPERATOR_ACK"]],
    ["source-handoff-import", ["VNS_SOURCE_HANDOFF_ENABLED", "VNS_SOURCE_HANDOFF_OPERATOR_ACK"]],
    [
      "feed-observer",
      [
        "VNS_FEED_RUNTIME_ENABLED",
        "VNS_FEED_NETWORK_APPROVED",
        "VNS_FEED_RIGHTS_ATTESTED",
        "VNS_FEED_SIGNED_EXPORT_ENABLED",
        "VNS_FEED_SOURCE_ANCHOR_APPROVED",
      ],
    ],
  ]) {
    for (const flag of flags) {
      must(
        services[name].environment[flag] === "${" + flag + ":-false}",
        name + " must default to disabled: " + flag,
      );
    }
  }
  for (const flag of ["VNS_FEED_SCHEDULER_ENABLED", "VNS_FEED_SCHEDULER_OPERATOR_ACK"]) {
    assert.equal(scheduler.environment[flag], "${" + flag + ":-false}");
  }
  assert.equal(
    scheduler.environment.VNS_FEED_SCHEDULER_MODE,
    "${VNS_FEED_SCHEDULER_MODE:-disabled}",
  );
  assert.equal(
    scheduler.environment.VNS_FEED_SCHEDULER_MAX_TICKS,
    "${VNS_FEED_SCHEDULER_MAX_TICKS:-0}",
  );
  assert.equal(
    scheduler.environment.VNS_FEED_SCHEDULER_FAILURE_LIMIT,
    "${VNS_FEED_SCHEDULER_FAILURE_LIMIT:-0}",
  );
  for (const flag of ["VNS_FEED_RUNTIME_ENABLED", "VNS_FEED_SOURCE_ANCHOR_APPROVED"]) {
    assert.equal(scheduler.environment[flag], observer.environment[flag]);
  }
  for (const [role, service] of [
    ["producer", producer],
    ["consumer", consumer],
  ]) {
    const prefix = role === "producer" ? "VNS_FEED_SEPARATE_PRODUCER" : "VNS_FEED_SEPARATE_WORKER";
    assert.equal(service.environment[prefix + "_ENABLED"], "${" + prefix + "_ENABLED:-false}");
    assert.equal(
      service.environment[prefix + "_OPERATOR_ACK"],
      "${" + prefix + "_OPERATOR_ACK:-false}",
    );
    assert.equal(service.environment.VNS_FEED_SOURCE_BOOTSTRAP, "false");
  }
  must(
    !observer.secrets && !scheduler.secrets && !consumer.secrets && !producer.secrets,
    "unexpected runtime secrets",
  );
  return true;
}

const overlay = yaml.load(
  await readFile(new URL("../compose.feed-observation.yaml", import.meta.url), "utf8"),
);
test("signed feed Compose mounts are isolated and all activation gates fail closed", () => {
  assert.equal(verifySignedFeedOverlay(overlay), true);
});

test("Compose safety check rejects exposure, wrong UID and writable staging", () => {
  for (const modify of [
    (copy) => {
      copy.services["source-handoff-import"].network_mode = "host";
    },
    (copy) => {
      copy.services["source-handoff-import"].user = "10001:10001";
    },
    (copy) => {
      copy.services["feed-observer"].ports = ["443:443"];
    },
    (copy) => {
      copy.services["source-handoff-import"].volumes[0].read_only = false;
    },
    (copy) => {
      copy.services["feed-observer"].volumes.push(
        structuredClone(copy.services["source-publisher"].volumes[2]),
      );
    },
    (copy) => {
      copy.services["feed-observer"].environment.VNS_FEED_RUNTIME_ENABLED = "true";
    },
    (copy) => {
      copy.services["source-publisher"].profiles = [];
    },
    (copy) => {
      copy.services["feed-scheduler"].environment.VNS_FEED_SCHEDULER_ENABLED = "true";
    },
    (copy) => {
      copy.services["feed-scheduler"].ports = ["443:443"];
    },
    (copy) => {
      copy.services["feed-producer"].volumes.push(
        structuredClone(copy.services["feed-consumer"].volumes[2]),
      );
    },
    (copy) => {
      copy.services["feed-consumer"].environment.VNS_FEED_SEPARATE_WORKER_ENABLED = "true";
    },
    (copy) => {
      copy.services["feed-producer"].networks = ["backend", "feed_egress"];
    },
  ]) {
    const copy = structuredClone(overlay);
    modify(copy);
    assert.throws(() => verifySignedFeedOverlay(copy));
  }
});
