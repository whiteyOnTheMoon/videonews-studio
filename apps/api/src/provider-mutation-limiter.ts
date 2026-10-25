/**
 * Offline, bounded, process-local mutation limiter for the dormant admin
 * provider contract. This is NOT a distributed production rate limiter.
 * All writers share one bucket: untrusted headers never select a bucket.
 */
export class ProviderMutationLimiter {
  private startedAt: number | null = null;
  private attempts = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limit = 5,
    private readonly windowMs = 60_000,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid provider mutation rate limit");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) {
      throw new Error("Invalid provider mutation rate window");
    }
  }

  /** Every authenticated mutation attempt consumes capacity before parsing. */
  allow(): boolean {
    const instant = this.now();
    if (!Number.isSafeInteger(instant) || instant < 0) return false;
    if (this.startedAt === null) {
      this.startedAt = instant;
      this.attempts = 0;
    }
    // Clock rollback fails closed until the clock catches up.
    if (instant < this.startedAt) return false;
    if (instant - this.startedAt >= this.windowMs) {
      this.startedAt = instant;
      this.attempts = 0;
    }
    if (this.attempts >= this.limit) return false;
    this.attempts++;
    return true;
  }
}
