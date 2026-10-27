import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import pg, { type Pool, type PoolConfig } from "pg";
import type { AdminAuth } from "./auth.js";
import type { EditorAuth } from "./editor-auth.js";
import { NamedAdminProviderConfiguration } from "./named-admin-provider-configuration.js";
import { withProviderMasterKey } from "./provider-master-key-file.js";
import { PostgresNamedProviderConfigStore } from "./postgres-named-provider-config-store.js";
import { PostgresProviderMutationLimiter } from "./postgres-provider-mutation-limiter.js";

const WRITER_PASSWORD_FILE = "/run/secrets/pg_provider_admin_password";
const UNAVAILABLE = "Named provider runtime unavailable";

/**
 * Production boundary: never retains a master key after an HTTP request.
 * Named identity is resolved again for every operation, and the PostgreSQL
 * writer pool is completely separate from the regular editor pool.
 */
export class NamedProviderRequestRuntime {
  constructor(
    private readonly editor: EditorAuth,
    private readonly auth: AdminAuth,
    private readonly pool: Pool,
    private readonly withKey: typeof withProviderMasterKey = withProviderMasterKey,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    return this.withKey(async (key) => {
      const handler = new NamedAdminProviderConfiguration(
        this.editor,
        this.auth,
        new PostgresNamedProviderConfigStore(this.pool),
        key,
        new PostgresProviderMutationLimiter(this.pool),
      );
      return handler.handle(request, response);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Default off; refuses to start if the named writer credentials, actor login,
 * database role membership or private encryption key is missing.
 * Enabling this alone cannot enable any paid provider calls.
 */
export async function namedProviderRuntimeFromEnv(
  editor: EditorAuth | undefined,
  auth: AdminAuth | undefined,
  env: NodeJS.ProcessEnv = process.env,
  readPassword: (path: string) => string = (path) => readFileSync(path, "utf8"),
  poolFactory: (options: PoolConfig) => Pool = (options) => new pg.Pool(options),
  withKey: typeof withProviderMasterKey = withProviderMasterKey,
): Promise<NamedProviderRequestRuntime | undefined> {
  if (env.VNS_PROVIDER_ADMIN_WRITE_ENABLED === undefined || env.VNS_PROVIDER_ADMIN_WRITE_ENABLED === "false") {
    return undefined;
  }
  if (
    env.VNS_PROVIDER_ADMIN_WRITE_ENABLED !== "true" ||
    env.VNS_EDITOR_AUTH_ENABLED !== "true" ||
    env.VNS_ADMIN_AUTH_ENABLED !== "true" ||
    !editor ||
    !auth ||
    env.VNS_PROVIDER_WRITER_PASSWORD_FILE !== WRITER_PASSWORD_FILE ||
    env.VNS_ADMIN_ORIGIN === undefined
  ) {
    throw new Error(UNAVAILABLE);
  }
  let password: string;
  try {
    password = readPassword(WRITER_PASSWORD_FILE).trimEnd();
  } catch {
    throw new Error(UNAVAILABLE);
  }
  if (password.length < 24 || password.length > 256 || /[^\x21-\x7e]/.test(password)) {
    throw new Error(UNAVAILABLE);
  }
  const pool = poolFactory({
    host: "postgres",
    port: 5432,
    database: "videonews",
    user: "vns_provider_config_login",
    password,
    max: 2,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 5000,
    statement_timeout: 6000,
  });
  try {
    const verified = await pool.query<{ who: string; admitted: boolean }>(
      "SELECT session_user::text AS who, " +
        "pg_has_role(session_user,'vns_provider_config_writer','MEMBER') AS admitted",
    );
    if (
      verified.rows.length !== 1 ||
      verified.rows[0]?.who !== "vns_provider_config_login" ||
      verified.rows[0]?.admitted !== true
    ) {
      throw new Error(UNAVAILABLE);
    }
    // Checks custody and permissions, then discards temporary material.
    await withKey(async (key) => {
      if (key.length !== 32) throw new Error(UNAVAILABLE);
    });
    return new NamedProviderRequestRuntime(editor, auth, pool, withKey);
  } catch {
    await pool.end().catch(() => undefined);
    throw new Error(UNAVAILABLE);
  }
}
