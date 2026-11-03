import assert from "node:assert/strict";
import test from "node:test";
import type { FeedRuntimeAdmission } from "./feed-runtime-admission.js";
import { feedAnchorPoolConfig } from "./feed-anchor-pool-config.js";

const local: Pick<
  FeedRuntimeAdmission,
  "anchorPlacement" | "anchorDatabase" | "anchorHost" | "anchorUser" | "anchorCaPath"
> = {
  anchorPlacement: "same_vps",
  anchorDatabase: "videonews",
  anchorHost: "postgres",
  anchorUser: "vns_anchor_login_prod",
  anchorCaPath: "/run/secrets/vns_feed_source_anchor_ca",
};

const password = "a".repeat(64);

test("one-shot and persistent workers use the same single-VPS SCRAM SQL boundary", () => {
  let caReads = 0;
  const readCa = () => {
    caReads++;
    throw new Error("Unused local TLS CA must never be accessed");
  };
  for (const application of ["vns_source_anchor_observation", "vns_feed_anchor_guard"] as const) {
    assert.deepEqual(feedAnchorPoolConfig(local, password, readCa, application), {
      host: "postgres",
      port: 5432,
      database: "videonews",
      user: "vns_anchor_login_prod",
      password,
      ssl: false,
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      application_name: application,
    });
  }
  assert.equal(caReads, 0);
});

test("external anchor retains pinned TLS identity and reads the CA exactly once", () => {
  const reads: string[] = [];
  const external = {
    ...local,
    anchorPlacement: "separate_tls" as const,
    anchorDatabase: "vns_source_anchor" as const,
    anchorHost: "anchor.example.org",
  };
  const config = feedAnchorPoolConfig(
    external,
    password,
    (path) => {
      reads.push(path);
      return "synthetic PEM certificate";
    },
    "vns_source_anchor_observation",
  );
  assert.deepEqual(config.ssl, {
    ca: "synthetic PEM certificate",
    rejectUnauthorized: true,
    servername: "anchor.example.org",
  });
  assert.equal(config.database, "vns_source_anchor");
  assert.deepEqual(reads, [local.anchorCaPath]);
});

test("placement, host, database and credentials must not silently downgrade security", () => {
  for (const override of [
    { anchorHost: "anchor.example.org" },
    { anchorHost: "127.0.0.1" },
    { anchorDatabase: "vns_source_anchor" },
    { anchorPlacement: "unknown" },
    { anchorPlacement: "" },
    { anchorUser: "vns" },
  ]) {
    assert.throws(
      () =>
        feedAnchorPoolConfig(
          { ...local, ...override } as typeof local,
          password,
          () => "UNEXPECTED",
          "vns_feed_anchor_guard",
        ),
      /refused/,
    );
  }
  for (const badHost of ["postgres", "127.0.0.1", "anchor.local", "anchor.internal"]) {
    assert.throws(
      () =>
        feedAnchorPoolConfig(
          {
            ...local,
            anchorPlacement: "separate_tls",
            anchorDatabase: "vns_source_anchor",
            anchorHost: badHost,
          },
          password,
          () => "UNEXPECTED",
          "vns_feed_anchor_guard",
        ),
      /refused/,
    );
  }
  assert.throws(
    () => feedAnchorPoolConfig(local, "short", () => "unused", "vns_feed_anchor_guard"),
    /refused/,
  );
});

test("external TLS trust-file failure propagates; it never retries as local plaintext", () => {
  assert.throws(
    () =>
      feedAnchorPoolConfig(
        {
          ...local,
          anchorPlacement: "separate_tls",
          anchorDatabase: "vns_source_anchor",
          anchorHost: "anchor.example.org",
        },
        password,
        () => {
          throw new Error("Synthetic CA unavailable");
        },
        "vns_feed_anchor_guard",
      ),
    /Synthetic CA unavailable/,
  );
});
