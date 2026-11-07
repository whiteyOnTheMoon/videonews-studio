import { readNasaBoundedResponseGate } from "./feed-nasa-bounded-response.js";
import type {
  FeedDecodeRefusalKind,
  FeedMetadataRejectionCounts,
  RejectedFeedTrackingQueryPreview,
} from "./feed-poller.js";

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

/**
 * Separately gated, count-only, NASA-only RSS metadata rejection review.
 * Reuses the original buffered response; never fetches, retains or logs XML.
 */
export function oneShotNasaMetadataRejectionReporter(
  env: NodeJS.ProcessEnv,
  emit: (line: string) => void = (line) => console.log(line),
): ((sourceId: string, counts: FeedMetadataRejectionCounts) => void) | undefined {
  if (
    env.VNS_FEED_NASA_REJECTION_COUNTS !== "true" ||
    !oneShotNasaDecodeRefusalReporter(env, () => undefined)
  ) {
    return undefined;
  }
  return (sourceId, counts) => {
    if (sourceId !== "nasa_news" || !counts) return;
    const reasons = counts.linkFailureReasons;
    if (!reasons) return;
    const numbers = [
      counts.scanned,
      counts.outsideApprovedPrefix,
      counts.invalidOrBlockedLink,
      counts.invalidHeadline,
      counts.invalidPublishedAt,
      counts.duplicate,
      counts.accepted,
      reasons.missingOrUnreadable,
      reasons.queryString,
      reasons.fragment,
      reasons.percentEncoded,
      reasons.dotSegments,
      reasons.invalidPublicUrl,
      reasons.nonCanonical,
      reasons.blockedOrUnapprovedScope,
      reasons.other,
    ];
    if (
      !numbers.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 20) ||
      counts.scanned < 1 ||
      counts.accepted !== 0 ||
      counts.invalidOrBlockedLink !==
        reasons.missingOrUnreadable +
          reasons.queryString +
          reasons.fragment +
          reasons.percentEncoded +
          reasons.dotSegments +
          reasons.invalidPublicUrl +
          reasons.nonCanonical +
          reasons.blockedOrUnapprovedScope +
          reasons.other ||
      counts.scanned !==
        counts.outsideApprovedPrefix +
          counts.invalidOrBlockedLink +
          counts.invalidHeadline +
          counts.invalidPublishedAt +
          counts.duplicate
    ) {
      return;
    }
    try {
      emit(
        JSON.stringify({
          event: "feed_rejected_metadata_counts",
          sourceId: "nasa_news",
          counts: {
            scanned: counts.scanned,
            outsideApprovedPrefix: counts.outsideApprovedPrefix,
            invalidOrBlockedLink: counts.invalidOrBlockedLink,
            linkFailureReasons: {
              missingOrUnreadable: reasons.missingOrUnreadable,
              queryString: reasons.queryString,
              fragment: reasons.fragment,
              percentEncoded: reasons.percentEncoded,
              dotSegments: reasons.dotSegments,
              invalidPublicUrl: reasons.invalidPublicUrl,
              nonCanonical: reasons.nonCanonical,
              blockedOrUnapprovedScope: reasons.blockedOrUnapprovedScope,
              other: reasons.other,
            },
            invalidHeadline: counts.invalidHeadline,
            invalidPublishedAt: counts.invalidPublishedAt,
            duplicate: counts.duplicate,
            accepted: counts.accepted,
          },
        }),
      );
    } catch {
      // An output failure never changes the underlying feed refusal.
    }
  };
}

/** Exact known key names only; publisher-provided values are never logged. */
const QUERY_PREVIEW_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_id",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
] as const;

/**
 * Additional default-off, NASA-only category counts for the SAME rejected RSS.
 * This never grants any query parameter admission or authorizes another GET.
 */
export function oneShotNasaQueryPreviewReporter(
  env: NodeJS.ProcessEnv,
  emit: (line: string) => void = (line) => console.log(line),
): ((sourceId: string, counts: RejectedFeedTrackingQueryPreview) => void) | undefined {
  if (
    env.VNS_FEED_NASA_QUERY_PREVIEW_COUNTS !== "true" ||
    !oneShotNasaMetadataRejectionReporter(env, () => undefined)
  ) {
    return undefined;
  }
  return (sourceId, counts) => {
    if (sourceId !== "nasa_news" || !counts || !counts.recognizedKeyCounts) return;
    const known = counts.recognizedKeyCounts;
    if (
      Object.keys(known).length !== QUERY_PREVIEW_KEYS.length ||
      !QUERY_PREVIEW_KEYS.every((key) => Object.hasOwn(known, key))
    ) {
      return;
    }
    const numbers = [
      counts.inspectedQueryLinks,
      counts.trackingKeysOnly,
      counts.unknownOrMixedKeys,
      counts.malformedOrUnusableQuery,
      counts.wouldPassExistingUrlAndMetadataGuards,
      counts.canonicalCollisions,
      ...QUERY_PREVIEW_KEYS.map((key) => known[key]),
    ];
    if (
      !numbers.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 20) ||
      counts.inspectedQueryLinks !==
        counts.trackingKeysOnly + counts.unknownOrMixedKeys + counts.malformedOrUnusableQuery ||
      counts.wouldPassExistingUrlAndMetadataGuards + counts.canonicalCollisions >
        counts.trackingKeysOnly ||
      QUERY_PREVIEW_KEYS.some((key) => known[key] > counts.trackingKeysOnly)
    ) {
      return;
    }
    try {
      emit(
        JSON.stringify({
          event: "feed_rejected_query_preview_counts",
          sourceId: "nasa_news",
          counts: {
            inspectedQueryLinks: counts.inspectedQueryLinks,
            trackingKeysOnly: counts.trackingKeysOnly,
            unknownOrMixedKeys: counts.unknownOrMixedKeys,
            malformedOrUnusableQuery: counts.malformedOrUnusableQuery,
            wouldPassExistingUrlAndMetadataGuards: counts.wouldPassExistingUrlAndMetadataGuards,
            canonicalCollisions: counts.canonicalCollisions,
            recognizedKeyCounts: Object.fromEntries(
              QUERY_PREVIEW_KEYS.map((key) => [key, known[key]]),
            ),
          },
        }),
      );
    } catch {
      // Logging cannot change the underlying feed refusal or write SQL.
    }
  };
}
