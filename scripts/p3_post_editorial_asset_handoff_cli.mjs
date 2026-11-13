#!/usr/bin/env node
/**
 * P3-11 opt-in bridge after a curated story and named source handoff.
 *
 * Usage:
 * node scripts/p3_post_editorial_asset_handoff_cli.mjs
 *   <curated-story.json> <research-report.json> <review-attestation.json>
 *   <private-cache-root> [--discover] [--resume=/absolute/workspace]
 *
 * No automatic calls from the dormant research worker. No media downloads.
 */
import {randomBytes} from "node:crypto";
import {lstat, readFile, realpath, rename, rm, writeFile} from "node:fs/promises";
import {basename, dirname, isAbsolute, join, resolve} from "node:path";
import {createEpisodeMediaLibrary} from "./p3_episode_asset_library.mjs";
import {createEpisodeAssetWorkspace} from "./p3_episode_asset_workspace.mjs";
import {
  buildVisualResearchTasks, researchVisualBatch, verifyPostEditorialMediaHandoff,
} from "./p3_post_editorial_asset_handoff.mjs";

function fail(message) { throw new Error("POST_EDITORIAL_ASSET_DENIED: " + message); }
async function safePrivateWorkspace(workspace, root) {
  if (!isAbsolute(workspace) || resolve(workspace) !== workspace ||
      dirname(workspace) !== root || basename(workspace).startsWith(".")) {
    fail("Workspace must be an immediate child of the private root");
  }
  for (const path of [root, workspace]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 || await realpath(path) !== path ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      fail("Workspace and root must be owned, private, non-symlink directories");
    }
  }
}
async function replaceJsonAtomically(path, value) {
  const temp = join(dirname(path), "." + basename(path) + "-" +
    randomBytes(6).toString("hex") + ".pending");
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n",
      {mode: 0o600, flag: "wx"});
    await rename(temp, path);
  } catch (error) {
    await rm(temp, {force: true});
    throw error;
  }
}
function parseArgs(args) {
  if (args.length < 4 || args.length > 6) fail("Expected story, research, attestation and private root");
  const [storyPath, researchPath, attestationPath, root, ...options] = args;
  for (const path of [storyPath, researchPath, attestationPath, root]) {
    if (!isAbsolute(path) || resolve(path) !== path) fail("All input paths must be absolute");
  }
  if (new Set(options).size !== options.length ||
    options.some(arg => arg !== "--discover" && !arg.startsWith("--resume=")) ||
    options.filter(x => x.startsWith("--resume=")).length > 1) {
    fail("Only --discover and one --resume=/absolute/workspace option are supported");
  }
  return {storyPath, researchPath, attestationPath, root,
    discover: options.includes("--discover"),
    resume: options.find(x => x.startsWith("--resume="))?.slice(9) ?? null};
}
export async function runPostEditorialHandoffCli(args) {
  const input = parseArgs(args);
  const [story, researchReport, attestation] = await Promise.all([
    readFile(input.storyPath, "utf8").then(JSON.parse),
    readFile(input.researchPath, "utf8").then(JSON.parse),
    readFile(input.attestationPath, "utf8").then(JSON.parse),
  ]);
  const {plan, receipt} = verifyPostEditorialMediaHandoff({
    story, researchReport, attestation,
  });
  const tasks = buildVisualResearchTasks(plan);
  let workspace;
  let checkpoint;
  if (input.resume) {
    workspace = input.resume;
    await safePrivateWorkspace(workspace, input.root);
    const path = join(workspace, "post-editorial-asset-library.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024)
      fail("Invalid previous discovery checkpoint");
    checkpoint = JSON.parse(await readFile(path, "utf8"));
    if (checkpoint?.schemaVersion !== 1 ||
        checkpoint.handoff?.curatedStorySha256 !== receipt.curatedStorySha256 ||
        checkpoint.handoff?.researchEventId !== receipt.researchEventId ||
        checkpoint.handoff?.reviewedBy !== receipt.reviewedBy ||
        !Number.isSafeInteger(checkpoint.nextCursor) ||
        checkpoint.nextCursor < 0 || checkpoint.nextCursor > tasks.length ||
        checkpoint.tasksTotal !== tasks.length ||
        checkpoint.library?.rightsStatus !== "BLOCKED") {
      fail("Cannot resume a stale or mismatched editorial handoff");
    }
  } else {
    workspace = await createEpisodeAssetWorkspace({
      root: input.root, episodeId: plan.episodeId,
    });
    checkpoint = {
      schemaVersion: 1, handoff: receipt, nextCursor: 0,
      tasksTotal: tasks.length, library: createEpisodeMediaLibrary(plan),
      queryLog: [], discoveryStatus: "PLAN_ONLY_NO_NETWORK",
    };
  }
  if (input.discover && checkpoint.nextCursor < tasks.length) {
    const step = await researchVisualBatch({
      plan, tasks, cursor: checkpoint.nextCursor, budget: 4,
      previous: checkpoint.library,
      pexelsKey: process.env.PEXELS_API_KEY || null,
    });
    checkpoint = {
      ...checkpoint, nextCursor: step.nextCursor, library: step.library,
      queryLog: [...checkpoint.queryLog, ...step.queryLog],
      discoveryStatus: step.status,
    };
  }
  await replaceJsonAtomically(
    join(workspace, "post-editorial-asset-library.json"), checkpoint);
  const covered = new Set(checkpoint.library.candidates.map(x => x.sceneId));
  return {
    status: checkpoint.discoveryStatus,
    workspace,
    mediaDownloads: 0,
    publicationAllowed: false,
    rightsApproved: false,
    sourceHandoff: "CURATED_STORY_LINKED_FOR_RESEARCH_ONLY",
    tasksCompleted: checkpoint.nextCursor,
    tasksTotal: tasks.length,
    scenesWithAlternatives: covered.size,
    candidateAlternatives: checkpoint.library.candidates.length,
  };
}

if (process.argv[1] && import.meta.url ===
    new URL("file://" + resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runPostEditorialHandoffCli(process.argv.slice(2)), null, 2));
}
