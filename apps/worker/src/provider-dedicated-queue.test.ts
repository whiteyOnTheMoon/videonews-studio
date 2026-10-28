import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_QUEUE,
  PROVIDER_REDIS_PASSWORD_FILE,
  readProviderQueueConfig,
  createDormantProviderQueueWorker,
} from "./provider-dedicated-queue.js";

const env = {
  VNS_P1_PROVIDER_QUEUE_ENABLED: "true",
  VNS_P1_PROVIDER_QUEUE_OPERATOR_ACK: "true",
  VNS_P1_PROVIDER_QUEUE_NAME: PROVIDER_QUEUE,
  VNS_P1_PROVIDER_REDIS_PASSWORD_FILE: PROVIDER_REDIS_PASSWORD_FILE,
};
const password = "a".repeat(48);

test("dedicated provider queue is disabled by default before file access", () => {
  let reads = 0;
  assert.throws(
    () =>
      readProviderQueueConfig({}, () => {
        reads++;
        return password;
      }),
    /disabled/,
  );
  assert.equal(reads, 0);
});

test("explicit operator acknowledgement and dedicated Redis identity required", () => {
  for (const change of [
    { VNS_P1_PROVIDER_QUEUE_ENABLED: "false" },
    { VNS_P1_PROVIDER_QUEUE_OPERATOR_ACK: "false" },
    { VNS_P1_PROVIDER_QUEUE_NAME: "vns-jobs" },
    { VNS_P1_PROVIDER_REDIS_PASSWORD_FILE: "/tmp/password" },
    { VNS_P1_PROVIDER_LIVE_DISPATCH_ENABLED: "true" },
    { VNS_P1_PROVIDER_CANARY_ENABLED: "true" },
  ]) {
    assert.throws(() => readProviderQueueConfig({ ...env, ...change }, () => password), /disabled/);
  }
});

test("read only fixed provider Redis secret and reject weak credentials", () => {
  let seen = "";
  const actual = readProviderQueueConfig(env, (path) => {
    seen = path;
    return password + "\n";
  });
  assert.equal(seen, PROVIDER_REDIS_PASSWORD_FILE);
  assert.equal(actual.username, "vns_provider");
  assert.equal(actual.host, "redis");
  assert.equal(actual.port, 6379);
  assert.equal(actual.password, password);
  assert.equal(Object.isFrozen(actual), true);
  assert.throws(() => readProviderQueueConfig(env, () => "short"), /unavailable/);
  assert.throws(
    () =>
      readProviderQueueConfig(env, () => {
        throw new Error("secret");
      }),
    /unavailable/,
  );
});

test("worker construction requires explicit opt-in and never creates a Redis connection otherwise", () => {
  const config = readProviderQueueConfig(env, () => password);
  const coordinator = {
    async run() {
      throw new Error("No provider calls allowed");
    },
  };
  assert.throws(() => createDormantProviderQueueWorker(config, coordinator), /disabled/);
  assert.throws(
    () =>
      createDormantProviderQueueWorker(
        { ...config, username: "vns_worker" as never },
        coordinator,
        true,
      ),
    /disabled/,
  );
});
