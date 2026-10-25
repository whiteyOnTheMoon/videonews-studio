import { ISOLATED_RESEARCH_QUEUE } from "./editorial-worker.js";

export type EditorialQueueService = "dispatch" | "statusSync";

/**
 * Explicitly binds editorial dispatch/status to the research-only queue.
 * Neither service can put research jobs into the running probe queue.
 * An operator must approve both the component and the separate research
 * rollout: a single generic worker flag is not sufficient.
 */
export function readEditorialQueueRoute(
  service: EditorialQueueService,
  env: NodeJS.ProcessEnv = process.env,
): typeof ISOLATED_RESEARCH_QUEUE {
  const flag =
    service === "dispatch" ? "VNS_OUTBOX_DISPATCH_ENABLED" : "VNS_STATUS_RECONCILE_ENABLED";
  if (
    (service !== "dispatch" && service !== "statusSync") ||
    env[flag] !== "true" ||
    env.VNS_RESEARCH_OPERATOR_APPROVED !== "true" ||
    env.VNS_EDITORIAL_QUEUE_NAME !== ISOLATED_RESEARCH_QUEUE
  ) {
    throw new Error("Editorial queue routing not approved");
  }
  return ISOLATED_RESEARCH_QUEUE;
}
