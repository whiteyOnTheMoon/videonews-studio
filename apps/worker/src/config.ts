export interface WorkerConfig {
  maxRenderConcurrency: number;
}

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const value = Number(env.MAX_RENDER_CONCURRENCY ?? "1");
  if (!Number.isInteger(value) || value !== 1) {
    throw new Error("MVP worker requires MAX_RENDER_CONCURRENCY=1.");
  }
  return { maxRenderConcurrency: value };
}
