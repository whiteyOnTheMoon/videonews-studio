#!/usr/bin/env node
// P1-02: one-time SHA-pinned cleanup of exactly 182 verified merged PR refs.
// On PR: strictly read-only audit. On a specific merged-main push: deletion.
// Never delete unmerged, opened, protected, unknown, or changed branches.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(
    new URL("../docs/maintenance/branch-prune-2026-11-11.json", import.meta.url),
    "utf8",
  ),
);
const deleting = process.argv.includes("--delete");
const auditing = process.argv.includes("--audit");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const runSha = process.env.GITHUB_SHA;
const FAIL = "REFUSED: exact merged-branch cleanup admission failed";
const TARGET_COUNT = 182;
const TITLE = "[P1-02] Verified cleanup of 182 merged refs";
const OWN = "maintenance/p1-02-merged-branch-prune-20261111";
const shaOk = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

if (
  deleting === auditing ||
  !token ||
  !shaOk(runSha) ||
  repository !== "whiteyOnTheMoon/videonews-studio"
) {
  throw new Error(FAIL);
}

function branchPath(name) {
  if (
    typeof name !== "string" ||
    !/^[a-z][a-z0-9._/-]{4,127}$/.test(name) ||
    name === "main" ||
    name === OWN ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("/.")
  ) {
    throw new Error(FAIL);
  }
  return name.split("/").map(encodeURIComponent).join("/");
}
async function api(path, method = "GET") {
  const response = await fetch("https://api.github.com/repos/" + repository + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (method === "DELETE" && response.status === 204) return null;
  if (method === "GET" && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(FAIL + ": GitHub HTTP " + response.status);
  }
  return response.json();
}

if (
  manifest.schemaVersion !== 1 ||
  manifest.repository !== repository ||
  !shaOk(manifest.releaseBase) ||
  manifest.ownBranch !== OWN ||
  !Number.isInteger(manifest.ownPr) ||
  manifest.ownPr <= 0 ||
  manifest.expectedCandidates !== TARGET_COUNT ||
  !Array.isArray(manifest.candidates) ||
  manifest.candidates.length !== TARGET_COUNT
) {
  throw new Error(FAIL);
}

const seen = new Set();
for (const item of manifest.candidates) {
  branchPath(item.branch);
  if (
    !shaOk(item.sha) ||
    !Number.isInteger(item.pr) ||
    item.pr <= 0 ||
    seen.has(item.branch)
  ) {
    throw new Error(FAIL);
  }
  seen.add(item.branch);
}
const ownPR = await api("/pulls/" + manifest.ownPr);
if (
  !ownPR ||
  ownPR.head?.ref !== OWN ||
  ownPR.head?.repo?.full_name !== repository ||
  ownPR.base?.ref !== "main"
) {
  throw new Error(FAIL);
}
if (deleting) {
  if (
    process.env.GITHUB_EVENT_NAME !== "push" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    ownPR.state !== "closed" ||
    !ownPR.merged_at ||
    ownPR.merge_commit_sha !== runSha
  ) {
    throw new Error(FAIL);
  }
  const commit = await api("/commits/" + runSha);
  const main = await api("/branches/main");
  if (
    !commit?.commit?.message?.startsWith(TITLE + " (#" + manifest.ownPr + ")") ||
    main?.commit?.sha !== runSha
  ) {
    throw new Error(FAIL);
  }
} else if (
  process.env.GITHUB_EVENT_NAME !== "pull_request" ||
  ownPR.state !== "open"
) {
  throw new Error(FAIL);
}

const checked = [];
for (const item of manifest.candidates) {
  const ref = await api("/branches/" + branchPath(item.branch));
  const pr = await api("/pulls/" + item.pr);
  if (
    !pr ||
    pr.state !== "closed" ||
    !pr.merged_at ||
    pr.base?.ref !== "main" ||
    pr.head?.ref !== item.branch ||
    pr.head?.sha !== item.sha ||
    pr.head?.repo?.full_name !== repository ||
    (ref && (ref.protected || ref.commit?.sha !== item.sha))
  ) {
    throw new Error(FAIL);
  }
  if (ref) checked.push(item);
}
console.log(
  "PASS: exact merged PR and SHA checks for",
  TARGET_COUNT,
  "candidates; present=",
  checked.length,
);
if (auditing) {
  console.log("AUDIT_ONLY=true; DELETED=0");
  process.exit(0);
}
for (const item of checked) {
  const ref = await api("/branches/" + branchPath(item.branch));
  if (!ref || ref.protected || ref.commit?.sha !== item.sha) {
    throw new Error(FAIL);
  }
  // The closed merged PR was checked in the global preflight immediately
  // before deletion, and the specific branch SHA is rechecked here.
  await api("/git/refs/heads/" + branchPath(item.branch), "DELETE");
}
const own = await api("/branches/" + branchPath(OWN));
if (
  !own ||
  own.protected ||
  own.commit?.sha !== ownPR.head.sha ||
  !shaOk(ownPR.head.sha)
) {
  throw new Error(FAIL);
}
await api("/git/refs/heads/" + branchPath(OWN), "DELETE");
console.log("PASS: exact verified merged-branch cleanup");
console.log("DELETED=" + (checked.length + 1));
console.log("NO_UNMERGED_BRANCHES_DELETED=true");
