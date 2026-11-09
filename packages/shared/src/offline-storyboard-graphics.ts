/**
 * P3-07: deterministic, offline SVG storyboard graphics.
 *
 * No remote images, map tiles, provider APIs, AI, fonts or external SVG content.
 * Input source references are NOT independently verified. This is a strictly
 * nonpublishable visual PREVIEW, not a video render or media-rights approval.
 */

export type OfflineGraphicKind = "text-card" | "table" | "timeline" | "chart" | "map";

export interface OfflineGraphicFrame {
  index: number;
  kind: OfflineGraphicKind;
  svg: string;
  sourceCount: number;
}

export interface OfflineGraphicStoryboard {
  status: "PREVIEW_ONLY" | "REJECTED";
  storyId: string | null;
  frames: readonly OfflineGraphicFrame[];
  errors: readonly string[];
  videoRenderAllowed: false;
  uploadAllowed: false;
  sourcesVerified: false;
}

type RecordValue = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SCENES = 8;
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function safeText(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) return false;
  if (value !== value.trim()) return false;
  return ![...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 32 || code === 127);
  });
}

function safeSource(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 2048 ||
    !value.startsWith("https://") ||
    /[\s\\]/.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.hash === "" &&
      url.hostname.includes(".") &&
      !url.hostname.endsWith(".")
    );
  } catch {
    return false;
  }
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textAt(x: number, y: number, value: string, size = 30, color = "#eef6ff"): string {
  return (
    '<text x="' +
    x +
    '" y="' +
    y +
    '" font-size="' +
    size +
    '" fill="' +
    color +
    '" font-family="Arial, sans-serif">' +
    xml(value) +
    "</text>"
  );
}

function linesOf(text: string, limit = 47): string[] {
  const words = text.split(" ");
  const chunks: string[] = [];
  let line = "";
  for (const word of words) {
    let remainder = word;
    while (remainder.length > limit) {
      if (line) {
        chunks.push(line);
        line = "";
      }
      chunks.push(remainder.slice(0, limit));
      remainder = remainder.slice(limit);
    }
    if (!remainder) continue;
    const proposed = line ? line + " " + remainder : remainder;
    if (proposed.length > limit) {
      chunks.push(line);
      line = remainder;
    } else {
      line = proposed;
    }
  }
  if (line) chunks.push(line);
  return chunks;
}

function sourceList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 3 &&
    value.every((item) => safeSource(item)) &&
    new Set(value).size === value.length
  );
}

function validTuple(value: unknown, max: number): value is [string, string] {
  return (
    Array.isArray(value) && value.length === 2 && safeText(value[0], max) && safeText(value[1], max)
  );
}

function finite(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}

function validateScene(scene: RecordValue): scene is RecordValue {
  if (!safeText(scene.title, 75) || !sourceList(scene.sourceUrls)) return false;
  if (scene.kind === "text-card") return safeText(scene.body, 220);
  if (scene.kind === "table") {
    return (
      validTuple(scene.columns, 28) &&
      Array.isArray(scene.rows) &&
      scene.rows.length >= 2 &&
      scene.rows.length <= 6 &&
      scene.rows.every((row) => validTuple(row, 65))
    );
  }
  if (scene.kind === "timeline") {
    return (
      Array.isArray(scene.entries) &&
      scene.entries.length >= 2 &&
      scene.entries.length <= 5 &&
      scene.entries.every((item) => {
        const entry = record(item);
        return entry && safeText(entry.label, 42) && safeText(entry.detail, 75);
      })
    );
  }
  if (scene.kind === "chart") {
    return (
      Array.isArray(scene.bars) &&
      scene.bars.length >= 2 &&
      scene.bars.length <= 6 &&
      scene.bars.every((item) => {
        const bar = record(item);
        return bar && safeText(bar.label, 38) && finite(bar.value, 1000000);
      })
    );
  }
  if (scene.kind === "map") {
    return (
      Array.isArray(scene.locations) &&
      scene.locations.length >= 1 &&
      scene.locations.length <= 6 &&
      scene.locations.every((item) => {
        const point = record(item);
        return point && safeText(point.label, 32) && finite(point.x, 100) && finite(point.y, 100);
      })
    );
  }
  return false;
}

