import type { Pool } from "pg";
import {
  dormantProviderBudgetBridge,
} from "./provider-budget-worker-bridge.js";
import {
  dormantPostClaimCredentialScope,
  type WorkerMasterKeyScope,
} from "./provider-claimed-credential-scope.js";
import {
  dormantOneShotTextCoordinator,
} from "./provider-one-shot-text-coordinator.js";
import type { DormantTextTransport } from "./provider-native-text-transport.js";
import { attestSeparatedProviderWorkerDatabases } from "./provider-worker-db-admission.js";

/**
 * A production-shaped composition contract, not a running service:
 * - separate SQL connections, each individually verified
 * - injected provider transport (none constructed here)
 * - encrypted key scope only after the irreversible SQL claim
 * - no job subscription, credentials, environment activation or network
 */
export async function dormantSeparatedProviderWorker(
  budgetDb: Pick<Pool, "query" | "connect">,
  secretDb: Pick<Pool, "query">,
  transport: DormantTextTransport,
  withKey: WorkerMasterKeyScope,
  enabled = false,
) {
  if (
    enabled !== true ||
    !budgetDb ||
    !secretDb ||
    budgetDb === secretDb ||
    !transport ||
    typeof transport.send !== "function" ||
    typeof withKey !== "function"
  ) {
    throw new Error("Provider worker composition disabled");
  }
  await attestSeparatedProviderWorkerDatabases(budgetDb, secretDb, false);
  const budget = dormantProviderBudgetBridge(budgetDb, true);
  const credentials = dormantPostClaimCredentialScope(secretDb, true, withKey);
  return dormantOneShotTextCoordinator(budget, transport, credentials, true);
}
