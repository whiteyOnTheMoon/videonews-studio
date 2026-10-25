import { readFileSync } from "node:fs";
import pg from "pg";
import { readResearchRedisConfig } from "./research-redis-config.js";
import { createDormantEditorialWorker } from "./editorial-worker.js";
import { readDedicatedPostgresConfig } from "./runtime-db.js";
import { parseApprovedResearchCatalog } from "./research-catalog.js";
import { readResearchLaunchGate } from "./research-service-config.js";
import {
  createReviewedCatalogDiscovery,
  parseReviewedSourceRegistry,
} from "./source-registry.js";
import { PostgresResearchEvidenceStore, createResearchProcessor } from "./research-process.js";
import { fetchApprovedSourceDocument, readApprovedFetchPolicy } from "./source-fetch.js";

/**
 * NOT the probe worker entrypoint. No Docker Compose service references it.
 * Strict opt-in is verified before creating network clients or a BullMQ worker.
 * It consumes ONLY vns-research; existing dispatch still targets vns-jobs.
 */
async function main() {
  const gate = readResearchLaunchGate();
  const policy = readApprovedFetchPolicy();
  let catalogContents: string;
  try {
    catalogContents = readFileSync(gate.catalogPath, "utf8");
  } catch {
    throw new Error("Approved research catalog unavailable");
  }
  let registryContents: string;
  try {
    registryContents = readFileSync(gate.registryPath, "utf8");
  } catch {
    throw new Error("Reviewed source registry unavailable");
  }
  const catalog = parseApprovedResearchCatalog(catalogContents, policy);
  const registry = parseReviewedSourceRegistry(registryContents, policy);
  const dbConfig = readDedicatedPostgresConfig("research");
  const redisConfig = readResearchRedisConfig();
  const pool = new pg.Pool({
    ...dbConfig,
    max: 1,
    connectionTimeoutMillis: 4000,
    idleTimeoutMillis: 5000,
    statement_timeout: 12000,
  });
  let worker: ReturnType<typeof createDormantEditorialWorker> | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled([worker?.worker.close(), worker?.connection.quit(), pool.end()]);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  try {
    const handler = createResearchProcessor(
      new PostgresResearchEvidenceStore(pool),
      createReviewedCatalogDiscovery(catalog, registry),
      { fetch: (sourceUrl) => fetchApprovedSourceDocument(sourceUrl, policy) },
    );
    worker = createDormantEditorialWorker(redisConfig, true, handler, gate.queue);
    worker.worker.on("error", () =>
      console.error("Isolated research queue error (details omitted)"),
    );
    // Only an explicitly launched process runs the dormant factory.
    // This cannot consume the deployed probe queue.
    await worker.worker.run();
  } finally {
    await shutdown();
  }
}

try {
  await main();
} catch {
  // Raw source, SQL, Redis and credential errors must never enter logs.
  console.error("Isolated research worker unavailable or not approved");
  process.exitCode = 1;
}
