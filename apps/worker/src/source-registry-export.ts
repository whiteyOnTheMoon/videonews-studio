import { createHash, timingSafeEqual } from "node:crypto";
import { parseReviewedSourceRegistry, type RegisteredResearchSource } from "./source-registry.js";
import { readApprovedFetchPolicy, type ApprovedFetchPolicy } from "./source-fetch.js";

/**
 * CI-only transition between DB-admin source snapshots and the existing
 * worker file contract. It does NOT write any file, connect to PostgreSQL,
 * permit a network request, or mount a production worker.
 *
 * IMPORTANT: The host approval snapshot must come from an INDEPENDENT,
 * personally audited operator action, NEVER from the source editor POST.
 */
export interface HostApprovalSnapshot {
  revision: number;
  approvedHosts: readonly string[];
}
export interface SourceAdminExportSnapshot {
  revision: number;
  sources: readonly RegisteredResearchSource[];
}
export interface DormantSourceExport {
  version: 1;
  sourceRevision: number;
  hostApprovalRevision: number;
  allowedHosts: readonly string[];
  registryJson: string;
  sha256: string;
}

const EXPORT_FIELDS = [
  "version",
  "sourceRevision",
  "hostApprovalRevision",
  "allowedHosts",
  "registryJson",
  "sha256",
];
const SHA256 = /^[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function sortedHosts(hosts: readonly string[]): string[] {
  return [...hosts].sort();
}
function identical(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((host, index) => host === b[index]);
}
function safeHostApproval(value: unknown): HostApprovalSnapshot {
  if (
    !record(value) ||
    !exact(value, ["revision", "approvedHosts"]) ||
    !revision(value.revision) ||
    !Array.isArray(value.approvedHosts) ||
    !value.approvedHosts.every((host) => typeof host === "string")
  ) {
    throw new Error("Independent source host approval unavailable");
  }
  const approvedHosts = value.approvedHosts as string[];
  // Reuse the existing fetch policy hostname grammar and five-host cap.
  // The caller has NOT authorized fetching merely by passing this object.
  const policy = readApprovedFetchPolicy({
    VNS_SOURCE_FETCH_ENABLED: "true",
    VNS_ALLOWED_SOURCE_HOSTS: approvedHosts.join(","),
  });
  if (
    approvedHosts.some((host) => host.startsWith("xn--") || host.includes(".xn--")) ||
    !identical(sortedHosts(approvedHosts), sortedHosts(policy.hosts))
  ) {
    throw new Error("Independent source host approval invalid");
  }
  return { revision: value.revision as number, approvedHosts: sortedHosts(approvedHosts) };
}
function exportBody(
  sourceRevision: number,
  hostApprovalRevision: number,
  allowedHosts: readonly string[],
  registryJson: string,
) {
  return {
    version: 1 as const,
    sourceRevision,
    hostApprovalRevision,
    allowedHosts,
    registryJson,
  };
}
function digest(body: ReturnType<typeof exportBody>): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}
function checkedRegistry(input: unknown): {
  all: RegisteredResearchSource[];
  hostsWithApproval: Set<string>;
} {
  if (
    !record(input) ||
    !exact(input, ["revision", "sources"]) ||
    !revision(input.revision) ||
    !Array.isArray(input.sources) ||
    input.sources.length > 20
  ) {
    throw new Error("Admin source export snapshot invalid");
  }
  const all: RegisteredResearchSource[] = [];
  const ids = new Set<string>();
  const scopes = new Set<string>();
  const hostsWithApproval = new Set<string>();

  for (const entry of input.sources as unknown[]) {
    if (!record(entry) || typeof entry.baseUrl !== "string") {
      throw new Error("Admin source export entry invalid");
    }
    let host: string;
    try {
      host = new URL(entry.baseUrl).hostname;
    } catch {
      throw new Error("Admin source export URL invalid");
    }
    // Validate EVERY database entry, even those omitted from the final
    // host-restricted worker registry.
    const parsed = parseReviewedSourceRegistry(JSON.stringify({ version: 1, sources: [entry] }), {
      enabled: true,
      hosts: [host],
    });
    const item = parsed[0];
    if (!item || ids.has(item.id) || scopes.has(item.baseUrl)) {
      throw new Error("Admin source export duplicate");
    }
    ids.add(item.id);
    scopes.add(item.baseUrl);
    all.push(item);
    if (item.status === "approved") hostsWithApproval.add(host);
  }
  return { all, hostsWithApproval };
}

