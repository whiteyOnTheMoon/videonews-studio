#!/usr/bin/env node
/**
 * Manual opt-in pilot for post-news asset discovery.
 * An existing private 0700 root is required. No media is downloaded.
 * Usage: node scripts/p3_episode_asset_research_cli.mjs <story.json> <private-root> [--discover]
 */
import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import {isAbsolute, join, resolve} from "node:path";
import {
  buildEpisodeAssetResearchPlan, createEpisodeMediaLibrary,
  discoverEpisodeCandidates,
} from "./p3_episode_asset_library.mjs";
import {createEpisodeAssetWorkspace} from "./p3_episode_asset_workspace.mjs";

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 || (args.length === 3 && args[2] === "--discover"),
    "Usage: node scripts/p3_episode_asset_research_cli.mjs <story.json> <private-root> [--discover]");
  const [storyPath, root] = args;
  assert.ok(isAbsolute(storyPath) && isAbsolute(root) &&
    resolve(storyPath) === storyPath && resolve(root) === root);
  const story = JSON.parse(await readFile(storyPath, "utf8"));
  const plan = buildEpisodeAssetResearchPlan(story);
  const doSearch = args[2] === "--discover";
  const research = doSearch ?
    await discoverEpisodeCandidates(plan, {
      pexelsKey: process.env.PEXELS_API_KEY || null,
      maxQueries: 4,
    }) : {
      library: createEpisodeMediaLibrary(plan),
      queryLog: [], queriedScenes: 0, notQueried: plan.scenes.length,
      status: "PLAN_ONLY_NO_NETWORK",
    };
  const workspace = await createEpisodeAssetWorkspace({
    root, episodeId: plan.episodeId,
  });
  await writeFile(join(workspace, "episode-library.json"),
    JSON.stringify({
      ...research.library,
      queryLog: research.queryLog,
      queriedScenes: research.queriedScenes,
      notQueried: research.notQueried,
      discoveryStatus: research.status,
    }, null, 2) + "\n", {mode: 0o600, flag: "wx"});
  console.log(JSON.stringify({
    status: research.status, workspace,
    searchIntents: plan.scenes.length,
    candidateCount: research.library.candidates.length,
    remainingUnqueriedScenes: research.notQueried,
    rightsStatus: "BLOCKED",
    mediaDownloads: 0,
    publishing: "DENIED",
  }, null, 2));
}

await main();
