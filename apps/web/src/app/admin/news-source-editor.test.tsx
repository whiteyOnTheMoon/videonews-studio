import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import NewsSourceEditor, { type EditableNewsSource } from "./news-source-editor";

const source: EditableNewsSource = {
  id: "city_news",
  baseUrl: "https://city.example.org/news/",
  status: "pending",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: "https://city.example.org/terms/",
  usage: "metadata_only",
  licenseNotes: "Only operator-reviewed metadata citations.",
  reviewedAt: "2026-10-25",
};
const notWired = async () => {
  throw new Error("Dormant source admin UI must not call network");
};

test("disabled form cannot collect source URLs, credentials or issue writes", () => {
  const html = renderToStaticMarkup(
    <NewsSourceEditor sources={[source]} revision={1} onCommand={notWired} />,
  );
  assert.match(html, /noch nicht freigeschaltet/);
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /city.example.org/);
});

test("ready form derives providers from operator-supplied source rows only", () => {
  const html = renderToStaticMarkup(
    <NewsSourceEditor
      sources={[source, { ...source, id: "another_feed", status: "blocked" }]}
      revision={1}
      ready
      onCommand={notWired}
    />,
  );
  assert.match(html, /city_news/);
  assert.match(html, /another_feed/);
  assert.match(html, /https:\/\/city.example.org\/news\//);
  assert.match(html, /Nach Rechteprüfung freigeben/);
  assert.match(html, /Erneut prüfen/);
  assert.match(html, /Quelle ungeprüft anlegen/);
  assert.match(html, /Änderung als ungeprüft speichern|Quellendaten ändern|Quelle hinzufügen/);
  assert.match(html, /name|news-source-url/);
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(html, /apiKey/);
  assert.doesNotMatch(html, /<form[^>]+action=/);
});

test("no production admin page or API route imports dormant editor", async () => {
  const page = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
  assert.ok(!page.includes("news-source-editor"));
});
