import { createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { importSignedSourceHandoff } from "./source-export-files.js";
import { readApprovedFetchPolicy } from "./source-fetch.js";
import {
  FEED_SIGNED_SOURCE_INBOX,
  FEED_SOURCE_PUBLIC_KEY,
} from "./feed-runtime-admission.js";

export const SOURCE_HANDOFF_STAGING = "/var/lib/vns/source-handoff" as const;

/** No database, Redis, HTTPS, publisher private key or scheduling credentials. */
export function readSourceHandoffAdmission(env: NodeJS.ProcessEnv) {
  if (
    env.VNS_SOURCE_HANDOFF_ENABLED !== "true" ||
    env.VNS_SOURCE_HANDOFF_OPERATOR_ACK !== "true" ||
    env.VNS_SOURCE_HANDOFF_MODE !== "single_pass" ||
    env.VNS_SOURCE_HANDOFF_STAGING !== SOURCE_HANDOFF_STAGING ||
    env.VNS_FEED_SIGNED_SOURCE_INBOX !== FEED_SIGNED_SOURCE_INBOX ||
    env.VNS_FEED_SOURCE_PUBLIC_KEY_FILE !== FEED_SOURCE_PUBLIC_KEY
  ) {
    throw new Error("Signed source handoff not authorized");
  }
  return {
    staging: SOURCE_HANDOFF_STAGING,
    inbox: FEED_SIGNED_SOURCE_INBOX,
    keyFile: FEED_SOURCE_PUBLIC_KEY,
    policy: readApprovedFetchPolicy(env),
  };
}

function readPinnedPublicKey(path: string) {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size < 16 ||
      stat.size > 8192 ||
      (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" &&
        stat.uid !== 0 &&
        stat.uid !== process.getuid())
    ) {
      throw new Error("Pinned key permissions invalid");
    }
    const key = createPublicKey(readFileSync(fd, "utf8"));
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("Unsupported public key");
    }
    return key;
  } catch {
    throw new Error("Source handoff trust key unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Manual, fail-closed and offline. The live worker revalidates the anchor. */
export async function importApprovedSourceOnce(env: NodeJS.ProcessEnv = process.env) {
  const admission = readSourceHandoffAdmission(env);
  try {
    return await importSignedSourceHandoff(
      admission.staging,
      admission.inbox,
      admission.policy,
      readPinnedPublicKey(admission.keyFile),
    );
  } catch {
    throw new Error("Signed source handoff failed");
  }
}

if (process.argv[1]?.endsWith("/source-handoff-import-once.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--once") {
    console.error("Signed source handoff requires --once");
    process.exitCode = 2;
  } else {
    try {
      const result = await importApprovedSourceOnce();
      console.log(
        JSON.stringify({
          event: "signed_source_handoff_imported",
          sourceRevision: result.sourceRevision,
          hostApprovalRevision: result.hostApprovalRevision,
        }),
      );
    } catch {
      console.error("Signed source handoff refused or failed");
      process.exitCode = 1;
    }
  }
}
