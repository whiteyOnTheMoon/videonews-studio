// Disposable Redis only. Never connect to the VPS, produce a job or fetch news.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Redis } from "ioredis";

if (
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REPOSITORY !== "whiteyOnTheMoon/videonews-studio" ||
  process.env.VNS_P2_STUDIO_STATUS_ACL_CI !== "true"
) {
  throw new Error("Studio status ACL integration refused outside disposable CI");
}

const password = "ci_only_private_studio_status_acl_password_20261110";
const python = [
  "import sys",
  "sys.path.insert(0, 'scripts')",
  "from p2_02_studio_status_acl_custody import acl_line",
  "sys.stdout.buffer.write(acl_line(sys.stdin.buffer.read()))",
].join("\n");
const raw = execFileSync("python3", ["-c", python], {
  input: Buffer.from(password + "\n"),
  encoding: "utf8",
}).trim();
const fields = raw.split(" ");
assert.deepEqual(fields.slice(0, 3), ["user", "vns_feed_status_studio", "on"]);
assert.match(fields[3], /^#[a-f0-9]{64}$/);

const address = { host: "127.0.0.1", port: 6379, connectTimeout: 2000 };
const admin = new Redis(address);
const completed = "bull:vns:feed:vns-feed-poll:completed";
const failed = "bull:vns:feed:vns-feed-poll:failed";
const job = "bull:vns:feed:vns-feed-poll:vns-feed-tick-12345";
const blocked = "bull:vns:feed:vns-feed-poll:wait";
const other = "bull:vns:vns-jobs:completed";
let status;

try {
  await admin.acl("SETUSER", ...fields.slice(1));
  await admin.zadd(completed, "123456", "vns-feed-tick-12345");
  await admin.zadd(failed, "123456", "vns-feed-tick-12344");
  await admin.hset(job, "returnvalue", '{"ok":true}');
  await admin.set(blocked, "forbidden");
  await admin.zadd(other, "123", "outside");

  status = new Redis({
    ...address,
    username: "vns_feed_status_studio",
    password,
    lazyConnect: true,
    enableReadyCheck: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  status.on("error", () => undefined);

  assert.equal(await status.ping(), "PONG");
  assert.equal(await status.zscore(completed, "vns-feed-tick-12345"), "123456");
  assert.equal(await status.zscore(failed, "vns-feed-tick-12344"), "123456");
  assert.equal(await status.hget(job, "returnvalue"), '{"ok":true}');
  assert.equal(await status.exists(job), 1);

  // Same queue, wrong key type/operation or another BullMQ namespace must fail.
  for (const operation of [
    () => status.set(job, "bad"),
    () => status.hset(job, "returnvalue", "bad"),
    () => status.zadd(completed, "1", "bad"),
    () => status.del(job),
    () => status.get(job),
    () => status.exists(blocked),
    () => status.zscore(other, "outside"),
    () => status.eval("return 1", 0),
    () => status.keys("*"),
    () => status.scan(0),
    () => status.acl("LIST"),
  ]) {
    await assert.rejects(operation(), /NOPERM/);
  }
  console.log("PASS: Studio status ACL authenticates and reads only exact feed completion evidence");
  console.log("PASS: writes, Lua, key enumeration, other jobs and other namespaces denied");
} finally {
  if (status) await status.quit().catch(() => status.disconnect());
  await admin.acl("DELUSER", "vns_feed_status_studio").catch(() => undefined);
  await admin.del(completed, failed, job, blocked, other).catch(() => undefined);
  await admin.quit().catch(() => admin.disconnect());
}
