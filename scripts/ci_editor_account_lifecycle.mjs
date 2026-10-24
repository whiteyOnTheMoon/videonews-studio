// Disposable CI-only account lifecycle harness. No CLI, web route or VPS use.
// The CI database's privileged bootstrap user is constrained to SET LOCAL ROLE
// vns_editor_provisioner for every write; only synthetic ci_* users are allowed.
import { randomBytes, scryptSync } from "node:crypto";

const USERNAME = /^ci_[a-z][a-z0-9_-]{0,27}$/;
const ROLE = new Set(["editor", "reviewer", "admin"]);
const KEYS = {
  create: ["type", "username", "displayName", "role", "password"],
  rotate: ["type", "username", "password"],
  activate: ["type", "username"],
  deactivate: ["type", "username"],
  setRole: ["type", "username", "role"],
};

function acceptedInput(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return false;
  const required = Object.hasOwn(KEYS, action.type) ? KEYS[action.type] : null;
  if (!required || !USERNAME.test(action.username ?? "")) return false;
  if (
    Object.keys(action).sort().join(",") !== [...required].sort().join(",")
  ) {
    return false;
  }
  if (action.type === "create") {
    if (
      typeof action.displayName !== "string" ||
      action.displayName !== action.displayName.trim() ||
      action.displayName.length < 3 ||
      action.displayName.length > 100 ||
      [...action.displayName].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      return false;
    }
  }
  if (required.includes("role") && !ROLE.has(action.role)) return false;
  if (required.includes("password")) {
    if (
      typeof action.password !== "string" ||
      action.password.length < 16 ||
      action.password.length > 256 ||
      Buffer.byteLength(action.password, "utf8") > 1024 ||
      [...action.password].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      return false;
    }
  }
  return true;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("hex")}`;
}

function requireDisposableCi(pool) {
  const config = pool?.options;
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.CI !== "true" ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") ||
    process.env.GITHUB_REPOSITORY !== "whiteyOnTheMoon/videonews-studio" ||
    config?.host !== "127.0.0.1" ||
    Number(config?.port) !== 15434 ||
    config?.database !== "videonews" ||
    config?.user !== "vns"
  ) {
    throw new Error("REFUSED: disposable GitHub Actions PostgreSQL only");
  }
}

export async function runCiEditorAccountAction(pool, action) {
  requireDisposableCi(pool);
  if (!acceptedInput(action)) {
    throw new Error("Invalid synthetic editor account operation");
  }

  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query("BEGIN");
    transaction = true;
    // No privilege is granted to an application login. This is an isolated
    // authorization test for the NOLOGIN provisioner role only.
    await client.query("SET LOCAL ROLE vns_editor_provisioner");
    const passwordHash =
      action.type === "create" || action.type === "rotate"
        ? hashPassword(action.password)
        : null;
    let result;
    switch (action.type) {
      case "create":
        result = await client.query(
          `INSERT INTO vns.editor_accounts
            (username, display_name, role, password_hash)
            VALUES ($1, $2, $3, $4)
            RETURNING id::text AS id, username, role, active`,
          [action.username, action.displayName, action.role, passwordHash],
        );
        break;
      case "rotate":
        result = await client.query(
          `UPDATE vns.editor_accounts SET password_hash=$2
            WHERE username=$1 RETURNING id::text AS id, username, role, active`,
          [action.username, passwordHash],
        );
        break;
      case "activate":
      case "deactivate":
        result = await client.query(
          `UPDATE vns.editor_accounts SET active=$2
            WHERE username=$1 RETURNING id::text AS id, username, role, active`,
          [action.username, action.type === "activate"],
        );
        break;
      case "setRole":
        result = await client.query(
          `UPDATE vns.editor_accounts SET role=$2
            WHERE username=$1 RETURNING id::text AS id, username, role, active`,
          [action.username, action.role],
        );
        break;
    }
    if (result?.rowCount !== 1) {
      throw new Error("Account operation rejected");
    }
    await client.query("COMMIT");
    transaction = false;
    return result.rows[0]; // Never return a password or a stored password hash.
  } catch {
    if (transaction) await client.query("ROLLBACK").catch(() => undefined);
    throw new Error("Account operation rejected");
  } finally {
    client.release();
  }
}
