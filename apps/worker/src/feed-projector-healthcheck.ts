import { checkFeedConsumerHealth } from "./feed-consumer-health.js";
import { FEED_PROJECTOR_HEALTH_PATH } from "./feed-projector-health.js";

// Read-only, UID-scoped Docker health probe. No DB, HTTP or secrets.
if (process.argv[1]?.endsWith("/feed-projector-healthcheck.js")) {
  if (process.argv.length !== 2 || !checkFeedConsumerHealth(FEED_PROJECTOR_HEALTH_PATH)) {
    process.exitCode = 1;
  }
}
