import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchJobs from "./research-jobs";

test("dashboard is visibly disabled with no submit control until separate activation", () => {
  const html = renderToStaticMarkup(<ResearchJobs enabled={false} />);
  assert.match(html, /Noch nicht freigeschaltet/);
  assert.match(html, /gesonderten Datenbankfreigabe/);
  assert.doesNotMatch(html, /type="submit"/);
  assert.doesNotMatch(html, /Aktualisieren/);
});

test("enabled dashboard clearly labels database-only creation and limited listing", () => {
  const html = renderToStaticMarkup(<ResearchJobs enabled={true} />);
  assert.match(html, /Neuen Auftrag vormerken/);
  assert.match(html, /PostgreSQL-Vormerkungen/);
  assert.match(html, /keine Anzeige für eine laufende Recherche/);
  assert.match(html, /Letzte 20 Aufträge/);
  assert.match(html, /Noch keine Rechercheaufträge vorgemerkt|Lade Vormerkungen/);
  assert.doesNotMatch(html, /Recherche starten/);
});
