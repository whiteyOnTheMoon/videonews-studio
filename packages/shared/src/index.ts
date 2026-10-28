export const PRODUCT_NAME = "VideoNews Studio";

export type ServiceName = "web" | "api" | "worker";

export type HealthStatus = "ok" | "degraded";

export interface ServiceHealth {
  service: ServiceName;
  status: HealthStatus;
  timestamp: string;
}

export function createHealth(service: ServiceName, date: Date = new Date()): ServiceHealth {
  return { service, status: "ok", timestamp: date.toISOString() };
}

export { officialPriceReviewSource } from "./provider-pricing-provenance.js";
export type { ReviewSourceKind } from "./provider-pricing-provenance.js";

export { sealProviderPrompt, openProviderPrompt } from "./provider-encrypted-prompt.js";
export type { EncryptedProviderPrompt } from "./provider-encrypted-prompt.js";
