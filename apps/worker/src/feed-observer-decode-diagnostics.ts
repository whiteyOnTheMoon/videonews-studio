import { readNasaBoundedResponseGate } from "./feed-nasa-bounded-response.js";
import type { FeedDecodeRefusalKind } from "./feed-poller.js";

/** NASA-only, disabled-by-default diagnostic. Does not authorize any new GET. */
const KINDS: ReadonlySet<FeedDecodeRefusalKind> = new Set([
  "response_invalid",
  "media_type_refused",
  "xml_unsafe",
  "xml_envelope_invalid",
  "no_supported_items",
  "no_approved_metadata",
  "official_json_invalid",
  "official_shape_invalid",
  "other",
]);

export function oneShotNasaDecodeRefusalReporter(
  env: NodeJS.ProcessEnv,
  emit: (line: string) => void = (line) => console.log(line),
): ((sourceId: string, kind: FeedDecodeRefusalKind) => void) | undefined {
  if (
    env.VNS_FEED_POLL_STAGE_DIAGNOSTICS !== "true" ||
    env.VNS_FEED_NASA_DECODE_DIAGNOSTICS !== "true"
  ) {
    return undefined;
  }
  try {
    if (!readNasaBoundedResponseGate(env)) return undefined;
  } catch {
    return undefined;
  }
  return (sourceId, kind) => {
    if (sourceId !== "nasa_news" || !KINDS.has(kind)) return;
    try {
      emit(JSON.stringify({ event: "feed_decode_refusal", sourceId: "nasa_news", kind }));
    } catch {
      // Diagnostic output cannot turn a refusal into a successful feed commit.
    }
  };
}
