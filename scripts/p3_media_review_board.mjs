#!/usr/bin/env node
/**
 * P3-13 private offline selection board with local SHA-verified previews.
 * No CDN images, remote scripts, API calls, licensing or publication.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {lstat, readFile, realpath, writeFile} from "node:fs/promises";
import {basename, dirname, extname, isAbsolute, join, resolve} from "node:path";
import {rankEpisodeMediaCandidates} from "./p3_media_candidate_ranking.mjs";
import {
  fingerprintPrivateMedia, inspectEpisodeVisualDuplicates,
} from "./p3_visual_similarity.mjs";

const HASH = /^[a-f0-9]{64}$/;
const TYPES = new Set([".jpg", ".jpeg", ".png", ".mp4"]);
const htmlEscape = input => String(input ?? "").replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const safeLink = input => {
  const url = new URL(input);
  assert.ok(url.protocol === "https:" && !url.username && !url.password);
  return htmlEscape(url.href);
};
async function checkPrivateDirectory(path) {
  assert.ok(typeof path === "string" && isAbsolute(path) &&
    resolve(path) === path && path !== "/");
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() &&
    (info.mode & 0o077) === 0 &&
    (typeof process.getuid !== "function" || info.uid === process.getuid()),
    "Private board folder must be owned, 0700 and without symlinks");
  assert.equal(await realpath(path), path);
}
async function readPrivateJson(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() &&
    (info.mode & 0o077) === 0 && info.size >= 2 && info.size <= 512 * 1024,
    "Board input must be a private small JSON file");
  return JSON.parse(await readFile(path, "utf8"));
}
export function extractEpisodeLibrary(document) {
  assert.ok(document && typeof document === "object");
  const library = document.library ?? document;
  assert.ok(library && library.schemaVersion === 1 &&
    library.publicationAllowed === false && library.rightsStatus === "BLOCKED");
  return library;
}
export async function validatePrivateThumbnailSource(record, root, ids) {
  await checkPrivateDirectory(root);
  assert.ok(record && ids.has(record.candidateId) &&
    record.status === "QUARANTINED_REVIEW_REQUIRED" &&
    record.rightsApproved === false &&
    record.editorialApproved === false &&
    record.thirdPartyRightsCleared === false &&
    typeof record.sha256 === "string" && HASH.test(record.sha256) &&
    typeof record.localPath === "string" &&
    isAbsolute(record.localPath) && resolve(record.localPath) === record.localPath &&
    dirname(record.localPath) === root,
    "Thumbnail requires a matching, unapproved quarantined source");
  const ext = extname(record.localPath).toLowerCase();
  assert.ok(TYPES.has(ext) && basename(record.localPath) === record.sha256 + ext);
  const stat = await lstat(record.localPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() &&
    stat.size > 32 && stat.size <= 48 * 1024 * 1024);
  assert.equal(await realpath(record.localPath), record.localPath);
  const sha = createHash("sha256").update(await readFile(record.localPath)).digest("hex");
  assert.equal(sha, record.sha256, "File hash differs from quarantine receipt");
  return record.localPath;
}
export function createOfflineJpegThumbnail(path) {
  assert.ok(isAbsolute(path) && TYPES.has(extname(path).toLowerCase()));
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-protocol_whitelist", "file,pipe", "-ss", "0.1", "-i", path,
    "-vf", "scale=320:180:force_original_aspect_ratio=decrease," +
      "pad=320:180:(ow-iw)/2:(oh-ih)/2:color=0x071420",
    "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
  ], {encoding: null, timeout: 20000, maxBuffer: 256 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"}});
  assert.equal(r.status, 0, "ffmpeg failed on local review preview");
  assert.ok(Buffer.isBuffer(r.stdout) && r.stdout.length > 128 &&
    r.stdout.length < 200 * 1024 && r.stdout[0] === 255 && r.stdout[1] === 216,
    "Generated review preview is not a bounded JPEG");
  return r.stdout;
}

const css = String.raw`
:root{color-scheme:dark;font:14px system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;background:#101b27;color:#e9f2f9;line-height:1.5}
header{padding:24px clamp(16px,4vw,60px);background:#1c3042}
main{max-width:1360px;margin:auto;padding:16px}
h1{font-size:1.8rem;margin:0}h2{font-size:1.15rem}h3{font-size:1rem;overflow-wrap:anywhere}
p,small{color:#c5d9e7}.warning{border-left:4px solid #eac181;padding:10px;background:#334457}
.scene{border:1px solid #3a5365;border-radius:12px;margin:16px 0;overflow:hidden}
.scene summary{padding:12px;cursor:pointer;background:#213648;font-weight:700}
.scene-content{padding:14px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.card{padding:13px;border:1px solid #3a5365;border-radius:10px;background:#192c3c}
.preview{height:155px;display:grid;place-items:center;background:#091723;border-radius:7px;overflow:hidden}
.preview img{max-height:100%;max-width:100%;object-fit:contain}
.placeholder{text-align:center;color:#b9cede;padding:14px}
.similarity{border-left:3px solid #f2c274;padding:8px;margin:10px 0;background:#45362b;color:#fff2cf}
.similarity-list{margin:12px 0;padding:12px;background:#283746;border-radius:8px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.tag{background:#314c61;padding:3px 7px;border-radius:5px;font-size:12px}
a{color:#a5e3f1;overflow-wrap:anywhere}small{display:block}
label{display:block;margin-top:12px}button{background:#38877a;color:white;padding:12px;border:0;border-radius:6px;cursor:pointer}
button:focus,input:focus,a:focus{outline:3px solid #f0c675}
footer{padding:16px;background:#1b2c3b}
`;
const exportScript = String.raw`
(() => {
  "use strict";
  document.getElementById("save-draft").addEventListener("click", () => {
    const chosen = [...document.querySelectorAll("input[data-candidate]:checked")];
    if (!chosen.length || chosen.length > 4) {
      alert("Bitte zwischen 1 und 4 Kandidaten auswählen.");
      return;
    }
    const counts = new Map(), motifs = new Set();
    const selections = [];
    for (const c of chosen) {
      const sceneId = c.dataset.scene;
      counts.set(sceneId, (counts.get(sceneId) ?? 0) + 1);
      if (counts.get(sceneId) > 2 || motifs.has(c.dataset.motif)) {
        alert("Maximal zwei Alternativen pro Szene und keine Motivwiederholung.");
        return;
      }
      motifs.add(c.dataset.motif);
      selections.push({candidateId:c.dataset.candidate, sceneId,
        directUrl:"REQUIRES_OFFICIAL_DIRECT_FILE_URL_REVIEW"});
    }
    const draft = {schemaVersion:1,operatorConsent:{
      operatorId:"REPLACE_WITH_REAL_REVIEWER_ID",
      approvePreviewAcquisition:false,allowRendering:false,allowPublication:false
    },selections};
    const blob = new Blob([JSON.stringify(draft, null, 2)],
      {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href=url; a.download="p3-unapproved-media-selection.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });
})();`;

function card(item, jpeg, warnings = []) {
  const image = jpeg ?
    '<img alt="Offline erzeugte lokale Vorschau" src="data:image/jpeg;base64,' +
      jpeg.toString("base64") + '">' :
    '<span class="placeholder">Noch keine lokal geprüfte Vorschau – Originalquelle öffnen</span>';
  const resolution = item.width && item.height ?
    item.width + "×" + item.height : "unbekannt";
  const reasons = item.reasons.map(t => "<li>" + htmlEscape(t) + "</li>").join("");
  const similarity = warnings.map(warning =>
    '<p class="similarity"><strong>Visuelle Ähnlichkeit prüfen:</strong> ' +
      htmlEscape(warning.kind === "EXACT_FILE_DUPLICATE" ?
        "Identische Mediendatei" : "Möglicherweise nahezu identisches Bildmotiv") +
      ' – ' + htmlEscape(warning.counterpartId) +
      ' (' + htmlEscape(warning.counterpartScene) +
      '). Kein automatischer Ausschluss.</p>').join("");
  return '<article class="card"><div class="preview">' + image + '</div>' +
    '<h3>' + htmlEscape(item.title || item.id) + '</h3>' +
    '<div class="tags"><span class="tag">' + htmlEscape(item.provider) + '</span>' +
    '<span class="tag">' + htmlEscape(item.mediaType) + '</span>' +
    '<span class="tag">Metadaten ' + item.score + '/100</span></div>' +
    '<small>' + htmlEscape(item.credit) + '</small>' +
    '<small>Auflösung: ' + htmlEscape(resolution) +
    ' · Sekunden: ' + htmlEscape(item.durationSeconds ?? "unbekannt") + '</small>' +
    '<small>Datum: ' + htmlEscape(item.observedDate ?? "ungeprüft") + '</small>' +
    '<small><a href="' + safeLink(item.sourcePage) +
    '" target="_blank" rel="noopener noreferrer">Originalquelle</a> · ' +
    '<a href="' + safeLink(item.licensePage) +
    '" target="_blank" rel="noopener noreferrer">Lizenzhinweise</a></small>' +
    '<ul>' + reasons + '</ul>' + similarity +
    '<small>Inhalt und Nutzungsrechte weiterhin ungeprüft</small>' +
    '<label><input type="checkbox" data-candidate="' + htmlEscape(item.id) +
    '" data-scene="' + htmlEscape(item.sceneId) +
    '" data-motif="' + htmlEscape(item.motifId) +
    '"> In gesperkten Auswahlentwurf übernehmen</label></article>';
}
/** Only data URLs for local thumbnails; external links are user-initiated. */
export function renderOfflineMediaBoardHtml(ranked, previews = new Map(), visualReport = null) {
  assert.ok(ranked && ranked.schemaVersion === 1 &&
    ranked.publicationAllowed === false &&
    ranked.rightsApproved === false && ranked.renderAllowed === false &&
    Array.isArray(ranked.scenes) && ranked.scenes.length === 19 &&
    previews instanceof Map &&
    (visualReport === null || (visualReport &&
      visualReport.publicationAllowed === false &&
      Array.isArray(visualReport.pairs))));
  const warnings = new Map();
  for (const pair of visualReport?.pairs ?? []) {
    for (const [candidateId, counterpartId, counterpartScene] of [
      [pair.candidateA, pair.candidateB, pair.sceneB],
      [pair.candidateB, pair.candidateA, pair.sceneA],
    ]) {
      const entries = warnings.get(candidateId) ?? [];
      entries.push({kind: pair.kind, counterpartId, counterpartScene});
      warnings.set(candidateId, entries);
    }
  }
  const scenes = ranked.scenes.map(scene => {
    const group = (heading, items) =>
      '<h2>' + htmlEscape(heading) + ' (' + items.length + ')</h2><div class="cards">' +
      (items.map(item => card(item, previews.get(item.id), warnings.get(item.id) ?? [])).join("") ||
      '<p>Keine Quellenkandidaten gefunden.</p>') + '</div>';
    return '<details class="scene"><summary>' + htmlEscape(scene.sceneId) +
      ' · ' + htmlEscape(scene.title) +
      ' · ' + htmlEscape(scene.status) + '</summary><div class="scene-content">' +
      group("NASA – wissenschaftliche Kandidaten", scene.science) +
      group("Stock – nur atmosphärischer Kontext", scene.broll) +
      '</div></details>';
  }).join("");
  return '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
      'default-src &#39;none&#39;; img-src data:; ' +
      'style-src &#39;unsafe-inline&#39;; script-src &#39;unsafe-inline&#39;; ' +
      'connect-src &#39;none&#39;; object-src &#39;none&#39;; ' +
      'base-uri &#39;none&#39;; form-action &#39;none&#39;">' +
    '<title>VNS Episoden-Medienauswahl</title><style>' + css +
    '</style></head><body><header><h1>VideoNewsStudio – Medienbibliothek</h1>' +
    '<p>Episode ' + htmlEscape(ranked.episodeId) + ' · ' +
    ranked.sourceCandidates + ' Kandidaten · ' +
    ranked.scenesWithoutCandidates + ' Szenen ohne Alternativen · ' +
    ranked.scenesMissingScientificSource + ' Szenen ohne NASA-Kandidaten</p>' +
    '<p class="warning">NUR PRIVATE VORSCHAU – Metadaten-Score ist weder ' +
    'Bildinhaltsprüfung noch Lizenznachweis. Stock-Material ist keine ' +
    'wissenschaftliche Evidenz. Veröffentlichung gesperrt.</p>' +
    '<button id="save-draft" type="button">Auswahl als gesperrten JSON-Entwurf speichern</button>' +
    '<small>Dieser Entwurf enthält absichtlich keine direkten Video-URLs ' +
    'und aktiviert keine Download- oder Renderfreigabe.</small></header>' +
    '<main>' +
    '<section class="similarity-list"><h2>Bildähnlichkeitsprüfung (nur lokale Dateien)</h2>' +
    '<p>' + String(visualReport?.inspectedSources ?? 0) +
    ' lokale Medien geprüft; ' + String(visualReport?.possiblePairs ?? 0) +
    ' mögliche Motivüberschneidungen. Ein dHash-Treffer ist kein Nachweis' +
    ' derselben Aufnahme, keiner Lizenz und keiner wissenschaftlichen Bedeutung.' +
    ' Fehlende Downloads wurden nicht bildlich untersucht.</p></section>' +
    scenes + '</main>' +
    '<footer>Keine externen Bilder, Skripte, Schriften oder API-Aufrufe. ' +
    'Quellen-Links öffnen erst nach einem Klick.</footer><script>' +
    exportScript + '</script></body></html>';
}
export async function buildOfflineMediaBoard({
  libraryDocument, workspace, receipt = null,
  makeThumbnail = createOfflineJpegThumbnail,
  fingerprintMedia = fingerprintPrivateMedia,
}) {
  await checkPrivateDirectory(workspace);
  const library = extractEpisodeLibrary(libraryDocument);
  const ranked = rankEpisodeMediaCandidates(library);
  const previews = new Map();
  const fingerprints = [];
  if (receipt) {
    assert.ok(receipt.schemaVersion === 1 &&
      receipt.episodeId === ranked.episodeId &&
      receipt.status === "QUARANTINE_ONLY_REQUIRES_REVIEW" &&
      Array.isArray(receipt.records) && receipt.records.length <= 120);
    const quarantine = join(workspace, "quarantine");
    const candidates = new Map(library.candidates.map(item => [item.id, item]));
    for (const record of receipt.records) {
      assert.ok(!previews.has(record.candidateId),
        "Repeated local preview candidate");
      const original = candidates.get(record.candidateId);
      assert.ok(original &&
        record.sceneId === original.sceneId &&
        record.motifId === original.motifId,
        "Quarantine preview must match the original episode scene and motif");
      const path = await validatePrivateThumbnailSource(
        record, quarantine, new Set(candidates.keys()));
      const jpeg = await makeThumbnail(path);
      assert.ok(Buffer.isBuffer(jpeg) && jpeg.length > 2 &&
        jpeg.length < 200 * 1024 &&
        jpeg[0] === 255 && jpeg[1] === 216);
      previews.set(record.candidateId, jpeg);
      fingerprints.push(await fingerprintMedia({
        file: path,
        sha256: record.sha256,
        candidateId: record.candidateId,
        sceneId: record.sceneId,
      }));
    }
  }
  const visualReport = inspectEpisodeVisualDuplicates(fingerprints);
  return {
    html: renderOfflineMediaBoardHtml(ranked, previews, visualReport),
    ranked, localPreviews: previews.size,
    visualReport,
    rightsApproved: false, publicationAllowed: false,
  };
}
export async function runOfflineMediaBoardCli(args) {
  assert.ok(Array.isArray(args) && args.length >= 2 && args.length <= 3,
    "Usage: <library.json> <workspace> [--receipt=/absolute/path]");
  const [libraryPath, workspace, option] = args;
  await checkPrivateDirectory(workspace);
  const libraryDocument = await readPrivateJson(libraryPath);
  let receipt = null;
  if (option) {
    assert.ok(option.startsWith("--receipt="));
    const path = option.slice("--receipt=".length);
    assert.equal(dirname(path), workspace, "Receipt must belong to episode workspace");
    receipt = await readPrivateJson(path);
  }
  const board = await buildOfflineMediaBoard({libraryDocument, workspace, receipt});
  const output = join(workspace, "episode-media-review-board.html");
  await writeFile(output, board.html, {mode: 0o600, flag: "wx"});
  return {
    status: "PRIVATE_OFFLINE_MEDIA_BOARD_CREATED",
    output, episodeId: board.ranked.episodeId,
    candidates: board.ranked.sourceCandidates,
    scenes: board.ranked.scenes.length, localPreviews: board.localPreviews,
    possibleVisualDuplicates: board.visualReport.possiblePairs,
    rightsApproved: false, publicationAllowed: false,
  };
}
if (process.argv[1] && import.meta.url ===
    new URL("file://" + resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runOfflineMediaBoardCli(process.argv.slice(2)), null, 2));
}
