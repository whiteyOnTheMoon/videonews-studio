import assert from "node:assert/strict";
import test from "node:test";
import { readEditorialQueueRoute } from "./editorial-routing.js";
import { ISOLATED_RESEARCH_QUEUE } from "./editorial-worker.js";
import { QUEUE_NAME } from "./queue.js";

const approved = {
  VNS_OUTBOX_DISPATCH_ENABLED: "true",
  VNS_STATUS_RECONCILE_ENABLED: "true",
  VNS_RESEARCH_OPERATOR_APPROVED: "true",
  VNS_EDITORIAL_QUEUE_NAME: ISOLATED_RESEARCH_QUEUE,
};

test("neither dispatcher nor status sync has a default active editorial route", () => {
  for (const component of ["dispatch", "statusSync"] as const) {
    assert.throws(() => readEditorialQueueRoute(component, {}), /not approved/);
    assert.equal(readEditorialQueueRoute(component, approved), ISOLATED_RESEARCH_QUEUE);
  }
});

test("explicit approval, component switch and isolated queue are all required", () => {
  for (const component of ["dispatch", "statusSync"] as const) {
    const relevant = [
      "VNS_RESEARCH_OPERATOR_APPROVED",
      "VNS_EDITORIAL_QUEUE_NAME",
      component === "dispatch" ? "VNS_OUTBOX_DISPATCH_ENABLED" : "VNS_STATUS_RECONCILE_ENABLED",
    ];
    for (const key of relevant) {
      const incomplete: Record<string, string> = { ...approved };
      delete incomplete[key];
      assert.throws(() => readEditorialQueueRoute(component, incomplete), /not approved/);
      assert.throws(
        () => readEditorialQueueRoute(component, { ...approved, [key]: "false" }),
        /not approved/,
      );
    }
    assert.throws(
      () =>
        readEditorialQueueRoute(component, { ...approved, VNS_EDITORIAL_QUEUE_NAME: QUEUE_NAME }),
      /not approved/,
    );
    assert.throws(
      () => readEditorialQueueRoute(component, { ...approved, VNS_EDITORIAL_QUEUE_NAME: "other" }),
      /not approved/,
    );
  }
});

test("one component may not be enabled by the other component switch", () => {
  assert.throws(
    () =>
      readEditorialQueueRoute("dispatch", { ...approved, VNS_OUTBOX_DISPATCH_ENABLED: "false" }),
    /not approved/,
  );
  assert.throws(
    () =>
      readEditorialQueueRoute("statusSync", { ...approved, VNS_STATUS_RECONCILE_ENABLED: "false" }),
    /not approved/,
  );
});
