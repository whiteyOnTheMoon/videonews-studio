#!/usr/bin/env node
// One-time SHA-pinned cleanup v2: bulk read-only admission, per-ref checked deletion.
// Never run from VPS. Refuses changed, missing, open, protected or unmerged refs.
// No retry after partial failure; operator must independently audit state.
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(
  new URL("../docs/maintenance/branch-prune-2026-11-11-v2.json", import.meta.url),
  "utf8",
));
const repo = "whiteyOnTheMoon/videonews-studio";
const ownBranch = "maintenance/p1-02-merged-branch-prune-bulk-20261111";
const commitTitle = "[P1-02] Verified cleanup of 182 merged refs bulk";
const deleting = process.argv.includes("--delete");
const auditing = process.argv.includes("--audit");
const runSha = process.env.GITHUB_SHA;
const token = process.env.GITHUB_TOKEN;
const deny = (reason) => { throw new Error("REFUSED: merged-branch prune v2: " + reason); };
const shaOk = (s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
const encoded = (name) => {
  if (
    typeof name !== "string" ||
    !/^[a-z][a-z0-9._/-]{4,127}$/.test(name) ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("/.") ||
    name === "main"
  ) deny("unsafe branch");
  return name.split("/").map(encodeURIComponent).join("/");
};
if (
  deleting === auditing ||
  !token || !shaOk(runSha) ||
  process.env.GITHUB_REPOSITORY !== repo
) deny("unauthenticated");
if (
  manifest.schemaVersion !== 1 ||
  manifest.repository !== repo ||
  !shaOk(manifest.releaseBase) ||
  manifest.ownBranch !== ownBranch ||
  !Number.isInteger(manifest.ownPr) ||
  manifest.ownPr < 1 ||
  manifest.expectedCandidates !== 182 ||
  !Array.isArray(manifest.candidates) ||
  manifest.candidates.length !== 182
) deny("manifest shape");

const seen = new Set();
for (const c of manifest.candidates) {
  encoded(c.branch);
  if (
    c.branch === ownBranch ||
    seen.has(c.branch) ||
    !shaOk(c.sha) ||
    !Number.isInteger(c.pr) ||
    c.pr <= 0
  ) deny("unsafe candidate");
  seen.add(c.branch);
}
async function api(path, method = "GET") {
  let response;
  try {
    response = await fetch("https://api.github.com/repos/" + repo + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(35000),
    });
  } catch {
    deny("GitHub request failed; do NOT auto-retry");
  }
  if (method === "DELETE" && response.status === 204) return null;
  if (method === "GET" && response.status === 404) return null;
  if (!response.ok) deny("GitHub HTTP " + response.status);
  return response.json();
}
async function pages(path, max) {
  const results = [];
  for (let page = 1; page <= max; page++) {
    const batch = await api(path + (path.includes("?") ? "&" : "?") +
      "per_page=100&page=" + page);
    if (!Array.isArray(batch)) deny("unexpected collection");
    results.push(...batch);
    if (batch.length < 100) return results;
  }
  deny("unbounded pagination");
}

const ownPR = await api("/pulls/" + manifest.ownPr);
if (
  !ownPR || ownPR.head?.ref !== ownBranch ||
  ownPR.head?.repo?.full_name !== repo ||
  ownPR.base?.ref !== "main" ||
  !shaOk(ownPR.head?.sha)
) deny("own PR mismatch");

if (deleting) {
  if (
    process.env.GITHUB_EVENT_NAME !== "push" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    ownPR.state !== "closed" ||
    !ownPR.merged_at ||
    ownPR.merge_commit_sha !== runSha
  ) deny("not the specific merged-main push");
  const [commit, main] = await Promise.all([
    api("/commits/" + runSha), api("/branches/main"),
  ]);
  if (
    !commit?.commit?.message?.startsWith(commitTitle + " (#" + manifest.ownPr + ")") ||
    main?.commit?.sha !== runSha
  ) deny("merged commit/main mismatch");
} else if (
  process.env.GITHUB_EVENT_NAME !== "pull_request" ||
  ownPR.state !== "open"
) deny("not a review-only PR audit");

const [branches, mergedPRs, openedPRs] = await Promise.all([
  pages("/branches", 4),
  pages("/pulls?state=closed", 8),
  pages("/pulls?state=open", 2),
]);
const byBranch = new Map(branches.map(x => [x.name, x]));
const byPR = new Map(mergedPRs.map(x => [x.number, x]));
const opened = new Set(openedPRs.map(x => x.head?.ref));
if (byBranch.size !== branches.length) deny("duplicate branch collection");
for (const c of manifest.candidates) {
  const ref = byBranch.get(c.branch);
  const pr = byPR.get(c.pr);
  if (
    !ref || ref.protected || ref.commit?.sha !== c.sha ||
    !pr || pr.state !== "closed" || !pr.merged_at ||
    pr.head?.ref !== c.branch ||
    pr.head?.sha !== c.sha ||
    pr.head?.repo?.full_name !== repo ||
    pr.base?.ref !== "main" ||
    opened.has(c.branch)
  ) deny("source reference or merged PR changed");
}
console.log("PASS: 182/182 exact SHA+merged PR matches; bulk audit");
if (auditing) {
  console.log("AUDIT_ONLY=true; DELETED=0");
  process.exit(0);
}

let removed = 0;
for (const c of manifest.candidates) {
  const current = await api("/branches/" + encoded(c.branch));
  if (!current || current.protected || current.commit?.sha !== c.sha) {
    deny("source ref changed immediately before deletion");
  }
  await api("/git/refs/heads/" + encoded(c.branch), "DELETE");
  removed++;
  if (removed % 20 === 0) {
    console.log("DELETED_VERIFIED_MERGED_REFS=" + removed);
  }
}
const own = await api("/branches/" + encoded(ownBranch));
if (!own || own.protected || own.commit?.sha !== ownPR.head.sha) {
  deny("own ref changed");
}
await api("/git/refs/heads/" + encoded(ownBranch), "DELETE");
console.log("PASS: one-time bulk audited merged-branch deletion");
console.log("DELETED_TOTAL=" + (removed + 1));
console.log("UNMERGED_REFS_PRESERVED=true");
