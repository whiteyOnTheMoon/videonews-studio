import assert from "node:assert/strict";
import test from "node:test";
import { privatePreviewProxy, privatePreviewProxyConfig } from "./private-preview-proxy.js";

const config = { origin: "https://studio.ap-pixels.com", api: "http://api:4000" };
const admin = "__Host-vns_session=" + "a".repeat(64);
const editor = "__Host-vns_editor=" + "b".repeat(64);
const cookies = admin + "; " + editor;
const file = "earth-climate-explained-ozone-2026-en-20261109-223501-01234567.mp4";
function request(
  path: string,
  method = "GET",
  opts: { cookie?: string; origin?: string; range?: string } = {},
) {
  return new Request(config.origin + path, {
    method,
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.range ? { range: opts.range } : {}),
    },
  });
}
function authorizedFetch(
  extra: (url: string) => Response = () => Response.json({ files: [], private: true }),
) {
  return async (resource: string | URL | Request): Promise<Response> => {
    const url = String(resource);
    if (url.endsWith("/admin/me")) return Response.json({ role: "admin" });
    if (url.endsWith("/editor/me")) return Response.json({ username: "operator", role: "admin" });
    return extra(url);
  };
}

test("preview BFF is disabled by default, even when an admin session exists", async () => {
  assert.equal(privatePreviewProxyConfig({}), null);
  const result = await privatePreviewProxy(
    request("/api/admin/private-previews", "GET", { cookie: cookies }),
    "list",
    null,
  );
  assert.equal(result.status, 404);
});

test("missing cookies fail closed without any upstream calls", async () => {
  let calls = 0;
  const result = await privatePreviewProxy(
    request("/api/admin/private-previews", "GET", { cookie: admin }),
    "list",
    config,
    undefined,
    async () => {
      calls++;
      return new Response();
    },
  );
  assert.equal(result.status, 401);
  assert.equal(calls, 0);
});

test("admin and named-editor session must both be currently valid", async () => {
  const invalid = await privatePreviewProxy(
    request("/api/admin/private-previews", "GET", { cookie: cookies }),
    "list",
    config,
    undefined,
    async (resource) =>
      String(resource).endsWith("/admin/me")
        ? Response.json({ role: "admin" })
        : Response.json({ username: "viewer", role: "editor" }),
  );
  assert.equal(invalid.status, 403);
});

test("safe list data is returned without any publishing permission", async () => {
  const response = await privatePreviewProxy(
    request("/api/admin/private-previews", "GET", { cookie: cookies }),
    "list",
    config,
    undefined,
    authorizedFetch(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { files: [], private: true });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("malformed upstream list or forged publication status is refused", async () => {
  const response = await privatePreviewProxy(
    request("/api/admin/private-previews", "GET", { cookie: cookies }),
    "list",
    config,
    undefined,
    authorizedFetch(() =>
      Response.json({
        private: true,
        files: [
          {
            file,
            bytes: 200000,
            modifiedAt: "2026-11-09T22:35:01.000Z",
            reviewRequired: true,
            publishingAllowed: true,
          },
        ],
      }),
    ),
  );
  assert.equal(response.status, 503);
});

test("path traversal and malformed Range are rejected before streaming", async () => {
  const invalid = await privatePreviewProxy(
    request("/api/admin/private-previews/%2Fetc%2Fpasswd", "GET", { cookie: cookies }),
    "file",
    config,
    "%2Fetc%2Fpasswd",
    authorizedFetch(),
  );
  assert.equal(invalid.status, 404);
  const range = await privatePreviewProxy(
    request("/api/admin/private-previews/" + file, "GET", {
      cookie: cookies,
      range: "bytes=0-10,20-30",
    }),
    "file",
    config,
    file,
    authorizedFetch(),
  );
  assert.equal(range.status, 416);
});

test("download response always preserves privacy and attachment semantics", async () => {
  const bytes = new Uint8Array([0, 1, 2, 3]);
  const response = await privatePreviewProxy(
    request("/api/admin/private-previews/" + file + "?download=1", "GET", { cookie: cookies }),
    "file",
    config,
    file,
    authorizedFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": "4",
            "Content-Disposition": "inline",
          },
        }),
    ),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

test("render request requires same-site origin; no upstream request on mismatch", async () => {
  const response = await privatePreviewProxy(
    request("/api/admin/private-previews/render", "POST", {
      cookie: cookies,
      origin: "https://other.example.com",
    }),
    "render",
    config,
    undefined,
    authorizedFetch(),
  );
  assert.equal(response.status, 403);
});
