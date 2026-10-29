import { isRankedFeedCandidate } from "./editorial-ranked-events";
import {
  validRankingPolicyCommit,
  validRankingPolicySettings,
  validRankingPolicySnapshot,
} from "./editorial-ranking-policy";
import type { AdminProxyConfig } from "./admin-proxy";
import { clientEditorCookie, editorProfile, editorProxyConfig } from "./editor-proxy";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
type EditorialEndpoint =
  "profiles" | "timeline" | "checkpoints" | "ranked-events" | "ranking-policy";
const ENDPOINTS: Record<EditorialEndpoint, string> = {
  profiles: "/admin/editorial-profiles",
  timeline: "/admin/editorial-timeline",
  checkpoints: "/admin/editorial-checkpoints",
  "ranked-events": "/admin/editorial-ranked-events",
  "ranking-policy": "/admin/editorial-ranking-policy",
};

export function editorialAdminProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_EDITORIAL_ADMIN_ENABLED !== "true") return null;
  return editorProxyConfig(env);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reply(status: number, body: object): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
function numeric(value: string | null, minimum: number, maximum: number): boolean {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum;
}
function validQuery(path: EditorialEndpoint, url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== new Set(keys).size) return false;
  if (path === "profiles") return keys.length === 0;
  if (path === "ranking-policy") {
    const profileId = url.searchParams.get("profileId");
    return (
      keys.length === 1 &&
      keys[0] === "profileId" &&
      !!profileId &&
      /^[a-z][a-z0-9_-]{2,40}$/.test(profileId)
    );
  }
  if (path === "ranked-events")
    return (
      keys.length === 1 && keys[0] === "limit" && numeric(url.searchParams.get("limit"), 1, 50)
    );
  if (path === "checkpoints") {
    const eventId = url.searchParams.get("eventId");
    return (
      keys.length === 3 &&
      keys.every((key) => ["eventId", "after", "limit"].includes(key)) &&
      !!eventId &&
      UUID.test(eventId) &&
      numeric(url.searchParams.get("after"), 0, 10000) &&
      numeric(url.searchParams.get("limit"), 1, 100)
    );
  }
  const storyId = url.searchParams.get("storyId");
  const afterTime = url.searchParams.get("afterTime");
  const afterId = url.searchParams.get("afterId");
  return (
    !!storyId &&
    UUID.test(storyId) &&
    numeric(url.searchParams.get("limit"), 1, 100) &&
    keys.every((key) => ["storyId", "limit", "afterTime", "afterId"].includes(key)) &&
    (afterTime === null) === (afterId === null) &&
    (afterId === null || UUID.test(afterId)) &&
    (afterTime === null ||
      (Number.isFinite(Date.parse(afterTime)) && new Date(afterTime).toISOString() === afterTime))
  );
}
async function readBody(request: Request, endpoint: EditorialEndpoint): Promise<string | null> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    request.headers.has("content-encoding")
  )
    return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) return null;
      chunks.push(value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(output);
    output.fill(0);
    const input: unknown = JSON.parse(raw);
    if (!object(input)) return null;
    if (endpoint === "timeline") {
      if (
        Object.keys(input).sort().join(",") !==
          "details,documentSha256,eventKind,referenceUri,storyId" ||
        typeof input.storyId !== "string" ||
        !UUID.test(input.storyId) ||
        !["source", "claim", "claim_rejected", "review", "script_revision", "decision"].includes(
          input.eventKind as string,
        ) ||
        (input.referenceUri !== null &&
          (typeof input.referenceUri !== "string" ||
            input.referenceUri.length > 2048 ||
            !/^https:\/\/[a-z0-9.-]+(?::443)?\/[a-zA-Z0-9/._~-]*$/.test(input.referenceUri))) ||
        (input.documentSha256 !== null &&
          (typeof input.documentSha256 !== "string" ||
            !/^[0-9a-f]{64}$/.test(input.documentSha256))) ||
        !object(input.details) ||
        Object.keys(input.details).sort().join(",") !== "reasonCodes,summary" ||
        typeof input.details.summary !== "string" ||
        input.details.summary.length < 8 ||
        input.details.summary.length > 2000 ||
        [...input.details.summary].some((char: string) => char.charCodeAt(0) < 32) ||
        !Array.isArray(input.details.reasonCodes) ||
        input.details.reasonCodes.length < 1 ||
        input.details.reasonCodes.length > 20 ||
        input.details.reasonCodes.some(
          (code: unknown) => typeof code !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(code),
        )
      )
        return null;
    } else if (endpoint === "ranking-policy") {
      if (
        Object.keys(input).sort().join(",") !== "expectedRevision,profileId,settings" ||
        typeof input.profileId !== "string" ||
        !/^[a-z][a-z0-9_-]{2,40}$/.test(input.profileId) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        (input.expectedRevision as number) < 0 ||
        !validRankingPolicySettings(input.settings)
      )
        return null;
    } else if (endpoint === "checkpoints") {
      if (
        Object.keys(input).sort().join(",") !==
          "artifactSha256,eventId,expectedRevision,outcome,reasonCodes,score,stage" ||
        typeof input.eventId !== "string" ||
        !UUID.test(input.eventId) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        (input.expectedRevision as number) < 0 ||
        (input.expectedRevision as number) > 9999 ||
        !["ranking", "claim_review", "freshness", "script_revision", "quality"].includes(
          input.stage as string,
        ) ||
        !["candidate", "blocked", "needs_review"].includes(input.outcome as string) ||
        typeof input.artifactSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(input.artifactSha256) ||
        !Array.isArray(input.reasonCodes) ||
        input.reasonCodes.length < 1 ||
        input.reasonCodes.length > 20 ||
        input.reasonCodes.some(
          (code: unknown) => typeof code !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(code),
        ) ||
        (input.score !== null &&
          (!Number.isSafeInteger(input.score) ||
            (input.score as number) < 0 ||
            (input.score as number) > 1000))
      )
        return null;
    } else if (
      Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, "expectedRevision") ||
      !Object.hasOwn(input, "profiles") ||
      !Number.isSafeInteger(input.expectedRevision) ||
      (input.expectedRevision as number) < 0 ||
      !Array.isArray(input.profiles) ||
      input.profiles.length > 20
    )
      return null;
    return JSON.stringify(input);
  } catch {
    return null;
  } finally {
    chunks.forEach((part) => part.fill(0));
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Fixed-route, same-origin BFF; no browser-supplied backend URL or actor identity.
 * Both API auth and individual PostgreSQL session login are rechecked upstream.
 */
export async function dormantEditorialAdminProxy(
  request: Request,
  endpoint: EditorialEndpoint,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (!(endpoint in ENDPOINTS)) return reply(404, { error: "not_found" });
  if (
    request.method !== "GET" &&
    !(
      ["profiles", "ranking-policy", "checkpoints", "timeline"].includes(endpoint) &&
      request.method === "POST"
    )
  ) {
    return reply(405, { error: "method_not_allowed" });
  }
  if (request.method === "POST" && request.headers.get("origin") !== config.origin) {
    return reply(403, { error: "forbidden" });
  }
  const url = new URL(request.url);
  if (
    request.method === "POST" && endpoint !== "profiles"
      ? url.search !== ""
      : !validQuery(endpoint, url)
  )
    return reply(400, { error: "invalid_request" });
  const cookie = clientEditorCookie(request.headers.get("cookie"));
  if (!cookie) return reply(401, { error: "unauthorized" });
  const profile = await editorProfile(request, config, fetcher);
  if (profile.status === 401) return reply(401, { error: "unauthorized" });
  if (profile.status !== 200) return reply(503, { error: "temporarily_unavailable" });
  const actor: unknown = await profile.json();
  if (!object(actor) || actor.role !== "admin") return reply(403, { error: "forbidden" });
  const body = request.method === "POST" ? await readBody(request, endpoint) : undefined;
  if (request.method === "POST" && !body) return reply(400, { error: "invalid_request" });
  try {
    const upstream = await fetcher(config.api + ENDPOINTS[endpoint] + url.search, {
      method: request.method,
      headers: {
        Cookie: cookie,
        ...(body ? { Origin: config.origin, "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if ([400, 401, 403, 409, 429].includes(upstream.status)) {
      return reply(upstream.status, { error: "request_refused" });
    }
    if (upstream.status !== 200) return reply(503, { error: "temporarily_unavailable" });
    const raw = await upstream.text();
    if (raw.length > 1048576) return reply(503, { error: "temporarily_unavailable" });
    const value: unknown = JSON.parse(raw);
    if (!object(value)) return reply(503, { error: "temporarily_unavailable" });
    if (endpoint === "ranking-policy") {
      if (request.method === "GET") {
        if (!validRankingPolicySnapshot(value)) {
          return reply(503, { error: "temporarily_unavailable" });
        }
        return reply(200, value);
      }
      if (!validRankingPolicyCommit(value)) return reply(503, { error: "temporarily_unavailable" });
      return reply(200, value);
    }
    if (endpoint === "ranked-events") {
      if (
        Object.keys(value).sort().join(",") !== "candidates,metadataOnly" ||
        value.metadataOnly !== true ||
        !Array.isArray(value.candidates) ||
        value.candidates.length > 50 ||
        !value.candidates.every(isRankedFeedCandidate)
      )
        return reply(503, { error: "temporarily_unavailable" });
      return reply(200, { candidates: value.candidates, metadataOnly: true });
    }
    if (endpoint === "profiles" && request.method === "GET") {
      if (
        !Number.isSafeInteger(value.revision) ||
        !Array.isArray(value.profiles) ||
        value.profiles.length > 20
      )
        return reply(503, { error: "temporarily_unavailable" });
      return reply(200, { revision: value.revision, profiles: value.profiles });
    }
    if (endpoint === "profiles") {
      if (
        value.saved !== true ||
        value.productionActive !== false ||
        !Number.isSafeInteger(value.revision)
      ) {
        return reply(503, { error: "temporarily_unavailable" });
      }
      return reply(200, {
        saved: true,
        revision: value.revision,
        productionActive: false,
      });
    }
    if (endpoint === "timeline" && request.method === "POST") {
      if (
        typeof value.eventId !== "string" ||
        !UUID.test(value.eventId) ||
        value.approvedForPublication !== false
      ) {
        return reply(503, { error: "temporarily_unavailable" });
      }
      return reply(200, {
        eventId: value.eventId,
        approvedForPublication: false,
      });
    }
    if (endpoint === "checkpoints" && request.method === "POST") {
      if (
        value.saved !== true ||
        value.approvedForPublication !== false ||
        !Number.isSafeInteger(value.revision)
      ) {
        return reply(503, { error: "temporarily_unavailable" });
      }
      return reply(200, {
        saved: true,
        revision: value.revision,
        approvedForPublication: false,
      });
    }
    if (!Array.isArray(value.events) || value.events.length > 100) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    if (endpoint === "timeline") return reply(200, { events: value.events, cursor: value.cursor });
    return reply(200, { events: value.events, nextRevision: value.nextRevision });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
