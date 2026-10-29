const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Client- and BFF-safe validation. Never treat a metadata candidate as approved. */
export function isRankedFeedCandidate(value: unknown): boolean {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !==
      "approvedForPublication,articleCount,eventId,headline,profileId,profileRevision,rankedAt,reasons,score,sourceCount"
  ) return false;
  const at = typeof value.rankedAt === "string" ? Date.parse(value.rankedAt) : NaN;
  return (
    typeof value.eventId === "string" && UUID.test(value.eventId) &&
    typeof value.profileId === "string" && /^[a-z][a-z0-9_-]{2,40}$/.test(value.profileId) &&
    Number.isSafeInteger(value.profileRevision) && (value.profileRevision as number) >= 0 &&
    typeof value.headline === "string" && value.headline.length >= 8 &&
    value.headline.length <= 200 &&
    Number.isSafeInteger(value.score) && (value.score as number) >= 0 &&
    (value.score as number) <= 1000 &&
    Number.isSafeInteger(value.articleCount) && (value.articleCount as number) >= 1 &&
    (value.articleCount as number) <= 100 &&
    Number.isSafeInteger(value.sourceCount) && (value.sourceCount as number) >= 1 &&
    (value.sourceCount as number) <= (value.articleCount as number) &&
    Array.isArray(value.reasons) && value.reasons.length >= 2 &&
    value.reasons.length <= 10 &&
    value.reasons.every((reason: unknown) => typeof reason === "string" && reason.length <= 100) &&
    value.reasons.includes("independent_verification_required") &&
    Number.isFinite(at) && new Date(at).toISOString() === value.rankedAt &&
    value.approvedForPublication === false
  );
}
