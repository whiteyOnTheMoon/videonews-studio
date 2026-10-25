/** Names are reserved for future service-scoped LOGIN roles, not yet provisioned. */
export const POSTGRES_SERVICE_IDENTITIES = {
  dispatch: "vns_outbox_dispatch_login",
  statusSync: "vns_job_status_sync_login",
  research: "vns_research_writer_login",
} as const;

export function requireDedicatedPostgresIdentity(
  service: keyof typeof POSTGRES_SERVICE_IDENTITIES,
  enabled: boolean,
): string {
  if (enabled !== true || !Object.hasOwn(POSTGRES_SERVICE_IDENTITIES, service)) {
    throw new Error("Dedicated PostgreSQL identity must be explicitly enabled");
  }
  return POSTGRES_SERVICE_IDENTITIES[service];
}
