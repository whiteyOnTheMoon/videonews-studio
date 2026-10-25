import assert from "node:assert/strict";
import test from "node:test";
import { readResearchRedisConfig, RESEARCH_REDIS_SECRET } from "./research-redis-config.js";

const approved = {
  VNS_RESEARCH_OPERATOR_APPROVED: "true",
  VNS_REDIS_RESEARCH_PASSWORD_FILE: RESEARCH_REDIS_SECRET,
  VNS_REDIS_HOST: "redis",
  VNS_REDIS_PORT: "6379",
};
const validSecret = () => "r".repeat(60);

test("research credentials are off by default and cannot fall back to probe", () => {
  assert.throws(() => readResearchRedisConfig({}, validSecret), /not approved/);
  const probeFile = {
    ...approved,
    VNS_REDIS_RESEARCH_PASSWORD_FILE: "/run/secrets/redis_password",
  };
  assert.throws(() => readResearchRedisConfig(probeFile, validSecret), /not approved/);
  const disabled = { ...approved, VNS_RESEARCH_OPERATOR_APPROVED: "false" };
  assert.throws(() => readResearchRedisConfig(disabled, validSecret), /not approved/);
});

test("research requires dedicated named-user secret without exposing it", () => {
  const config = readResearchRedisConfig(approved, (path) => {
    assert.equal(path, RESEARCH_REDIS_SECRET);
    return "r".repeat(60) + "\n";
  });
  assert.deepEqual(config, {
    host: "redis",
    port: 6379,
    username: "vns_research",
    password: "r".repeat(60),
  });
  const failSecret = () => {
    throw new Error("private");
  };
  assert.throws(() => readResearchRedisConfig(approved, failSecret), /secret unavailable/);
  assert.throws(() => readResearchRedisConfig(approved, () => "short"), /secret invalid/);
});

test("research Redis host and port are restricted", () => {
  const foreignHost = { ...approved, VNS_REDIS_HOST: "internet.example" };
  assert.throws(() => readResearchRedisConfig(foreignHost, validSecret), /address invalid/);
  const invalidPort = { ...approved, VNS_REDIS_PORT: "0" };
  assert.throws(() => readResearchRedisConfig(invalidPort, validSecret), /address invalid/);
});
