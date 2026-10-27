import { checkFeedConsumerHealth } from "./feed-consumer-health.js";
import { FEED_PRODUCER_HEALTH_PATH } from "./feed-producer-continuous.js";

// Fail closed: Docker/Beszel observes stopped or stale continuous producer.
if (process.argv[1]?.endsWith("/feed-producer-healthcheck.js")) {
  if (process.argv.length !== 2 || !checkFeedConsumerHealth(FEED_PRODUCER_HEALTH_PATH)) {
    process.exitCode = 1;
  }
}
