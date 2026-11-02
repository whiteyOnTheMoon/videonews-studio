import { createPublicKey } from "node:crypto";
import { Pool } from "pg";
import {
  readFeedRuntimeAdmission,
  attestFeedDatabaseIdentity,
  type FeedRuntimeMode,
} from "./feed-runtime-admission.js";
import {
  createDormantFeedScheduler,
  type OfflineFeedScheduler,
} from "./feed-scheduler-composition.js";
import { productionFeedHttpsDependencies } from "./feed-https-transport.js";
import { REVIEWED_SOURCE_REGISTRY_PATH } from "./research-service-config.js";
import { readApprovedFetchPolicy } from "./source-fetch.js";
import { acceptDormantSourceFile } from "./source-export-files.js";
import { postgresSourceRevisionAnchor } from "./postgres-source-revision-anchor.js";
import { attestFeedSourceAnchorIdentity } from "./feed-source-anchor-identity.js";
import { advancePinnedFeedTrustPolicy } from "./feed-trust-policy-runtime.js";

import {
  readFeedSecretFile as readFeedSecret,
  readPinnedFeedTrustFile,
} from "./feed-runtime-protected-files.js";

export { readFeedSecretFile as readFeedSecret } from "./feed-runtime-protected-files.js";

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
    const pinnedKey = createPublicKey(readPinnedFeedTrustFile(admission.sourcePublicKeyPath));
    if (pinnedKey.type !== "public" || pinnedKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Publisher identity refused");
    }
    const ca = readPinnedFeedTrustFile(admission.anchorCaPath);
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
    // Independently anchor the actual pinned signer and its explicit policy
    // revision BEFORE advancing source checkpoint or starting feed transport.
    await advancePinnedFeedTrustPolicy(
      {
        async query(sql, params) {
          const result = await anchorPool!.query<{ accepted: unknown }>(sql, [...params]);
          return { rowCount: result.rowCount, rows: result.rows };
        },
      },
      pinnedKey,
      admission.trustPolicyRevision,
    );
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
