import assert from "node:assert/strict";
import { once } from "node:events";
import { type AddressInfo } from "node:net";
import test from "node:test";
import { createApiServer } from "./server.js";

test("health endpoint answers only GET and does not cache responses", async () => {
  const server = createApiServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;

    const ok = await fetch(url + "/healthz");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal((await ok.json() as { service: string }).service, "api");

    const missing = await fetch(url + "/missing");
    assert.equal(missing.status, 404);

    const wrongMethod = await fetch(url + "/healthz", { method: "POST" });
    assert.equal(wrongMethod.status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
