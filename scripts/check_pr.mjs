#!/usr/bin/env node
// Minimal PR-to-Issue policy; project builds/tests are handled in P1-08.
const title = process.env.PR_TITLE ?? "";
const body = process.env.PR_BODY ?? "";
const match = /^\[(P[0-7]-\d{2})\]\s+\S/.exec(title);
if (!match) {
  console.error("PR title must begin with a valid project ID: [P1-02] Summary");
  process.exitCode = 1;
}
if (!/\b(?:Closes|Fixes|Resolves)\s+#\d+\b/i.test(body)) {
  console.error("PR body must refer to an issue using Closes #123 (or Fixes/Resolves).");
  process.exitCode = 1;
}
if (!process.exitCode) {
  console.log("PR metadata policy passed for " + match[1]);
}
