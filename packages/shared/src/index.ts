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

export { precheckAssetLicense } from "./asset-license-policy.js";
export type {
  AssetLicensePrecheck,
  AssetLicensePrecheckStatus,
  AssetLicensePrecheckReason,
} from "./asset-license-policy.js";

export { buildOfflineVideoCreditsReport } from "./offline-video-credits-report.js";
export type {
  AssetCreditsBlockReason,
  OfflineAssetCreditEntry,
  OfflineVideoCreditsReport,
} from "./offline-video-credits-report.js";

export { makeOfflineGraphicStoryboard } from "./offline-storyboard-graphics.js";
export type {
  OfflineGraphicKind,
  OfflineGraphicFrame,
  OfflineGraphicStoryboard,
} from "./offline-storyboard-graphics.js";

export { readOfflinePexelsPage } from "./pexels-offline-discovery.js";
export type {
  PexelsMediaType,
  PexelsDiscoveryFailure,
  PexelsDiscoveryCandidate,
  PexelsDiscoveryResult,
} from "./pexels-offline-discovery.js";

export { inspectOfflineCommonsImageInfo } from "./commons-offline-imageinfo.js";
export type {
  CommonsLicenseCode,
  CommonsInspectionFailure,
  CommonsManualReviewReason,
  CommonsFileCandidate,
  CommonsInspectionResult,
} from "./commons-offline-imageinfo.js";

export {
  EARTH_CLIMATE_EXPLAINED_SECTION_IDS,
  assertEarthClimateExplainedStructure,
} from "./explained-script-structure.js";
export type {
  EarthClimateExplainedSectionId,
  EarthClimateExplainedSection,
  EarthClimateExplainedScript,
} from "./explained-script-structure.js";

export { buildNarrationTimeline } from "./narration-timeline.js";
export type {
  NarrationTimingInput,
  VisualBeatTiming,
  NarrationSectionTiming,
  NarrationTimeline,
} from "./narration-timeline.js";
