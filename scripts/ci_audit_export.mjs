// P1-07: CI-ONLY, offline audit export integrity prototype.
// No production entry point, off-host upload, user-configurable SQL or URLs.
// Checksums detect changes relative to a TRUSTED manifest, not authenticity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_ROWS = 1000;
const MAX_FILE_BYTES = 3_000_000;
const SOURCE_USER = "vns_ci_audit_login";
const PREFIX = "vns-p1-07-audit-ci-";
const FORMAT = "vns-ci-audit-bundle-v1";

// Explicit column allowlists ensure account credentials cannot be exported.
// All three queries execute in one repeatable-read, read-only transaction.
const STREAMS = [
  {
    name: "source_reviews",
    file: "source_reviews.ndjson",
    fields: [
      "id", "evidence_id", "editor_id", "reviewer_label", "before_status",
      "after_status", "reason", "recorded_at",
    ],
    sql: `SELECT id::text, evidence_id::text, editor_id::text, reviewer_label,
                 before_status, after_status, reason, recorded_at
          FROM vns.evidence_review_events ORDER BY recorded_at, id LIMIT $1`,
  },
  {
    name: "editor_lifecycle",
    file: "editor_lifecycle.ndjson",
    fields: [
      "id", "editor_id", "editor_username", "operator_id", "operator_login",
      "operator_label", "operation", "password_rotated", "role_changed",
      "active_changed", "display_name_changed", "previous_role",
      "new_role", "previous_active", "new_active", "previous_auth_version",
      "new_auth_version", "recorded_at",
    ],
    sql: `SELECT id::text, editor_id::text, editor_username, operator_id::text,
                 operator_login::text, operator_label, operation, password_rotated,
                 role_changed, active_changed, display_name_changed,
                 previous_role, new_role, previous_active, new_active,
                 previous_auth_version, new_auth_version, recorded_at
          FROM vns.editor_account_lifecycle_events
          ORDER BY recorded_at, id LIMIT $1`,
  },
  {
    name: "operator_governance",
    file: "operator_governance.ndjson",
    fields: [
      "id", "login_role", "operator_id", "operator_label", "event_type",
      "authorized_by", "justification", "recorded_at",
    ],
    sql: `SELECT id::text, login_role::text, operator_id::text, operator_label,
                 event_type, authorized_by::text, justification, recorded_at
          FROM vns.editor_operator_registry_events
          ORDER BY recorded_at, id LIMIT $1`,
  },
];

function requireCi() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.CI !== "true" ||
    process.env.GITHUB_REPOSITORY !== "whiteyOnTheMoon/videonews-studio" ||
    process.env.VNS_CI_AUDIT_EXPORT_PROBE !== "true" ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
  ) {
    throw new Error("REFUSED: GitHub Actions disposable audit export only");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function strictFields(value, allowed) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value), allowed);
}

async function regularFile(directory, file) {
  const info = await lstat(join(directory, file));
  assert.ok(info.isFile() && !info.isSymbolicLink(), "Bundle contains a non-regular file");
  assert.ok(info.size <= MAX_FILE_BYTES, "Audit file exceeds CI size limit");
  assert.equal(info.mode & 0o077, 0, "Audit file must remain owner-only");
  return readFile(join(directory, file));
}

export async function exportCiAuditBundle(pool) {
  requireCi();
  const options = pool?.options;
  if (
    options?.host !== "127.0.0.1" ||
    Number(options?.port) !== 15434 ||
    options?.database !== "videonews" ||
    options?.user !== SOURCE_USER
  ) {
    throw new Error("REFUSED: only the disposable read-only audit LOGIN");
  }

  const client = await pool.connect();
  const directory = await mkdtemp(join(tmpdir(), PREFIX));
  let transaction = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transaction = true;
    const who = await client.query("SELECT session_user, current_user");
    assert.equal(who.rows[0].session_user, SOURCE_USER);
    assert.equal(who.rows[0].current_user, SOURCE_USER);

    const streams = [];
    for (const stream of STREAMS) {
      const result = await client.query(stream.sql, [MAX_ROWS + 1]);
      assert.ok(result.rowCount <= MAX_ROWS, "Audit snapshot too large for CI export");
      const lines = result.rows.map((row) => {
        strictFields(row, stream.fields);
        // PostgreSQL timestamps become UTC ISO strings when JSON serialized.
        const record = { stream: stream.name, ...row };
        return JSON.stringify(record) + "\n";
      });
      const bytes = Buffer.from(lines.join(""), "utf8");
      assert.ok(bytes.length <= MAX_FILE_BYTES, "Audit snapshot file exceeds limit");
      await writeFile(join(directory, stream.file), bytes, { flag: "wx", mode: 0o600 });
      streams.push({
        stream: stream.name,
        file: stream.file,
        rows: result.rows.length,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    }
    await client.query("COMMIT");
    transaction = false;
    const manifest = {
      format: FORMAT,
      generated_at: new Date().toISOString(),
      source_role: SOURCE_USER,
      streams,
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return directory;
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyCiAuditBundle(directory) {
  requireCi();
  assert.equal(typeof directory, "string");
  assert.ok(
    directory.startsWith(join(tmpdir(), PREFIX)) &&
      !directory.slice(join(tmpdir(), PREFIX).length).includes("/"),
    "REFUSED: non-CI audit directory",
  );
  const bytes = await regularFile(directory, "manifest.json");
  const manifest = JSON.parse(bytes.toString("utf8"));
  strictFields(manifest, ["format", "generated_at", "source_role", "streams"]);
  assert.equal(manifest.format, FORMAT);
  assert.equal(manifest.source_role, SOURCE_USER);
  assert.match(manifest.generated_at, /^\d{4}-\d\d-\d\dT/);
  assert.ok(Array.isArray(manifest.streams));
  assert.equal(manifest.streams.length, STREAMS.length);

  for (let i = 0; i < STREAMS.length; i += 1) {
    const definition = STREAMS[i];
    const entry = manifest.streams[i];
    strictFields(entry, ["stream", "file", "rows", "bytes", "sha256"]);
    assert.equal(entry.stream, definition.name);
    assert.equal(entry.file, definition.file);
    assert.ok(Number.isSafeInteger(entry.rows) && entry.rows >= 0 && entry.rows <= MAX_ROWS);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    const content = await regularFile(directory, definition.file);
    assert.equal(content.length, entry.bytes, "Audit file length mismatch");
    assert.equal(sha256(content), entry.sha256, "Audit file checksum mismatch");
    const data = content.toString("utf8");
    const lines = data ? data.split("\n").slice(0, -1) : [];
    assert.ok(data === "" || data.endsWith("\n"), "Unterminated NDJSON");
    assert.equal(lines.length, entry.rows, "Audit event count mismatch");
    for (const line of lines) {
      const event = JSON.parse(line);
      strictFields(event, ["stream", ...definition.fields]);
      assert.equal(event.stream, definition.name);
      assert.equal(JSON.stringify(event), line, "Audit event is not canonical");
    }
  }
  return { streams: manifest.streams.map(({ stream, rows }) => ({ stream, rows })) };
}
