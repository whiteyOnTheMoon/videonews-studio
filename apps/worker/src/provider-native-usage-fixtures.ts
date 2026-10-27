export const openaiFixture = Object.freeze({
  object: "response",
  id: "resp_native_openai_000001",
  model: "operator-chosen-model",
  status: "completed",
  error: null,
  incomplete_details: null,
  output: [{ type: "message" }],
  usage: {
    input_tokens: 100,
    output_tokens: 40,
    total_tokens: 140,
    input_tokens_details: { cached_tokens: 25 },
    output_tokens_details: { reasoning_tokens: 5 },
  },
});

export const geminiFixture = Object.freeze({
  responseId: "gemini_native_response_01",
  modelVersion: "operator-chosen-gemini",
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: {
    promptTokenCount: 100,
    cachedContentTokenCount: 20,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 3,
    totalTokenCount: 113,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 100 }],
    candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 10 }],
  },
});

