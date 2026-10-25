// Disposable GitHub Actions Redis ACL integration. No VPS or source access.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.CI !== "true" ||
  process.env.GITHUB_REPOSITORY !== "whiteyOnTheMoon/videonews-studio" ||
  !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
) {
  throw new Error("REFUSED: disposable GitHub Actions only");
}
const directory = process.env.VNS_CI_ACL_DIRECTORY;
if (!directory?.startsWith("/tmp/")) throw new Error("REFUSED: disposable secret directory only");
const port = 16381;
const base = {
  host: "127.0.0.1",
  port,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
};
const settings = (username, file) => ({
  ...base,
  username,
  password: readFileSync(directory + "/" + file, "utf8").trimEnd(),
});
const probe = new Redis(settings("vns_worker", "redis_password"));
const research = new Redis(settings("vns_research", "research_password"));
const probeQueue = new Queue("vns-jobs", { connection: probe, prefix: "bull:vns" });
const researchQueue = new Queue("vns-research", { connection: research, prefix: "bull:vns" });
try {
  assert.equal(await probe.ping(), "PONG");
  assert.equal(await research.ping(), "PONG");
  // Allowed commands and real BullMQ Lua operations in each distinct namespace.
  const p = await probeQueue.add("probe", { kind: "probe" }, { jobId: "aclprobe" });
  const r = await researchQueue.add("research", { kind: "research" }, { jobId: "aclresearch" });
  assert.equal((await probeQueue.getJob(p.id))?.id, p.id);
  assert.equal((await researchQueue.getJob(r.id))?.id, r.id);
  const denied = async (operation) =>
    assert.rejects(operation(), (error) => /NOPERM/.test(String(error?.message)));
  await denied(() => probe.exists("bull:vns:vns-research:wait"));
  await denied(() => research.exists("bull:vns:vns-jobs:wait"));
  await denied(() => probe.set("bull:vns:vns-research:forbidden", "1"));
  await denied(() => research.set("bull:vns:vns-jobs:forbidden", "1"));
  await denied(() => probe.publish("bull:vns:vns-research:events", "forbidden"));
  await denied(() => research.publish("bull:vns:vns-jobs:events", "forbidden"));
  await denied(() => probe.exists("unrelated:key"));
  await denied(() => research.exists("unrelated:key"));
  console.log("PASS: isolated Redis users each operate own BullMQ queue");
  console.log("PASS: cross-queue key writes, reads and pub/sub publishing denied");
} finally {
  await Promise.allSettled([probeQueue.close(), researchQueue.close()]);
  await Promise.allSettled([probe.quit(), research.quit()]);
}
