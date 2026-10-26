import type { Pool } from "pg";
import type { FeedItem, FeedPollLease, FeedPollStore, FeedValidators } from "./feed-poller.js";

const ID = /^[a-z][a-z0-9_-]{2,40}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/**
 * Only for a future *dedicated* vns_feed_poll_writer PostgreSQL connection.
 * The two SECURITY DEFINER functions own locking, database-clock admission,
 * metadata-only persistence, and stale-lease rejection. No live pool is wired.
 */
export class PostgresFeedPollStore implements FeedPollStore {
  constructor(private readonly pool: Pool) {}

  async claim(sourceId: string, now: Date, intervalMinutes: number): Promise<FeedPollLease | null> {
    if (
      !ID.test(sourceId) ||
      !(now instanceof Date) ||
      Number.isNaN(now.getTime()) ||
      !Number.isSafeInteger(intervalMinutes) ||
      intervalMinutes < 15 ||
      intervalMinutes > 10080
    ) {
      throw new Error("Feed polling claim rejected");
    }
    // Do NOT send the worker clock: PostgreSQL clock_timestamp() is authoritative.
    const result = await this.pool.query<{
      token: string;
      etag: string | null;
      last_modified: string | null;
    }>("SELECT token, etag, last_modified FROM vns.claim_feed_poll($1::text,$2::integer)", [
      sourceId,
      intervalMinutes,
    ]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      typeof row.token !== "string" ||
      !UUID.test(row.token)
    ) {
      throw new Error("Feed polling lease unavailable");
    }
    return { token: row.token, validators: { etag: row.etag, lastModified: row.last_modified } };
  }

  async commit(
    sourceId: string,
    token: string,
    items: readonly FeedItem[],
    validators: FeedValidators,
  ): Promise<number> {
    if (
      !ID.test(sourceId) ||
      !UUID.test(token) ||
      !Array.isArray(items) ||
      items.length > 20 ||
      items.some(
        (item) =>
          item.sourceId !== sourceId ||
          item.reviewStatus !== "candidate" ||
          typeof item.url !== "string" ||
          typeof item.headline !== "string" ||
          (item.publishedAt !== null && typeof item.publishedAt !== "string"),
      )
    ) {
      throw new Error("Feed polling commit rejected");
    }
    const payload = items.map(({ url, headline, publishedAt }) => ({
      url,
      headline,
      publishedAt,
    }));
    const result = await this.pool.query<{ created: number }>(
      "SELECT vns.commit_feed_poll($1::text,$2::uuid,$3::jsonb,$4::text,$5::text) AS created",
      [sourceId, token, JSON.stringify(payload), validators.etag, validators.lastModified],
    );
    const created = result.rows[0]?.created;
    if (
      result.rows.length !== 1 ||
      !Number.isSafeInteger(created) ||
      created < 0 ||
      created > items.length
    ) {
      throw new Error("Feed polling commit result invalid");
    }
    return created;
  }
}
