import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AdminAuth } from "./auth.js";
import type { AdminJobs } from "./admin-jobs.js";
import { AdminProviderConfiguration } from "./admin-provider-configuration.js";
import type { EditorAuth } from "./editor-auth.js";
import { NamedAdminProviderConfiguration } from "./named-admin-provider-configuration.js";
import { createApiServer } from "./server.js";

test("provider route stays unavailable unless a named handler is explicitly injected", async () => {
  const server = createApiServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const reply = await fetch(`http://127.0.0.1:${address.port}/admin/ai-providers`);
    assert.equal(reply.status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("only a personally authenticated provider handler can be mounted", () => {
  const key = randomBytes(32);
  try {
    const named = new NamedAdminProviderConfiguration(
      { authenticatedAdminIdentity: async () => null },
      { originAllowed: () => true },
      {
        list: async () => [],
        mutateAsNamedAdmin: async () => undefined,
      },
      key,
      { allow: async () => true },
    );
    assert.throws(
      () => createApiServer({ providerConfig: named }),
      /Provider configuration requires authentication/,
    );
    assert.throws(
      () => createApiServer({ auth: {} as AdminAuth, providerConfig: named }),
      /requires personal editor authentication/,
    );

    const legacy = new AdminProviderConfiguration(
      { hasAdminSession: () => true, originAllowed: () => true },
      {
        list: async () => [],
        mutateWithAudit: async () => undefined,
      },
      key,
    );
    assert.throws(
      () =>
        createApiServer({
          auth: {} as AdminAuth,
          jobs: {} as AdminJobs,
          editor: {} as EditorAuth,
          providerConfig: legacy as unknown as NamedAdminProviderConfiguration,
        }),
      /Legacy provider configuration is forbidden/,
    );
  } finally {
    key.fill(0);
  }
});
