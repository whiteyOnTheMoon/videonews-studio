import assert from "node:assert/strict";
import test from "node:test";
import {
  readContinuousProjectionAdmission,
  runContinuousProjection,
  sleepUntilNextProjection,
} from "./feed-project-continuous.js";

const valid: NodeJS.ProcessEnv = {
  VNS_P2_FEED_PROJECTION_ENABLED: "true",
  VNS_P2_FEED_PROJECTION_OPERATOR_ACK: "true",
  VNS_P2_FEED_PROJECTION_CONTINUOUS_ENABLED: "true",
  VNS_P2_FEED_PROJECTION_CONTINUOUS_OPERATOR_ACK: "true",
  VNS_P2_FEED_PROJECTION_MODE: "continuous",
  VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP: "false",
  VNS_P2_FEED_PROJECTION_DB_HOST: "postgres",
  VNS_P2_FEED_PROJECTION_DB_USER: "vns_feed_project_login_ciunit",
  VNS_P2_FEED_PROJECTION_DB_PASSWORD_FILE: "/run/secrets/vns_feed_project_db_password",
  VNS_P2_FEED_PROJECTION_SOURCE_IDS: "news_alpha,news_beta,news_gamma",
  VNS_P2_FEED_PROJECTION_LIMIT: "25",
  VNS_P2_FEED_PROJECTION_INTERVAL_MINUTES: "15",
};

test("continuous projection requires an independent opt-in, 3–5 unique sources and bounded intervals", () => {
  assert.deepEqual(readContinuousProjectionAdmission(valid), {
    sourceIds: ["news_alpha", "news_beta", "news_gamma"],
    intervalMinutes: 15,
    limit: 25,
  });
  for (const override of [
    { VNS_P2_FEED_PROJECTION_ENABLED: "false" },
    { VNS_P2_FEED_PROJECTION_OPERATOR_ACK: "false" },
    { VNS_P2_FEED_PROJECTION_CONTINUOUS_ENABLED: "false" },
    { VNS_P2_FEED_PROJECTION_CONTINUOUS_OPERATOR_ACK: "false" },
    { VNS_P2_FEED_PROJECTION_MODE: "single_pass" },
    { VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP: "true" },
    { VNS_P2_FEED_PROJECTION_SOURCE_IDS: "news_alpha,news_beta" },
    { VNS_P2_FEED_PROJECTION_SOURCE_IDS: "news_alpha,news_beta,news_alpha" },
    { VNS_P2_FEED_PROJECTION_SOURCE_IDS: "news_alpha, news_beta,news_gamma" },
    { VNS_P2_FEED_PROJECTION_SOURCE_IDS: "news_alpha,news_beta,news_gamma,news_delta,news_epsilon,news_zeta" },
    { VNS_P2_FEED_PROJECTION_SOURCE_IDS: "news_alpha;bad,news_beta,news_gamma" },
    { VNS_P2_FEED_PROJECTION_SOURCE_ID: "unreviewed_feed" },
    { VNS_P2_FEED_PROJECTION_INTERVAL_MINUTES: "1" },
    { VNS_P2_FEED_PROJECTION_INTERVAL_MINUTES: "14" },
    { VNS_P2_FEED_PROJECTION_INTERVAL_MINUTES: "61" },
    { VNS_P2_FEED_PROJECTION_DB_USER: "postgres" },
    { VNS_P2_FEED_PROJECTION_LIMIT: "101" },
    { VNS_P2_FEED_PROJECTION_DB_PASSWORD_FILE: "/tmp/unsafe" },
  ]) {
    assert.throws(() => readContinuousProjectionAdmission({ ...valid, ...override }));
  }
});

test("a projected round covers all sources under the single guarded DB contract, no automatic replay", async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  let pauses = 0;
  await runContinuousProjection(
    valid,
    controller.signal,
    async (env) => {
      assert.equal(env.VNS_P2_FEED_PROJECTION_MODE, "single_pass");
      assert.equal(env.VNS_P2_FEED_PROJECTION_DB_USER, valid.VNS_P2_FEED_PROJECTION_DB_USER);
      assert.equal(env.VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP, "false");
      seen.push(env.VNS_P2_FEED_PROJECTION_SOURCE_ID!);
    },
    async (ms) => {
      pauses++;
      assert.equal(ms, 900000);
      controller.abort();
    },
  );
  assert.deepEqual(seen, ["news_alpha", "news_beta", "news_gamma"]);
  assert.equal(pauses, 1);
});

test("a failed approved-source projection halts before touching later sources", async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  let pauses = 0;
  await assert.rejects(
    runContinuousProjection(
      valid,
      controller.signal,
      async (env) => {
        seen.push(env.VNS_P2_FEED_PROJECTION_SOURCE_ID!);
        if (seen.length === 2) throw Error("DB rights revoked");
      },
      async () => { pauses++; },
    ),
    /DB rights revoked/,
  );
  assert.deepEqual(seen, ["news_alpha", "news_beta"]);
  assert.equal(pauses, 0);
});

test("abort before startup or after first source stops further DB calls", async () => {
  const stopped = new AbortController();
  stopped.abort();
  let calls = 0;
  await runContinuousProjection(valid, stopped.signal, async () => { calls++; });
  assert.equal(calls, 0);
  const controller = new AbortController();
  await runContinuousProjection(valid, controller.signal, async () => {
    calls++;
    controller.abort();
  });
  assert.equal(calls, 1);
});

test("abortable sleep refuses invalid intervals and never leaves aborted work queued", async () => {
  const controller = new AbortController();
  for (const ms of [0, -1, 899999, 3600001, Number.NaN]) {
    assert.throws(() => sleepUntilNextProjection(ms, controller.signal));
  }
  controller.abort();
  await sleepUntilNextProjection(900000, controller.signal);
});
