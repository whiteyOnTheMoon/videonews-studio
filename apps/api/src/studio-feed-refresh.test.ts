import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { AdminAuth } from "./auth.js";
import type { EditorAuth } from "./editor-auth.js";
import {
  feedSlotAt,
  StudioFeedRefreshService,
  studioFeedRefreshFromEnv,
  type FeedProducerPort,
} from "./studio-feed-refresh.js";

const NOW = new Date("2026-11-10T04:00:00.000Z");
const slot = Math.floor(NOW.getTime() / 900000);
const ORIGIN = "https://studio.ap-pixels.com";

function auth(allowed = true, correctOrigin = true): AdminAuth {
  return {
    hasAdminSession: () => allowed,
    originAllowed: () => correctOrigin,
  } as unknown as AdminAuth;
}

function editor(role: "admin" | "reviewer" | null = "admin"): EditorAuth {
  return {
    authenticatedAdminIdentity: async () =>
      role
        ? {
            id: "a0000000-0000-4000-8000-000000000001",
            authVersion: 1,
            username: "operator",
            role,
          }
        : null,
  } as unknown as EditorAuth;
}

async function call(service: StudioFeedRefreshService, method = "POST", origin = ORIGIN) {
  const server = createServer((req, res) => {
    void service.handle(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await fetch("http://127.0.0.1:" + address.port + "/admin/studio-news-refresh", {
      method,
      headers: { Origin: origin },
    });
  } finally {
    server.close();
  }
}

test("producer bridge stays OFF without explicit admission", () => {
  assert.equal(studioFeedRefreshFromEnv(undefined, undefined, {}), undefined);
  assert.throws(
    () =>
      studioFeedRefreshFromEnv(auth(), editor(), {
        VNS_STUDIO_FEED_REFRESH_API_ENABLED: "true",
        VNS_STUDIO_FEED_REFRESH_OPERATOR_ACK: "true",
      }),
    /not authorized/,
  );
  assert.equal(feedSlotAt(NOW), slot);
  assert.throws(() => feedSlotAt(new Date("invalid")), /clock refused/);
});

test("authenticated request enqueues the exact deterministic queue payload", async () => {
  const calls: unknown[][] = [];
  const producer: FeedProducerPort = {
    async add(...args) {
      calls.push(args);
    },
  };
  const service = new StudioFeedRefreshService(auth(), editor(), producer, undefined, () => NOW);
  const response = await call(service);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: true,
    queueJobId: "vns-feed-tick-" + slot,
    completed: false,
    publishingAllowed: false,
  });
  assert.deepEqual(calls, [
    [
      "feed-tick",
      { kind: "feed-tick", slot },
      {
        jobId: "vns-feed-tick-" + slot,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    ],
  ]);
  assert.equal((await call(service)).status, 202);
  assert.deepEqual(calls[0], calls[1]);
});

test("anonymous, wrong editor, wrong origin and GET never contact producer", async () => {
  let attempts = 0;
  const producer = {
    async add() {
      attempts++;
    },
  };
  assert.equal(
    (await call(new StudioFeedRefreshService(auth(false), editor(), producer))).status,
    401,
  );
  assert.equal(
    (await call(new StudioFeedRefreshService(auth(), editor(null), producer))).status,
    403,
  );
  assert.equal(
    (await call(new StudioFeedRefreshService(auth(), editor("reviewer"), producer))).status,
    403,
  );
  assert.equal(
    (await call(new StudioFeedRefreshService(auth(true, false), editor(), producer))).status,
    403,
  );
  assert.equal(
    (await call(new StudioFeedRefreshService(auth(), editor(), producer), "GET")).status,
    405,
  );
  assert.equal(attempts, 0);
});

test("producer errors never become a success confirmation or leak details", async () => {
  const producer = {
    async add() {
      throw new Error("upstream secret must not escape");
    },
  };
  const response = await call(new StudioFeedRefreshService(auth(), editor(), producer));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /secret|completed":true/);
});
