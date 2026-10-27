import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import type { EditorIdentity } from "./editor-auth.js";
import type { NamedEditorialSessionFactory } from "./personal-editorial-admin.js";

export const PERSONAL_EDITORIAL_SECRETS_DIR = "/run/secrets/vns_editor_credentials" as const;
const ACCOUNT = /^[a-z][a-z0-9_-]{2,31}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const LOGIN = /^editor_[a-z][a-z0-9_-]{2,31}$/;

export interface PersonalEditorialAdmission {
  pgHost: "postgres" | "127.0.0.1";
  secretDirectory: typeof PERSONAL_EDITORIAL_SECRETS_DIR;
}

/**
 * Fail closed before reading secrets or allocating database connections.
 * No default admin login, hardcoded credential or system role impersonation.
 */
export function readPersonalEditorialAdmission(
  env: NodeJS.ProcessEnv,
): PersonalEditorialAdmission | null {
  const enabled = env.VNS_EDITORIAL_PERSONAL_DB_ENABLED;
  const acknowledged = env.VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK;
  if (enabled === undefined || enabled === "false") {
    if (acknowledged !== undefined && acknowledged !== "false") {
      throw new Error("Personal editorial gate inconsistent");
    }
    return null;
  }
  if (
    enabled !== "true" ||
    acknowledged !== "true" ||
    env.VNS_EDITORIAL_PERSONAL_DB_SECRETS_DIR !== PERSONAL_EDITORIAL_SECRETS_DIR ||
    !["postgres", "127.0.0.1"].includes(env.VNS_EDITORIAL_PERSONAL_DB_HOST ?? "")
  )
    throw new Error("Personal editorial runtime admission denied");
  return {
    pgHost: env.VNS_EDITORIAL_PERSONAL_DB_HOST as PersonalEditorialAdmission["pgHost"],
    secretDirectory: PERSONAL_EDITORIAL_SECRETS_DIR,
  };
}

function readIndividualCredential(directory: string, login: string): string {
  let folder: number | undefined;
  let file: number | undefined;
  try {
    folder = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const dirInfo = fstatSync(folder);
    if (
      !dirInfo.isDirectory() ||
      (dirInfo.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        dirInfo.uid !== 0 &&
        dirInfo.uid !== process.getuid())
    ) {
      throw new Error("Unsafe personal credential directory");
    }
    // Exact, verified directory with no group/world writes, login restricts
    // the filename. O_NOFOLLOW prevents the final file being a symlink.
    const path = directory + "/" + login + ".password";
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 40 ||
      stat.size > 256 ||
      (typeof process.getuid === "function" && stat.uid !== 0 && stat.uid !== process.getuid())
    ) {
      throw new Error("Personal credential inaccessible");
    }
    const password = readFileSync(file, "utf8").trimEnd();
    if (!/^[A-Za-z0-9_-]{40,256}$/.test(password)) {
      throw new Error("Personal credential malformed");
    }
    return password;
  } catch {
    throw new Error("Personal editorial credential unavailable");
  } finally {
    if (file !== undefined) closeSync(file);
    if (folder !== undefined) closeSync(folder);
  }
}

/**
 * A new physical PostgreSQL connection with a dedicated LOGIN for EVERY
 * authenticated request. DB proves session_user and checks the person's
 * current auth_version before permitting a checkpoint or profile operation.
 */
export function createPersonalEditorialSessions(
  admission: PersonalEditorialAdmission,
): NamedEditorialSessionFactory {
  if (
    !admission ||
    !["postgres", "127.0.0.1"].includes(admission.pgHost) ||
    admission.secretDirectory !== PERSONAL_EDITORIAL_SECRETS_DIR
  )
    throw new Error("Personal editorial session configuration invalid");
  return {
    async open(identity: EditorIdentity) {
      if (
        !identity ||
        identity.role !== "admin" ||
        !ACCOUNT.test(identity.username) ||
        !UUID.test(identity.id) ||
        !Number.isSafeInteger(identity.authVersion) ||
        identity.authVersion < 0
      ) {
        throw new Error("Personal editorial account refused");
      }
      const login = "editor_" + identity.username;
      if (!LOGIN.test(login)) throw new Error("Personal editorial login refused");
      const pool = new Pool({
        host: admission.pgHost,
        port: 5432,
        database: "videonews",
        user: login,
        password: readIndividualCredential(admission.secretDirectory, login),
        max: 1,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 5000,
        application_name: "vns_personal_editorial",
      });
      return {
        async query<T>(sql: string, args: readonly unknown[] = []) {
          if (typeof sql !== "string" || sql.length > 2000 || !Array.isArray(args)) {
            throw new Error("Personal editorial query invalid");
          }
          const result = await pool.query(sql, [...args]);
          return { rows: result.rows as T[] };
        },
        async close() {
          await pool.end();
        },
      };
    },
  };
}
