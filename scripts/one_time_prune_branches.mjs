#!/usr/bin/env node
// SHA-pinned, audited, one-time cleanup; never delete unnamed refs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(
    new URL("../docs/maintenance/branch-prune-2026-10-27.json", import.meta.url),
    "utf8",
  ),
);
const deleting = process.argv.includes("--delete");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const runSha = process.env.GITHUB_SHA;
if (!token || repository !== manifest.repository || !/^[0-9a-f]{40}$/.test(runSha ?? "")) {
  throw new Error("Authenticated repository and run SHA required");
}
if (
  deleting &&
  (process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_EVENT_NAME !== "push")
) {
  throw new Error("Pruning is authorized only from the one-time main push");
}
function branchPath(name) {
  if (
    typeof name !== "string" ||
    !/^(?:chore|docs|feat|fix|maintenance|test)\/[a-zA-Z0-9._/-]+$/.test(name) ||
    name.includes("..") ||
    name.endsWith("/")
  ) {
    throw new Error("Unsafe branch name");
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
  if (!response.ok) throw new Error("GitHub refused " + method + ": HTTP " + response.status);
  return response.json();
}
if (!Array.isArray(manifest.candidates) || manifest.candidates.length !== 49) {
  throw new Error("Unexpected pre-audited manifest size");
}
const seen = new Set();
const candidates = [];
for (const item of manifest.candidates) {
  const encoded = branchPath(item.branch);
  assert.match(item.sha, /^[0-9a-f]{40}$/);
  if (seen.has(item.branch) || item.branch === "main") {
    throw new Error("Duplicate/protected branch in manifest");
  }
  seen.add(item.branch);
  const actual = await api("/branches/" + encoded);
  if (!actual) {
    console.log("Already absent:", item.branch);
    continue;
  }
  if (actual.protected || actual.commit?.sha !== item.sha) {
    throw new Error("Changed/protected branch: " + item.branch);
  }
  if (item.kind === "merged" || item.kind === "superseded") {
    assert.ok(Number.isInteger(item.pr) && item.pr > 0);
    const pr = await api("/pulls/" + item.pr);
    if (
      !pr ||
      pr.head?.ref !== item.branch ||
      pr.head?.sha !== item.sha ||
      pr.head?.repo?.full_name !== repository
    ) {
      throw new Error("Mismatched pull request: " + item.branch);
    }
    if (item.kind === "merged" && !pr.merged_at) {
      throw new Error("PR was not merged: " + item.branch);
    }
    if (item.kind === "superseded") {
      if (![81, 83].includes(item.pr) || pr.state !== "closed" || pr.merged_at) {
        throw new Error("Unreviewed unmerged branch: " + item.branch);
      }
    }
  } else if (item.kind === "ancestor") {
    const comparison = await api("/compare/main..." + item.sha);
    if (!comparison || comparison.ahead_by !== 0) {
      throw new Error("Branch not contained in main");
    }
  } else {
    throw new Error("Unknown branch cleanup status");
  }
  candidates.push(item);
}
console.log("Preflight passed for", candidates.length, "verified branches");
if (!deleting) {
  console.log("DRY RUN – branch refs unchanged");
  process.exit(0);
}
for (const item of candidates) {
  const encoded = branchPath(item.branch);
  const actual = await api("/branches/" + encoded);
  if (!actual || actual.protected || actual.commit?.sha !== item.sha) {
    throw new Error("Branch changed after preflight: " + item.branch);
  }
  await api("/git/refs/heads/" + encoded, "DELETE");
  console.log("Deleted:", item.branch);
}
const ownName = "maintenance/p1-02-verified-49-branch-prune";
const recent = await api("/pulls?state=closed&per_page=10");
const ownPr = recent?.find(
  (pr) => pr.merge_commit_sha === runSha && pr.head?.ref === ownName && pr.merged_at,
);
if (!ownPr) {
  throw new Error("Cleanup PR is not the exact merged push");
}
const own = await api("/branches/" + branchPath(ownName));
if (!own || own.protected || own.commit?.sha !== ownPr.head.sha) {
  throw new Error("Maintenance branch unexpectedly changed");
}
await api("/git/refs/heads/" + branchPath(ownName), "DELETE");
console.log("Deleted maintenance branch. Branch cleanup complete.");
