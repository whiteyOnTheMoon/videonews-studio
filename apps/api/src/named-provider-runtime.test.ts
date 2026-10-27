import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import type { Pool, PoolConfig } from "pg";
import type { AdminAuth } from "./auth.js";
import type { EditorAuth } from "./editor-auth.js";
import type { withProviderMasterKey } from "./provider-master-key-file.js";
import { namedProviderRuntimeFromEnv } from "./named-provider-runtime.js";

const editor = {} as EditorAuth;
const auth = {} as AdminAuth;
const valid = {
  VNS_ADMIN_AUTH_ENABLED: "true",
  VNS_EDITOR_AUTH_ENABLED: "true",
  VNS_PROVIDER_ADMIN_WRITE_ENABLED: "true",
  VNS_PROVIDER_WRITER_PASSWORD_FILE: "/run/secrets/pg_provider_admin_password",
  VNS_ADMIN_ORIGIN: "https://example.invalid",
};
function scenario(allowed: boolean) {
  let closed = 0;
  const configs: PoolConfig[] = [];
  const keys: Buffer[] = [];
  const pool = {
    async query() {
      return { rows: [{ who: "vns_provider_config_login", admitted: allowed }] };
    },
    async end() {
      closed++;
    },
  } as unknown as Pool;
  const factory = (config: PoolConfig): Pool => {
    configs.push(config);
    return pool;
  };
  const key: typeof withProviderMasterKey = async <T>(
    callback: (value: Buffer) => T | Promise<T>,
  ): Promise<T> => {
    const bytes = randomBytes(32);
    keys.push(bytes);
    try {
      return await callback(bytes);
    } finally {
      bytes.fill(0);
    }
  };
  return { factory, key, configs, keys, closed: () => closed };
}
test("provider administration stays off unless all runtime gates are enabled", async () => {
  const f = scenario(true);
  const runtime = await namedProviderRuntimeFromEnv(editor, auth, {}, undefined, f.factory, f.key);
  assert.equal(runtime, undefined);
  assert.equal(f.configs.length, 0);
});
test("role mismatch refuses startup and closes dedicated pool", async () => {
  const f = scenario(false);
  await assert.rejects(
    namedProviderRuntimeFromEnv(
      editor,
      auth,
      valid,
      () => "ci_placeholder_not_real_1234567",
      f.factory,
      f.key,
    ),
    /Named provider runtime unavailable/,
  );
  assert.equal(f.closed(), 1);
  assert.equal(f.keys.length, 0);
});
test("verified dedicated pool and private key are required", async () => {
  const f = scenario(true);
  const runtime = await namedProviderRuntimeFromEnv(
    editor,
    auth,
    valid,
    () => "ci_placeholder_not_real_1234567",
    f.factory,
    f.key,
  );
  assert.ok(runtime);
  assert.equal(f.configs[0]?.user, "vns_provider_config_login");
  assert.equal(f.configs[0]?.host, "postgres");
  assert.equal(f.configs[0]?.max, 2);
  assert.deepEqual(f.keys[0], Buffer.alloc(32));
  await runtime.close();
  assert.equal(f.closed(), 1);
});
