import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminAuth } from "./auth.js";
import { readLimitedJson, respond } from "./admin-provider-configuration.js";
import type { EditorAuth, EditorIdentity } from "./editor-auth.js";

export interface HostApprovalSnapshot {
  revision: number;
  approvedHosts: readonly string[];
}
export interface HostApprovalCommand {
  action: "grant" | "revoke";
  expectedRevision: number;
  expectedSourceRevision: number;
  host: string;
  reason: string;
}
export interface HostApprovalStore {
  read(): Promise<HostApprovalSnapshot>;
  commit(
    command: HostApprovalCommand,
    identity: EditorIdentity,
  ): Promise<"saved" | "conflict">;
}
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export function validHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > 253) return false;
  if (!HOST.test(value) || /^(?:[0-9]+\.){3}[0-9]+$/.test(value)) return false;
  if (/\.(?:localhost|local|internal|onion)$/.test(value)) return false;
  return value.split(".").every(
    (label) =>
      label.length <= 63 &&
      !label.startsWith("-") &&
      !label.endsWith("-") &&
      !label.startsWith("xn--"),
  );
}
export function validateHostApprovalSnapshot(value: unknown): HostApprovalSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Host approval snapshot invalid");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 2 ||
    !Object.hasOwn(row, "revision") ||
    !Object.hasOwn(row, "approvedHosts") ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 0 ||
    !Array.isArray(row.approvedHosts) ||
    row.approvedHosts.length > 5
  ) {
    throw new Error("Host approval snapshot invalid");
  }
  const hosts: string[] = [];
  for (const host of row.approvedHosts as unknown[]) {
    if (!validHost(host) || hosts.includes(host)) throw new Error("Host approval snapshot invalid");
    hosts.push(host);
  }
  if (hosts.some((host, index) => index > 0 && host <= (hosts[index - 1] ?? ""))) {
    throw new Error("Host approval snapshot invalid");
  }
  return { revision: row.revision as number, approvedHosts: hosts };
}
export function parseHostApprovalCommand(input: unknown): HostApprovalCommand | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  if (
    Object.keys(row).length !== 5 ||
    !["action", "expectedRevision", "expectedSourceRevision", "host", "reason"].every(
      (key) => Object.hasOwn(row, key),
    ) ||
    (row.action !== "grant" && row.action !== "revoke") ||
    !Number.isSafeInteger(row.expectedRevision) ||
    (row.expectedRevision as number) < 0 ||
    !Number.isSafeInteger(row.expectedSourceRevision) ||
    (row.expectedSourceRevision as number) < 1 ||
    !validHost(row.host) ||
    typeof row.reason !== "string" ||
    row.reason.length < 20 ||
    row.reason.length > 300 ||
    row.reason.trim() !== row.reason ||
    Array.from(row.reason).some((char) => char.charCodeAt(0) < 32)
  ) {
    return null;
  }
  return {
    action: row.action as HostApprovalCommand["action"],
    expectedRevision: row.expectedRevision as number,
    expectedSourceRevision: row.expectedSourceRevision as number,
    host: row.host as string,
    reason: row.reason,
  };
}

/** Explicitly injectable only. The API production entrypoint never mounts this handler. */
export class DormantNamedHostApproval {
  constructor(
    private readonly editor: Pick<EditorAuth, "authenticatedAdminIdentity">,
    private readonly origin: Pick<AdminAuth, "originAllowed">,
    private readonly store: HostApprovalStore,
    private readonly admission: { allow(): Promise<boolean> },
    private readonly enabled = false,
  ) {
    if (!admission || typeof admission.allow !== "function") {
      throw new Error("Independent host approval admission required");
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.url !== "/admin/source-hosts") return false;
    if (!this.enabled) {
      respond(res, 404, { error: "not_found" });
      return true;
    }
    let actor: EditorIdentity | null;
    try {
      actor = await this.editor.authenticatedAdminIdentity(req);
    } catch {
      respond(res, 503, { error: "temporarily_unavailable" });
      return true;
    }
    if (!actor || actor.role !== "admin") {
      respond(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method === "GET") {
      try {
        const state = validateHostApprovalSnapshot(await this.store.read());
        respond(res, 200, { ...state, feedActive: false });
      } catch {
        respond(res, 503, { error: "temporarily_unavailable" });
      }
      return true;
    }
    if (req.method !== "POST") {
      respond(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!this.origin.originAllowed(req)) {
      respond(res, 403, { error: "forbidden" });
      return true;
    }
    try {
      if ((await this.admission.allow()) !== true) {
        respond(res, 429, { error: "too_many_requests" });
        return true;
      }
    } catch {
      respond(res, 503, { error: "temporarily_unavailable" });
      return true;
    }
    const command = parseHostApprovalCommand(await readLimitedJson(req));
    if (!command) {
      respond(res, 400, { error: "invalid_request" });
      return true;
    }
    try {
      const result = await this.store.commit(command, actor);
      if (result !== "saved") {
        respond(res, 409, { error: "revision_conflict" });
        return true;
      }
      respond(res, 200, {
        saved: true,
        host: command.host,
        action: command.action,
        revision: command.expectedRevision + 1,
        feedActive: false,
      });
    } catch {
      respond(res, 503, { error: "temporarily_unavailable" });
    }
    return true;
  }
}
