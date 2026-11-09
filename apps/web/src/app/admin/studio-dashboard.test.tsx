import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import StudioDashboard from "./studio-dashboard";

test("owner studio has two primary actions and a three-tab information architecture", () => {
  const rendered = renderToStaticMarkup(
    <StudioDashboard
      newsEnabled={false}
      previewEnabled={false}
      renderEnabled={false}
      settings={<p>Advanced controls</p>}
    />,
  );
  assert.match(rendered, />News recherchieren</);
  assert.match(rendered, />Video erstellen</);
  assert.match(rendered, />Erstellen</);
  assert.match(rendered, />Videos</);
  assert.match(rendered, />Einstellungen</);
  assert.match(rendered, /role="tablist"/);
  assert.match(rendered, /aria-selected="true"/);
  assert.match(rendered, /VPS-Videostart ist noch nicht aktiv/);
  assert.doesNotMatch(rendered, /Advanced controls/);
  assert.doesNotMatch(rendered, /MP4 herunterladen/);
});

test("source candidates cannot start rendering when video render gate is disabled", () => {
  const rendered = renderToStaticMarkup(
    <StudioDashboard
      newsEnabled
      previewEnabled
      renderEnabled={false}
      settings={<p>Admin tools</p>}
    />,
  );
  assert.match(rendered, /Video erstellen<\/button>/);
  assert.match(rendered, /disabled=""/);
  assert.match(rendered, /noch keine neue Live-Recherche/);
  assert.doesNotMatch(rendered, /YouTube veröffentlichen|Upload starten/);
});
