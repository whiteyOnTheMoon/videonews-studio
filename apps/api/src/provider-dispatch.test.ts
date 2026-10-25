import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AdminProviderConfiguration } from "./admin-provider-configuration.js";
import { createApiServer } from "./server.js";

test("provider route stays unavailable unless an authenticated handler is explicitly injected", async () => {
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

test("provider handler without the core auth dependency is rejected before listening", () => {
  const key = randomBytes(32);
  try {
    const handler = new AdminProviderConfiguration(
      { hasAdminSession: () => true, originAllowed: () => true },
      {
        list: async () => [],
        mutateWithAudit: async () => undefined,
      },
      key,
    );
    assert.throws(
      () => createApiServer({ providerConfig: handler }),
      /Provider configuration requires authentication/,
    );
  } finally {
    key.fill(0);
  }
});
