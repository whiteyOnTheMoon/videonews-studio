import type { Pool } from "pg";
import { readSingleSourceCanarySelection } from "./feed-canary-source-selection.js";
import { readNasaBoundedResponseGate, feedResponseMaxBytes } from "./feed-nasa-bounded-response.js";
import {
  oneShotNasaDecodeRefusalReporter,
  oneShotNasaMetadataRejectionReporter,
  oneShotNasaQueryPreviewReporter,
} from "./feed-observer-decode-diagnostics.js";
import {
  createDormantFeedPoller,
  type FeedPollFailureStage,
  type PollResult,
} from "./feed-poller.js";
import {
  createPinnedFeedHttpsTransport,
  type FeedHttpsDependencies,
} from "./feed-https-transport.js";
import { PostgresFeedPollStore } from "./postgres-feed-poll-store.js";
import { PostgresFeedSourceAuthority } from "./postgres-feed-source-authority.js";
import { REVIEWED_SOURCE_REGISTRY_PATH } from "./research-service-config.js";
import { readApprovedFetchPolicy } from "./source-fetch.js";
import { approvedSourceForUrl, parseReviewedSourceRegistry } from "./source-registry.js";

export interface OfflineFeedSchedulerPorts {
  /** Caller-owned connection; this module must never open a database pool. */
  pool: Pool;
  /** Explicitly injected network boundary: no implicit live HTTP/DNS fallback. */
  https: FeedHttpsDependencies;
  /** Only read after all opt-in switches and host policy are validated. */
  readRegistry(path: typeof REVIEWED_SOURCE_REGISTRY_PATH): string;
}

export interface OfflineFeedScheduler {
  sourceIds: readonly string[];
  /** An operator-invoked single pass, not a timer or BullMQ registration. */
  tick(now: Date): Promise<readonly PollResult[]>;
}

/**
 * Composition-only P2-02 contract. The running probe worker does not import it.
 * No cron, queue, network connection, database login or secret is created.
 */
export function createDormantFeedScheduler(
  env: NodeJS.ProcessEnv,
  ports: OfflineFeedSchedulerPorts,
): OfflineFeedScheduler {
  if (
    env.VNS_FEED_OFFLINE_COMPOSITION_ENABLED !== "true" ||
    env.VNS_FEED_OFFLINE_OPERATOR_ACK !== "true" ||
    env.VNS_FEED_REGISTRY_FILE !== REVIEWED_SOURCE_REGISTRY_PATH
  ) {
    throw new Error("Feed scheduler composition disabled");
  }
  if (
    !ports ||
    !ports.pool ||
    typeof ports.pool.query !== "function" ||
    !ports.https ||
    typeof ports.https.resolveIPv4 !== "function" ||
    typeof ports.https.requestPinned !== "function" ||
    typeof ports.readRegistry !== "function"
  ) {
    throw new Error("Feed scheduler requires explicit test ports");
  }

  // Before loading a registry, reject unauthorized selection. The normal
  // scheduler remains unchanged with no selector.
  const selectedSourceId = readSingleSourceCanarySelection(env, env.VNS_FEED_RUNTIME_MODE ?? "");
  const nasaReviewEnabled = readNasaBoundedResponseGate(env);
  const policy = readApprovedFetchPolicy(env);
  let contents: string;
  try {
    contents = ports.readRegistry(REVIEWED_SOURCE_REGISTRY_PATH);
  } catch {
    throw new Error("Reviewed feed registry unavailable");
  }
  const registry = parseReviewedSourceRegistry(contents, policy);
  if (selectedSourceId !== null) {
    const selected = registry.find((source) => source.id === selectedSourceId);
    // NASA is deliberately selected only with a separately signed exact
    // feedUrl. Neither the operator nor this selector supplies a URL; all
    // actual paths come from the pinned signed and SQL-approved source.
    const expectedHost =
      selectedSourceId === "nasa_news"
        ? "www.nasa.gov"
        : selectedSourceId === "noaa_news"
          ? "www.noaa.gov"
          : "www.usgs.gov";
    if (
      !selected ||
      selected.status !== "approved" ||
      selected.access !== "rss" ||
      selected.usage !== "metadata_only" ||
      new URL(selected.baseUrl).hostname !== expectedHost ||
      new URL(selected.feedUrl ?? selected.baseUrl).hostname !== expectedHost ||
      approvedSourceForUrl(selected.baseUrl, registry)?.id !== selectedSourceId ||
      (selectedSourceId === "nasa_news" && !selected.feedUrl) ||
      (selectedSourceId === "usgs_news" &&
        (selected.baseUrl !== "https://www.usgs.gov/news/" ||
          selected.feedUrl !== "https://www.usgs.gov/news/149248/feed"))
    ) {
      throw new Error("Reviewed single-source canary denied");
    }
    // The exception is valid only for the exact independently signed NASA
    // news-release feed; it cannot be switched to a CLI-selected endpoint.
    if (nasaReviewEnabled) feedResponseMaxBytes(selected, true);
  }
  const store = new PostgresFeedPollStore(
    ports.pool,
    env.VNS_FEED_RUNTIME_ENABLED === "true"
      ? new Map(registry.map((source) => [source.id, source]))
      : undefined,
  );
  const transport = createPinnedFeedHttpsTransport(
    registry,
    policy,
    ports.https,
    nasaReviewEnabled,
  );
  // The explicitly authorized live one-shot mode consults the current
  // PostgreSQL source/host grants; the offline fixture mode stays injectable.
  const authority =
    env.VNS_FEED_RUNTIME_ENABLED === "true"
      ? new PostgresFeedSourceAuthority(ports.pool)
      : undefined;
  // Exact opt-in: only the real, manually triggered single-pass observer may
  // log approved source IDs and fixed failure stages. Default is silent.
  const onFailure =
    env.VNS_FEED_POLL_STAGE_DIAGNOSTICS === "true" &&
    env.VNS_FEED_RUNTIME_ENABLED === "true" &&
    env.VNS_FEED_RUNTIME_MODE === "single_pass"
      ? (sourceId: string, stage: FeedPollFailureStage) => {
          console.log(JSON.stringify({ event: "feed_poll_failure_stage", sourceId, stage }));
        }
      : undefined;
  const poller = createDormantFeedPoller(
    registry,
    true,
    store,
    transport,
    authority,
    onFailure,
    selectedSourceId ?? undefined,
    nasaReviewEnabled,
    oneShotNasaDecodeRefusalReporter(env),
    oneShotNasaMetadataRejectionReporter(env),
    oneShotNasaQueryPreviewReporter(env),
  );
  const sourceIds = Object.freeze(
    registry
      .filter(
        (source) =>
          source.status === "approved" &&
          ["rss", "atom", "official_api"].includes(source.access) &&
          approvedSourceForUrl(source.baseUrl, registry)?.id === source.id,
      )
      .map((source) => source.id),
  );
  return Object.freeze({
    sourceIds,
    tick: (now: Date) => poller.poll(now),
  });
}
