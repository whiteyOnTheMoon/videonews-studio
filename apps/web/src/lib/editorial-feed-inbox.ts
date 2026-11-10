/** Unranked, metadata-only personal Admin feed intake. */
export interface FeedInboxItem {
  sourceId: string;
  articleUrl: string;
  headline: string;
  publishedAt: string;
  projected: boolean;
  eventId: string | null;
  approvedForPublication: false;
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SOURCE = /^[a-z][a-z0-9_-]{2,40}$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validFeedArticleUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 2048 ||
    value.includes("%") ||
    /[\s?#]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^(?:[a-z0-9-]+\\.)+[a-z]{2,}$/.test(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

export function parseFeedInboxPage(value: unknown, limit = 25): readonly FeedInboxItem[] | null {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "items,metadataOnly,rankingApplied" ||
    value.metadataOnly !== true ||
    value.rankingApplied !== false ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 25 ||
    !Array.isArray(value.items) ||
    value.items.length > limit
  )
    return null;
  for (const row of value.items) {
    if (
      !object(row) ||
      Object.keys(row).sort().join(",") !==
        "approvedForPublication,articleUrl,eventId,headline,projected,publishedAt,sourceId" ||
      typeof row.sourceId !== "string" ||
      !SOURCE.test(row.sourceId) ||
      !validFeedArticleUrl(row.articleUrl) ||
      typeof row.headline !== "string" ||
      row.headline.length < 8 ||
      row.headline.length > 500 ||
      [...row.headline].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127 || character === "<" || character === ">";
      }) ||
      typeof row.publishedAt !== "string" ||
      !Number.isFinite(Date.parse(row.publishedAt)) ||
      new Date(row.publishedAt).toISOString() !== row.publishedAt ||
      typeof row.projected !== "boolean" ||
      (row.eventId !== null && (typeof row.eventId !== "string" || !UUID.test(row.eventId))) ||
      row.projected !== (row.eventId !== null) ||
      row.approvedForPublication !== false
    )
      return null;
  }
  return value.items as FeedInboxItem[];
}
