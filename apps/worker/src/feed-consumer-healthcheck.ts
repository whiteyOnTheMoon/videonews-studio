import { checkFeedConsumerHealth } from "./feed-consumer-health.js";

// Read-only container health probe. Do not leak status-file contents or secrets.
if (process.argv[1]?.endsWith("/feed-consumer-healthcheck.js")) {
  if (process.argv.length !== 2 || !checkFeedConsumerHealth()) {
    process.exitCode = 1;
  }
}
