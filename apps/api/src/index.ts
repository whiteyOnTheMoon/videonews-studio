import { adminAuthFromEnv } from "./auth.js";
import { adminJobsFromEnv } from "./admin-jobs.js";
import { createApiServer } from "./server.js";
import { editorAuthFromEnv } from "./editor-auth.js";
import { DormantPersonalEditorialAdmin } from "./personal-editorial-admin.js";
import { createPersonalEditorialSessions, readPersonalEditorialAdmission } from "./personal-editorial-runtime.js";

const host = process.env.API_HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? "4000");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT must be an integer from 1 to 65535.");
}

// Explicit opt-in only. Invalid secrets or a non-HTTPS origin prevent startup.
const auth = adminAuthFromEnv(process.env);
const jobs = adminJobsFromEnv(auth, process.env);
const editor = editorAuthFromEnv(auth, jobs, process.env);
const personalAdmission = readPersonalEditorialAdmission(process.env);
if (personalAdmission && (!auth || !editor)) {
  throw new Error("Personal editorial runtime requires authenticated API and editor");
}
const personalEditorial = personalAdmission && auth && editor
  ? new DormantPersonalEditorialAdmin(
      editor,
      auth,
      createPersonalEditorialSessions(personalAdmission),
      true,
    )
  : undefined;
const server = createApiServer({ auth, jobs, editor, personalEditorial });
server.listen(port, host, () => {
  console.log(`VideoNews Studio API ready at http://${host}:${port}`);
});

function shutdown(): void {
  server.close((error) => {
    if (error) console.error("API shutdown failed");
    void editor?.close().catch(() => {
      console.error("Editor database shutdown failed");
      process.exitCode = 1;
    });
    void jobs?.close().catch(() => {
      console.error("Admin-job database shutdown failed");
      process.exitCode = 1;
    });
    if (error) process.exitCode = 1;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
