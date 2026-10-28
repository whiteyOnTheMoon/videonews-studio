import type { Job } from "bullmq";
import type { dormantOneShotTextCoordinator } from "./provider-one-shot-text-coordinator.js";
import { admitProviderQueueJob } from "./provider-job-admission.js";

/**
 * Binds a validated BullMQ job to the already SQL-guarded coordinator.
 * A future dedicated worker may inject this processor only after its own
 * authenticated producer, budget policy and operator rollout are approved.
 * This factory creates no Redis worker, provider transport or network access.
 */
export function createDormantProviderJobProcessor(
  coordinator: Pick<ReturnType<typeof dormantOneShotTextCoordinator>, "run">,
  enabled = false,
): (job: Job) => Promise<Readonly<{ reservationId: string; costMicroUsd: string; reconciled: true }>> {
  if (enabled !== true || !coordinator || typeof coordinator.run !== "function") {
    throw new Error("Provider job processor disabled");
  }
  return async (job: Job) => {
    // BullMQ can redeliver stalled or failed jobs even when opts.attempts=1.
    // Such redeliveries must never reach a second vendor dispatch.
    if (
      !job ||
      job.attemptsMade !== 0 ||
      (typeof job.stalledCounter !== "undefined" && job.stalledCounter !== 0)
    ) {
      throw new Error("Provider job replay denied");
    }
    const admitted = admitProviderQueueJob(job);
    // Only the SQL coordinator can reserve, claim, read a credential and send.
    return coordinator.run(admitted.request, admitted.prompt);
  };
}
