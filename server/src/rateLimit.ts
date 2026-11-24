/** Counts failed attempts for each key in a fixed time window. State is in memory, so a
 *  restart clears it. */
export class RateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(maxFailures: number, windowMs: number, now: () => number = Date.now) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Seconds until `key` can try again, or 0 when it is not blocked. */
  retryAfter(key: string): number {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= this.now()) return 0;
    return entry.count >= this.maxFailures ? Math.ceil((entry.resetAt - this.now()) / 1000) : 0;
  }

  fail(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.entries.size >= 10_000) this.prune(now);
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }

  /** Takes back one `fail`. Callers count an attempt before a slow check, so parallel
   *  requests cannot pass the limit, and call this when the attempt succeeds. */
  undo(key: string): void {
    const entry = this.entries.get(key);
    if (entry && --entry.count <= 0) this.entries.delete(key);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}
