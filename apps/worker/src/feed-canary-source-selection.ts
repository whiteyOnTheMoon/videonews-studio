/**
 * Explicit P2-02 operator-only, narrowly scoped one-source observation.
 * The full 3-5 source signed registry must remain intact; this only changes
 * which already-approved source may acquire a lease in a manual single pass.
 * No default or automatic enablement. No secrets or network ports here.
 */
export const P2_NOAA_CANARY_SOURCE = "noaa_news" as const;
export const P2_NOAA_CANARY_ACK = "NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY" as const;

export function readSingleSourceCanarySelection(
  env: NodeJS.ProcessEnv,
  expectedMode: string,
): typeof P2_NOAA_CANARY_SOURCE | null {
  const selected = env.VNS_FEED_CANARY_SOURCE_ID ?? "";
  const acknowledgement = env.VNS_FEED_CANARY_OPERATOR_ACK ?? "";
  if (selected === "" && acknowledgement === "") return null;
  if (
    selected !== P2_NOAA_CANARY_SOURCE ||
    acknowledgement !== P2_NOAA_CANARY_ACK ||
    expectedMode !== "single_pass" ||
    env.VNS_FEED_RUNTIME_MODE !== "single_pass" ||
    env.VNS_FEED_RUNTIME_ENABLED !== "true" ||
    env.VNS_FEED_SOURCE_BOOTSTRAP !== "false"
  ) {
    throw new Error("Feed one-source canary gate refused");
  }
  return P2_NOAA_CANARY_SOURCE;
}
