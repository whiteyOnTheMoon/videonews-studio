#!/usr/bin/env node
// ONE-TIME, SHA-pinned deletion of two already-merged historical refs.
// Deletion only after audited PR is merged via an exact-title main push.
// Explicitly retain P1-09, P3 open-PR branches and the default branch.

const REPO = "whiteyOnTheMoon/videonews-studio";
const OWN = "maintenance/p1-02-final-merged-refs-prune-20261112";
const BASE = "ac6b6d96c6c7607a1bdc909e9ff1fc6c69dc5d20";
const TITLE = "[P1-02] Verified final cleanup of 2 merged refs";
const candidates = Object.freeze([
  {
    branch: "maintenance/p1-02-merged-branch-prune-20261111",
    sha: "40577662841dedcda7c0f23cb3e14819de3ede69",
    pr: 501,
  },
  {
    branch: "p2-02-redis8-unpause-watchdog-policy-20261111",
    sha: "91b412f2678777305ab573f7e1cec86166245ac1",
    pr: 503,
  },
]);
const protectedRefs = Object.freeze([
  {branch: "main", sha: BASE},
  {branch: "p1-09-operator-prompt-key-distribution",
   sha: "af5e981347a22b7527e89e304df0b0988b9785c5"},
  {branch: "feat/p1-09-guarded-admin-pricing-deployment",
   sha: "b0322a21b02d4a84511cd2a230132eb2b702e258"},
  {branch: "p3-07-curated-real-ozone-voice-20261109",
   sha: "19689b3090b5cd66e8aad1cb0ee695fd7b625a37"},
  {branch: "p3-synthetic-playable-mp4-demo-20261109",
   sha: "93b62969d91775e77b3696fb497dbee077440e6e"},
]);
const mode = process.argv[2];
const deleting = mode === "--delete";
const auditing = mode === "--audit";
const shaOk = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const refuse = reason => { throw new Error("REFUSED: branch-cleanup: " + reason); };
if (deleting === auditing ||
    process.env.GITHUB_REPOSITORY !== REPO ||
    !process.env.GITHUB_TOKEN ||
    !shaOk(process.env.GITHUB_SHA)) refuse("bad invocation context");
if (new Set(candidates.map(x => x.branch)).size !== 2) refuse("unexpected candidate set");

const refPath = name => {
  if (typeof name !== "string" ||
      !/^[a-z][a-z0-9._/-]{2,127}$/.test(name) ||
      name.includes("..") || name.includes("//") ||
      name.startsWith("/") || name.endsWith("/") ||
      name === "main") refuse("unsafe deletion ref");
  return name.split("/").map(encodeURIComponent).join("/");
};

