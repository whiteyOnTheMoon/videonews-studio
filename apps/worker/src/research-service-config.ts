import { ISOLATED_RESEARCH_QUEUE } from "./editorial-worker.js";

export const APPROVED_RESEARCH_CATALOG_PATH =
  "/run/secrets/approved_research_sources.json" as const;

/**
 * This is an intentionally redundant rollout gate. No environment defaults
 * activate editorial jobs. The research queue is NOT the running probe queue.
 * Further production approval is required to wire a dispatcher to this queue.
 */
export function readResearchLaunchGate(env: NodeJS.ProcessEnv = process.env): {
  queue: typeof ISOLATED_RESEARCH_QUEUE;
  catalogPath: typeof APPROVED_RESEARCH_CATALOG_PATH;
} {
  if (
    env.VNS_RESEARCH_WORKER_ENABLED !== "true" ||
    env.VNS_RESEARCH_OPERATOR_APPROVED !== "true" ||
    env.VNS_WORKER_ENABLED !== "true" ||
    env.VNS_PG_RUNTIME_IDENTITIES_ENABLED !== "true" ||
    env.VNS_SOURCE_FETCH_ENABLED !== "true" ||
    env.VNS_RESEARCH_QUEUE_NAME !== ISOLATED_RESEARCH_QUEUE ||
    env.VNS_RESEARCH_CATALOG_FILE !== APPROVED_RESEARCH_CATALOG_PATH
  ) {
    throw new Error("Research worker activation is disabled");
  }
  return { queue: ISOLATED_RESEARCH_QUEUE, catalogPath: APPROVED_RESEARCH_CATALOG_PATH };
}
