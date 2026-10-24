import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import EvidenceReview from "./evidence-review";

const JOB = "12345678-1234-4123-8123-123456789012";

test("evidence review is closed by default and has no automatic decision controls", () => {
  const html = renderToStaticMarkup(<EvidenceReview jobId={JOB} />);
  assert.match(html, /Quellen und Prüfstatus anzeigen/);
  assert.match(html, /Quellen-Nachweise/);
  assert.doesNotMatch(html, /Entscheidung unwiderruflich speichern/);
  assert.doesNotMatch(html, /type="submit"/);
  assert.doesNotMatch(html, /automatisch als bestätigt/);
});

test("disabled admin preview does not render evidence review controls", async () => {
  const { default: ResearchJobs } = await import("./research-jobs");
  const html = renderToStaticMarkup(<ResearchJobs enabled={false} />);
  assert.match(html, /Noch nicht freigeschaltet/);
  assert.doesNotMatch(html, /Quellen und Prüfstatus anzeigen/);
});
