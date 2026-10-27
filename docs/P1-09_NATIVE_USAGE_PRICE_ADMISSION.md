# P1-09 / #230 — vendor-native text usage & trusted fixed-point quote

**Status: offline, not deployed.** This deliberately has no network client, API key import, provider execution path, runtime worker import, DB connection, budget reservation writer or billing permissions. It does **not** close #230, cannot approve a 1 EUR real canary and must not be used to infer paid service authorization.

## Provider response evidence

\`apps/worker/src/provider-native-usage.ts\` handles only two explicitly named endpoints:

- **OpenAI Responses API**: require a completed \`response\`, exact model, response ID, no reported error/incompletion, and \`usage.input_tokens\`, \`usage.output_tokens\`, \`usage.total_tokens\`, \`usage.input_tokens_details.cached_tokens\` and output-reasoning detail. Cached input counts are a subset of input. Reasoning output counts are a subset of output. If tools or incomplete responses appear, **do not silently treat them as a billable zero**: hold the prior reservation, block further spending and arrange a separate review.
- **Google Gemini generateContent**: require matching \`modelVersion\`, \`responseId\`, successful \`candidates[].finishReason = STOP\` and \`usageMetadata\` totals. \`promptTokenCount\` includes cached prompt tokens; \`candidatesTokenCount + thoughtsTokenCount\` form output in this constrained *text* pricing contract. Tool-use tokens and any reported non-text modality are refused; the current contract cannot price TTS/audio/images/video, tool calls, continuations or background streaming. Sum of prompt + candidates + thoughts must exactly match total (when tool tokens are absent).

The tool intentionally does not log or pass on provider prompts or responses; it returns only canonical counts and response identifiers, always \`persistent:false\`, \`approvedForPayment:false\`.

Primary native field references, verified against vendor docs on 2026-10-27:

- OpenAI migration guide Responses API example: https://platform.openai.com/docs/assistants/migration
- Gemini \`GenerateContentResponse\` and \`UsageMetadata\` fields: https://ai.google.dev/api/generate-content

Native reports are **not invoices**. The vendor may have minimum charges, caching rules, tiers, multimodal units, free tiers, delayed invoices or other SKU lines not represented in this text-only parser. A verified billing reconciliation process is still required.

## Fixed-point quotes (never an authorized charge)

\`apps/worker/src/provider-priced-usage.ts\` takes a **server-controlled, versioned, reviewed** price snapshot for an exact provider/model. It charges uncached input tokens, cached input tokens and output tokens separately, using nonnegative integer \`micro-USD per million tokens\` and one final ceiling to integer micro-USD. It uses \`BigInt\` throughout monetary arithmetic and rejects missing/noncanonical rates and \`calculatedCost > reservedMicroUsd\`.

No default model IDs, price numbers, token budgets, allowed API hosts or FX rates are embedded. Tests use *invented example numbers*, not verified OpenAI/Gemini rates. Neither price snapshots nor reservations can be trusted from browser input, response bodies or AI-generated text; the future controlled worker must load both from independent trusted infrastructure and atomically reserve **before** opening a paid connection.

This step does not address atomic SQL reservation/reconciliation, job/day/month global caps, idempotent live ingestion, recorded thinking/tool subtotals in a persisted schema, late usage, error responses, price validity periods, invoice-to-ledger audit, genuine vendor adapter authentication or actual canary approval. Migration \`0036\` is present in Git only: **never apply it in isolation to the VPS**, whose last confirmed installed ledger ends at \`0018\`.

## Required follow-up before a real provider request

1. Obtain reviewed current vendor SKU prices, identifiable version and period, text-only scope, and implement a trusted server-side price catalog with no default fallback.
2. Implement a first-class reservation and settlement system across job, day, month and project that accounts for maximum possible output and vendor-side overages; refuse missing/late receipts and any overspend with a global kill-switch.
3. Bind the real provider client transport, a pinned model lookup and the checked quote to an authorized, authenticated usage writer; handle all partial/cancelled requests without undercounting and preserve personal audit attribution. Test concurrent retries and DB/Redis outages in isolated services.
4. Explicitly authorize a hard-capped provider canary **separately**, preserving the owner's absolute maximum of 1 EUR; never send expensive requests on the strength of this PR.
