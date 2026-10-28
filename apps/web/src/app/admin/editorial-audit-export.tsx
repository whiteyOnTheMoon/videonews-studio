"use client";

import { useState, type FormEvent } from "react";
import { verifyCheckpointPage, verifyTimelinePage } from "../../lib/editorial-export-continuity";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
type Ledger = "checkpoints" | "timeline";
interface Batch {
  events: Record<string, unknown>[];
  cursor?: { afterTime: string; afterId: string } | null;
  nextRevision?: number;
}
export function validEditorialExportBatch(value: unknown, kind: Ledger): value is Batch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body.events) ||
    body.events.length > 100 ||
    !body.events.every((row) => !!row && typeof row === "object" && !Array.isArray(row))
  ) return false;
  if (kind === "checkpoints") {
    return (
      Object.keys(body).sort().join(",") === "events,nextRevision" &&
      Number.isSafeInteger(body.nextRevision) &&
      (body.nextRevision as number) >= 0 &&
      (body.nextRevision as number) <= 10000
    );
  }
  if (kind !== "timeline" || Object.keys(body).sort().join(",") !== "cursor,events")
    return false;
  if (body.cursor === null) return true;
  if (!body.cursor || typeof body.cursor !== "object" || Array.isArray(body.cursor))
    return false;
  const cursor = body.cursor as Record<string, unknown>;
  if (
    Object.keys(cursor).sort().join(",") !== "afterId,afterTime" ||
    typeof cursor.afterId !== "string" ||
    !UUID.test(cursor.afterId) ||
    typeof cursor.afterTime !== "string"
  ) return false;
  const time = Date.parse(cursor.afterTime);
  return Number.isFinite(time) && new Date(time).toISOString() === cursor.afterTime;
}

/** End-of-export must acknowledge the exact previously consumed position. */
export function validEditorialExportTerminator(
  kind: Ledger,
  batch: Batch,
  expectedRevision: number,
): boolean {
  return kind === "checkpoints"
    ? batch.events.length === 0 && batch.nextRevision === expectedRevision
    : kind === "timeline" && batch.events.length === 0 && batch.cursor === null;
}

/** Pagination stops on complete empty page or refuses to create a truncated export. */
export default function EditorialAuditExport({ enabled }: { enabled: boolean }) {
  const [kind, setKind] = useState<Ledger>("checkpoints");
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function exportLedger(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !enabled || !UUID.test(id)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const collected: Record<string, unknown>[] = [];
      let nextRevision = 0;
      let lastChain: string | null = null;
      let cursor: { afterTime: string; afterId: string } | null = null;
      let completed = false;
      for (let page = 0; page < 101; page++) {
        const params = new URLSearchParams({ limit: "100" });
        if (kind === "checkpoints") {
          params.set("eventId", id);
          params.set("after", String(nextRevision));
        } else {
          params.set("storyId", id);
          if (cursor) {
            params.set("afterTime", cursor.afterTime);
            params.set("afterId", cursor.afterId);
          }
        }
        const response = await fetch("/api/admin/editorial-" + kind + "?" + params.toString(), {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        });
        if (response.status !== 200) throw new Error("Editorial audit export unavailable");
        const raw: unknown = await response.json();
        if (!validEditorialExportBatch(raw, kind)) throw new Error("Audit page format invalid");
        const rows = raw.events;
        collected.push(...rows);
        if (rows.length === 0) {
          // Even an empty terminator must acknowledge exactly the expected
          // final position. Otherwise refuse the allegedly complete file.
          if (!validEditorialExportTerminator(kind, raw, nextRevision)) {
            throw new Error("Audit export terminator mismatch");
          }
          completed = true;
          break;
        }
        if (collected.length > 10000) throw new Error("Audit export safety limit exceeded");
        if (kind === "checkpoints") {
          const result = verifyCheckpointPage(
            rows,
            { revision: nextRevision, chain: lastChain },
            raw.nextRevision,
          );
          if (!result) throw new Error("Checkpoint page continuity invalid");
          nextRevision = result.revision;
          lastChain = result.chain;
        } else {
          const result = verifyTimelinePage(rows, cursor, raw.cursor);
          if (!result) throw new Error("Timeline page continuity invalid");
          cursor = result;
        }
      }
      if (!completed) throw new Error("Incomplete ledger export");
      const data = JSON.stringify(
        {
          version: 1,
          kind,
          scopeId: id,
          evidenceOnly: true,
          exportCompleteness: "all_pages_read",
          events: collected,
        },
        null,
        2,
      );
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = "vns-" + kind + "-" + id + ".json";
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      setNotice("Prüfhistorie vollständig seitenweise ausgelesen. Keine Freigabe erteilt.");
    } catch {
      setError("Export nicht bestätigt oder unvollständig. Kein Teilbericht ausgegeben.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="jobs-section" aria-labelledby="editorial-audit-heading">
      <h2 id="editorial-audit-heading">Redaktionelles Produktionsprotokoll</h2>
      <p>Geschützter JSON-Export der verfügbaren Prüfhistorie. Nur persönliche Admin-Sitzungen.</p>
      {!enabled ? (
        <p role="status">Produktionsprotokoll-Export noch nicht freigeschaltet.</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {enabled ? (
        <form onSubmit={(event) => void exportLedger(event)}>
          <label htmlFor="editorial-audit-kind">Protokolltyp</label>
          <select
            id="editorial-audit-kind"
            value={kind}
            disabled={busy}
            onChange={(event) => setKind(event.target.value as Ledger)}
          >
            <option value="checkpoints">Ranking, Claims, Skript und Qualität</option>
            <option value="timeline">Redaktionelle Ereignishistorie</option>
          </select>
          <label htmlFor="editorial-audit-id">
            {kind === "checkpoints" ? "Ereignis-UUID" : "Story-UUID"}
          </label>
          <input
            id="editorial-audit-id"
            value={id}
            required
            disabled={busy}
            pattern="[0-9a-f-]{36}"
            maxLength={36}
            onChange={(event) => setId(event.target.value)}
          />
          <button type="submit" disabled={busy || !UUID.test(id)}>
            {busy ? "Protokoll wird geprüft …" : "Vollständigen JSON-Export erstellen"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
