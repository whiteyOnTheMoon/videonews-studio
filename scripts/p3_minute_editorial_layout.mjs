/**
 * P3-18 editorially centered typographic layers.
 * Distinct from the legacy P3-17 corner composition. Background is allowed to
 * be dimmed/covered; authenticated scientific insets stay above the dim.
 */
import assert from "node:assert/strict";

const esc = x => String(x).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const txt = (x, y, value, size, options = "") =>
  '<text x="' + x + '" y="' + y +
  '" font-family="DejaVu Sans,sans-serif" font-size="' + size +
  '" ' + (options.includes('fill=') ? '' : 'fill="#ffffff" ') +
  options + '>' + esc(value) + '</text>';
const lineWrap = (raw, maxChars, maxLines) => {
  const lines = [];
  let line = "";
  for (const part of String(raw).trim().split(/\s+/).filter(Boolean)) {
    assert.ok(part.length <= maxChars, "Overlong title word");
    if (line && line.length + part.length + 1 > maxChars) {
      lines.push(line);
      line = "";
    }
    if (lines.length >= maxLines) break;
    line += (line ? " " : "") + part;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
};
export const PILOT_PRESENTATIONS = Object.freeze([
  "hero", "metric", "science-focus", "center-brief", "closing",
]);

export function minuteMediaPlacement(presentation) {
  switch (presentation) {
    case "science-focus": return {x: 280, y: 232, width: 720, height: 405};
    case "center-brief": return {x: 686, y: 241, width: 504, height: 284};
    default: return {x: 765, y: 242, width: 448, height: 252};
  }
}

export function createMinuteEditorialOverlaySvg({
  visual, sequence, backgroundCredit, foreground,
}) {
  assert.ok(PILOT_PRESENTATIONS.includes(visual.presentation),
    "Unknown centered editorial presentation");
  assert.ok(typeof visual.title === "string" && visual.title.length >= 5 &&
    visual.title.length <= 72);
  assert.ok(typeof visual.body === "string" && visual.body.length <= 180);
  assert.ok(typeof backgroundCredit === "string");
  assert.ok(Number.isInteger(sequence) && sequence >= 1 && sequence <= 19);
  const presentation = visual.presentation;
  const media = foreground ? minuteMediaPlacement(presentation) : null;
  const lines = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<defs><clipPath id="copy"><rect x="76" y="100" width="1128" height="505"/></clipPath></defs>',
    '<g clip-path="url(#copy)">',
    txt(640, 118, "EARTH  /  CLIMATE  /  EXPLAINED", 18,
      'text-anchor="middle" font-weight="700" letter-spacing="3" fill="#93eee3"'),
  ];
  if (presentation === "hero" || presentation === "closing") {
    lines.push('<rect x="210" y="216" width="860" height="258" rx="18" fill="#041725" fill-opacity=".30"/>');
    lineWrap(visual.title, 26, 3).forEach((line, i) => lines.push(
      txt(640, 288 + 60 * i, line, 51, 'text-anchor="middle" font-weight="700"')));
    lineWrap(visual.body, 75, 2).forEach((line, i) => lines.push(
      txt(640, 478 + 31 * i, line, 24, 'text-anchor="middle" fill="#d9f2f7"')));
  } else if (presentation === "metric") {
    const metric = String(visual.metric ?? "");
    assert.ok(metric.length >= 2 && metric.length <= 22, "Metric text missing");
    lines.push('<rect x="235" y="187" width="810" height="326" rx="18" fill="#041725" fill-opacity=".24"/>');
    lines.push(txt(640, 263, visual.title, 34,
      'text-anchor="middle" font-weight="700"'));
    lines.push(txt(640, 381, metric, 84,
      'text-anchor="middle" font-weight="700" fill="#8feee0"'));
    lineWrap(visual.body, 78, 2).forEach((line, i) => lines.push(
      txt(640, 452 + 34 * i, line, 23, 'text-anchor="middle" fill="#e0f4f8"')));
  } else if (presentation === "science-focus") {
    assert.ok(media && foreground, "Science focus requires reviewed media");
    lines.push(txt(640, 179, visual.title, 34,
      'text-anchor="middle" font-weight="700"'));
    lines.push('<rect x="' + (media.x - 12) + '" y="' + (media.y - 12) +
      '" width="' + (media.width + 24) + '" height="' + (media.height + 24) +
      '" rx="14" fill="none" stroke="#8beede" stroke-opacity=".74" stroke-width="2"/>');
  } else if (presentation === "center-brief") {
    const x = media ? 330 : 640;
    const width = media ? 24 : 32;
    lineWrap(visual.title, width, 3).forEach((line, i) => lines.push(
      txt(x, 300 + 55 * i, line, 43,
        'text-anchor="middle" font-weight="700"')));
    lineWrap(visual.body, media ? 33 : 82, 3).forEach((line, i) => lines.push(
      txt(x, 445 + 33 * i, line, 22,
        'text-anchor="middle" fill="#dcecf5"')));
    if (media) lines.push('<rect x="' + (media.x - 10) + '" y="' +
      (media.y - 10) + '" width="' + (media.width + 20) +
      '" height="' + (media.height + 20) +
      '" rx="12" fill="none" stroke="#87e0d5" stroke-opacity=".75" stroke-width="2"/>');
  }
  lines.push('</g>');
  lines.push('<rect x="190" y="673" width="900" height="1" fill="#9feee4" fill-opacity=".45"/>');
  lines.push(txt(640, 701, "VISUAL SOURCE: " +
    backgroundCredit.slice(0, 74), 14,
  'text-anchor="middle" fill="#cfebee"'));
  if (foreground) lines.push(txt(640, 661, foreground.credit.slice(0, 92), 16,
    'text-anchor="middle" fill="#e8ffff"'));
  lines.push('</svg>');
  return lines.join("");
}
