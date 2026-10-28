import type { Job } from "bullmq";
import type { BudgetReplayRequest } from "./provider-budget-worker-bridge.js";

/**
 * A strict admission boundary for a future dedicated provider queue.
 * This does not authorize vendor dispatch. Its caller must additionally
 * establish a trusted producer, user authorization, reviewed SQL policy,
 * price provenance and a default-off runtime operator grant.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST = /^[A-Za-z0-9_-]{12,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PROMPT_LIMIT = 32768;

export type ProviderJobAdmission = Readonly<{ request: BudgetReplayRequest; prompt: string }>;

function reject(): never {
  throw new Error("Provider job admission denied");
}

export function admitProviderQueueJob(job: Pick<Job, "name" | "data" | "opts" | "id">): ProviderJobAdmission {
  if (!job || job.name !== "provider-text" || typeof job.id !== "string" || !UUID.test(job.id)) reject();
  const opts = job.opts;
  // A claimed external request can incur charges even when BullMQ sees a
  // transient error; no queue-level replay or delayed retry is acceptable.
  if (!opts || opts.attempts !== 1 || opts.repeat || opts.jobId !== job.id) reject();
  const data: unknown = job.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) reject();
  const payload = data as Record<string, unknown>;
  if (Object.keys(payload).length !== 2 || !Object.hasOwn(payload, "request") || !Object.hasOwn(payload, "prompt")) reject();
  const request = payload.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) reject();
  const row = request as Record<string, unknown>;
  if (Object.keys(row).length !== 7 ||
      !["jobId","requestId","provider","model","priceSnapshotId","maxInputTokens","maxOutputTokens"].every(k => Object.hasOwn(row,k)) ||
      row.jobId !== job.id || typeof row.jobId !== "string" || !UUID.test(row.jobId) ||
      typeof row.priceSnapshotId !== "string" || !UUID.test(row.priceSnapshotId) ||
      typeof row.requestId !== "string" || !REQUEST.test(row.requestId) ||
      (row.provider !== "openai" && row.provider !== "google_gemini") ||
      typeof row.model !== "string" || !MODEL.test(row.model) ||
      !Number.isSafeInteger(row.maxInputTokens) || !Number.isSafeInteger(row.maxOutputTokens) ||
      (row.maxInputTokens as number) < 1 || (row.maxInputTokens as number) > 32768 ||
      (row.maxOutputTokens as number) < 16 || (row.maxOutputTokens as number) > 4096 ||
      typeof payload.prompt !== "string" || !payload.prompt.trim() ||
      Buffer.byteLength(payload.prompt,"utf8") > PROMPT_LIMIT ||
      Buffer.byteLength(payload.prompt,"utf8") > (row.maxInputTokens as number)) reject();
  return Object.freeze({
    request: Object.freeze({
      jobId: row.jobId as string,
      requestId: row.requestId as string,
      provider: row.provider as BudgetReplayRequest["provider"],
      model: row.model as string,
      priceSnapshotId: row.priceSnapshotId as string,
      maxInputTokens: row.maxInputTokens as number,
      maxOutputTokens: row.maxOutputTokens as number,
    }),
    prompt: payload.prompt as string,
  });
}
