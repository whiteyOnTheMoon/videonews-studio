import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { Pool } from "pg";
import {
  readFeedRuntimeAdmission,
  attestFeedDatabaseIdentity,
  type FeedRuntimeMode,
} from "./feed-runtime-admission.js";
import { createDormantFeedScheduler, type OfflineFeedScheduler } from "./feed-scheduler-composition.js";
import { productionFeedHttpsDependencies } from "./feed-https-transport.js";
import { REVIEWED_SOURCE_REGISTRY_PATH } from "./research-service-config.js";
import { readApprovedFetchPolicy } from "./source-fetch.js";
import { acceptDormantSourceFile } from "./source-export-files.js";
import { postgresSourceRevisionAnchor } from "./postgres-source-revision-anchor.js";
import { attestFeedSourceAnchorIdentity } from "./feed-source-anchor-identity.js";

/** Read only precisely located, pre-provisioned runtime secrets. Never log values. */
export function readFeedSecret(path: string): string {
  try {
    const password = readFileSync(path, "utf8").trimEnd();
    if (password.length < 40 || password.length > 256 || !/^[A-Za-z0-9_-]+$/.test(password)) {
      throw new Error("Invalid feed secret");
    }
    return password;
  } catch {
    throw new Error("Feed runtime secret unavailable");
  }
}

function readPinnedFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 16 || stat.size > 16384 || (stat.mode & 0o022) !== 0) {
      throw new Error("Untrusted feed trust material");
    }
    return readFileSync(fd, "utf8");
  } catch {
    throw new Error("Pinned feed trust material unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface TrustedFeedContext {
  scheduler: OfflineFeedScheduler;
  close(): Promise<void>;
}

/**
 * Re-attest the actual unprivileged PostgreSQL LOGIN, independent TLS anchor,
 * signed source snapshot, monotonic revision and current allowlist every time
 * a durable worker processes a job. Never trust producer job data for sources.
 * Call close() in a finally block; no implicit queue or timer is constructed.
 */
export async function openTrustedFeedContext(
  env: NodeJS.ProcessEnv,
  mode: FeedRuntimeMode,
): Promise<TrustedFeedContext> {
  const admission = readFeedRuntimeAdmission(env, mode);
  const pgPassword = readFeedSecret(admission.dbSecretPath);
  const pool = new Pool({
    host: admission.dbHost,
    port: 5432,
    database: "videonews",
    user: admission.dbUser,
    password: pgPassword,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    application_name: "vns_feed_guarded_worker",
  });
  let anchorPool: Pool | undefined;
  try {
    await attestFeedDatabaseIdentity(pool, admission.dbUser);
    const pinnedKey = createPublicKey(readPinnedFile(admission.sourcePublicKeyPath));
    if (pinnedKey.type !== "public" || pinnedKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Publisher identity refused");
    }
    const ca = readPinnedFile(admission.anchorCaPath);
    const anchorPassword = readFeedSecret(admission.anchorPasswordPath);
    anchorPool = new Pool({
      host: admission.anchorHost,
      port: 5432,
      database: "vns_source_anchor",
      user: admission.anchorUser,
      password: anchorPassword,
      ssl: { ca, rejectUnauthorized: true, servername: admission.anchorHost },
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      application_name: "vns_feed_anchor_guard",
    });
    await attestFeedSourceAnchorIdentity(anchorPool, admission.anchorUser);
    const anchor = postgresSourceRevisionAnchor({
      async query(sql, params) {
        const result = await anchorPool!.query<{ accepted: unknown }>(sql, [...params]);
        return { rowCount: result.rowCount, rows: result.rows };
      },
    });
    const sources = await acceptDormantSourceFile(
      admission.signedExportDirectory,
      admission.signedCheckpointDirectory,
      readApprovedFetchPolicy(env),
      pinnedKey,
      admission.initialBootstrap,
      anchor,
    );
    const verifiedRegistry = JSON.stringify({ version: 1, sources });
    const scheduler = createDormantFeedScheduler(env, {
      pool,
      https: productionFeedHttpsDependencies(),
      readRegistry(path) {
        if (path !== REVIEWED_SOURCE_REGISTRY_PATH) {
          throw new Error("Unexpected source registry");
        }
        return verifiedRegistry;
      },
    });
    if (scheduler.sourceIds.length < 3 || scheduler.sourceIds.length > 5) {
      throw new Error("Approved source set invalid");
    }
    return {
      scheduler,
      async close() {
        await anchorPool?.end().catch(() => undefined);
        await pool.end().catch(() => undefined);
      },
    };
  } catch {
    await anchorPool?.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw new Error("Trusted feed context unavailable");
  }
}
