import { isIP } from "node:net";
import type { PoolConfig } from "pg";
import type { FeedRuntimeAdmission } from "./feed-runtime-admission.js";

type Admission = Pick<
  FeedRuntimeAdmission,
  "anchorPlacement" | "anchorDatabase" | "anchorHost" | "anchorUser" | "anchorCaPath"
>;
type AnchorApplication = "vns_source_anchor_observation" | "vns_feed_anchor_guard";

/**
 * Shared anchor connection contract for both the one-shot observer and the
 * persistent worker. A same-VPS connection is a deliberate, weaker alternative
 * to a separately pinned TLS authority; it may NEVER be selected by fallback.
 *
 * This helper only constructs options; it opens no connections or secrets.
 */
export function feedAnchorPoolConfig(
  admission: Admission,
  password: string,
  readPinnedCa: (path: string) => string,
  applicationName: AnchorApplication,
): PoolConfig {
  if (
    !admission ||
    typeof readPinnedCa !== "function" ||
    typeof password !== "string" ||
    !/^[A-Za-z0-9_-]{40,256}$/.test(password) ||
    !/^vns_anchor_login_[a-z0-9_]{3,24}$/.test(admission.anchorUser) ||
    !["vns_source_anchor_observation", "vns_feed_anchor_guard"].includes(applicationName)
  ) {
    throw new Error("Feed anchor connection refused");
  }

  let ssl: PoolConfig["ssl"];
  if (admission.anchorPlacement === "same_vps") {
    if (admission.anchorHost !== "postgres" || admission.anchorDatabase !== "videonews") {
      throw new Error("Feed anchor connection refused");
    }
    // Docker-internal PostgreSQL SCRAM, with the same backup/restore domain.
    // No TLS CA file is read or trusted for this explicitly acknowledged mode.
    ssl = false;
  } else if (admission.anchorPlacement === "separate_tls") {
    const host = admission.anchorHost;
    if (
      admission.anchorDatabase !== "vns_source_anchor" ||
      typeof host !== "string" ||
      host.length > 253 ||
      isIP(host) !== 0 ||
      !/^[a-z0-9-]+([.][a-z0-9-]+)+$/.test(host) ||
      /[.](local|internal|localhost|onion)$/.test(host)
    ) {
      throw new Error("Feed anchor connection refused");
    }
    ssl = { ca: readPinnedCa(admission.anchorCaPath), rejectUnauthorized: true, servername: host };
  } else {
    throw new Error("Feed anchor connection refused");
  }
  return {
    host: admission.anchorHost,
    port: 5432,
    database: admission.anchorDatabase,
    user: admission.anchorUser,
    password,
    ssl,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    application_name: applicationName,
  };
}