async function api(path, method="GET") {
  let response;
  try {
    response = await fetch("https://api.github.com/repos/" + REPO + path, {
      method,
      headers: {
        Authorization: "Bearer " + process.env.GITHUB_TOKEN,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    refuse("GitHub request failed, do not auto-retry");
  }
  if (method === "DELETE" && response.status === 204) return null;
  if (method === "GET" && response.status === 404) return null;
  if (!response.ok) refuse("GitHub returned HTTP " + response.status);
  return response.json();
}

const prNumber = auditing ? Number(process.env.VNS_OWN_PR_NUMBER) : null;
let ownPR;
if (auditing) {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request" ||
      !Number.isSafeInteger(prNumber) || prNumber <= 0 ||
      !shaOk(process.env.VNS_OWN_PR_SHA)) refuse("not an authenticated review PR");
  ownPR = await api("/pulls/" + prNumber);
  if (!ownPR || ownPR.state !== "open" ||
      ownPR.head?.ref !== OWN ||
      ownPR.head?.sha !== process.env.VNS_OWN_PR_SHA ||
      ownPR.head?.repo?.full_name !== REPO ||
      ownPR.base?.ref !== "main" ||
      ownPR.base?.sha !== BASE) refuse("own review PR or base changed");
} else {
  const runSha = process.env.GITHUB_SHA;
  if (process.env.GITHUB_EVENT_NAME !== "push" ||
      process.env.GITHUB_REF !== "refs/heads/main")
    refuse("cleanup may run only on main merge push");
  const [main, commit, linkedPRs] = await Promise.all([
    api("/branches/main"),
    api("/commits/" + runSha),
    api("/commits/" + runSha + "/pulls"),
  ]);
  if (main?.commit?.sha !== runSha ||
      !commit?.commit?.message?.startsWith(TITLE + " (#") ||
      !Array.isArray(linkedPRs)) refuse("main does not point at exact cleanup merge");
  ownPR = linkedPRs.find(p => p.merge_commit_sha === runSha &&
      p.head?.ref === OWN && p.merged_at && p.state === "closed");
  if (!ownPR || ownPR.head?.repo?.full_name !== REPO ||
      ownPR.base?.ref !== "main" ||
      !shaOk(ownPR.head?.sha)) refuse("not the audited merged cleanup PR");
}

const [all, open, main] = await Promise.all([
  api("/branches?per_page=100"),
  api("/pulls?state=open&per_page=100"),
  api("/branches/main"),
]);
if (!Array.isArray(all) || all.length !== 8 ||
    !Array.isArray(open) || open.length !== (auditing ? 3 : 2))
  refuse("unexpected branch/PR count, preserve all refs");
const byName = new Map(all.map(b => [b.name, b]));
if (byName.size !== 8) refuse("duplicate branch list");
const expected = new Set([
  ...candidates.map(x => x.branch),
  ...protectedRefs.map(x => x.branch),
  OWN,
]);
if (expected.size !== 8 ||
    [...byName.keys()].some(name => !expected.has(name)))
  refuse("unexpected branch; do not delete anything");

if (!deleting && main?.commit?.sha !== BASE) refuse("main changed since review base");
if (deleting && main?.commit?.sha !== process.env.GITHUB_SHA)
  refuse("main changed since merge");

for (const item of protectedRefs) {
  const entry = byName.get(item.branch);
  if (!entry || entry.protected !== false ||
      (item.branch !== "main" && entry.commit?.sha !== item.sha))
    refuse("protected/reference branch unexpectedly changed");
}
const openHeads = new Set(open.map(p => p.head?.ref));
for (const active of [
  "p3-07-curated-real-ozone-voice-20261109",
  "p3-synthetic-playable-mp4-demo-20261109",
]) if (!openHeads.has(active)) refuse("open P3 PR changed");
if (openHeads.has(candidates[0].branch) || openHeads.has(candidates[1].branch))
  refuse("candidate has open PR");
if (auditing && !openHeads.has(OWN)) refuse("own review PR missing");
if (deleting && openHeads.has(OWN)) refuse("own cleanup PR still open");

for (const candidate of candidates) {
  const entry = byName.get(candidate.branch);
  const pr = await api("/pulls/" + candidate.pr);
  if (!entry || entry.protected || entry.commit?.sha !== candidate.sha ||
      !pr || pr.state !== "closed" || !pr.merged_at ||
      pr.head?.ref !== candidate.branch ||
      pr.head?.sha !== candidate.sha ||
      pr.head?.repo?.full_name !== REPO ||
      pr.base?.ref !== "main")
    refuse("candidate branch or merged PR mismatch: " + candidate.branch);
  const comparison = await api("/compare/" + candidate.sha + "..." +
      main.commit.sha);
  if (!comparison || comparison.behind_by !== 0 ||
      comparison.ahead_by < 0)
    refuse("candidate not fully contained in main");
}

const own = byName.get(OWN);
if (!own || own.protected || own.commit?.sha !== ownPR.head.sha)
  refuse("own maintenance branch changed");
console.log("AUDITED_CANDIDATE_COUNT=2");
console.log("MERGED_PR_IDS=501,503");
console.log("ACTIVE_P1_P3_BRANCHES_PRESERVED=true");
if (auditing) {
  console.log("AUDIT_ONLY=true");
  console.log("BRANCHES_DELETED=0");
  process.exit(0);
}
for (const candidate of candidates) {
  const fresh = await api("/branches/" + refPath(candidate.branch));
  if (!fresh || fresh.protected || fresh.commit?.sha !== candidate.sha)
    refuse("changed ref immediately before deletion, stop");
  await api("/git/refs/heads/" + refPath(candidate.branch), "DELETE");
  console.log("DELETED_MERGED_BRANCH=" + candidate.branch);
}
const freshOwn = await api("/branches/" + refPath(OWN));
if (!freshOwn || freshOwn.protected ||
    freshOwn.commit?.sha !== ownPR.head.sha)
  refuse("own ref changed immediately before deletion");
await api("/git/refs/heads/" + refPath(OWN), "DELETE");
console.log("DELETED_MAINTENANCE_BRANCH=" + OWN);
console.log("DELETED_TOTAL=3");
console.log("PRESERVED_MAIN_P1_P3=true");
