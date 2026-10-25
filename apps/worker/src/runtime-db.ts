import { readFileSync } from "node:fs";

/** Future service-specific LOGIN principals; no users are created here. */
export const POSTGRES_SERVICE_IDENTITIES = {
  dispatch: "vns_outbox_dispatch_login",
  statusSync: "vns_job_status_sync_login",
  research: "vns_research_writer_login",
} as const;

const secretFiles = {
  dispatch: "/run/secrets/pg_outbox_dispatch_password",
  statusSync: "/run/secrets/pg_job_status_sync_password",
  research: "/run/secrets/pg_research_writer_password",
} as const;

export type RuntimeDbService = keyof typeof POSTGRES_SERVICE_IDENTITIES;

export function requireDedicatedPostgresIdentity(service: RuntimeDbService, enabled: boolean): string {
  if (enabled !== true || !Object.hasOwn(POSTGRES_SERVICE_IDENTITIES, service)) {
    throw new Error("Dedicated PostgreSQL identity must be explicitly enabled");
  }
  return POSTGRES_SERVICE_IDENTITIES[service];
}

export function readDedicatedPostgresConfig(
  service: RuntimeDbService,
  env: NodeJS.ProcessEnv = process.env,
  readSecret: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { host: string; port: number; database: string; user: string; password: string } {
  const user = requireDedicatedPostgresIdentity(
    service,
    env.VNS_PG_RUNTIME_IDENTITIES_ENABLED === "true",
  );
  const secretPath = secretFiles[service];
  if (env.VNS_POSTGRES_RUNTIME_PASSWORD_FILE !== secretPath) {
    throw new Error("Dedicated PostgreSQL secret path mismatch");
  }
  const host = env.VNS_POSTGRES_HOST ?? "postgres";
  const port = Number(env.VNS_POSTGRES_PORT ?? "5432");
  const database = env.VNS_POSTGRES_DB ?? "videonews";
  if (
    !["postgres", "127.0.0.1"].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(database)
  ) {
    throw new Error("Dedicated PostgreSQL endpoint invalid");
  }
  let password: string;
  try {
    password = readSecret(secretPath).trimEnd();
  } catch {
    throw new Error("Dedicated PostgreSQL secret unavailable");
  }
  if (password.length < 40 || !/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error("Dedicated PostgreSQL secret invalid");
  }
  return { host, port, database, user, password };
}
