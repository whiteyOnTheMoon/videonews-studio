import { readFileSync } from "node:fs";

/**
 * Separate, fail-closed credentials for future research-only processes.
 * Never falls back to the existing live probe password or identity.
 */
export const RESEARCH_REDIS_USER = "vns_research" as const;
export const RESEARCH_REDIS_SECRET = "/run/secrets/redis_research_password" as const;

export interface ResearchRedisConfig {
  host: string;
  port: number;
  username: typeof RESEARCH_REDIS_USER;
  password: string;
}

export function readResearchRedisConfig(
  env: NodeJS.ProcessEnv = process.env,
  readSecret: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ResearchRedisConfig {
  if (
    env.VNS_RESEARCH_OPERATOR_APPROVED !== "true" ||
    env.VNS_REDIS_RESEARCH_PASSWORD_FILE !== RESEARCH_REDIS_SECRET
  ) {
    throw new Error("Dedicated research Redis identity not approved");
  }
  const host = env.VNS_REDIS_HOST ?? "redis";
  const port = Number(env.VNS_REDIS_PORT ?? "6379");
  if (!["redis", "127.0.0.1"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Research Redis address invalid");
  }
  let password: string;
  try {
    password = readSecret(RESEARCH_REDIS_SECRET).trimEnd();
  } catch {
    throw new Error("Dedicated research Redis secret unavailable");
  }
  if (password.length < 40 || !/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error("Dedicated research Redis secret invalid");
  }
  return { host, port, username: RESEARCH_REDIS_USER, password };
}
