import { readSingleSourceCanarySelection } from "./feed-canary-source-selection.js";
import type { RegisteredResearchSource } from "./source-registry.js";

/**
 * Default cap is unchanged for every source, including NASA, unless a
 * separately acknowledged single-pass NASA-only review is explicitly enabled.
 * This is a *bounded response* exception, never a fetch authorization.
 */
export const DEFAULT_FEED_MAX_BYTES = 131072;
export const NASA_REVIEW_MAX_BYTES = 524288;
export const NASA_REVIEW_FEED_URL = "https://www.nasa.gov/news-release/feed/";
export const NASA_REVIEW_SIZE_ACK = "NASA_EXACT_SIGNED_NEWS_RELEASE_512K_ONLY";

export function readNasaBoundedResponseGate(env: NodeJS.ProcessEnv): boolean {
  const enabled = env.VNS_FEED_NASA_512K_ENABLED ?? "false";
  const acknowledgement = env.VNS_FEED_NASA_512K_OPERATOR_ACK ?? "";
  if (enabled === "false" && acknowledgement === "") return false;
  if (
    enabled !== "true" ||
    acknowledgement !== NASA_REVIEW_SIZE_ACK ||
    readSingleSourceCanarySelection(env, "single_pass") !== "nasa_news" ||
    env.VNS_FEED_RUNTIME_MODE !== "single_pass" ||
    env.VNS_FEED_SOURCE_BOOTSTRAP !== "false"
  ) {
    throw new Error("NASA extended RSS response not authorized");
  }
  return true;
}

/** This exact signed source URL must be independently verified, not CLI-supplied. */
export function feedResponseMaxBytes(
  source: Pick<RegisteredResearchSource, "id" | "status" | "access" | "usage" | "feedUrl">,
  nasaReviewEnabled: boolean,
): number {
  if (!nasaReviewEnabled) return DEFAULT_FEED_MAX_BYTES;
  if (
    source.id !== "nasa_news" ||
    source.status !== "approved" ||
    source.access !== "rss" ||
    source.usage !== "metadata_only" ||
    source.feedUrl !== NASA_REVIEW_FEED_URL
  ) {
    throw new Error("NASA signed feed response scope refused");
  }
  return NASA_REVIEW_MAX_BYTES;
}
