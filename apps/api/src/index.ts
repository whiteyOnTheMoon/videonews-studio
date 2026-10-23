import { adminAuthFromEnv } from "./auth.js";
import { adminJobsFromEnv } from "./admin-jobs.js";
import { createApiServer } from "./server.js";

const host = process.env.API_HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? "4000");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT must be an integer from 1 to 65535.");
}

// Explicit opt-in only. Invalid secrets or a non-HTTPS origin prevent startup.
const auth = adminAuthFromEnv(process.env);
const jobs = adminJobsFromEnv(auth, process.env);
const server = createApiServer({ auth, jobs });
server.listen(port, host, () => {
  console.log(`VideoNews Studio API ready at http://${host}:${port}`);
});

function shutdown(): void {
  server.close((error) => {
    if (error) console.error("API shutdown failed");
    void jobs?.close().catch(() => {
      console.error("Admin-job database shutdown failed");
      process.exitCode = 1;
    });
    if (error) process.exitCode = 1;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
