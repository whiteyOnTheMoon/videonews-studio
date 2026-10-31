import { adminAuthFromEnv } from "./auth.js";
import { adminJobsFromEnv } from "./admin-jobs.js";
import { createApiServer } from "./server.js";
import { editorAuthFromEnv } from "./editor-auth.js";
import { DormantPersonalEditorialAdmin } from "./personal-editorial-admin.js";
import {
  createPersonalEditorialSessions,
  readPersonalEditorialAdmission,
} from "./personal-editorial-runtime.js";
import { namedProviderRuntimeFromEnv } from "./named-provider-runtime.js";
import {
  DormantPersonalSourceHostAdmin,
  readPersonalSourceHostGates,
} from "./personal-source-host-admin.js";

async function start(): Promise<void> {
  const host = process.env.API_HOST ?? "127.0.0.1";
  const port = Number(process.env.API_PORT ?? "4000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT must be an integer from 1 to 65535.");
  }

  const auth = adminAuthFromEnv(process.env);
  const jobs = adminJobsFromEnv(auth, process.env);
  const editor = editorAuthFromEnv(auth, jobs, process.env);
  const personalAdmission = readPersonalEditorialAdmission(process.env);
  if (personalAdmission && (!auth || !editor)) {
    throw new Error("Personal editorial runtime requires authenticated API and editor");
  }
  const sourceHostGates = readPersonalSourceHostGates(process.env, !!personalAdmission);
  const personalSessions = personalAdmission
    ? createPersonalEditorialSessions(personalAdmission)
    : undefined;
  const personalSourceHost =
    personalSessions && auth && editor &&
    (sourceHostGates.sourceEnabled || sourceHostGates.hostEnabled)
      ? new DormantPersonalSourceHostAdmin(
          editor,
          auth,
          personalSessions,
          sourceHostGates.sourceEnabled,
          sourceHostGates.hostEnabled,
        )
      : undefined;
  const personalEditorial =
    personalAdmission && auth && editor
      ? new DormantPersonalEditorialAdmin(
          editor,
          auth,
          personalSessions!,
          true,
        )
      : undefined;

  let providerConfig: Awaited<ReturnType<typeof namedProviderRuntimeFromEnv>>;
  try {
    providerConfig = await namedProviderRuntimeFromEnv(editor, auth);
  } catch {
    await editor?.close().catch(() => undefined);
    await jobs?.close().catch(() => undefined);
    throw new Error("Named provider configuration failed startup checks");
  }

  const server = createApiServer({ auth, jobs, editor, personalEditorial, personalSourceHost, providerConfig });
  server.listen(port, host, () => {
    console.log(`VideoNews Studio API ready at http://${host}:${port}`);
  });

  async function close(): Promise<void> {
    server.close((error) => {
      if (error) process.exitCode = 1;
      void Promise.allSettled([editor?.close(), jobs?.close(), providerConfig?.close()]).then(
        (results) => {
          if (results.some((result) => result.status === "rejected")) {
            console.error("API resource shutdown failed");
            process.exitCode = 1;
          }
        },
      );
    });
  }
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

void start().catch(() => {
  // Startup diagnostics must never print provider key material or DB URLs.
  console.error("API startup failed");
  process.exitCode = 1;
});
