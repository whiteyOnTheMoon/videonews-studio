import assert from "node:assert/strict";
import test from "node:test";
import {
  ONE_SHOT_FEED_PRODUCER_REDIS_SECRET,
  readOneShotFeedRedisAdmission,
} from "./feed-observer-redis-admission.js";

const consumer = "vns_feed_consumer_prod";
const env: NodeJS.ProcessEnv = {
  VNS_FEED_PRODUCER_REDIS_USER: "vns_feed_producer_prod",
  VNS_FEED_OBSERVER_PRODUCER_REDIS_PASSWORD_FILE: "/run/secrets/vns_feed_producer_redis_password",
};

test("single-shot admission binds two existing restricted Redis logins to exact secret", () => {
  const accounts = readOneShotFeedRedisAdmission(env, consumer);
  assert.deepEqual(accounts, {
    producerUser: "vns_feed_producer_prod",
    consumerUser: consumer,
    producerSecretPath: ONE_SHOT_FEED_PRODUCER_REDIS_SECRET,
  });
  assert.equal(Object.isFrozen(accounts), true);
});

test("single-shot refuses shared, default or unexpectedly privileged Redis users", () => {
  for (const name of [
    "",
    "default",
    "vns_worker",
    "vns_feed_producer",
    "vns_feed_consumer_prod",
    "vns_feed_observer",
    "vns_feed_producer_",
    "vns_feed_producer_ROOT",
  ]) {
    const invalid = { ...env, VNS_FEED_PRODUCER_REDIS_USER: name };
    assert.throws(() => readOneShotFeedRedisAdmission(invalid, consumer));
  }
  for (const name of ["", "default", "vns_worker", "vns_feed_producer_prod", "vns_feed_observer"]) {
    assert.throws(() => readOneShotFeedRedisAdmission(env, name));
  }
});

test("single-shot denies absent or arbitrary producer secret path before credential access", () => {
  for (const path of [
    undefined,
    "",
    "/tmp/pw",
    "/run/secrets/vns_feed_redis_password",
    "/run/secrets/vns_feed_producer_redis_password/../x",
  ]) {
    const invalid = { ...env, VNS_FEED_OBSERVER_PRODUCER_REDIS_PASSWORD_FILE: path };
    assert.throws(() => readOneShotFeedRedisAdmission(invalid, consumer));
  }
  assert.throws(() => readOneShotFeedRedisAdmission({}, consumer));
});
