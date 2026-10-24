import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import EditorLogin from "./editor-login";

test("personal login controls remain hidden when the editor feature is off", () => {
  const html = renderToStaticMarkup(<EditorLogin enabled={false} />);
  assert.match(html, /Persönliche Redakteur-Anmeldung/);
  assert.match(html, /Noch nicht freigeschaltet/);
  assert.doesNotMatch(html, /Persönliches Passwort/);
  assert.doesNotMatch(html, /Persönlich anmelden/);
});

test("enabled editor preview shows separate credential fields, never shared admin password", () => {
  const html = renderToStaticMarkup(<EditorLogin enabled={true} />);
  assert.match(html, /Redakteur-Benutzername/);
  assert.match(html, /Persönliches Passwort/);
  assert.match(html, /autocomplete="username"/i);
  assert.match(html, /type="password"/);
  assert.match(html, /persönlich anmelden/i);
});
