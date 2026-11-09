#!/usr/bin/env node
/**
 * P3-07: real-world, manually curated, nonpublishable news-video CI proof.
 *
 * Real source citations and original narration are read from a dated
 * in-repository snapshot. This script does NOT fetch live news or verify
 * the article contents, author rights, or independent editorial approval.
 *
 * Only a disposable GitHub Actions runner may create temporary media here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOfflineVideoCreditsReport,
  makeOfflineGraphicStoryboard,
} from "../packages/shared/dist/index.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("REFUSED: real-source preview encoder is GitHub CI only");
}

const STORY_PATH = new URL("../content/news/ozone-2026-antarktis-de.json", import.meta.url);
const VIDEO_ID = "00000000-0000-4000-8000-000000000731";
const STORY_ID = "00000000-0000-4000-8000-000000000732";
const EXPECTED_DOMAINS = Object.freeze({
  NOAA_2026_11_04: "www.noaa.gov",
  NASA_2026_11_09: "science.nasa.gov",
  CAMS_2026_09_16: "atmosphere.copernicus.eu",
  DLR_2026_10_26: "www.dlr.de",
});

function command(name, args, timeout = 120000) {
  const result = spawnSync(name, args, {
    shell: false,
    encoding: "utf8",
    timeout,
    maxBuffer: 512 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      name +
        " failed: " +
        (result.error?.code ?? result.status) +
        " " +
        (result.stderr ?? "").slice(-900),
    );
  }
  return result.stdout;
}

function safeText(value, max) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127 || character === "<" || character === ">");
    })
  );
}

function preflight(news) {
  assert.equal(news.schemaVersion, 1);
  assert.equal(news.id, "ozone-2026-antarktis-de");
  assert.equal(news.language, "de-DE");
  assert.equal(news.asOf, "2026-11-09");
  assert.equal(news.editorialStatus, "REVIEW_REQUIRED");
  assert.equal(news.sourceStatus, "manually_curated_public_reports_not_live_ingestion");
  for (const field of [
    "editorialApproved",
    "rightsApproved",
    "renderAllowed",
    "uploadAllowed",
    "publicationAllowed",
  ]) {
    assert.equal(news[field], false, "no editorial or publishing approval: " + field);
  }
  assert.equal(news.sources?.length, 4);
  assert.equal(news.scenes?.length, 7);
  assert.ok(news.facts?.length >= 6 && news.facts.length <= 12);
  const sources = new Map();
  for (const source of news.sources) {
    assert.ok(Object.hasOwn(EXPECTED_DOMAINS, source.id));
    assert.ok(!sources.has(source.id));
    assert.ok(safeText(source.publisher, 90));
    assert.match(source.publishedAt, /^2026-\d{2}-\d{2}$/);
    assert.ok(source.publishedAt <= news.asOf);
    const url = new URL(source.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, EXPECTED_DOMAINS[source.id]);
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(url.hash, "");
    assert.equal(url.search, "");
    assert.equal(url.port, "");
    assert.equal(url.toString(), source.url);
    assert.ok(safeText(source.evidenceGroup, 100));
    sources.set(source.id, source);
  }
  // NASA and NOAA describe a joint seasonal analysis. DLR and CAMS
  // provide different observational context, NOT an invented 4-way vote.
  assert.equal(sources.get("NOAA_2026_11_04").evidenceGroup, sources.get("NASA_2026_11_09").evidenceGroup);
  assert.notEqual(sources.get("CAMS_2026_09_16").evidenceGroup, sources.get("NOAA_2026_11_04").evidenceGroup);
  assert.notEqual(sources.get("DLR_2026_10_26").evidenceGroup, sources.get("NOAA_2026_11_04").evidenceGroup);

  const facts = new Map();
  for (const fact of news.facts) {
    assert.ok(safeText(fact.id, 90));
    assert.ok(!facts.has(fact.id));
    assert.ok(Array.isArray(fact.sourceIds) && fact.sourceIds.length >= 1);
    assert.ok(fact.sourceIds.every((id) => sources.has(id)));
    facts.set(fact.id, fact);
  }
  assert.equal(facts.get("seasonal_mean_area").value, 25);
  assert.equal(facts.get("seasonal_mean_area").unit, "million_km2");
  assert.equal(facts.get("seasonal_mean_area_rank").value, 7);
  assert.equal(facts.get("seasonal_mean_area_rank").ofYears, 48);
  assert.equal(facts.get("single_day_peak_area").value, 27.1);
  assert.equal(facts.get("single_day_peak_area").measuredAt, "2026-09-18");
  assert.equal(facts.get("south_pole_minimum_ozone_2026").value, 105);
  assert.equal(facts.get("south_pole_minimum_ozone_2006").value, 92);
  assert.equal(facts.get("recovery_estimate").value, "2070s");
  assert.equal(facts.get("recovery_estimate").type, "projection_not_guarantee");

  for (const scene of news.scenes) {
    assert.ok(safeText(scene.title, 75));
    assert.ok(safeText(scene.summary, 220));
    assert.ok(safeText(scene.narration, 600));
    assert.ok(Array.isArray(scene.sourceIds) && scene.sourceIds.length >= 1);
    assert.ok(scene.sourceIds.length <= 4);
    assert.ok(scene.sourceIds.every((id) => sources.has(id)));
    assert.ok(!/(?:publishApproved|renderAllowed|uploadAllowed)/.test(scene.narration));
  }
  return { sources, facts };
}

function produceStoryboard(news, { sources, facts }) {
  function urls(index) {
    // P3-07 supports 1-3 public source URLs per frame.
    const ids = news.scenes[index].sourceIds.slice(0, 3);
    return ids.map((id) => sources.get(id).url);
  }
  const scenes = [
    {
      kind: "text-card",
      title: news.scenes[0].title,
      body: news.scenes[0].summary,
      sourceUrls: urls(0),
    },
    {
      kind: "table",
      title: news.scenes[1].title,
      columns: ["Metrik", "Messwert"],
      rows: [
        ["Mittlere Flaeche", facts.get("seasonal_mean_area").value.toFixed(1) + " Mio. km2"],
        ["Rang nach Mittel", "7 von 48 Jahren"],
      ],
      sourceUrls: urls(1),
    },
    {
      kind: "text-card",
      title: news.scenes[2].title,
      body: news.scenes[2].summary,
      sourceUrls: urls(2),
    },
    {
      kind: "chart",
      title: news.scenes[3].title,
      bars: [
        { label: "Suedpol 2006 (DU)", value: facts.get("south_pole_minimum_ozone_2006").value },
        { label: "Suedpol 2026 (DU)", value: facts.get("south_pole_minimum_ozone_2026").value },
      ],
      sourceUrls: urls(3),
    },
    {
      kind: "text-card",
      title: news.scenes[4].title,
      body: news.scenes[4].summary,
      sourceUrls: urls(4),
    },
    {
      kind: "timeline",
      title: news.scenes[5].title,
      entries: [
        { label: "1987", detail: "Montrealer Protokoll" },
        { label: "2026", detail: "Messwerte und Variabilitaet" },
        { label: "2070er", detail: "Projektion, keine Garantie" },
      ],
      sourceUrls: urls(5),
    },
    {
      kind: "text-card",
      title: news.scenes[6].title,
      body: news.scenes[6].summary,
      sourceUrls: urls(6),
    },
  ];
  const preview = makeOfflineGraphicStoryboard({
    storyId: STORY_ID,
    publisherApproved: true, // Forged approval must have no effect.
    uploadAllowed: true,
    scenes,
  });
  assert.equal(preview.status, "PREVIEW_ONLY", JSON.stringify(preview.errors));
  assert.equal(preview.frames.length, 7);
  assert.equal(preview.videoRenderAllowed, false);
  assert.equal(preview.uploadAllowed, false);
  assert.equal(preview.sourcesVerified, false);
  return preview;
}

async function main() {
  const news = JSON.parse(await readFile(STORY_PATH, "utf8"));
  const evidence = preflight(news);
  const storyboard = produceStoryboard(news, evidence);
  const rights = buildOfflineVideoCreditsReport({ videoId: VIDEO_ID, assets: [] });
  assert.equal(rights.status, "BLOCKED");
  assert.equal(rights.renderAllowed, false);
  assert.equal(rights.uploadAllowed, false);
  assert.equal(rights.creditsVerified, false);

  command("ffmpeg", ["-hide_banner", "-version"], 10000);
  command("ffprobe", ["-hide_banner", "-version"], 10000);
  command("rsvg-convert", ["--version"], 10000);
  command("espeak-ng", ["--version"], 10000);
  const folder = await mkdtemp(join(tmpdir(), "vns-real-news-no-publish-"));
  try {
    const segmentPaths = [];
    for (const frame of storyboard.frames) {
      assert.ok(frame.svg.includes("VORSCHAU – NICHT ZUR VERÖFFENTLICHUNG"));
      assert.doesNotMatch(frame.svg, /<image\b|<script\b|<foreignObject\b|xlink:href/);
      const base = "scene-" + String(frame.index + 1).padStart(2, "0");
      const svg = join(folder, base + ".svg");
      const png = join(folder, base + ".png");
      const wav = join(folder, base + ".wav");
      const mp4 = join(folder, base + ".mp4");
      await writeFile(svg, frame.svg, { encoding: "utf8", mode: 0o600, flag: "wx" });
      command("rsvg-convert", ["--output", png, svg], 30000);
      assert.equal((await readFile(png)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      command("espeak-ng", [
        "-v",
        "de",
        "-s",
        "145",
        "-w",
        wav,
        news.scenes[frame.index].narration,
      ], 30000);
      const duration = Number(command("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nk=1:nw=1",
        wav,
      ]));
      assert.ok(duration >= 2 && duration <= 35);
      const clipSeconds = (Math.ceil((duration + 0.5) * 24) / 24).toFixed(3);
      command("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-loop",
        "1",
        "-framerate",
        "24",
        "-i",
        png,
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        wav,
        "-af",
        "aresample=48000,apad=pad_dur=1",
        "-t",
        clipSeconds,
        "-r",
        "24",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ac",
        "1",
        mp4,
      ], 120000);
      segmentPaths.push(mp4);
    }
    const list = join(folder, "concat.txt");
    await writeFile(
      list,
      segmentPaths.map((path) => "file '" + path + "'").join("\n") + "\n",
      { mode: 0o600, flag: "wx" },
    );
    const output = join(folder, "REAL_NEWS_REVIEW_REQUIRED_NOT_PUBLISHABLE.mp4");
    command("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ], 120000);
    const info = JSON.parse(command("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_name,codec_type,width,height,nb_frames",
      "-of",
      "json",
      output,
    ]));
    const video = info.streams.find((stream) => stream.codec_type === "video");
    const audio = info.streams.find((stream) => stream.codec_type === "audio");
    assert.equal(video.codec_name, "h264");
    assert.equal(audio.codec_name, "aac");
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.ok(Number(video.nb_frames) > 7 * 24);
    assert.ok(Number(info.format.duration) > 35 && Number(info.format.duration) < 220);
    const byteSize = (await stat(output)).size;
    assert.ok(byteSize > 5000 && byteSize < 30 * 1024 * 1024);
    const sha256 = createHash("sha256").update(await readFile(output)).digest("hex");
    assert.equal(news.editorialApproved, false);
    assert.equal(news.publicationAllowed, false);
    assert.equal(rights.renderAllowed, false);
    assert.equal(rights.uploadAllowed, false);
    console.log(
      "P3 REAL SOURCE CI PREVIEW PASS: " +
        storyboard.frames.length +
        " original SVG scenes; H264/AAC; " +
        info.format.duration +
        " seconds; bytes=" +
        byteSize +
        "; SHA256=" +
        sha256,
    );
    console.log(
      "Sources: NASA/NOAA joint evidence + independent Copernicus/DLR context. " +
        "Editorial rights approval: DENIED. Production render/upload: NOT ENABLED.",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

await main();
