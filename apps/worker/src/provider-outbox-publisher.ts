import { isDeepStrictEqual } from "node:util";
import { openProviderPrompt } from "@vns/shared";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { QUEUE_PREFIX } from "./queue.js";
import { admitProviderQueueJob } from "./provider-job-admission.js";
import { PROVIDER_QUEUE } from "./provider-dedicated-queue.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REQUEST = /^[A-Za-z0-9_-]{12,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export type SealedOutboxRow = Readonly<{
  job_id: string;
  request_id: string;
  provider: string;
  model: string;
  price_snapshot_id: string;
  prompt_sha256: string;
  max_input_tokens: number;
  max_output_tokens: number;
  envelope_version: number;
  iv_base64: string;
  tag_base64: string;
  ciphertext_base64: string;
}>;

export type ProviderOutboxJob = Pick<Job, "id" | "name" | "data" | "opts">;

export interface ProviderRedisQueuePort {
  getJob(id: string): Promise<ProviderOutboxJob | undefined | null>;
  add(
    name: string,
    data: unknown,
    opts: Readonly<{
      jobId: string;
      attempts: 1;
      removeOnComplete: false;
      removeOnFail: false;
    }>,
  ): Promise<ProviderOutboxJob>;
}

function deny(): never {
  throw new Error("Provider outbox delivery unavailable");
}

function admittedRow(raw: unknown): SealedOutboxRow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) deny();
  const row = raw as Record<string, unknown>;
  if (
    Object.keys(row).length !== 12 ||
    !UUID.test(row.job_id as string) ||
    !UUID.test(row.price_snapshot_id as string) ||
    !REQUEST.test(row.request_id as string) ||
    (row.provider !== "openai" && row.provider !== "google_gemini") ||
    !MODEL.test(row.model as string) ||
    !DIGEST.test(row.prompt_sha256 as string) ||
    !Number.isInteger(row.max_input_tokens) ||
    !Number.isInteger(row.max_output_tokens) ||
    (row.max_input_tokens as number) < 1 ||
    (row.max_input_tokens as number) > 32768 ||
    (row.max_output_tokens as number) < 16 ||
    (row.max_output_tokens as number) > 4096 ||
    row.envelope_version !== 1 ||
    typeof row.iv_base64 !== "string" ||
    typeof row.tag_base64 !== "string" ||
    typeof row.ciphertext_base64 !== "string"
  ) {
    deny();
  }
  return row as SealedOutboxRow;
}

function verifiedQueueJob(
  job: ProviderOutboxJob | null | undefined,
  id: string,
  data: unknown,
): void {
  if (
    !job ||
    job.id !== id ||
    job.name !== "provider-text" ||
    !isDeepStrictEqual(job.data, data) ||
    !job.opts ||
    job.opts.jobId !== id ||
    job.opts.attempts !== 1 ||
    job.opts.removeOnComplete !== false ||
    job.opts.removeOnFail !== false ||
    Object.hasOwn(job.opts, "repeat") ||
    (job.opts.delay !== undefined && job.opts.delay !== 0)
  ) {
    deny();
  }
  admitProviderQueueJob(job as Pick<Job, "id" | "name" | "data" | "opts">);
}

/**
 * Explicitly dormant one-shot SQL -> Redis producer. Reads only the restricted
 * SECURITY DEFINER function, decrypts with a separate 32-byte private key,
 * checks the immutable digest, and verifies any job-ID collision byte-for-byte.
 *
 * SQL receipt follows Redis inspection. On a crash between the two, the next
 * call may acknowledge the *same* retained BullMQ job but never replace it.
 * Permanent Redis retention and independent SQL one-shot dispatch claim are
 * prerequisites for any future live rollout.
 */
export function dormantProviderOutboxPublisher(
  sql: Pick<Pool, "query">,
  queue: ProviderRedisQueuePort,
  withPromptKey: <T>(fn: (key: Buffer) => Promise<T>) => Promise<T>,
  enabled = false,
) {
  if (
    enabled !== true ||
    !sql ||
    typeof sql.query !== "function" ||
    !queue ||
    typeof queue.add !== "function" ||
    typeof queue.getJob !== "function" ||
    typeof withPromptKey !== "function"
  ) {
    throw new Error("Provider outbox publisher disabled");
  }

  return Object.freeze({
    async runOnce(limit = 5): Promise<Readonly<{ verified: number; acknowledged: number }>> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) deny();
      try {
        const read = await sql.query<SealedOutboxRow>(
          "SELECT * FROM vns.read_authorized_provider_outbox($1::integer)",
          [limit],
        );
        if (!Array.isArray(read.rows) || read.rows.length > limit) deny();
        const ids = new Set<string>();
        let acknowledged = 0;
        for (const raw of read.rows) {
          const row = admittedRow(raw);
          if (ids.has(row.job_id)) deny();
          ids.add(row.job_id);
          const data = await withPromptKey(async (key) => {
            const prompt = openProviderPrompt(
              {
                version: 1,
                sha256: row.prompt_sha256,
                iv: row.iv_base64,
                tag: row.tag_base64,
                ciphertext: row.ciphertext_base64,
              },
              key,
            );
            return {
              request: {
                jobId: row.job_id,
                requestId: row.request_id,
                provider: row.provider,
                model: row.model,
                priceSnapshotId: row.price_snapshot_id,
                maxInputTokens: row.max_input_tokens,
                maxOutputTokens: row.max_output_tokens,
              },
              prompt,
            };
          });
          const opts = {
            jobId: row.job_id,
            attempts: 1 as const,
            removeOnComplete: false as const,
            removeOnFail: false as const,
          };
          // Validate the exact consumer contract before a Redis side effect.
          admitProviderQueueJob({ id: row.job_id, name: "provider-text", data, opts });
          const existing = await queue.getJob(row.job_id);
          if (existing) {
            verifiedQueueJob(existing, row.job_id, data);
          } else {
            const created = await queue.add("provider-text", data, opts);
            verifiedQueueJob(created, row.job_id, data);
          }
          // Independently read back the persisted Redis job before SQL ACK.
          verifiedQueueJob(await queue.getJob(row.job_id), row.job_id, data);
          const ack = await sql.query<{ acknowledged: boolean }>(
            "SELECT vns.ack_provider_outbox_delivery($1::uuid) AS acknowledged",
            [row.job_id],
          );
          if (ack.rows.length !== 1 || ack.rows[0]?.acknowledged !== true) deny();
          acknowledged++;
        }
        return Object.freeze({ verified: ids.size, acknowledged });
      } catch {
        // Never expose encrypted payload, plaintext prompt or credentials.
        deny();
      }
    },
  });
}

/** Queue name and prefix are shared with the dormant consumer. */
export const PROVIDER_OUTBOX_REDIS_TARGET = Object.freeze({
  name: PROVIDER_QUEUE,
  prefix: QUEUE_PREFIX,
});
