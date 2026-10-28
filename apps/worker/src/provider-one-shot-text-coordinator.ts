import {
  reconcileRecordedProviderFixture,
  type BudgetReplayRequest,
  type dormantProviderBudgetBridge,
} from "./provider-budget-worker-bridge.js";
import {
  verifyNativeTextSend,
  type DormantTextTransport,
  type NativeTextSend,
} from "./provider-native-text-transport.js";
import type { NativeProvider } from "./provider-native-usage.js";

export type TrustedProviderCredentialScope = Readonly<{
  // Must read the separately protected, encrypted provider credential and
  // keep it scoped to this one operation. The database/KEK implementation
  // and its security review are NOT part of this dormant worker module.
  withCredential<T>(
    provider: NativeProvider,
    operation: (secret: string) => Promise<T>,
  ): Promise<T>;
}>;

/**
 * Fail-closed ordering: validate -> reserve -> SQL projection -> one-shot
 * claim -> trusted scoped key -> fixed vendor HTTPS -> quote -> receipt ->
 * settlement. No retries after claim, even on ambiguous network failure.
 *
 * Entire factory is default-OFF and NOT imported by a running entrypoint.
 * This DOES NOT grant permission for any real or billable request.
 */
export function dormantOneShotTextCoordinator(
  bridge: ReturnType<typeof dormantProviderBudgetBridge>,
  transport: DormantTextTransport,
  credentials: TrustedProviderCredentialScope,
  enabled = false,
) {
  if (
    enabled !== true ||
    !bridge ||
    typeof bridge.reserve !== "function" ||
    typeof bridge.claim !== "function" ||
    typeof bridge.projection !== "function" ||
    typeof bridge.halt !== "function" ||
    typeof bridge.settle !== "function" ||
    !transport ||
    typeof transport.send !== "function" ||
    !credentials ||
    typeof credentials.withCredential !== "function"
  ) {
    throw new Error("Provider text coordinator disabled");
  }
  return Object.freeze({
    async run(
      request: BudgetReplayRequest,
      prompt: string,
    ): Promise<Readonly<{ reservationId: string; costMicroUsd: string; reconciled: true }>> {
      const textRequest: NativeTextSend = {
        provider: request.provider,
        model: request.model,
        maxInputTokens: request.maxInputTokens,
        maxOutputTokens: request.maxOutputTokens,
        prompt,
      };
      // No reservation, SQL claim, secret read or vendor call for bad inputs.
      verifyNativeTextSend(textRequest);
      const reservationId = await bridge.reserve(request);
      try {
        await bridge.projection(request, reservationId);
      } catch {
        await bridge.halt(reservationId, "settlement_unconfirmed");
        throw new Error("Provider budget review required");
      }
      // Once committed, claim cannot be repeated even after worker failure.
      await bridge.claim(reservationId);
      let raw: unknown;
      try {
        raw = await credentials.withCredential(request.provider, (key) =>
          transport.send(textRequest, key),
        );
      } catch {
        await bridge.halt(reservationId, "response_missing");
        throw new Error("Provider budget review required");
      }
      return reconcileRecordedProviderFixture(bridge, request, raw, reservationId);
    },
  });
}
