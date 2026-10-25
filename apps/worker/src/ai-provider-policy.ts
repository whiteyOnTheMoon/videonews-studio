/**
 * P1-09 Git-only AI provider decision and conservative offline cost proposal.
 * Deliberately NO imports of AI SDKs, fetch, network, files, database, or secrets.
 * Neither constructing plans nor passing all checks grants permission to spend.
 */

export const EDITORIAL_LANGUAGE = "en" as const;
export const PROVIDER_POLICY_DATE = "2026-10-25" as const;
export const PROPOSED_DAILY_CAP_MICRO_USD = 2_000_000n;
export const PROPOSED_JOB_CAP_MICRO_USD = 250_000n;
export const PROPOSED_REQUEST_CAP_MICRO_USD = 100_000n;

export const TEXT_STAGES = {
  topic_triage: {
    provider: "openai",
    model: "gpt-6-luna",
    maxInputTokens: 4_000,
    maxOutputTokens: 700,
    inputMicroUsdPerMillion: 100_000n,
    outputMicroUsdPerMillion: 500_000n,
  },
  script_draft: {
    provider: "openai",
    model: "gpt-6.1-sol",
    maxInputTokens: 20_000,
    maxOutputTokens: 5_000,
    inputMicroUsdPerMillion: 2_000_000n,
    outputMicroUsdPerMillion: 10_000_000n,
  },
  fact_audit: {
    provider: "openai",
    model: "gpt-6.1-sol",
    maxInputTokens: 12_000,
    maxOutputTokens: 2_500,
    inputMicroUsdPerMillion: 2_000_000n,
    outputMicroUsdPerMillion: 10_000_000n,
  },
} as const;

export type TextStage = keyof typeof TEXT_STAGES;

export const TTS_CANDIDATE = {
  provider: "google_gemini",
  model: "gemini-3.8-flash-tts",
  language: EDITORIAL_LANGUAGE,
  voice: null,
  priceVerified: false,
  audioCostAccountingReady: false,
  executionAllowed: false,
} as const;

export type OfflineTextRequest = {
  stage: TextStage;
  model: string;
  language: typeof EDITORIAL_LANGUAGE;
  maxInputTokens: number;
  maxOutputTokens: number;
};

export type OfflineTextReservation = {
  stage: TextStage;
  provider: "openai";
  model: string;
  language: "en";
  maxInputTokens: number;
  maxOutputTokens: number;
  estimatedWorstCaseMicroUsd: string;
  estimated: true;
  priceSnapshot: typeof PROVIDER_POLICY_DATE;
  networkAllowed: false;
  spendApproved: false;
};

function checkedPositiveSafeInt(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= maximum
  );
}

function ownFieldsOnly(data: object, expected: readonly string[]): boolean {
  return (
    Object.keys(data).length === expected.length &&
    expected.every((key) => Object.hasOwn(data, key))
  );
}

export function proposeOfflineTextReservation(value: unknown): OfflineTextReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid AI proposal");
  }
  const request = value as Record<string, unknown>;
  if (
    !ownFieldsOnly(request, [
      "stage",
      "model",
      "language",
      "maxInputTokens",
      "maxOutputTokens",
    ]) ||
    typeof request.stage !== "string" ||
    !Object.hasOwn(TEXT_STAGES, request.stage)
  ) {
    throw new Error("Invalid AI proposal");
  }

  const stage = request.stage as TextStage;
  const policy = TEXT_STAGES[stage];
  if (
    request.model !== policy.model ||
    request.language !== EDITORIAL_LANGUAGE ||
    !checkedPositiveSafeInt(request.maxInputTokens, policy.maxInputTokens) ||
    !checkedPositiveSafeInt(request.maxOutputTokens, policy.maxOutputTokens)
  ) {
    throw new Error("AI request exceeds offline policy");
  }

  // BigInt avoids floating-point currency and always rounds *up* to a micro-USD.
  const numerator =
    BigInt(request.maxInputTokens) * policy.inputMicroUsdPerMillion +
    BigInt(request.maxOutputTokens) * policy.outputMicroUsdPerMillion;
  const cost = (numerator + 999_999n) / 1_000_000n;
  if (cost > PROPOSED_REQUEST_CAP_MICRO_USD) {
    throw new Error("Proposed request exceeds budget ceiling");
  }

  return Object.freeze({
    stage,
    provider: "openai" as const,
    model: policy.model,
    language: EDITORIAL_LANGUAGE,
    maxInputTokens: request.maxInputTokens,
    maxOutputTokens: request.maxOutputTokens,
    estimatedWorstCaseMicroUsd: cost.toString(),
    estimated: true as const,
    priceSnapshot: PROVIDER_POLICY_DATE,
    networkAllowed: false as const,
    spendApproved: false as const,
  });
}

export function proposeOfflineJobBudget(
  items: unknown,
): {
  requests: readonly OfflineTextReservation[];
  estimatedWorstCaseMicroUsd: string;
  proposedDailyCapMicroUsd: string;
  proposedJobCapMicroUsd: string;
  estimated: true;
  networkAllowed: false;
  spendApproved: false;
} {
  // Exactly one of each operation; no hidden prompts or additional retries.
  if (!Array.isArray(items) || items.length !== 3) {
    throw new Error("Offline plan must contain three editorial stages");
  }
  const requests = items.map(proposeOfflineTextReservation);
  if (
    new Set(requests.map((r) => r.stage)).size !== 3 ||
    !["topic_triage", "script_draft", "fact_audit"].every((stage) =>
      requests.some((r) => r.stage === stage),
    )
  ) {
    throw new Error("Offline plan contains duplicated or missing stages");
  }
  const cost = requests.reduce(
    (sum, item) => sum + BigInt(item.estimatedWorstCaseMicroUsd),
    0n,
  );
  if (cost > PROPOSED_JOB_CAP_MICRO_USD) {
    throw new Error("Offline job exceeds proposed ceiling");
  }
  return Object.freeze({
    requests: Object.freeze(requests),
    estimatedWorstCaseMicroUsd: cost.toString(),
    proposedDailyCapMicroUsd: PROPOSED_DAILY_CAP_MICRO_USD.toString(),
    proposedJobCapMicroUsd: PROPOSED_JOB_CAP_MICRO_USD.toString(),
    estimated: true as const,
    networkAllowed: false as const,
    spendApproved: false as const,
  });
}

export function defaultOfflineEnglishNewsPlan() {
  return proposeOfflineJobBudget([
    {
      stage: "topic_triage",
      model: TEXT_STAGES.topic_triage.model,
      language: "en",
      maxInputTokens: TEXT_STAGES.topic_triage.maxInputTokens,
      maxOutputTokens: TEXT_STAGES.topic_triage.maxOutputTokens,
    },
    {
      stage: "script_draft",
      model: TEXT_STAGES.script_draft.model,
      language: "en",
      maxInputTokens: TEXT_STAGES.script_draft.maxInputTokens,
      maxOutputTokens: TEXT_STAGES.script_draft.maxOutputTokens,
    },
    {
      stage: "fact_audit",
      model: TEXT_STAGES.fact_audit.model,
      language: "en",
      maxInputTokens: TEXT_STAGES.fact_audit.maxInputTokens,
      maxOutputTokens: TEXT_STAGES.fact_audit.maxOutputTokens,
    },
  ]);
}
