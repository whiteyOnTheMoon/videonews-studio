import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { DormantPersonalEditorialAdmin } from "../apps/api/dist/personal-editorial-admin.js";
import { verifyWebRankedFeedBridge } from "./ci_p2_web_admin_bridge.mjs";

const ORIGIN = "https://studio.example.invalid";
const TEST_EDITOR_ID = "ca340001-1111-4111-8111-111111111111";

/**
 * End-to-end API exercise using the real PostgreSQL editor LOGIN and
 * physically separate DBA connection already provisioned by the isolated
 * Redis -> feed -> projector integration fixture.
 *
 * No HTTP port, bearer token, real editor credential or internet required.
 * Every API query goes through the real session_user authorization functions.
 */
export async function verifyNamedAdminRankedFeed({ reader, dba }) {
  if (
    process.env.CI !== "true" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.VNS_P2_ISOLATED_PORT_TEST !== "true"
  ) {
    throw new Error("Named admin integration requires disposable GitHub PostgreSQL");
  }

  const login = await reader.query("SELECT session_user AS login");
  assert.equal(login.rows[0]?.login, "editor_ci_fullchain");
  const editor = {
    id: TEST_EDITOR_ID,
    authVersion: 0,
    username: "ci_port_source",
    role: "admin",
  };
  let currentIdentity = editor;
  let authenticated = true;
  let connections = 0;
  let selectCalls = 0;
  const handler = new DormantPersonalEditorialAdmin(
    {
      async authenticatedAdminIdentity() {
        return authenticated ? currentIdentity : null;
      },
    },
    {
      originAllowed(request) {
        return request.headers.origin === ORIGIN;
      },
    },
    {
      async open() {
        connections++;
        // This same bounded real PostgreSQL LOGIN is used by the API,
        // not a DBA pool or a mock SELECT return value.
        return {
          async query(sql, args = []) {
            selectCalls++;
            assert.match(sql, /^SELECT /);
            assert.ok(
              sql === "SELECT * FROM vns.named_current_editor()" ||
                sql === "SELECT * FROM vns.named_ranked_feed_page($1::integer)",
            );
            return reader.query(sql, [...args]);
          },
          async close() {
            // A fresh DB session is already separately tested by the
            // personal-session factory. The disposable E2E reader is shared.
          },
        };
      },
    },
    true,
  );

  async function request(method, path, origin = ORIGIN) {
    const req = Object.assign(Readable.from([""]), {
      url: path,
      method,
      headers: {
        origin,
        cookie: "__Host-vns_editor=synthetic-disposable-e2e",
      },
    });
    const response = {
      status: 0,
      body: "",
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body ?? "";
      },
    };
    assert.equal(await handler.handle(req, response), true);
    return { status: response.status, json: JSON.parse(response.body), headers: response.headers };
  }

  const path = "/admin/editorial-ranked-events?limit=25";
  const accepted = await request("GET", path);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal(accepted.json.metadataOnly, true);
  assert.equal(accepted.json.candidates.length, 1);
  const candidate = accepted.json.candidates[0];
  assert.equal(candidate.profileId, "science_news");
  assert.equal(candidate.articleCount, 3);
  assert.equal(candidate.sourceCount, 3);
  assert.equal(candidate.approvedForPublication, false);
  assert.ok(candidate.reasons.includes("independent_verification_required"));
  assert.deepEqual(
    Object.keys(candidate).sort(),
    [
      "approvedForPublication",
      "articleCount",
      "eventId",
      "headline",
      "profileId",
      "profileRevision",
      "rankedAt",
      "reasons",
      "score",
      "sourceCount",
    ].sort(),
  );
  assert.ok(connections >= 1 && selectCalls >= 2);
  await verifyWebRankedFeedBridge(handler);

  // Method denial, missing cookie-level authorization and malformed query
  // may not create new source or ranking rows or access the database.
  const beforeUnauthorized = connections;
  assert.equal((await request("POST", path)).status, 405);
  authenticated = false;
  assert.equal((await request("GET", path)).status, 401);
  authenticated = true;
  assert.equal(connections, beforeUnauthorized);

  // A compromised/inconsistent browser identity cannot be silently
  // substituted for the DB's authenticated editor identity.
  currentIdentity = { ...editor, authVersion: 1 };
  const mismatched = await request("GET", path);
  assert.equal(mismatched.status, 403);
  assert.ok(!JSON.stringify(mismatched.json).includes(candidate.headline));
  currentIdentity = editor;

  const invalid = await request("GET", "/admin/editorial-ranked-events?limit=25&actor=forged");
  assert.equal(invalid.status, 400);

  // Revoke personal DB principal in the disposable DBA session. The
  // source/ranking rows remain persisted but no subsequent API read
  // is authorized. Always restore for teardown and other CI assertions.
  try {
    await dba.query(
      "UPDATE vns.editor_db_principals SET active=false WHERE login_role='editor_ci_fullchain'",
    );
    const revoked = await request("GET", path);
    await verifyWebRankedFeedBridge(handler, "revoked");
    assert.notEqual(revoked.status, 200);
    assert.ok(!JSON.stringify(revoked.json).includes(candidate.headline));
    const stillThere = await dba.query(
      "SELECT count(*)::integer AS count FROM vns.feed_event_rankings",
    );
    assert.equal(stillThere.rows[0]?.count, 1);
  } finally {
    await dba.query(
      "UPDATE vns.editor_db_principals SET active=true WHERE login_role='editor_ci_fullchain'",
    );
  }
  const restored = await request("GET", path);
  assert.equal(restored.status, 200);
  await verifyWebRankedFeedBridge(handler);
  assert.equal(restored.json.candidates[0].eventId, candidate.eventId);
}