/**
 * Prepare a deterministic SINGLE bundle, suitable for future atomic
 * publication by a separately approved filesystem writer. The checksum is
 * integrity-only, NOT a signature or independent approval.
 */
export function prepareDormantSourceExport(
  sourceSnapshot: unknown,
  independentHostApproval: unknown,
): DormantSourceExport {
  const approval = safeHostApproval(independentHostApproval);
  const validated = checkedRegistry(sourceSnapshot);
  const approvedHosts = sortedHosts([...validated.hostsWithApproval]);
  if (!identical(approvedHosts, approval.approvedHosts)) {
    // Never derive network permission from newly approved source metadata.
    // Extra host grants are also forbidden: narrow the outbound allowance.
    throw new Error("Source host grant and reviewed sources disagree");
  }
  const selected = validated.all
    .filter((item) => approval.approvedHosts.includes(new URL(item.baseUrl).hostname))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (selected.length === 0) throw new Error("No independently approved sources");
  const registryJson = JSON.stringify({ version: 1, sources: selected });
  const policy: ApprovedFetchPolicy = { enabled: true, hosts: approvedHosts };
  // This validates the entire final bundle and retains blocked child scopes
  // alongside approved parents. Omitting them would remove deny overrides.
  parseReviewedSourceRegistry(registryJson, policy);
  const body = exportBody(
    (sourceSnapshot as SourceAdminExportSnapshot).revision,
    approval.revision,
    approvedHosts,
    registryJson,
  );
  return { ...body, sha256: digest(body) };
}

/**
 * Worker-side offline acceptance: a checksum does not authenticate the
 * publisher. The reader MUST also supply a separately trusted host policy
 * and minimum accepted revisions from its own monotonic checkpoint.
 */
export function parseDormantSourceExport(
  input: unknown,
  independentlyTrustedPolicy: ApprovedFetchPolicy,
  minimum: { sourceRevision: number; hostApprovalRevision: number },
): readonly RegisteredResearchSource[] {
  if (
    !record(input) ||
    !exact(input, EXPORT_FIELDS) ||
    input.version !== 1 ||
    !revision(input.sourceRevision) ||
    !revision(input.hostApprovalRevision) ||
    !revision(minimum.sourceRevision) ||
    !revision(minimum.hostApprovalRevision) ||
    (input.sourceRevision as number) < minimum.sourceRevision ||
    (input.hostApprovalRevision as number) < minimum.hostApprovalRevision ||
    !Array.isArray(input.allowedHosts) ||
    !input.allowedHosts.every((host) => typeof host === "string") ||
    typeof input.registryJson !== "string" ||
    typeof input.sha256 !== "string" ||
    !SHA256.test(input.sha256)
  ) {
    throw new Error("Source registry export envelope invalid");
  }
  const hosts = safeHostApproval({
    revision: input.hostApprovalRevision,
    approvedHosts: input.allowedHosts,
  }).approvedHosts;
  if (
    independentlyTrustedPolicy.enabled !== true ||
    !Array.isArray(independentlyTrustedPolicy.hosts) ||
    !identical(hosts, sortedHosts(independentlyTrustedPolicy.hosts))
  ) {
    throw new Error("Source export not independently approved");
  }
  const body = exportBody(
    input.sourceRevision as number,
    input.hostApprovalRevision as number,
    hosts,
    input.registryJson,
  );
  const expected = Buffer.from(digest(body), "hex");
  const actual = Buffer.from(input.sha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Source registry export checksum invalid");
  }
  const parsed = parseReviewedSourceRegistry(input.registryJson, independentlyTrustedPolicy);
  const acceptedHosts = sortedHosts([
    ...new Set(
      parsed
        .filter((item) => item.status === "approved")
        .map((item) => new URL(item.baseUrl).hostname),
    ),
  ]);
  if (!identical(acceptedHosts, hosts)) {
    throw new Error("Source registry approval set invalid");
  }
  return parsed;
}
