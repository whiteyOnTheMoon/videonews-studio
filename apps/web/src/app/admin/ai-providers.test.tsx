import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import AiProviders from "./ai-providers";

test("AI providers section is visible but cannot accept or display API keys", () => {
  const html = renderToStaticMarkup(<AiProviders readOnlyEnabled={false} />);
  assert.match(html, /KI-Anbieter/);
  assert.match(html, /OpenAI/);
  assert.match(html, /Google Gemini/);
  assert.match(html, /Schlüsselverwaltung noch nicht freigeschaltet/);
  assert.match(html, /Betrieb: deaktiviert/);
  assert.match(html, /Status derzeit unbekannt/);
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /sk-[a-zA-Z0-9]+/);
});

test("read-only state only displays loading placeholder until independently verified", () => {
  const html = renderToStaticMarkup(<AiProviders readOnlyEnabled={true} />);
  assert.match(html, /Lade Anbieterstatus/);
  assert.match(html, /Status derzeit unbekannt/);
  assert.doesNotMatch(html, /Key vorhanden/);
});
