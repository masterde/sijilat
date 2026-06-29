// Minimal adaptive rate limiter: spaces requests to a target rate and backs off
// additively-increase / multiplicative-decrease style on 429s. Keeps bulk
// pagination polite against the government registry. Mirrors the Go CLI's
// cliutil.AdaptiveLimiter intent.

export class RateLimiter {
  private nextAt = 0;
  private readonly interval: number;
  private backoff = 0;

  constructor(perSecond = 6) {
    this.interval = 1000 / Math.max(0.1, perSecond);
  }

  /** Wait until the next request is allowed. */
  async acquire(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextAt - now) + this.backoff;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.nextAt = Date.now() + this.interval;
  }

  onSuccess(): void {
    this.backoff = Math.max(0, this.backoff - 250);
  }

  onRateLimit(): void {
    this.backoff = Math.min(8000, this.backoff * 2 + 500);
  }
}
