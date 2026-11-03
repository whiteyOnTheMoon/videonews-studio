/**
 * The existing production Redis ACL has two different least-privilege users:
 * the producer can enqueue and the consumer can read/finish jobs.
 * A one-shot observer must not invent a combined-privilege ACL.
 */
export const ONE_SHOT_FEED_PRODUCER_REDIS_SECRET =
  "/run/secrets/vns_feed_producer_redis_password" as const;

export interface OneShotFeedRedisAdmission {
  readonly producerUser: string;
  readonly consumerUser: string;
  readonly producerSecretPath: typeof ONE_SHOT_FEED_PRODUCER_REDIS_SECRET;
}

/**
 * Called after the base admission but before reading ANY secret or creating
 * Redis clients. No environment variable may choose a different secret file.
 */
export function readOneShotFeedRedisAdmission(
  env: NodeJS.ProcessEnv,
  consumerUser: string,
): OneShotFeedRedisAdmission {
  const producerUser = env.VNS_FEED_PRODUCER_REDIS_USER ?? "";
  if (
    env.VNS_FEED_OBSERVER_PRODUCER_REDIS_PASSWORD_FILE !==
      ONE_SHOT_FEED_PRODUCER_REDIS_SECRET ||
    !/^vns_feed_producer_[a-z0-9_]{3,24}$/.test(producerUser) ||
    !/^vns_feed_consumer_[a-z0-9_]{3,24}$/.test(consumerUser) ||
    producerUser === consumerUser
  ) {
    throw new Error("Feed observation Redis roles refused");
  }
  return Object.freeze({
    producerUser,
    consumerUser,
    producerSecretPath: ONE_SHOT_FEED_PRODUCER_REDIS_SECRET,
  });
}
