import assert from "node:assert/strict";
import test from "node:test";
import { readResearchLaunchGate, APPROVED_RESEARCH_CATALOG_PATH } from "./research-service-config.js";
import { ISOLATED_RESEARCH_QUEUE } from "./editorial-worker.js";
import { QUEUE_NAME } from "./queue.js";

const fullyOptedIn = {
  VNS_RESEARCH_WORKER_ENABLED: "true",
  VNS_RESEARCH_OPERATOR_APPROVED: "true",
  VNS_WORKER_ENABLED: "true",
  VNS_PG_RUNTIME_IDENTITIES_ENABLED: "true",
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_RESEARCH_QUEUE_NAME: "vns-research",
  VNS_RESEARCH_CATALOG_FILE: APPROVED_RESEARCH_CATALOG_PATH,
};

test("research entry cannot enable itself and refuses each missing activation gate", () => {
  assert.throws(() => readResearchLaunchGate({}), /disabled/);
  for (const key of Object.keys(fullyOptedIn) as (keyof typeof fullyOptedIn)[]) {
    const without = { ...fullyOptedIn };
    delete (without as Partial<typeof fullyOptedIn>)[key];
    assert.throws(() => readResearchLaunchGate(without), /disabled/, key);
    assert.throws(() => readResearchLaunchGate({ ...fullyOptedIn, [key]: "false" }), /disabled/, key);
  }
});

test("approved entry always uses separate queue, never shared probe queue", () => {
  assert.notEqual(ISOLATED_RESEARCH_QUEUE, QUEUE_NAME);
  assert.deepEqual(readResearchLaunchGate(fullyOptedIn), {
    queue: ISOLATED_RESEARCH_QUEUE,
    catalogPath: APPROVED_RESEARCH_CATALOG_PATH,
  });
  assert.throws(
    () => readResearchLaunchGate({ ...fullyOptedIn, VNS_RESEARCH_QUEUE_NAME: QUEUE_NAME }),
    /disabled/,
  );
  assert.throws(
    () =>
      readResearchLaunchGate({
        ...fullyOptedIn,
        VNS_RESEARCH_CATALOG_FILE: "/tmp/allow-any.json",
      }),
    /disabled/,
  );
});
