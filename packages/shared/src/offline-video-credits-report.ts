/**
 * P3-08 PARTIAL FOUNDATION: offline credits/provenance preview, NEVER approval.
 *
 * This code does not download assets or inspect real licenses. A recorded
 * download receipt is untrusted input and is checked only for consistency.
 * Render/upload gates must be separately implemented at real entrypoints.
 */
import { precheckAssetLicense } from "./asset-license-policy.js";
import type { AssetLicensePrecheck } from "./asset-license-policy.js";

export type AssetCreditsBlockReason =
  | "invalid_video_id"
  | "invalid_asset_list"
  | "no_assets"
  | "too_many_assets"
  | "invalid_asset_record"
  | "duplicate_asset_id"
  | "cross_video_asset_use"
  | "missing_or_mismatched_download_receipt"
  | "license_precheck_blocked"
  | "license_review_pending"
  | "named_rights_review_pending";

export interface OfflineAssetCreditEntry {
  assetId: string | null;
  proposedCredit: string | null;
  licenseCode: string | null;
  licenseUrl: string | null;
  originUrl: string | null;
  mediaSha256: string | null;
  termsSha256: string | null;
  downloadEvidence: "MISSING_OR_MISMATCHED" | "RECORDED_UNVERIFIED";
  licensePrecheck: AssetLicensePrecheck;
  reasons: readonly AssetCreditsBlockReason[];
}

export interface OfflineVideoCreditsReport {
  schema: "p3-08-offline-credits-preview-v1";
  videoId: string | null;
  status: "BLOCKED";
  renderAllowed: false;
  uploadAllowed: false;
  creditsVerified: false;
  entries: readonly OfflineAssetCreditEntry[];
  reasons: readonly AssetCreditsBlockReason[];
}

type ObjectValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_ASSETS = 25;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
}

function boundedCredit(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 1000 &&
    value === value.trim() &&
    !value.includes("<") &&
    !value.includes(">") &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  );
}

function validReceipt(asset: ObjectValue): boolean {
  const receipt = object(asset.downloadReceipt);
  const snapshot = object(asset.licenseSnapshot);
  if (!receipt || !snapshot) return false;
  if (
    typeof asset.contentSha256 !== "string" ||
    !DIGEST.test(asset.contentSha256) ||
    typeof snapshot.terms_sha256 !== "string" ||
    !DIGEST.test(snapshot.terms_sha256)
  ) {
    return false;
  }
  const downloadedAt = receipt.downloaded_at;
  return (
    receipt.media_sha256 === asset.contentSha256 &&
    receipt.terms_sha256 === snapshot.terms_sha256 &&
    receipt.origin_url === asset.originUrl &&
    typeof downloadedAt === "string" &&
    ISO.test(downloadedAt) &&
    Number.isFinite(Date.parse(downloadedAt))
  );
}

function reasonsUnique(
  values: readonly AssetCreditsBlockReason[],
): readonly AssetCreditsBlockReason[] {
  return Object.freeze([...new Set(values)]);
}

/**
 * Build a bounded candidate credit report for ONE video from untrusted
 * P3-01/P3-02-shaped metadata. Even an immaculate synthetic input remains
 * BLOCKED, because these inputs do not include authenticated human approval
 * and no actual render or upload gate is wired to this function.
 */
export function buildOfflineVideoCreditsReport(input: unknown): OfflineVideoCreditsReport {
  const request = object(input);
  const videoId =
    typeof request?.videoId === "string" && UUID.test(request.videoId)
      ? request.videoId
      : null;
  const assets = request?.assets;
  const reasons: AssetCreditsBlockReason[] = [];
  const entries: OfflineAssetCreditEntry[] = [];

  if (!videoId) reasons.push("invalid_video_id");
  if (!Array.isArray(assets)) reasons.push("invalid_asset_list");
  else if (assets.length === 0) reasons.push("no_assets");
  else if (assets.length > MAX_ASSETS) reasons.push("too_many_assets");

  if (videoId && Array.isArray(assets) && assets.length > 0 && assets.length <= MAX_ASSETS) {
    const seen = new Set<string>();
    for (const item of assets) {
      const asset = object(item);
      const assetId =
        typeof asset?.assetId === "string" && UUID.test(asset.assetId)
          ? asset.assetId
          : null;
      const precheck = precheckAssetLicense(asset);
      const entryReasons: AssetCreditsBlockReason[] = [];
      if (!assetId) entryReasons.push("invalid_asset_record");
      if (assetId && seen.has(assetId)) entryReasons.push("duplicate_asset_id");
      if (assetId) seen.add(assetId);
      if (!asset || asset.usedInVideoId !== videoId) {
        entryReasons.push("cross_video_asset_use");
      }
      const receiptValid = asset !== null && validReceipt(asset);
      if (!receiptValid) entryReasons.push("missing_or_mismatched_download_receipt");
      if (precheck.status === "BLOCKED") {
        entryReasons.push("license_precheck_blocked");
      } else if (precheck.status === "REVIEW_REQUIRED") {
        entryReasons.push("license_review_pending");
      }
      entryReasons.push("named_rights_review_pending");
      const proposedCredit =
        precheck.status !== "BLOCKED" && boundedCredit(asset?.attribution)
          ? asset.attribution
          : null;
      const candidateTermsHash = object(asset?.licenseSnapshot)?.terms_sha256;
      const termsSha256 =
        typeof candidateTermsHash === "string" && DIGEST.test(candidateTermsHash)
          ? candidateTermsHash
          : null;
      entries.push({
        assetId,
        proposedCredit,
        licenseCode: typeof asset?.licenseCode === "string" ? asset.licenseCode : null,
        licenseUrl: typeof asset?.licenseUrl === "string" ? asset.licenseUrl : null,
        originUrl: typeof asset?.originUrl === "string" ? asset.originUrl : null,
        mediaSha256:
          typeof asset?.contentSha256 === "string" && DIGEST.test(asset.contentSha256)
            ? asset.contentSha256
            : null,
        termsSha256,
        downloadEvidence: receiptValid ? "RECORDED_UNVERIFIED" : "MISSING_OR_MISMATCHED",
        licensePrecheck: precheck,
        reasons: reasonsUnique(entryReasons),
      });
      reasons.push(...entryReasons);
    }
  }

  return {
    schema: "p3-08-offline-credits-preview-v1",
    videoId,
    status: "BLOCKED",
    renderAllowed: false,
    uploadAllowed: false,
    creditsVerified: false,
    entries: Object.freeze(entries),
    reasons: reasonsUnique(reasons.length ? reasons : ["named_rights_review_pending"]),
  };
}
