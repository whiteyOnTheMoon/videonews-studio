import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ENABLED = process.getuid?.() === 0 && process.env.CI === "true";
const MODULE = new URL("../apps/worker/dist/feed-runtime-protected-files.js", import.meta.url).href;
const PASSWORD = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vns-protected-feed-files-"));
  chmodSync(root, 0o755); // CI-only traversal; each sensitive file remains private.
  const secret = join(root, "feed-db-password");
  const pinned = join(root, "pinned-signing-public-key");
  writeFileSync(secret, PASSWORD + "\n", { mode: 0o400 });
  chownSync(secret, 10002, 0); // GID is irrelevant for a strict owner-only 0400 file.
  chmodSync(secret, 0o400);
  writeFileSync(pinned, "-----BEGIN PUBLIC KEY-----\nCI-ONLY\n-----END PUBLIC KEY-----\n", {
    mode: 0o440,
  });
  chownSync(pinned, 0, 10002);
  chmodSync(pinned, 0o440);
  return { root, secret, pinned };
}

/**
 * Import the module before dropping rights only because the disposable
 * GitHub checkout may be root-only. All filesystem reads under test occur
 * after the kernel has verified UID/GID 10002.
 */
function probe(path, kind, expected, drop = true) {
  const source = `
    import assert from "node:assert/strict";
    const file = await import(process.argv[1]);
    const [kind, path, expected, drop] = process.argv.slice(2);
    if (drop === "true") {
      process.setgroups([]);
      process.setgid(10002);
      process.setuid(10002);
      assert.equal(process.getuid(), 10002);
      assert.equal(process.getgid(), 10002);
    }
    let result;
    try {
      result = kind === "secret" ?
        file.readFeedSecretFile(path) : file.readPinnedFeedTrustFile(path);
      assert.equal(expected, "allow");
      if (kind === "secret") assert.equal(result, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij");
      if (kind === "pinned") assert.ok(result.startsWith("-----BEGIN PUBLIC KEY-----"));
    } catch (error) {
      assert.equal(expected, "deny");
      assert.match(error.message, kind === "secret" ?
        /^Feed runtime secret unavailable$/ : /^Pinned feed trust material unavailable$/);
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, MODULE, kind, path, expected, String(drop)],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, "UID file-custody probe refused: " + result.stderr.slice(0, 900));
  assert.equal(result.stdout, "");
}

test("real worker UID accepts only 0400-owned secret and root:worker-group 0440 trust", {
  skip: !ENABLED,
}, () => {
  const f = fixture();
  try {
    probe(f.secret, "secret", "allow");
    probe(f.pinned, "pinned", "allow");
    probe(f.secret, "secret", "deny", false);
    probe(f.pinned, "pinned", "deny", false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a symlink, hardlink, wrong UID or overbroad secret mode fails closed", {
  skip: !ENABLED,
}, () => {
  const f = fixture();
  try {
    const link = join(f.root, "secret-link");
    symlinkSync(f.secret, link);
    probe(link, "secret", "deny");
    const hard = join(f.root, "secret-hardlink");
    linkSync(f.secret, hard);
    probe(f.secret, "secret", "deny");
    rmSync(hard);
    chmodSync(f.secret, 0o440);
    probe(f.secret, "secret", "deny");
    chmodSync(f.secret, 0o400);
    chownSync(f.secret, 0, 0);
    probe(f.secret, "secret", "deny");
    chownSync(f.secret, 10002, 0);
    probe(f.secret, "secret", "allow");
    const ancestor = join(f.root, "ancestor");
    symlinkSync(f.root, ancestor);
    probe(join(ancestor, "feed-db-password"), "secret", "deny");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("pinned TLS CA/public key requires root UID and exact group/mode", {
  skip: !ENABLED,
}, () => {
  const f = fixture();
  try {
    chmodSync(f.pinned, 0o444);
    probe(f.pinned, "pinned", "deny");
    chmodSync(f.pinned, 0o440);
    chownSync(f.pinned, 10002, 10002);
    probe(f.pinned, "pinned", "deny");
    chownSync(f.pinned, 0, 0);
    probe(f.pinned, "pinned", "deny");
    chownSync(f.pinned, 0, 10002);
    probe(f.pinned, "pinned", "allow");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("too-short and malformed credentials fail before a network connection", {
  skip: !ENABLED,
}, () => {
  const f = fixture();
  try {
    for (const content of ["x".repeat(39), "x".repeat(257), "x".repeat(40) + " !"]) {
      writeFileSync(f.secret, content);
      chownSync(f.secret, 10002, 0);
      chmodSync(f.secret, 0o400);
      probe(f.secret, "secret", "deny");
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