function graphicsFor(scene: RecordValue): string[] {
  const result: string[] = [];
  if (scene.kind === "text-card") {
    const wrapped = linesOf(scene.body as string, 48);
    for (const [index, line] of wrapped.entries()) {
      result.push(textAt(95, 270 + index * 60, line, 38));
    }
    return result;
  }
  if (scene.kind === "table") {
    const columns = scene.columns as [string, string];
    const rows = scene.rows as [string, string][];
    result.push('<rect x="92" y="204" width="1096" height="64" rx="8" fill="#1c354e"/>');
    result.push(textAt(112, 250, columns[0], 24, "#bfe8ff"));
    result.push(textAt(700, 250, columns[1], 24, "#bfe8ff"));
    for (const [index, row] of rows.entries()) {
      const y = 296 + index * 54;
      result.push('<rect x="92" y="' + y + '" width="1096" height="50" rx="5" fill="#102638"/>');
      result.push(textAt(112, y + 33, row[0], 21));
      result.push(textAt(700, y + 33, row[1], 21));
    }
    return result;
  }
  if (scene.kind === "timeline") {
    const entries = scene.entries as { label: string; detail: string }[];
    result.push('<path d="M 136 210 V 590" fill="none" stroke="#65b9e8" stroke-width="6"/>');
    for (const [index, entry] of entries.entries()) {
      const y = 232 + index * 83;
      result.push('<circle cx="136" cy="' + y + '" r="12" fill="#64d8cb"/>');
      result.push(textAt(177, y - 4, entry.label, 24, "#bfe8ff"));
      result.push(textAt(177, y + 32, entry.detail, 22));
    }
    return result;
  }
  if (scene.kind === "chart") {
    const bars = scene.bars as { label: string; value: number }[];
    const maximum = Math.max(1, ...bars.map((bar) => bar.value));
    for (const [index, bar] of bars.entries()) {
      const y = 215 + index * 66;
      const width = Math.round((bar.value / maximum) * 650);
      result.push(textAt(92, y + 24, bar.label, 22));
      result.push(
        '<rect x="460" y="' + y + '" width="' + width + '" height="35" rx="5" fill="#64d8cb"/>',
      );
      result.push(textAt(1140, y + 25, bar.value.toFixed(0), 22, "#bfe8ff"));
    }
    return result;
  }
  const points = scene.locations as { label: string; x: number; y: number }[];
  result.push('<rect x="90" y="190" width="1100" height="410" rx="12" fill="#10293b"/>');
  for (let x = 1; x <= 5; x++) {
    result.push('<path d="M ' + (90 + x * 183) + ' 198 V 594" stroke="#27445b" stroke-width="1"/>');
  }
  for (let y = 1; y <= 3; y++) {
    result.push(
      '<path d="M 96 ' + (190 + y * 102) + ' H 1184" stroke="#27445b" stroke-width="1"/>',
    );
  }
  for (const point of points) {
    const x = Math.round(122 + (point.x / 100) * 970);
    const y = Math.round(222 + (point.y / 100) * 328);
    result.push('<circle cx="' + x + '" cy="' + y + '" r="9" fill="#64d8cb"/>');
    result.push(textAt(Math.min(x + 15, 1030), y - 15, point.label, 18));
  }
  result.push(
    textAt(96, 630, "Schematische Positionsskizze – keine verifizierte GIS-Karte", 18, "#bfe8ff"),
  );
  return result;
}

function makeFrame(scene: RecordValue, index: number): OfflineGraphicFrame {
  const kind = scene.kind as OfflineGraphicKind;
  const title = scene.title as string;
  const sourceCount = (scene.sourceUrls as string[]).length;
  const elements = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      FRAME_WIDTH +
      '" height="' +
      FRAME_HEIGHT +
      '" viewBox="0 0 1280 720" role="img" aria-label="Nicht veröffentlichte Nachrichten-Grafik">',
    "<title>" + xml(title) + " – ungeprüfte Vorschau</title>",
    '<rect x="0" y="0" width="1280" height="720" fill="#0a1929"/>',
    '<rect x="52" y="42" width="10" height="100" rx="5" fill="#64d8cb"/>',
    textAt(92, 94, title, 38),
    textAt(92, 138, "EIGENE GRAFIK / OHNE FREMDES FOOTAGE", 16, "#bfe8ff"),
    ...graphicsFor(scene),
    '<rect x="0" y="667" width="1280" height="53" fill="#172c41"/>',
    textAt(92, 701, "VORSCHAU – NICHT ZUR VERÖFFENTLICHUNG", 18, "#ffd392"),
    textAt(948, 701, "Quellenlinks: " + sourceCount + " (ungeprüft)", 16, "#bfe8ff"),
    "</svg>",
  ];
  return { index, kind, svg: elements.join(""), sourceCount };
}

/**
 * Produces actual offline SVG image strings for five safe graphic types.
 * Whole-story validation is atomic: malformed scenes result in zero frames.
 * Generated graphics always remain PREVIEW_ONLY and never clear video rights.
 */
export function makeOfflineGraphicStoryboard(input: unknown): OfflineGraphicStoryboard {
  const request = record(input);
  const storyId =
    typeof request?.storyId === "string" && UUID.test(request.storyId) ? request.storyId : null;
  const errors: string[] = [];
  if (!storyId) errors.push("invalid_story_id");
  if (!request || !Array.isArray(request.scenes)) {
    errors.push("invalid_scenes");
  } else if (request.scenes.length < 1 || request.scenes.length > MAX_SCENES) {
    errors.push("scene_count_out_of_range");
  } else {
    for (const [index, raw] of request.scenes.entries()) {
      const scene = record(raw);
      if (!scene || !validateScene(scene)) errors.push("invalid_scene_" + index);
    }
  }
  if (errors.length || !request || !Array.isArray(request.scenes)) {
    return {
      status: "REJECTED",
      storyId,
      frames: [],
      errors: Object.freeze(errors),
      videoRenderAllowed: false,
      uploadAllowed: false,
      sourcesVerified: false,
    };
  }
  const frames = request.scenes.map((scene, index) => makeFrame(scene as RecordValue, index));
  return {
    status: "PREVIEW_ONLY",
    storyId,
    frames: Object.freeze(frames),
    errors: [],
    videoRenderAllowed: false,
    uploadAllowed: false,
    sourcesVerified: false,
  };
}
