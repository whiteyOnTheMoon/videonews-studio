#!/usr/bin/env node
// GitHub Issue Backlog importer. Requires Node.js 20+; no third-party packages.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ID_PATTERN = /^P[0-7]-\d{2}$/;
const TITLE_PATTERN = /^\[(P[0-7]-\d{2})\]\s/;

export function issueIdFromTitle(title) {
  return typeof title === "string" ? TITLE_PATTERN.exec(title)?.[1] ?? null : null;
}

export function validateBacklog(backlog) {
  if (!backlog || !Array.isArray(backlog.issues)) {
    throw new Error("Expected a JSON object containing an issues array.");
  }
  const seen = new Set();
  for (const issue of backlog.issues) {
    if (!issue || typeof issue.id !== "string" ||
        !ID_PATTERN.test(issue.id) ||
        issueIdFromTitle(issue.title) !== issue.id ||
        typeof issue.body !== "string" || !issue.body.trim()) {
      throw new Error("Invalid backlog issue: " + String(issue?.id));
    }
    if (seen.has(issue.id)) throw new Error("Duplicate backlog ID: " + issue.id);
    seen.add(issue.id);
  }
  return backlog.issues;
}

export function planImport(backlogIssues, remoteIssues) {
  const present = new Set();
  for (const issue of remoteIssues) {
    if (issue.pull_request) continue; // GitHub's /issues endpoint includes PRs.
    const id = issueIdFromTitle(issue.title);
    if (!id) continue;
    if (present.has(id)) throw new Error("Duplicate GitHub issue ID: " + id);
    present.add(id);
  }
  return backlogIssues.filter((issue) => !present.has(issue.id));
}

async function githubRequest(path, token, options = {}) {
  const response = await fetch("https://api.github.com" + path, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    throw new Error("GitHub API request failed (" + response.status + ") on " + path);
  }
  return response.json();
}

async function readExistingIssues(repo, token) {
  const result = [];
  for (let page = 1; ; page++) {
    const chunk = await githubRequest(
      "/repos/" + repo + "/issues?state=all&per_page=100&page=" + page, token
    );
    if (!Array.isArray(chunk)) throw new Error("Invalid GitHub issue list.");
    result.push(...chunk);
    if (chunk.length < 100) return result;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--repo", "--file", "--apply"]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) {
    throw new Error("Unknown argument. Supported: --repo, --file, --apply");
  }
  const valueFor = (flag, fallback) => {
    const at = args.indexOf(flag);
    return at === -1 ? fallback : args[at + 1];
  };
  const repo = valueFor("--repo", process.env.GITHUB_REPOSITORY);
  const file = valueFor("--file", "backlog/issues.json");
  const apply = args.includes("--apply");
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error("Pass --repo owner/name.");
  }
  if (!token) throw new Error("Set GH_TOKEN or GITHUB_TOKEN in the environment.");
  const data = JSON.parse(await readFile(file, "utf8"));
  const backlogIssues = validateBacklog(data);
  const existing = await readExistingIssues(repo, token);
  const missing = planImport(backlogIssues, existing);
  console.log("Backlog: " + backlogIssues.length + "; missing: " + missing.length);
  if (!apply) {
    console.log("Dry run. To create missing issues, rerun with --apply.");
    for (const issue of missing) console.log("MISSING " + issue.id);
    return;
  }
  for (const issue of missing) {
    const created = await githubRequest("/repos/" + repo + "/issues", token, {
      method: "POST",
      body: JSON.stringify({ title: issue.title, body: issue.body }),
    });
    console.log("CREATED " + issue.id + " #" + created.number);
  }
  console.log("Import finished. Re-run to verify that 0 issues are missing.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
