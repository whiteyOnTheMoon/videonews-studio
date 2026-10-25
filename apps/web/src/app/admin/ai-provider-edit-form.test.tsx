import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import AiProviderEditForm from "./ai-provider-edit-form";
import { makeKeyCommand, makeModelCommand, makeRemoveCommand } from "./ai-provider-edit-model";

const SYNTHETIC_KEY = "sk-ci-placeholder-not-a-real-credential-01234567";
const noTransport = async () => {
  throw new Error("A dormant form must never issue network calls");
};

test("not-ready form has no password input, submission, transport or removal button", () => {
  const html = renderToStaticMarkup(
    <AiProviderEditForm
      provider="openai"
      selectedModel="gpt-6.1-sol"
      configured={false}
      onCommand={noTransport}
    />,
  );
  assert.match(html, /noch nicht freigeschaltet/);
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /<select/);
});

test("isolated ready form offers masked key replacement, allowlisted model and confirmed removal", () => {
  const html = renderToStaticMarkup(
    <AiProviderEditForm
      provider="openai"
      selectedModel="gpt-6.1-sol"
      configured={true}
      ready={true}
      onCommand={noTransport}
    />,
  );
  assert.match(html, /type="password"/);
  assert.match(html, /autocomplete="off"/i);
  assert.match(html, /Schlüssel sicher übermitteln/);
  assert.match(html, /Schlüssel entfernen/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /gpt-6-luna/);
  assert.match(html, /gpt-6.1-sol/);
  assert.match(html, /deaktiviert/);
  assert.doesNotMatch(html, /value="sk-/);
  assert.doesNotMatch(html, /<form[^>]+action=/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("Gemini selector cannot expose OpenAI models; absent key cannot be removed", () => {
  const html = renderToStaticMarkup(
    <AiProviderEditForm
      provider="google_gemini"
      selectedModel="gemini-3.8-flash-tts"
      configured={false}
      ready={true}
      onCommand={noTransport}
    />,
  );
  assert.match(html, /gemini-3.8-flash-tts/);
  assert.doesNotMatch(html, /gpt-6-luna/);
  assert.doesNotMatch(html, /Schlüssel entfernen/);
});

test("builders reject unsupported models, activation, malformed and whitespace keys", () => {
  assert.deepEqual(makeKeyCommand("openai", SYNTHETIC_KEY), {
    action: "set_key",
    provider: "openai",
    apiKey: SYNTHETIC_KEY,
  });
  for (const bad of [
    "short",
    " leading-secret-0123456",
    "line\nbreak-012345678",
    "z".repeat(513),
  ]) {
    assert.equal(makeKeyCommand("openai", bad), null);
  }
  assert.equal(makeKeyCommand("evil_provider", SYNTHETIC_KEY), null);
  assert.equal(makeKeyCommand("openai", null), null);
  assert.deepEqual(makeModelCommand("openai", "gpt-6-luna"), {
    action: "set_model",
    provider: "openai",
    model: "gpt-6-luna",
  });
  assert.equal(makeModelCommand("google_gemini", "gpt-6-luna"), null);
  assert.equal(makeModelCommand("openai", "https://bad.example"), null);
  assert.equal(makeModelCommand("unknown", "gpt-6-luna"), null);
  assert.equal(makeRemoveCommand("openai", true, false), null);
  assert.equal(makeRemoveCommand("openai", false, true), null);
  assert.equal(makeRemoveCommand("unknown", true, true), null);
  assert.deepEqual(makeRemoveCommand("openai", true, true), {
    action: "remove_key",
    provider: "openai",
  });
});

test("dormant component cannot be mounted from the current admin page or route", async () => {
  const [adminPage, preview, route] = await Promise.all([
    readFile(new URL("./page.tsx", import.meta.url), "utf8"),
    readFile(new URL("./ai-providers.tsx", import.meta.url), "utf8"),
    readFile(new URL("../api/admin/ai-providers/route.ts", import.meta.url), "utf8"),
  ]);
  for (const deployed of [adminPage, preview, route]) {
    assert.ok(!deployed.includes("ai-provider-edit-form"));
    assert.ok(!deployed.includes("ai-provider-edit-model"));
  }
  assert.ok(!route.includes("export async function POST"));
  assert.ok(!route.includes("admin-ai-provider-write-contract"));
});
