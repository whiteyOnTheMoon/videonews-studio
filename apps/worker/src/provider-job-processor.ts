import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import type { dormantOneShotTextCoordinator } from "./provider-one-shot-text-coordinator.js";
import { admitProviderQueueJob } from "./provider-job-admission.js";

/**
 * Binds a validated BullMQ job to the already SQL-guarded coordinator.
 * A future dedicated worker may inject this processor only after its own
 * authenticated producer, budget policy and operator rollout are approved.
 * This factory creates no Redis worker, provider transport or network access.
 */
type ProviderJobResult = Readonly<{
  reservationId: string;
  costMicroUsd: string;
  reconciled: true;
}>;

export type NamedProviderJobVerifier = (
  request: Parameters<ReturnType<typeof dormantOneShotTextCoordinator>["run"]>[0],
  promptDigest: string,
) => Promise<boolean>;

/** Dedicated usage-writer SQL only; never trusts Redis or caller assertions. */
export function createSqlNamedProviderJobVerifier(
  db: Pick<Pool, "query">,
): NamedProviderJobVerifier {
  if (!db || typeof db.query !== "function") {
    throw new Error("Provider job authorization unavailable");
  }
  return async (request, digest) => {
    try {
      const result = await db.query<{ authorized: boolean }>(
        "SELECT vns.verify_provider_named_job_authorization(" +
          "$1::uuid,$2::text,$3::text,$4::text,$5::uuid," +
          "$6::text,$7::integer,$8::integer) AS authorized",
        [
          request.jobId,
          request.requestId,
          request.provider,
          request.model,
          request.priceSnapshotId,
          digest,
          request.maxInputTokens,
          request.maxOutputTokens,
        ],
      );
      return result.rows.length === 1 && result.rows[0]?.authorized === true;
    } catch {
      throw new Error("Provider job authorization unavailable");
    }
  };
}

export function createDormantProviderJobProcessor(
  coordinator: Pick<ReturnType<typeof dormantOneShotTextCoordinator>, "run">,
  verify: NamedProviderJobVerifier,
  enabled = false,
): (job: Job) => Promise<ProviderJobResult> {
  if (
    enabled !== true ||
    !coordinator ||
    typeof coordinator.run !== "function" ||
    typeof verify !== "function"
  ) {
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
    const digest = createHash("sha256").update(admitted.prompt, "utf8").digest("hex");
    let authorized = false;
    try {
      authorized = (await verify(admitted.request, digest)) === true;
    } catch {
      throw new Error("Provider job authorization unavailable");
    }
    if (!authorized) throw new Error("Provider job authorization denied");
    // Only the SQL coordinator can reserve, claim, read a credential and send.
    return coordinator.run(admitted.request, admitted.prompt);
  };
}
