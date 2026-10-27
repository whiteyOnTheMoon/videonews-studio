import type { KeyObject } from "node:crypto";
import { prepareDormantSourceExport } from "./source-registry-export.js";
import { publishDormantSourceFile } from "./source-export-files.js";
import type { ApprovedFetchPolicy } from "./source-fetch.js";

export interface SourceExportQuery {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Publisher boundary from ONE locked, audited PostgreSQL snapshot to the
 * existing signed and fsync+rename source export. Caller provides the
 * restricted export-role connection, a separately approved host policy,
 * the out-of-band Ed25519 private key and its private publisher directory.
 *
 * No application or feed worker import mounts this helper automatically.
 */
export async function publishApprovedAdminSourceFile(
  db: SourceExportQuery,
  directory: string,
  independentlyApprovedPolicy: ApprovedFetchPolicy,
  signingPrivateKey: KeyObject,
): Promise<{ sourceRevision: number; hostApprovalRevision: number }> {
  try {
    const result = await db.query("SELECT vns.read_approved_source_export() AS snapshot");
    if (result.rows.length !== 1 || !result.rows[0]) {
      throw new Error("Invalid PostgreSQL export result");
    }
    const row = result.rows[0];
    if (Object.keys(row).length !== 1) throw new Error("Invalid export projection");
    const snapshot: unknown = row.snapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("Invalid export snapshot");
    }
    const fields = snapshot as Record<string, unknown>;
    if (
      Object.keys(fields).length !== 2 ||
      !Object.hasOwn(fields, "sourceSnapshot") ||
      !Object.hasOwn(fields, "hostApproval")
    ) {
      throw new Error("Invalid export fields");
    }
    // Source and host snapshots come from the *same SQL statement*,
    // never separate reads or caller-created approval objects.
    const bundle = prepareDormantSourceExport(
      fields.sourceSnapshot,
      fields.hostApproval,
    );
    await publishDormantSourceFile(
      directory,
      bundle,
      independentlyApprovedPolicy,
      signingPrivateKey,
    );
    return {
      sourceRevision: bundle.sourceRevision,
      hostApprovalRevision: bundle.hostApprovalRevision,
    };
  } catch {
    // Do not propagate potentially confidential source metadata, paths,
    // signing-key errors, DB identifiers or hostnames.
    throw new Error("Approved signed source publication unavailable");
  }
}
