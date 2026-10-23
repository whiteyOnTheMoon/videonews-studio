import assert from "node:assert/strict";
import test from "node:test";
import { isPlausiblePublicSourceUrl, makeSourceCandidate } from "./source-policy.js";

const candidate = {
  sourceUrl: "https://www.example.org/reports/mobility",
  publisher: "Example Transport Institute",
  headline: "Annual sustainable mobility report",
  claim: "The document summarizes proposed regional projects.",
};

test("candidate registration never auto-verifies claims", () => {
  assert.deepEqual(makeSourceCandidate(candidate), {
    ...candidate,
    reviewStatus: "candidate",
  });
  assert.throws(
    () =>
      makeSourceCandidate({
        ...candidate,
        reviewStatus: "verified",
      }),
    /Invalid source candidate/,
  );
  assert.throws(
    () =>
      makeSourceCandidate({
        ...candidate,
        claim: "unverified",
      }),
    /Invalid source candidate/,
  );
});

test("lexical URL checks reject insecure and local-looking addresses", () => {
  assert.equal(isPlausiblePublicSourceUrl(candidate.sourceUrl), true);
  for (const sourceUrl of [
    "http://www.example.org/news",
    "https://127.0.0.1/secret",
    "https://[::1]/secret",
    "https://localhost/private",
    "https://backend.internal/report",
    "https://user:password@www.example.org/news",
    "https://www.example.org:8443/hidden",
    "https://www.example.org/article#fragment",
    "file:///etc/passwd",
    "https://www.example.org/" + "a".repeat(600),
    "not-a-url",
  ]) {
    assert.equal(isPlausiblePublicSourceUrl(sourceUrl), false, sourceUrl);
    assert.throws(() => makeSourceCandidate({ ...candidate, sourceUrl }));
  }
});

test("headline, source and claim fields are bounded and reject extra keys", () => {
  assert.throws(() =>
    makeSourceCandidate({
      ...candidate,
      claim: "A source excerpt\nwith an injected newline",
    }),
  );
  assert.throws(() =>
    makeSourceCandidate({
      ...candidate,
      unexpected: "<script>alert(1)</script>",
    }),
  );
  assert.throws(() => makeSourceCandidate({ ...candidate, headline: "short" }));
});
