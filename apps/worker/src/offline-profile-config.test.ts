import assert from "node:assert/strict";
import test from "node:test";
import {
  parseOfflineEditorialProfiles,
  selectOfflineEditorialProfile,
} from "./offline-profile-config.js";

const one = {
  id: "science",
  language: "de-DE",
  keywords: ["science"],
  blockedTerms: ["sponsored"],
  minIndependentSources: 2,
  maximumArticleAgeHours: 24,
  format: "briefing",
};
const two = {
  ...one,
  id: "world_news",
  language: "en-US",
  format: "explainer",
};

test("niche, language and format switch solely through configuration", () => {
  const profiles = parseOfflineEditorialProfiles(
    JSON.stringify({
      version: 1,
      profiles: [one, two],
    }),
  );
  assert.equal(selectOfflineEditorialProfile(profiles, "science").language, "de-DE");
  assert.equal(selectOfflineEditorialProfile(profiles, "world_news").format, "explainer");
  assert.equal(Object.isFrozen(profiles), true);
  assert.equal(Object.isFrozen(profiles[0]?.keywords), true);
});

test("duplicate profiles, unknown fields and oversized payloads fail closed", () => {
  for (const profiles of [[one, one], [{ ...one, extra: "untrusted" }], []]) {
    assert.throws(() =>
      parseOfflineEditorialProfiles(
        JSON.stringify({
          version: 1,
          profiles,
        }),
      ),
    );
  }
  assert.throws(() => parseOfflineEditorialProfiles("x".repeat(32769)));
  assert.throws(() => parseOfflineEditorialProfiles('{"version":1,"profiles":[]}'));
  assert.throws(() => selectOfflineEditorialProfile([one as never], "unknown"));
});
