import {
  replayProviderBudgetFixture,
  type BudgetReplayRequest,
  type dormantProviderBudgetBridge,
} from "./provider-budget-worker-bridge.js";

/**
 * Offline-only proof that the one-shot SQL claim is made BEFORE a
 * pre-recorded vendor-shaped test response is processed. There is no
 * callback, network, SDK, token, endpoint or environment-driven enablement.
 *
 * NOT a production vendor dispatcher; a reviewed real transport, EUR gate,
 * response provenance and retry policy are still missing.
 */
export async function processOneShotRecordedFixture(
  bridge: ReturnType<typeof dormantProviderBudgetBridge>,
  request: BudgetReplayRequest,
  recordedFixture: unknown,
): Promise<Readonly<{ reservationId: string; costMicroUsd: string; reconciled: true }>> {
  const reservationId = await bridge.reserve(request);
  // This is irreversible. If the process exits after claim, the SQL record
  // remains and a retry must refuse to simulate a second paid request.
  await bridge.claim(reservationId);
  return replayProviderBudgetFixture(bridge, request, recordedFixture);
}
