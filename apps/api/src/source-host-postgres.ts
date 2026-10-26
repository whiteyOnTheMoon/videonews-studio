import type { EditorIdentity } from "./editor-auth.js";
import {
  parseHostApprovalCommand,
  validateHostApprovalSnapshot,
  type HostApprovalCommand,
  type HostApprovalSnapshot,
  type HostApprovalStore,
} from "./admin-source-host-approval.js";
import type { SourceQueryPort } from "./source-admin-postgres.js";

/** Detached SQL adapter; injected restricted pool ONLY, no runtime connections. */
export class PostgresHostApprovalStore implements HostApprovalStore {
  constructor(private readonly queryPort: SourceQueryPort) {}

  async read(): Promise<HostApprovalSnapshot> {
    const result = await this.queryPort.query(
      'SELECT revision, approved_hosts AS "approvedHosts" FROM vns.admin_source_host_approvals WHERE singleton=true',
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) throw new Error("Host approvals unavailable");
    return validateHostApprovalSnapshot({
      revision: typeof row.revision === "string" ? Number(row.revision) : row.revision,
      approvedHosts: row.approvedHosts,
    });
  }

  async commit(
    command: HostApprovalCommand,
    identity: EditorIdentity,
  ): Promise<"saved" | "conflict"> {
    if (
      !parseHostApprovalCommand(command) ||
      identity.role !== "admin" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(identity.id) ||
      !Number.isSafeInteger(identity.authVersion) ||
      identity.authVersion < 0 ||
      command.expectedRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("Host approval request invalid");
    }
    const result = await this.queryPort.query(
      "SELECT vns.admin_change_source_host_approval($1,$2,$3,$4,$5,$6::uuid,$7) AS saved",
      [
        command.expectedRevision,
        command.expectedSourceRevision,
        command.action,
        command.host,
        command.reason,
        identity.id,
        identity.authVersion,
      ],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || typeof row.saved !== "boolean") {
      throw new Error("Host approval transaction unavailable");
    }
    return row.saved ? "saved" : "conflict";
  }
}
