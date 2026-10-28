import assert from "node:assert/strict";
import test from "node:test";
import {
  dormantNativeTextTransport,
  verifyNativeTextSend,
} from "./provider-native-text-transport.js";
import { geminiFixture, openaiFixture } from "./provider-native-usage-fixtures.js";

const KEY = "ci-only-no-real-provider-key-123456789";
const textRequest = {
  provider: "openai" as const,
  model: "operator-chosen-model",
  prompt: "Summarize only the verified facts.",
  maxInputTokens: 512,
  maxOutputTokens: 64,
};

test("transport is disabled even if a fetch or key is supplied", () => {
  let calls = 0;
  const transport = (async () => {
    calls++;
    return Response.json(openaiFixture);
  }) as typeof fetch;
  assert.throws(
    () => dormantNativeTextTransport(false, transport),
    /Provider network transport disabled/,
  );
  assert.equal(calls, 0);
});

test("OpenAI sends exactly one fixed-origin, stateless, text-only request", async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const fetcher = (async (url: RequestInfo | URL, options?: RequestInit) => {
    calls.push({ url: String(url), options: options! });
    return Response.json(openaiFixture);
  }) as typeof fetch;
  const transport = dormantNativeTextTransport(true, fetcher);
  const response = await transport.send(textRequest, KEY);
  assert.deepEqual(response, openaiFixture);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.openai.com/v1/responses");
  const options = calls[0]!.options;
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error");
  assert.equal(options.referrerPolicy, "no-referrer");
  assert.equal(options.cache, "no-store");
  assert.ok(options.signal);
  const headers = new Headers(options.headers);
  assert.equal(headers.get("Authorization"), "Bearer " + KEY);
  assert.equal(headers.get("x-goog-api-key"), null);
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(options.body)), {
    model: textRequest.model,
    input: textRequest.prompt,
    max_output_tokens: 64,
    store: false,
    stream: false,
    tools: [],
  });
  assert.ok(!String(options.body).includes(KEY));
});

test("Gemini sends exactly one fixed-origin, no-query-key text request", async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const fetcher = (async (url: RequestInfo | URL, options?: RequestInit) => {
    calls.push({ url: String(url), options: options! });
    return Response.json(geminiFixture);
  }) as typeof fetch;
  const transport = dormantNativeTextTransport(true, fetcher);
  const request = {
    ...textRequest,
    provider: "google_gemini" as const,
    model: "operator-chosen-gemini",
  };
  const response = await transport.send(request, KEY);
  assert.deepEqual(response, geminiFixture);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/operator-chosen-gemini:generateContent",
  );
  assert.doesNotMatch(calls[0]!.url, /\?|key=/);
  const options = calls[0]!.options;
  assert.equal(options.redirect, "error");
  const headers = new Headers(options.headers);
  assert.equal(headers.get("Authorization"), null);
  assert.equal(headers.get("x-goog-api-key"), KEY);
  assert.deepEqual(JSON.parse(String(options.body)), {
    contents: [{ role: "user", parts: [{ text: request.prompt }] }],
    generationConfig: {
      maxOutputTokens: 64,
      candidateCount: 1,
      responseMimeType: "text/plain",
    },
  });
});

test("malformed model, prompt, budget or keys cannot reach HTTP", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    throw Error("Unexpected network");
  }) as typeof fetch;
  const transport = dormantNativeTextTransport(true, fetcher);
  const invalid = [
    { ...textRequest, provider: "third_party" },
    { ...textRequest, model: "https://evil.invalid/" },
    { ...textRequest, model: "../models/evil" },
    { ...textRequest, model: "model/with/path" },
    { ...textRequest, model: "a".repeat(81) },
    { ...textRequest, prompt: "" },
    { ...textRequest, prompt: "X".repeat(33000) },
    { ...textRequest, maxInputTokens: 3 },
    { ...textRequest, maxInputTokens: 1.5 },
    { ...textRequest, maxOutputTokens: 0 },
    { ...textRequest, maxOutputTokens: 4_097 },
    { ...textRequest, maxOutputTokens: 16.5 },
    { ...textRequest, endpoint: "https://evil.invalid" },
  ];
  for (const raw of invalid) {
    await assert.rejects(transport.send(raw as never, KEY), /Provider text request invalid/);
  }
  await assert.rejects(transport.send(textRequest, "short"), /Provider credential unavailable/);
  await assert.rejects(
    transport.send(textRequest, KEY + "\nmalicious"),
    /Provider credential unavailable/,
  );
  assert.equal(calls, 0);
  assert.throws(() => verifyNativeTextSend({ ...textRequest, maxOutputTokens: 1 }), /invalid/);
});

test("HTTP failure, redirect, wrong content type and unexpected native usage fail closed", async () => {
  const failures = [
    new Response("internal-secret=never-echo", { status: 500 }),
    new Response(null, { status: 302, headers: { location: "https://evil.invalid" } }),
    new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    Response.json({ ...openaiFixture, status: "incomplete" }),
    Response.json({ ...openaiFixture, model: "different-model" }),
    Response.json({ ...openaiFixture, usage: null }),
    Response.json({ error: "secret" }),
    Response.json({ ...openaiFixture, output: [{ type: "function_call" }] }),
    Response.json({ ...openaiFixture, output: [{ type: "message" }], status: "queued" }),
    new Response("x".repeat(262145), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "999999" },
    }),
  ];
  let count = 0;
  for (const raw of failures) {
    const fetcher = (async () => {
      count++;
      return raw;
    }) as typeof fetch;
    const transport = dormantNativeTextTransport(true, fetcher);
    await assert.rejects(
      transport.send(textRequest, KEY),
      (error: Error) =>
        error.message === "Provider response unavailable" && !error.message.includes("secret"),
    );
  }
  assert.equal(count, failures.length);
});

test("fetch exceptions must not leak credentials and must never trigger retries", async () => {
  let called = 0;
  const fetcher = (async () => {
    called++;
    throw new Error("Bearer " + KEY);
  }) as typeof fetch;
  await assert.rejects(
    dormantNativeTextTransport(true, fetcher).send(textRequest, KEY),
    (error: Error) => error.message === "Provider response unavailable",
  );
  assert.equal(called, 1);
});
