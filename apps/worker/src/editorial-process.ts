import type { Job } from "bullmq";
import type { ResearchProcessorResult } from "./research-process.js";

export function createEditorialProcessor(
  researchHandler: ((job: Job) => Promise<ResearchProcessorResult>) | undefined,
): (job: Job) => Promise<ResearchProcessorResult> {
  return async (job) => {
    if (
      job.name !== "research" ||
      typeof job.id !== "string" ||
      !/^job-[0-9a-f]{32}$/.test(job.id) ||
      !job.data ||
      typeof job.data !== "object" ||
      Array.isArray(job.data) ||
      Object.keys(job.data).length !== 2 ||
      job.data.kind !== "research" ||
      typeof job.data.jobId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.data.jobId) ||
      job.id !== "job-" + job.data.jobId.replaceAll("-", "")
    ) {
      throw new Error("Unsupported editorial job envelope");
    }
    if (!researchHandler) throw new Error("Editorial research handler is not configured");
    const result = await researchHandler(job);
    if (
      !result ||
      result.needsEditorialReview !== true ||
      !Number.isSafeInteger(result.candidatesRecorded) ||
      result.candidatesRecorded < 1 ||
      result.candidatesRecorded > 3
    ) {
      throw new Error("Editorial research handler returned an invalid result");
    }
    return result;
  };
}
