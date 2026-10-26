import assert from "node:assert/strict";
import { once } from "node:events";
import { type AddressInfo } from "node:net";
import test from "node:test";
import type { AdminAuth } from "./auth.js";
import type { AdminJobs } from "./admin-jobs.js";
import type { EditorAuth } from "./editor-auth.js";
import { DormantNamedSourceAdmin } from "./admin-source-registry.js";
import { createApiServer } from "./server.js";

test("server source registry is absent by default and requires named-admin dependencies", () => {
  assert.throws(
    () => createApiServer({ sourceRegistry: {} as DormantNamedSourceAdmin }),
    /named-admin contract/,
  );
  const sourceRegistry = new DormantNamedSourceAdmin(
    {
      async authenticatedAdminIdentity() {
        return null;
      },
    },
    {
      originAllowed() {
        return true;
      },
    },
    {
      async read() {
        return { revision: 0, sources: [] };
      },
      async saveWithAudit() {
        return "saved";
      },
    },
    {
      async allow() {
        return true;
      },
    },
    false,
  );
  assert.throws(() => createApiServer({ sourceRegistry }), /personal admin authentication/);
});
test("explicitly injected source API remains isolated from production runtime", async () => {
  const registry = new DormantNamedSourceAdmin(
    {
      async authenticatedAdminIdentity() {
        return {
          id: "12345678-1234-4123-8123-123456789012",
          username: "ci_admin",
          role: "admin" as const,
          authVersion: 0,
        };
      },
    },
    { originAllowed() { return true; } },
    {
      async read() {
        return { revision: 0, sources: [] };
      },
      async saveWithAudit() {
        return "saved";
      },
    },
    {
      async allow() {
        return true;
      },
    },
    true,
  );
  const server = createApiServer({
    auth: { originAllowed() { return true; } } as unknown as AdminAuth,
    jobs: {} as AdminJobs,
    editor: {} as EditorAuth,
    sourceRegistry: registry,
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/admin/news-sources`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { revision: 0, sources: [] });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
