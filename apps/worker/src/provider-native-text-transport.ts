import { extractNativeTextUsage, type NativeProvider } from "./provider-native-usage.js";

/**
 * P1-09/#230: dormant, text-only vendor transport.
 * Never imported by worker/index.ts; no environment flag or key loading here.
 * A separate reviewed dispatcher must hold a committed SQL one-shot claim
 * BEFORE calling this transport. The caller supplies the trusted key.
 */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const KEY = /^[\x21-\x7e]{12,512}$/;
const MAX_PROMPT_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_INPUT_TOKENS = 32_768;

export type NativeTextSend = Readonly<{
  provider: NativeProvider;
  model: string;
  prompt: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}>;

export function verifyNativeTextSend(value: NativeTextSend): void {
  if (
    !value ||
    Object.keys(value).length !== 5 ||
    !["provider", "model", "prompt", "maxInputTokens", "maxOutputTokens"].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    (value.provider !== "openai" && value.provider !== "google_gemini") ||
    typeof value.model !== "string" ||
    !MODEL.test(value.model) ||
    typeof value.prompt !== "string" ||
    value.prompt.trim().length < 1 ||
    !Number.isSafeInteger(value.maxInputTokens) ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    value.maxInputTokens < 1 ||
    value.maxInputTokens > MAX_INPUT_TOKENS ||
    value.maxOutputTokens < 16 ||
    value.maxOutputTokens > MAX_OUTPUT_TOKENS ||
    Buffer.byteLength(value.prompt, "utf8") > MAX_PROMPT_BYTES ||
    // Conservative bound: never claim that prompt bytes prove vendor tokens.
    Buffer.byteLength(value.prompt, "utf8") > value.maxInputTokens
  ) {
    throw new Error("Provider text request invalid");
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    !response.ok ||
    !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")
  ) {
    throw new Error("Provider response unavailable");
  }
  const size = response.headers.get("content-length");
  if (size !== null && (!/^(0|[1-9][0-9]*)$/.test(size) || Number(size) > MAX_RESPONSE_BYTES)) {
    throw new Error("Provider response unavailable");
  }
  if (!response.body) throw new Error("Provider response unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Provider response unavailable");
      chunks.push(next.value);
    }
    if (size !== null && length !== Number(size)) throw new Error("Provider response unavailable");
    const bytes = new Uint8Array(length);
    let index = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, index);
      index += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new Error("Provider response unavailable");
  } finally {
    await reader.cancel().catch(() => undefined);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export type DormantTextTransport = Readonly<{
  send(request: NativeTextSend, trustedKey: string): Promise<unknown>;
}>;

/**
 * Explicitly injected fetch for isolated tests. Production entrypoints
 * MUST NOT import/construct this module without independent authorization.
 * No URL, redirect, proxy, retry, tool, streaming or prompt-log overrides.
 */
export function dormantNativeTextTransport(
  enabled = false,
  fetcher: typeof fetch = fetch,
): DormantTextTransport {
  if (enabled !== true || typeof fetcher !== "function") {
    throw new Error("Provider network transport disabled");
  }
  return Object.freeze({
    async send(request: NativeTextSend, trustedKey: string): Promise<unknown> {
      verifyNativeTextSend(request);
      if (typeof trustedKey !== "string" || !KEY.test(trustedKey)) {
        throw new Error("Provider credential unavailable");
      }
      const isOpenai = request.provider === "openai";
      const url = isOpenai
        ? "https://api.openai.com/v1/responses"
        : `https://generativelanguage.googleapis.com/v1beta/models/${request.model}:generateContent`;
      const body = isOpenai
        ? {
            model: request.model,
            input: request.prompt,
            max_output_tokens: request.maxOutputTokens,
            store: false,
            stream: false,
            tools: [],
          }
        : {
            contents: [{ role: "user", parts: [{ text: request.prompt }] }],
            generationConfig: {
              maxOutputTokens: request.maxOutputTokens,
              candidateCount: 1,
              responseMimeType: "text/plain",
            },
          };
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (isOpenai) headers.Authorization = `Bearer ${trustedKey}`;
      else headers["x-goog-api-key"] = trustedKey;
      try {
        const response = await fetcher(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        const result = await boundedJson(response);
        // Native usage must match the requested model, be completed/text-only
        // and contain a valid vendor receipt before passing back to SQL.
        extractNativeTextUsage(request.provider, request.model, result);
        return result;
      } catch {
        // Deliberately no retries or original vendor errors/response bodies.
        throw new Error("Provider response unavailable");
      }
    },
  });
}
