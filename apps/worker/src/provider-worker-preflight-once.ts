import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import pg, { type Pool } from "pg";
import {
  PROVIDER_WORKER_DB_IDENTITIES,
  attestSeparatedProviderWorkerDatabases,
} from "./provider-worker-db-admission.js";

export const PROVIDER_WORKER_PREFLIGHT_FILES = Object.freeze({
  usage: "/run/secrets/vns_provider_usage_db_password",
  secret: "/run/secrets/vns_provider_secret_db_password",
});

const FAIL = "Provider worker preflight unavailable";
const PASSWORD = /^[A-Za-z0-9_-]{40,256}$/;

export function readProviderWorkerPreflightAdmission(env: NodeJS.ProcessEnv): void {
  if (
    env.VNS_P1_PROVIDER_PREFLIGHT_ENABLED !== "true" ||
    env.VNS_P1_PROVIDER_PREFLIGHT_OPERATOR_ACK !== "true" ||
    env.VNS_P1_PROVIDER_PREFLIGHT_MODE !== "read_only" ||
    env.VNS_P1_PROVIDER_USAGE_PASSWORD_FILE !== PROVIDER_WORKER_PREFLIGHT_FILES.usage ||
    env.VNS_P1_PROVIDER_SECRET_PASSWORD_FILE !== PROVIDER_WORKER_PREFLIGHT_FILES.secret ||
    env.VNS_P1_PROVIDER_DB_HOST !== "postgres" ||
    env.VNS_P1_PROVIDER_LIVE_DISPATCH_ENABLED === "true" ||
    env.VNS_P1_PROVIDER_CANARY_ENABLED === "true"
  ) {
    throw new Error(FAIL);
  }
}

function privatePassword(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.size < 40 ||
      stats.size > 257 ||
      (stats.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid() && stats.uid !== 0)
    )
      throw new Error(FAIL);
    const result = readFileSync(fd, "utf8").trimEnd();
    if (!PASSWORD.test(result)) throw new Error(FAIL);
    return result;
  } catch {
    throw new Error(FAIL);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type PreflightDbFactory = (
  role: "usage" | "secret",
  password: string,
) => Pick<Pool, "query" | "end">;

const defaultFactory: PreflightDbFactory = (role, password) =>
  new pg.Pool({
    host: "postgres",
    port: 5432,
    database: "videonews",
    user: PROVIDER_WORKER_DB_IDENTITIES[role],
    password,
    options: "-c default_transaction_read_only=on",
    max: 1,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 3000,
    statement_timeout: 5000,
    application_name: "vns_p1_provider_acl_preflight",
  });

/**
 * No KEK, vendor key, BullMQ subscription, reservation, dispatch or
 * outbound HTTP. Only SELECT on PostgreSQL role metadata.
 */
export async function runProviderWorkerReadOnlyPreflight(
  env: NodeJS.ProcessEnv = process.env,
  readPassword: (path: string) => string = privatePassword,
  createDb: PreflightDbFactory = defaultFactory,
): Promise<void> {
  readProviderWorkerPreflightAdmission(env); // before any file or DB access
  let usageDb: ReturnType<PreflightDbFactory> | undefined;
  let secretDb: ReturnType<PreflightDbFactory> | undefined;
  try {
    const usagePassword = readPassword(PROVIDER_WORKER_PREFLIGHT_FILES.usage);
    const secretPassword = readPassword(PROVIDER_WORKER_PREFLIGHT_FILES.secret);
    if (
      !PASSWORD.test(usagePassword) ||
      !PASSWORD.test(secretPassword) ||
      usagePassword === secretPassword
    )
      throw new Error(FAIL);
    usageDb = createDb("usage", usagePassword);
    secretDb = createDb("secret", secretPassword);
    await attestSeparatedProviderWorkerDatabases(usageDb, secretDb, true);
  } catch {
    throw new Error(FAIL);
  } finally {
    await Promise.allSettled([usageDb?.end(), secretDb?.end()]);
  }
}

if (process.argv[1]?.endsWith("/provider-worker-preflight-once.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--read-only") {
    console.error("Provider preflight requires explicit --read-only");
    process.exitCode = 2;
  } else {
    try {
      await runProviderWorkerReadOnlyPreflight();
      console.info(JSON.stringify({ event: "p1_provider_worker_acl_preflight", status: "pass" }));
    } catch {
      console.error("Provider worker preflight denied");
      process.exitCode = 1;
    }
  }
}
