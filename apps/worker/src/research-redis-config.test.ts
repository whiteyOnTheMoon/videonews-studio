import assert from "node:assert/strict";
import test from "node:test";
import { readResearchRedisConfig, RESEARCH_REDIS_SECRET } from "./research-redis-config.js";

const approved = {
  VNS_RESEARCH_OPERATOR_APPROVED: "true",
  VNS_REDIS_RESEARCH_PASSWORD_FILE: RESEARCH_REDIS_SECRET,
  VNS_REDIS_HOST: "redis",
  VNS_REDIS_PORT: "6379",
};

test("research credential defaults off and cannot fall back to probe secret", () => {
  assert.throws(() => readResearchRedisConfig({}, () => "x".repeat(50)), /not approved/);
  assert.throws(
    () => readResearchRedisConfig({ ...approved, VNS_REDIS_RESEARCH_PASSWORD_FILE: "/run/secrets/redis_password" }, () => "x".repeat(50)),
    /not approved/,
  );
  assert.throws(
    () => readResearchRedisConfig({ ...approved, VNS_RESEARCH_OPERATOR_APPROVED: "false" }, () => "x".repeat(50)),
    /not approved/,
  );
});

test("research requires dedicated named-user secret without exposing it", () => {
  const conf = readResearchRedisConfig(approved, (path) => {
    assert.equal(path, RESEARCH_REDIS_SECRET);
    return "r".repeat(60) + "\n";
  });
  assert.deepEqual(conf, {
    host: "redis",
    port: 6379,
    username: "vns_research",
    password: "r".repeat(60),
  });
  assert.throws(() => readResearchRedisConfig(approved, () => { throw Error("private"); }), /secret unavailable/);
  assert.throws(() => readResearchRedisConfig(approved, () => "short"), /secret invalid/);
});

test("research Redis host and port are restricted", () => {
  assert.throws(() => readResearchRedisConfig({ ...approved, VNS_REDIS_HOST: "internet.example" }, () => "r".repeat(60)), /address invalid/);
  assert.throws(() => readResearchRedisConfig({ ...approved, VNS_REDIS_PORT: "0" }, () => "r".repeat(60)), /address invalid/);
});
