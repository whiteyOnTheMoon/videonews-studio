import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import AiProviders from "./ai-providers";

test("AI providers management preview is visible but every credential action is disabled", () => {
  const html = renderToStaticMarkup(<AiProviders readOnlyEnabled={false} />);
  assert.match(html, /KI-Anbieter/);
  assert.match(html, /OpenAI/);
  assert.match(html, /Google Gemini/);
  assert.match(html, /Schlüsselverwaltung noch nicht freigeschaltet/);
  assert.match(html, /Betrieb: deaktiviert/);
  assert.match(html, /Status derzeit unbekannt/);
  assert.match(html, /API-Key hinterlegen \/ ersetzen/);
  assert.match(html, /API-Key entfernen/);
  assert.match(html, /Modell übernehmen/);
  assert.match(html, /English \(en\)/);
  assert.doesNotMatch(html, /<form\b/);
  assert.doesNotMatch(html, /sk-[a-zA-Z0-9]+/);
  const fields = [...html.matchAll(/<(?:input|select|button)\b[^>]*>/g)];
  assert.ok(fields.length >= 13);
  assert.ok(fields.every((field) => /\bdisabled(?:="")?/.test(field[0])));
  assert.equal((html.match(/type="password"/g) ?? []).length, 2);
});

test("read-only state only displays loading placeholder until independently verified", () => {
  const html = renderToStaticMarkup(<AiProviders readOnlyEnabled={true} />);
  assert.match(html, /Lade Anbieterstatus/);
  assert.match(html, /Status derzeit unbekannt/);
  assert.doesNotMatch(html, /Key vorhanden/);
  assert.doesNotMatch(html, /<form\b/);
});
