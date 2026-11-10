/**
 * Separately approved, default-off NOAA-only source selection for the
 * click-triggered Studio feed consumer. Never usable by a producer, observer,
 * scheduler, or ordinary multi-source consumer.
 *
 * The full signed/anchored registry is still verified by trusted-context.
 * This selector only narrows which source is polled in an admitted job.
 */
export const STUDIO_MANUAL_NOAA_ACK = "NOAA_STUDIO_MANUAL_METADATA_ONLY_CONSUMER_APPROVED" as const;

export function readStudioManualNoaaSelection(
  env: NodeJS.ProcessEnv,
  expectedMode: string,
): "noaa_news" | null {
  const enabled = env.VNS_FEED_STUDIO_NOAA_ONLY_ENABLED ?? "";
  const approval = env.VNS_FEED_STUDIO_NOAA_ONLY_OPERATOR_ACK ?? "";
  const sourceId = env.VNS_FEED_STUDIO_SOURCE_ID ?? "";

  // An explicit false is safe only when no other selector setting exists.
  if ((enabled === "" || enabled === "false") && approval === "" && sourceId === "") {
    return null;
  }
  if (
    enabled !== "true" ||
    approval !== STUDIO_MANUAL_NOAA_ACK ||
    sourceId !== "noaa_news" ||
    expectedMode !== "persistent_worker" ||
    env.VNS_FEED_RUNTIME_MODE !== "persistent_worker" ||
    env.VNS_FEED_RUNTIME_ENABLED !== "true" ||
    env.VNS_FEED_SOURCE_BOOTSTRAP !== "false" ||
    env.VNS_FEED_SEPARATE_WORKER_ENABLED !== "true" ||
    env.VNS_FEED_SEPARATE_WORKER_OPERATOR_ACK !== "true" ||
    (env.VNS_FEED_CANARY_SOURCE_ID ?? "") !== "" ||
    (env.VNS_FEED_CANARY_OPERATOR_ACK ?? "") !== ""
  ) {
    throw new Error("Studio manual NOAA source gate refused");
  }
  return "noaa_news";
}
