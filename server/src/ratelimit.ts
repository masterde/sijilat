// Upstream traffic guard for the government registry. Three layers:
//  - spacing: at most `perSecond` request starts per second (slots are reserved
//    synchronously, so concurrent callers can't burst past it);
//  - budget: at most `perMinute` calls in any rolling minute. Callers wait for
//    room up to `maxWaitMs`, then get UpstreamBudgetError instead of queueing
//    for a minute inside a serverless function;
//  - circuit breaker: a 403 (or 429s that exhaust the backoff) means the
//    registry is refusing this IP. trip() opens the breaker for `cooldownMs`;
//    while open every call fails fast with RegistryBlockedError, so a client
//    paging in a loop can't extend the block. After the cooldown one probe is
//    let through (half-open); success closes the breaker, a 403 re-opens it.
//
// State is per process. On Vercel that means per instance: Fluid Compute reuses
// instances, so one bursting client mostly hits the same one, but this is not a
// global guarantee. Shared state (e.g. Redis) would be the next step.

export interface LimitOptions {
  perSecond: number;
  perMinute: number;
  maxWaitMs: number;
  cooldownMs: number;
}

const envNum = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/**
 * Defaults are deliberately conservative: ~300 calls/min sustained for 3 min
 * got Vercel's IP blocked (2026-10-31); ~420 calls in 45 s from one machine
 * did not. The real threshold is unknown.
 */
export function defaultLimits(): LimitOptions {
  return {
    perSecond: envNum("SIJILAT_UPSTREAM_PER_SECOND", 4),
    perMinute: envNum("SIJILAT_UPSTREAM_PER_MINUTE", 120),
    maxWaitMs: envNum("SIJILAT_UPSTREAM_MAX_WAIT_MS", 5_000),
    cooldownMs: envNum("SIJILAT_BLOCK_COOLDOWN_S", 900) * 1000,
  };
}

/** The registry is refusing this server (403); fail fast until retryAfterMs. */
export class RegistryBlockedError extends Error {
  constructor(public retryAfterMs: number) {
    super(
      `the registry is refusing requests from this server (temporary block); ` +
        `retry in ~${Math.ceil(retryAfterMs / 60_000)} min and do not retry in a loop`,
    );
    this.name = "RegistryBlockedError";
  }
}

/** This server's own per-minute upstream budget is used up. */
export class UpstreamBudgetError extends Error {
  constructor(public retryAfterMs: number) {
    super(`upstream call budget exhausted; retry in ~${Math.ceil(retryAfterMs / 1000)} s and slow down`);
    this.name = "UpstreamBudgetError";
  }
}

/** True for errors that mean "stop calling the registry for now". */
export const isUpstreamStop = (e: unknown): e is RegistryBlockedError | UpstreamBudgetError =>
  e instanceof RegistryBlockedError || e instanceof UpstreamBudgetError;

const MAX_BACKOFF_MS = 8_000;
// A half-open probe that never reports back (network error, timeout) is
// abandoned after this long so the breaker can't wedge.
const PROBE_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  readonly opts: LimitOptions;
  private readonly interval: number;
  private nextAt = 0;
  private backoff = 0;
  private stamps: number[] = [];
  private openUntil = 0;
  private probeStartedAt = 0;

  constructor(opts: Partial<LimitOptions> = {}) {
    this.opts = { ...defaultLimits(), ...opts };
    this.interval = 1000 / Math.max(0.1, this.opts.perSecond);
  }

  /** Wait until the next request is allowed, or throw if it must not be made. */
  async acquire(): Promise<void> {
    this.checkBreaker();
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.opts.perMinute) break;
      const wait = this.stamps[0] + 60_000 - now;
      if (wait > this.opts.maxWaitMs) throw new UpstreamBudgetError(wait);
      await sleep(wait);
      this.checkBreaker();
    }
    const now = Date.now();
    this.stamps.push(now);
    const slot = Math.max(now, this.nextAt);
    this.nextAt = slot + this.interval;
    const wait = slot - now + this.backoff;
    if (wait > 0) await sleep(wait);
    // The breaker may have tripped while this call sat in the spacing queue
    // (a concurrent call got the 403). Don't let queued calls go out after it.
    // Only the open check: the half-open side effects belong to checkBreaker().
    if (Date.now() < this.openUntil) throw new RegistryBlockedError(this.openUntil - Date.now());
  }

  private checkBreaker(): void {
    if (!this.openUntil) return;
    const now = Date.now();
    if (now < this.openUntil) throw new RegistryBlockedError(this.openUntil - now);
    // Half-open: one probe at a time decides whether to close the breaker.
    if (this.probeStartedAt && now - this.probeStartedAt < PROBE_TIMEOUT_MS) {
      throw new RegistryBlockedError(PROBE_TIMEOUT_MS - (now - this.probeStartedAt));
    }
    this.probeStartedAt = now;
  }

  onSuccess(): void {
    this.backoff = Math.max(0, this.backoff - 250);
    this.openUntil = 0;
    this.probeStartedAt = 0;
  }

  /** HTTP 429. Backs off; repeated 429s past the max backoff trip the breaker. */
  onRateLimit(): void {
    if (this.backoff >= MAX_BACKOFF_MS) return this.trip();
    this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2 + 500);
  }

  /** HTTP 403: the registry is refusing us. Open the breaker for the cooldown. */
  trip(): void {
    this.openUntil = Date.now() + this.opts.cooldownMs;
    this.probeStartedAt = 0;
  }

  status() {
    const now = Date.now();
    const used = this.stamps.filter((t) => now - t < 60_000).length;
    return {
      blocked: now < this.openUntil,
      retry_after_s: now < this.openUntil ? Math.ceil((this.openUntil - now) / 1000) : 0,
      budget: { used, limit: this.opts.perMinute, window_s: 60 },
    };
  }
}
