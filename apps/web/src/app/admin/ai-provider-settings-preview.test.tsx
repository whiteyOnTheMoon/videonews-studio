import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import AiProviderSettingsPreview from "./ai-provider-settings-preview";

const providers = [
  { provider: "openai", label: "OpenAI" },
  { provider: "google_gemini", label: "Google Gemini" },
] as const;

test("each provider has a labelled but completely disabled credential and model preview", () => {
  for (const entry of providers) {
    const html = renderToStaticMarkup(<AiProviderSettingsPreview provider={entry.provider} />);
    assert.match(html, new RegExp(entry.label));
    assert.match(html, /Verwaltung – noch nicht freigeschaltet/);
    assert.match(html, /<fieldset\b[^>]*disabled/);
    assert.match(html, /<legend/);
    assert.match(html, /type="password"/);
    assert.match(html, /autoComplete="off"/i);
    assert.match(html, /English \(en\)/);
    assert.match(html, /Betrieb: deaktiviert/);
    assert.match(html, /Status derzeit unbekannt/);
    assert.doesNotMatch(html, /<form\b/);
    assert.doesNotMatch(html, /<textarea\b/);

    const fields = [...html.matchAll(/<(?:input|select|button)\b[^>]*>/g)].map((match) => match[0]);
    assert.ok(fields.length >= 6);
    for (const field of fields) {
      assert.match(field, /\bdisabled(?:="")?/);
    }
    const key = fields.find((field) => field.includes('type="password"'));
    assert.ok(key);
    assert.match(key, /\bvalue=""/);
    assert.match(key, /\breadOnly(?:="")?/);
    assert.ok(!html.includes("sk-live-"));
    assert.ok(!html.includes("AIza"));
  }
});

test("Gemini includes disabled voice placeholder; OpenAI does not claim a TTS voice", () => {
  const gemini = renderToStaticMarkup(<AiProviderSettingsPreview provider="google_gemini" />);
  assert.match(gemini, /Sprecherstimme/);
  assert.match(gemini, /Noch nicht festgelegt/);
  assert.match(gemini, /gemini-3.8-flash-tts/);

  const openai = renderToStaticMarkup(<AiProviderSettingsPreview provider="openai" />);
  assert.doesNotMatch(openai, /Sprecherstimme/);
  assert.match(openai, /gpt-6-luna/);
  assert.match(openai, /gpt-6\.1-sol/);
});

test("even when a status is configured, no existing key material or active controls appear", () => {
  const html = renderToStaticMarkup(
    <AiProviderSettingsPreview
      provider="openai"
      status={{
        provider: "openai",
        selectedModel: "gpt-6.1-sol",
        configured: true,
        active: false,
      }}
    />,
  );
  assert.match(html, /hinterlegt \(Inhalt niemals sichtbar\)/);
  assert.match(html, /Betrieb: deaktiviert/);
  const fields = [...html.matchAll(/<(?:input|select|button)\b[^>]*>/g)];
  assert.ok(fields.every((field) => /\bdisabled(?:="")?/.test(field[0])));
  assert.doesNotMatch(html, /<form\b/);
  assert.doesNotMatch(html, /apiKey/);
  assert.doesNotMatch(html, /ciphertext/);
});

test("unrecognized model in status is never inserted as a select choice", () => {
  const html = renderToStaticMarkup(
    <AiProviderSettingsPreview
      provider="openai"
      status={{
        provider: "openai",
        selectedModel: "untrusted-model",
        configured: false,
        active: false,
      }}
    />,
  );
  assert.doesNotMatch(html, /untrusted-model/);
  assert.match(html, /Noch nicht aus der Datenbank geladen/);
});
