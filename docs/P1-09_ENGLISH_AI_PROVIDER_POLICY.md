# P1-09 — English AI provider policy (offline proposal, not deployment)

## Decision recorded 2026-10-25

The operator accepted the proposed **English-language** editorial production
direction: OpenAI for classification, scripting, and draft review; Google
Gemini as the first separate text-to-speech candidate. Videos remain
editorially supervised source-based explanatory news, normally one per day,
about 8–12 minutes **only where sufficient verified substance exists**.
Approved sourced images/clips, maps, timelines, simple charts, and
Remotion/FFmpeg remain the media strategy; no mass generative-video
purchase or unattended publishing is authorized.

Important: choosing an architecture or model **does not authorize buying
API credit or generating paid API requests**. No vendor key, billing
account, identity, per-day spend approval, SMTP/TTS setup, API SDK or
service activation is part of this change. The VPS remains unchanged.

## Primary English text roles

| Stage | Proposed model ID | Purpose | Input max | Output max |
| --- | --- | --- | ---: | ---: |
| Topic triage | `gpt-6-luna` | Classify/normalize approved sources | 4,000 | 700 |
| Script draft | `gpt-6.1-sol` | Explain the news clearly in English | 20,000 | 5,000 |
| Fact audit | `gpt-6.1-sol` | Flag unsupported claims for human checking | 12,000 | 2,500 |

Stage values are enforced in the dormant
`apps/worker/src/ai-provider-policy.ts`. Input type is metadata **only**:
`stage`, `model`, `language='en'`, `maxInputTokens` and `maxOutputTokens`.
Prompts, sources, API keys, URLs and arbitrary additional metadata are
rejected. This is a proposal/validator, **not** a prompt constructor or
provider call. It has no side-effectful imports; no production worker
imports it. All proposals return `networkAllowed:false`,
`spendApproved:false`, `estimated:true`.

At a later phase, only approved, fetched real source evidence may enter a
separate scripted workflow; every material claim must retain references.
One AI's fact audit does not make a statement true. Unverified and stale
claims must block release until human review; output cannot publish
without existing editorial approval.

## Proposed illustrative USD rate snapshot (NOT live pricing)

Snapshot inspected on **2026-10-25**, OpenAI API Standard short-context:

| Model | Input micro-USD / million tokens | Output micro-USD / million tokens |
| --- | ---: | ---: |
| `gpt-6-luna` | 100,000 ($0.10) | 500,000 ($0.50) |
| `gpt-6.1-sol` | 2,000,000 ($2.00) | 10,000,000 ($10.00) |

Source: https://developers.openai.com/api/docs/pricing
Model catalog: https://developers.openai.com/api/docs/models

Rates are intentionally manually pinned and dated. Prior to any live
spending, recheck model eligibility and **current** official pricing.
Long-context surcharges, cache-write charges, tool calls, provider
retries, taxes, FX costs, audio and other providers are **not** included.
Unknown rates and billable request features must fail closed, not
be silently estimated using these tables.

Conservative, deliberately **unapproved** proposed ceilings:

- Per text request: $0.10 (100,000 micro-USD)
- Per complete three-step text job: $0.25 (250,000 micro-USD)
- Daily proposed total: $2.00 (2,000,000 micro-USD)
- One planned call per text stage. Additional retries/tools are NOT priced
  or approved here. These ceilings are **not** operational guarantees.

At maximum displayed token limits, hypothetical cost of one text job:

| Step | Upper-bound estimated USD |
| --- | ---: |
| Topic triage | $0.000750 |
| Script draft | $0.090000 |
| Fact audit | $0.049000 |
| **Total for text stages** | **$0.139750** |

The policy uses BigInt arithmetic, round-up to integer micro-USD and
rejects unknown stages, model mismatches, non-English plans, prompts,
fractional limits and duplicate/missing stages. This is *planning*;
not actual usage or an approved payment. Actual per-call cost depends
on the provider's authenticated consumption records, pricing version
and available budget. A later separately approved implementation
requires **atomic persistent budget reservations** covering concurrent
jobs, retries, cache, tools and every provider, not only a frontend limit.

## English voice (future P4)

First candidate: Google Gemini TTS `gemini-3.8-flash-tts`.
`gemini-3.8-flash-lite-tts` is a possible price/quality benchmark.
Source: https://ai.google.dev/gemini-api/docs/speech-generation

The selection is **not** an activation. Model pricing, billing units,
character/token/audio counts, voice licence, speaker quality, output
format and long-form continuity must be verified independently.
The config therefore explicitly sets `priceVerified:false`,
`audioCostAccountingReady:false` and `executionAllowed:false`.
Do not represent the text-only $0.139750 estimate as a total video cost.

The P4 TTS benchmark should compare English pronunciation, names and
acronyms, calm journalistic pacing, pauses, segmentation and licences
with two human-reviewed samples before selecting a permanent voice.

## Release gates

1. Confirm actual budget and provider billing project (not ChatGPT Plus).
2. Explicitly approve provider API calls and store secrets **only** on VPS
   in restricted runtime paths; never in chat, GitHub, URLs or logs.
3. Add real OpenAI adapter behind exact allowlists and dedicated worker
   permission with bounded HTTP retries/timeouts, source verification
   and no automatic model fallback or web browsing charges.
4. Add true provider response-usage token provenance, retries and
   idempotency, matching authorized prices and the `vns.job_token_usage`
   synthetic-only boundaries by **separate reviewed migration**.
5. Add independently approved Google TTS transport and usage/cost model
   *after* spoken-English quality and vendor terms pass review.
6. Safely migrate/test isolated data before enabling any billing;
   Offsite backups/restores remain deferred by the operator and
   must not be implicitly represented as available.

This change adds no API endpoint, scheduler, Docker service, credential,
database migration, approved cost limit, or public automatic upload.
Existing Beszel monitoring and the Git-only synthetic ledger remain unchanged.
