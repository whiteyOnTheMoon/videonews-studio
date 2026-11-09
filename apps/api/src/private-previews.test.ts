import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { EditorAuth } from "./editor-auth.js";
import {
  PrivatePreviewService,
  privatePreviewServiceFromEnv,
} from "./private-previews.js";

const origin = "https://studio.ap-pixels.com";
function actor(allowed: boolean): EditorAuth {
  return {
    authenticatedAdminIdentity: async () =>
      allowed
        ? { id: "00000000-0000-4000-8000-000000000123", username: "operator", role: "admin", authVersion: 1 }
        : null,
  } as unknown as EditorAuth;
}

async function request(
  service: PrivatePreviewService,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  const server = createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.writeHead(404);
        res.end();
      }
    }).catch(() => {
      if (!res.writableEnded) {
        res.writeHead(503);
        res.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
    });
  } finally {
    server.close();
  }
}

test("preview service defaults off even when env contains no credentials", () => {
  assert.equal(privatePreviewServiceFromEnv(undefined, {}), undefined);
  assert.equal(privatePreviewServiceFromEnv(actor(true), {}), undefined);
  assert.equal(
    privatePreviewServiceFromEnv(actor(true), {
      VNS_PRIVATE_PREVIEWS_API_ENABLED: "true",
      VNS_ADMIN_ORIGIN: origin,
      VNS_PRIVATE_PREVIEWS_ROOT: "/home/ap/www/public",
    }),
    undefined,
  );
});

test("unauthenticated listing, status and streams are denied", async () => {
  const service = new PrivatePreviewService(actor(false), origin, false);
  for (const path of [
    "/admin/private-previews",
    "/admin/private-previews/status",
    "/admin/private-previews/earth-climate-explained-ozone-2026-en-20261109-223501-01234567.mp4",
  ]) {
    const response = await request(service, path);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.doesNotMatch(await response.text(), /ozone-2026-en-2026/);
  }
});

test("review-only login cannot trigger rendering unless explicitly activated", async () => {
  const service = new PrivatePreviewService(actor(true), origin, false);
  const response = await request(service, "/admin/private-previews/render", "POST", {
    origin,
    "content-type": "application/json",
  }, JSON.stringify({ storyId: "ozone-2026-explained-en" }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "render_disabled" });
  const status = await request(service, "/admin/private-previews/status");
  assert.equal((await status.json()).state, "idle");
});

test("path traversal, malformed filename and method mismatch cannot expose bytes", async () => {
  const service = new PrivatePreviewService(actor(true), origin, false);
  const attempts = [
    "/admin/private-previews/%2e%2e%2fprivate.key",
    "/admin/private-previews/test.mp4",
    "/admin/private-previews/a.mp4?other=1",
  ];
  for (const path of attempts) {
    const response = await request(service, path);
    assert.equal(response.status, 404);
    if (response.headers.has("content-type")) {
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    }
  }
  const badMethod = await request(service, "/admin/private-previews", "POST");
  assert.equal(badMethod.status, 405);
});

test("only HTTPS origin can be configured", () => {
  assert.throws(() => new PrivatePreviewService(actor(true), "http://example.com", false));
  assert.throws(() => new PrivatePreviewService(actor(true), "https://example.com/secret", false));
});
