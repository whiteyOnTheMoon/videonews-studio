import {
  readProjectionAdmission,
  runApprovedProjectionOnce,
} from "./feed-candidate-project-once.js";

const SOURCE = /^[a-z][a-z0-9_-]{2,40}$/;

export interface ContinuousProjectionAdmission {
  readonly sourceIds: readonly string[];
  readonly intervalMinutes: number;
  readonly limit: number;
}

/**
 * Separate DB-only projection of 3–5 operator-selected, currently approved
 * source identities. It cannot sign sources, fetch feeds, enqueue BullMQ
 * jobs or publish scripts. Each DB call reattests the personal PROJECTOR
 * login and verifies current source/host approvals.
 */
export function readContinuousProjectionAdmission(
  env: NodeJS.ProcessEnv,
): ContinuousProjectionAdmission {
  if (
    env.VNS_P2_FEED_PROJECTION_CONTINUOUS_ENABLED !== "true" ||
    env.VNS_P2_FEED_PROJECTION_CONTINUOUS_OPERATOR_ACK !== "true" ||
    env.VNS_P2_FEED_PROJECTION_MODE !== "continuous" ||
    env.VNS_P2_FEED_PROJECTION_SOURCE_ID !== undefined
  ) {
    throw new Error("Continuous feed projection not approved");
  }
  const ids = env.VNS_P2_FEED_PROJECTION_SOURCE_IDS?.split(",") ?? [];
  const interval = env.VNS_P2_FEED_PROJECTION_INTERVAL_MINUTES;
  if (
    ids.length < 3 ||
    ids.length > 5 ||
    ids.some((id) => !SOURCE.test(id)) ||
    new Set(ids).size !== ids.length ||
    !interval ||
    !/^(15|30|45|60)$/.test(interval)
  ) {
    throw new Error("Continuous feed projection source/interval policy invalid");
  }
  // One-shot admission remains the sole authoritative identity/credential
  // contract, reused for *each* source under the distinct projector login.
  const perSource = ids.map((sourceId) =>
    readProjectionAdmission({
      ...env,
      VNS_P2_FEED_PROJECTION_MODE: "single_pass",
      VNS_P2_FEED_PROJECTION_SOURCE_ID: sourceId,
    }),
  );
  return Object.freeze({
    sourceIds: Object.freeze(ids),
    intervalMinutes: Number(interval),
    limit: perSource[0]!.limit,
  });
}

export function sleepUntilNextProjection(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 15 * 60 * 1000 ||
    milliseconds > 60 * 60 * 1000
  ) {
    throw new Error("Continuous projection timer invalid");
  }
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      done();
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Controlled adapter accepts injected ports for CI; never retries failures. */
export async function runContinuousProjection(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  project: (env: NodeJS.ProcessEnv) => Promise<void> = runApprovedProjectionOnce,
  pause: (milliseconds: number, signal: AbortSignal) => Promise<void> = sleepUntilNextProjection,
): Promise<void> {
  const config = readContinuousProjectionAdmission(env);
  if (!signal || typeof project !== "function" || typeof pause !== "function") {
    throw new Error("Continuous projection dependencies unavailable");
  }
  while (!signal.aborted) {
    for (const sourceId of config.sourceIds) {
      if (signal.aborted) return;
      await project({
        ...env,
        VNS_P2_FEED_PROJECTION_MODE: "single_pass",
        VNS_P2_FEED_PROJECTION_SOURCE_ID: sourceId,
      });
    }
    if (signal.aborted) return;
    await pause(config.intervalMinutes * 60 * 1000, signal);
  }
}

if (process.argv[1]?.endsWith("/feed-project-continuous.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--continuous-project") {
    console.error("Continuous feed projection requires --continuous-project");
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runContinuousProjection(process.env, controller.signal);
    } catch {
      console.error("Continuous feed projection halted, no further sources processed");
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}
