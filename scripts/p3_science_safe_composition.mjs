/**
 * P3-16 science-safe cinematic layout.
 * Pixel separation is structural: scientific footage lives only in the
 * x=320..1279, y=90..629 viewport and all typography stays in x=0..319.
 * This module never approves, fetches, publishes or edits source assets.
 */
import assert from "node:assert/strict";

export const SCIENCE_SAFE_MODE = "science-safe";
export const SCIENCE_VIEWPORT = Object.freeze({x: 320, y: 90, width: 960, height: 540});

const escapeXml = value => String(value).replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

function wrap(value, maxLength, maxLines) {
  const result = [];
  let line = "";
  for (const original of String(value ?? "").replace(/\s+/g, " ").trim().split(" ")) {
    if (!original) continue;
    // Long words are truncated rather than allowed to leak from the side rail.
    const word = original.length > maxLength ? original.slice(0, maxLength - 1) + "…" : original;
    if (line && line.length + word.length + 1 > maxLength) {
      result.push(line);
      line = "";
    }
    if (result.length === maxLines) break;
    line += (line ? " " : "") + word;
  }
  if (line && result.length < maxLines) result.push(line);
  return result;
}

function textLine(x, y, value, size, color = "#eef5fa", weight = 400) {
  return '<text x="' + x + '" y="' + y + '" font-family="DejaVu Sans,sans-serif" ' +
    'font-size="' + size + '" font-weight="' + weight + '" fill="' + color + '">' +
    escapeXml(value) + "</text>";
}

export function requiresScienceSafeMode(asset) {
  const hostname = new URL(asset.sourceUrl).hostname.toLowerCase();
  return asset.scientificVisualization === true ||
    hostname === "ozonewatch.gsfc.nasa.gov" ||
    hostname === "svs.gsfc.nasa.gov";
}

/** Overlay content is clipped to the independent sidebar, never to the footage. */
export function createScienceSafeOverlaySvg(visual, sequence) {
  assert.ok(visual && typeof visual.title === "string" &&
    visual.title.length >= 3 && visual.title.length <= 85);
  assert.ok(Number.isInteger(sequence) && sequence >= 1 && sequence <= 19);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<defs><clipPath id="science-rail"><rect x="16" y="10" width="288" height="535"/></clipPath></defs>',
    '<g clip-path="url(#science-rail)">',
    '<rect x="16" y="18" width="288" height="515" rx="12" fill="#102a3b" fill-opacity="0.62"/>',
    '<rect x="29" y="52" width="7" height="36" rx="3" fill="#60d7c7"/>',
    textLine(49, 67, "EARTH & CLIMATE", 14, "#8aeee1", 700),
    textLine(49, 87, "SCENE " + String(sequence).padStart(2, "0") + " / 19", 13, "#d2dfe8"),
    '<path d="M29 108 H288" stroke="#60d7c7" stroke-opacity="0.6" stroke-width="2"/>',
  ];
  wrap(visual.title, 21, 4).forEach((line, index) => {
    svg.push(textLine(29, 150 + 35 * index, line, 23, "#ffffff", 700));
  });
  const panelY = 326;
  if (visual.kind === "chart" && Array.isArray(visual.bars)) {
    const bars = visual.bars.slice(0, 3);
    const max = Math.max(1, ...bars.map(bar => Number(bar.value) || 0));
    bars.forEach((bar, index) => {
      const value = Number(bar.value);
      assert.ok(Number.isFinite(value) && value >= 0, "Invalid science-safe chart value");
      const y = panelY + index * 66;
      svg.push(textLine(29, y, String(bar.label ?? "").slice(0, 23), 14));
      svg.push('<rect x="29" y="' + (y + 10) + '" width="246" height="9" rx="4" fill="#335064"/>');
      svg.push('<rect x="29" y="' + (y + 10) + '" width="' +
        Math.round(246 * value / max) + '" height="9" rx="4" fill="#60d7c7"/>');
      svg.push(textLine(29, y + 36, String(value), 13, "#a9e7dc"));
    });
  } else {
    const copy = typeof visual.body === "string" ? visual.body :
      Array.isArray(visual.entries) ?
        visual.entries.map(item => item.label ?? "").join(" · ") : "";
    wrap(copy, 28, 6).forEach((line, index) =>
      svg.push(textLine(29, panelY + 28 * index, line, 16, "#d5e5ec")));
  }
  svg.push("</g></svg>");
  return svg.join("");
}

/** The persistent custody watermark and source credit also live off-footage. */
export function createScienceSafeBrandSvg(credit, captureDate) {
  assert.ok(typeof credit === "string" && credit.length > 2 && credit.length <= 112);
  assert.match(captureDate, /^\d{4}-\d{2}-\d{2}$/);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<defs><clipPath id="science-custody"><rect x="16" y="560" width="288" height="150"/></clipPath></defs>',
    '<g clip-path="url(#science-custody)">',
    '<rect x="16" y="560" width="288" height="146" rx="9" fill="#102a3b" fill-opacity="0.85"/>',
    textLine(28, 586, "PRIVATE PREVIEW", 15, "#ffc9a4", 700),
    textLine(28, 605, "NOT FOR PUBLICATION", 12, "#ffc9a4", 700),
    textLine(28, 634, "SOURCE / " + captureDate, 12, "#a9e7dc"),
  ];
  wrap(credit, 31, 2).forEach((line, index) =>
    svg.push(textLine(28, 656 + 19 * index, line, 13, "#eef5fa")));
  svg.push("</g></svg>");
  return svg.join("");
}

/**
 * Scale the *entire* input frame into a separate viewport; never crop, zoom
 * beyond fit, rotate, move a caption onto the data or cover any source pixel.
 */
export function scienceSafeBaseGraph(totalSeconds, fadeSeconds, fadeOut) {
  for (const value of [totalSeconds, fadeSeconds, fadeOut]) {
    assert.ok(/^\d+\.\d{6}$/.test(value), "Invalid frame-exact duration");
  }
  return [
    "color=c=0x071420:s=1280x720:r=24:d=" + totalSeconds + ",format=rgba[canvas]",
    "[0:v:0]fps=24,scale=960:540:force_original_aspect_ratio=decrease:flags=lanczos," +
      "pad=960:540:(ow-iw)/2:(oh-ih)/2:color=0x020b16,setsar=1," +
      "trim=duration=" + totalSeconds + ",setpts=PTS-STARTPTS,format=rgba," +
      "fade=t=in:st=0:d=" + fadeSeconds + "," +
      "fade=t=out:st=" + fadeOut + ":d=" + fadeSeconds + "[science]",
    "[canvas][science]overlay=" + SCIENCE_VIEWPORT.x + ":" +
      SCIENCE_VIEWPORT.y + ":shortest=1:format=auto[base]",
  ];
}
