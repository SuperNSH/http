/** Retry policy and its delays (behavior row 5 of `docs/behavior.md`): backoff with
 * jitter on the caller's clock, honoring `Retry-After`. Nothing retries unless the
 * client gets a policy; even then only idempotent methods, and never once a request
 * body stream has started. */

export interface RetryPolicy {
  /** 0 means no retries. */
  maxRetries: number;
  /** Wait before the first retry; doubled per attempt while `exponentialBackoff`. Default 1000. */
  delayMs?: number;
  /** Default false: a flat `delayMs` every time. */
  exponentialBackoff?: boolean;
  /** Ceiling for the exponential growth. Default 30000. */
  maxDelayMs?: number;
  /** Fraction of the delay added as plus-or-minus jitter, drawn from `random`. Default 0.1. */
  jitter?: number;
  /** The source of the jitter draw; a test pins delays by returning a constant. Default Math.random. */
  random?: () => number;
}

/** The explicit no-retries policy, also the behavior when a client gets no policy at all. */
export const noRetries: RetryPolicy = { maxRetries: 0 };

/** Three attempts with doubling from one second — nsh-query's `defaultRetry` shape. */
export const defaultRetry: RetryPolicy = { maxRetries: 3, delayMs: 1000, exponentialBackoff: true, maxDelayMs: 30_000, jitter: 0.1 };

/** The wait before retry number `attempt` (0-based): backoff capped at `maxDelayMs`, then jitter. */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  const base = policy.delayMs ?? 1000;
  let delay = policy.exponentialBackoff
    ? Math.min(base * 2 ** Math.min(attempt, 30), policy.maxDelayMs ?? 30_000)
    : base;
  const jitter = policy.jitter ?? 0.1;
  if (jitter > 0) delay += delay * jitter * ((policy.random ?? Math.random)() * 2 - 1);
  return delay;
}

/** Parses `Retry-After`: whole seconds, or an HTTP-date measured against now. `null` when absent or unparseable. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const seconds = /^\s*(\d+)\s*$/.exec(header);
  if (seconds) return Number(seconds[1]) * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(date - now, 0);
}
