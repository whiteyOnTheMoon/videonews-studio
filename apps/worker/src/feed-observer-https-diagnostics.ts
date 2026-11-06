import { readSingleSourceCanarySelection } from "./feed-canary-source-selection.js";
import type { FeedHttpsDependencies, FeedHttpsRefusalKind } from "./feed-https-transport.js";

/**
 * The ordinary live worker intentionally reports only the broad poll stage.
 * With an EXACT operator-selected one-shot canary and explicit diagnostics,
 * report one bounded reason from the transport's existing closed taxonomy.
 * Never log upstream URLs, addresses, headers, bodies, exceptions or secrets.
 */
const KINDS: ReadonlySet<FeedHttpsRefusalKind> = new Set([
  "dns_unavailable",
  "dns_address_refused",
  "https_unavailable",
  "request_timeout",
  "http_status_refused",
  "response_size_refused",
  "response_stream_refused",
  "response_compression_refused",
  "response_framing_refused",
  "response_header_refused",
  "response_media_type_refused",
  "response_utf8_refused",
  "response_304_body_refused",
]);

export function oneShotFeedHttpsRefusalReporter(
  env: NodeJS.ProcessEnv,
  emit: (line: string) => void = (line) => console.log(line),
): FeedHttpsDependencies["onRefusal"] | undefined {
  if (env.VNS_FEED_POLL_STAGE_DIAGNOSTICS !== "true") return undefined;

  let source: "noaa_news" | "usgs_news" | null;
  try {
    source = readSingleSourceCanarySelection(env, "single_pass");
  } catch {
    return undefined;
  }
  if (source === null) return undefined;

  return (sourceId, refusal) => {
    if (sourceId !== source || !refusal || !KINDS.has(refusal.kind)) return;
    const event: {
      event: "feed_https_refusal";
      sourceId: "noaa_news" | "usgs_news";
      kind: FeedHttpsRefusalKind;
      httpStatus?: number;
      phase?: "before_headers" | "response_body";
      bodySizeBand?: "zero" | "under_limit" | "over_limit";
      declaredLengthBand?: "missing" | "under_limit" | "over_limit" | "invalid";
    } = { event: "feed_https_refusal", sourceId: source, kind: refusal.kind };

    if (
      refusal.kind === "http_status_refused" &&
      Number.isInteger(refusal.httpStatus) &&
      refusal.httpStatus !== undefined &&
      refusal.httpStatus >= 100 &&
      refusal.httpStatus <= 599
    ) {
      event.httpStatus = refusal.httpStatus;
    }
    if (refusal.phase === "before_headers" || refusal.phase === "response_body") {
      event.phase = refusal.phase;
    }
    if (
      refusal.bodySizeBand === "zero" ||
      refusal.bodySizeBand === "under_limit" ||
      refusal.bodySizeBand === "over_limit"
    ) {
      event.bodySizeBand = refusal.bodySizeBand;
    }
    if (
      refusal.declaredLengthBand === "missing" ||
      refusal.declaredLengthBand === "under_limit" ||
      refusal.declaredLengthBand === "over_limit" ||
      refusal.declaredLengthBand === "invalid"
    ) {
      event.declaredLengthBand = refusal.declaredLengthBand;
    }
    try {
      emit(JSON.stringify(event));
    } catch {
      // Logging must not alter a transport refusal or cause a second fetch.
    }
  };
}
