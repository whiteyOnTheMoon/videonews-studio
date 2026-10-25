import type { Pool } from "pg";
import type { EditorIdentity } from "./editor-auth.js";
import type { ProviderMutation } from "./admin-provider-configuration.js";
import {
  PostgresProviderConfigStore,
  providerMutationArguments,
} from "./postgres-provider-config-store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USERNAME = /^[a-z][a-z0-9_-]{2,31}$/;

/**
 * Dormant named audit adapter. An upstream EditorAuth session must resolve the
 * identity; client-supplied claims alone are NOT trusted authorization.
 * PostgreSQL rechecks the active admin role and the auth_version under lock.
 */
export class PostgresNamedProviderConfigStore extends PostgresProviderConfigStore {
  constructor(private readonly namedPool: Pick<Pool, "query">) {
    super(namedPool);
  }

  async mutateAsNamedAdmin(change: ProviderMutation, identity: EditorIdentity): Promise<void> {
    if (
      !identity ||
      identity.role !== "admin" ||
      typeof identity.id !== "string" ||
      !UUID.test(identity.id) ||
      typeof identity.username !== "string" ||
      !USERNAME.test(identity.username) ||
      !Number.isSafeInteger(identity.authVersion) ||
      identity.authVersion < 0 ||
      identity.authVersion > 2147483647
    ) {
      throw new Error("Invalid named provider administrator");
    }
    const params = providerMutationArguments(change);
    try {
      await this.namedPool.query(
        "SELECT vns.admin_mutate_ai_provider_as_editor(" +
          "$1::text,$2::text,$3::text,$4::bytea,$5::bytea,$6::bytea,$7::uuid,$8::integer)",
        [...params, identity.id, identity.authVersion],
      );
    } catch {
      throw new Error("Named provider change unavailable");
    }
  }
}
