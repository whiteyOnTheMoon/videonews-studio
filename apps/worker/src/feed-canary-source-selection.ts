/**
 * Exact, operator-selected single-pass diagnostic subsets. A selected canary
 * never changes the verified full signed registry, independent host rights,
 * source revision anchor or the normal unselected scheduler's behavior.
 */
export const P2_NOAA_CANARY_SOURCE = "noaa_news" as const;
export const P2_NOAA_CANARY_ACK = "NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY" as const;
export const P2_USGS_CANARY_SOURCE = "usgs_news" as const;
export const P2_USGS_CANARY_ACK = "USGS_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY" as const;

export type P2OneShotSourceCanary =
  | typeof P2_NOAA_CANARY_SOURCE
  | typeof P2_USGS_CANARY_SOURCE;

export function readSingleSourceCanarySelection(
  env: NodeJS.ProcessEnv,
  expectedMode: string,
): P2OneShotSourceCanary | null {
  const selected = env.VNS_FEED_CANARY_SOURCE_ID ?? "";
  const acknowledgement = env.VNS_FEED_CANARY_OPERATOR_ACK ?? "";
  if (selected === "" && acknowledgement === "") return null;
  const authorized =
    (selected === P2_NOAA_CANARY_SOURCE && acknowledgement === P2_NOAA_CANARY_ACK) ||
    (selected === P2_USGS_CANARY_SOURCE && acknowledgement === P2_USGS_CANARY_ACK);
  if (
    !authorized ||
    expectedMode !== "single_pass" ||
    env.VNS_FEED_RUNTIME_MODE !== "single_pass" ||
    env.VNS_FEED_RUNTIME_ENABLED !== "true" ||
    env.VNS_FEED_SOURCE_BOOTSTRAP !== "false"
  ) {
    throw new Error("Feed one-source canary gate refused");
  }
  return selected as P2OneShotSourceCanary;
}
