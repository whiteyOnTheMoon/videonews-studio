import type { Pool, QueryResult } from "pg";

/**
 * P1-09: independent database admission, without any provider transport.
 * Usage SQL and sealed-key access must never share a database principal.
 */
export const PROVIDER_WORKER_DB_IDENTITIES = Object.freeze({
  usage: "vns_provider_usage_login",
  secret: "vns_provider_secret_login",
});

export type ProviderWorkerDbKind = keyof typeof PROVIDER_WORKER_DB_IDENTITIES;

interface IdentityEvidence {
  session_user: string;
  current_user: string;
  role_member: boolean;
  other_role_member: boolean;
  allowed_function: boolean;
  forbidden_function: boolean;
  direct_key_read: boolean;
  direct_key_write: boolean;
  policy_write: boolean;
  admin_change: boolean;
  superuser: boolean;
  create_role: boolean;
  create_db: boolean;
  replication: boolean;
  bypass_rls: boolean;
  read_only: boolean;
}

const IDENTITY_SQL = `
SELECT session_user::text, current_user::text,
  pg_has_role(session_user, $1::name, 'member') AS role_member,
  pg_has_role(session_user, $2::name, 'member') AS other_role_member,
  has_function_privilege(session_user, $3::text, 'EXECUTE') AS allowed_function,
  has_function_privilege(session_user, $4::text, 'EXECUTE') AS forbidden_function,
  has_table_privilege(session_user, 'vns.ai_provider_sealed_credentials', 'SELECT')
    AS direct_key_read,
  has_table_privilege(session_user, 'vns.ai_provider_sealed_credentials', 'UPDATE')
    AS direct_key_write,
  has_table_privilege(session_user, 'vns.provider_live_budget_policy', 'UPDATE')
    AS policy_write,
  has_function_privilege(session_user,
    'vns.admin_review_live_provider_price_as_editor(uuid,integer,text,text,text,bigint,bigint,bigint,timestamptz,text)',
    'EXECUTE') AS admin_change,
  role.rolsuper AS superuser, role.rolcreaterole AS create_role,
  role.rolcreatedb AS create_db, role.rolreplication AS replication,
  role.rolbypassrls AS bypass_rls,
  (current_setting('default_transaction_read_only') = 'on') AS read_only
FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user
`;

const ALLOWED_FUNCTIONS = {
  usage: "vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint)",
  secret: "vns.claimed_provider_sealed_key(uuid,text)",
};
const FORBIDDEN_FUNCTIONS = {
  usage: ALLOWED_FUNCTIONS.secret,
  secret: ALLOWED_FUNCTIONS.usage,
};
const ROLE_MEMBERS = {
  usage: "vns_provider_usage_writer",
  secret: "vns_provider_secret_reader",
};

function allowedIdentity(evidence: IdentityEvidence, expected: string, readonly: boolean): boolean {
  return (
    evidence.session_user === expected &&
    evidence.current_user === expected &&
    evidence.role_member === true &&
    evidence.allowed_function === true &&
    (!readonly || evidence.read_only === true) &&
    [
      evidence.other_role_member,
      evidence.forbidden_function,
      evidence.direct_key_read,
      evidence.direct_key_write,
      evidence.policy_write,
      evidence.admin_change,
      evidence.superuser,
      evidence.create_role,
      evidence.create_db,
      evidence.replication,
      evidence.bypass_rls,
    ].every((flag) => flag === false)
  );
}

/** Read-only ACL inspection. Does not read a stored credential or book money. */
export async function attestProviderWorkerDatabaseRole(
  db: Pick<Pool, "query">,
  kind: ProviderWorkerDbKind,
  expectedLogin: string,
  requireReadOnly = true,
): Promise<void> {
  if (
    (kind !== "usage" && kind !== "secret") ||
    expectedLogin !== PROVIDER_WORKER_DB_IDENTITIES[kind] ||
    !db ||
    typeof db.query !== "function"
  ) {
    throw new Error("Provider worker identity unavailable");
  }
  const other = kind === "usage" ? "secret" : "usage";
  try {
    const result: QueryResult<IdentityEvidence> = await db.query(IDENTITY_SQL, [
      ROLE_MEMBERS[kind],
      ROLE_MEMBERS[other],
      ALLOWED_FUNCTIONS[kind],
      FORBIDDEN_FUNCTIONS[kind],
    ]);
    if (
      result.rows.length !== 1 ||
      !result.rows[0] ||
      !allowedIdentity(result.rows[0], expectedLogin, requireReadOnly)
    )
      throw new Error("Provider worker privileges invalid");
  } catch {
    throw new Error("Provider worker database admission denied");
  }
}

/**
 * Both logins and connections must be different. A compromised usage
 * writer must never be able to call the sealed-key read function.
 */
export async function attestSeparatedProviderWorkerDatabases(
  usageDb: Pick<Pool, "query">,
  secretDb: Pick<Pool, "query">,
  requireReadOnly = true,
): Promise<void> {
  if (!usageDb || !secretDb || usageDb === secretDb) {
    throw new Error("Provider worker database separation unavailable");
  }
  await attestProviderWorkerDatabaseRole(
    usageDb,
    "usage",
    PROVIDER_WORKER_DB_IDENTITIES.usage,
    requireReadOnly,
  );
  await attestProviderWorkerDatabaseRole(
    secretDb,
    "secret",
    PROVIDER_WORKER_DB_IDENTITIES.secret,
    requireReadOnly,
  );
}
