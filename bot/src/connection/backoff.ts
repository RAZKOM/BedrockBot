export interface BackoffPolicy {
  /** Delay for the first retry (ms). */
  baseMs: number;
  /** Upper bound for any delay (ms). */
  capMs: number;
  /** Growth factor per attempt. */
  factor: number;
  /** Fraction of the delay that is randomised: 0.2 means the delay lands in [0.8 d, d]. */
  jitter: number;
}

export const defaultBackoff: BackoffPolicy = { baseMs: 1_000, capMs: 60_000, factor: 2, jitter: 0.2 };

/**
 * Exponential backoff with jitter. `attempt` is 0 for the first retry after a failure.
 * The un-jittered delay is min(cap, base * factor^attempt); jitter only ever shortens it, so the
 * result is always within [(1 - jitter) * d, d] and never above the cap.
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy = defaultBackoff, random: () => number = Math.random): number {
  const n = Math.max(0, Math.floor(attempt));
  const exp = Math.min(policy.capMs, policy.baseMs * policy.factor ** n);
  const jitter = Math.min(1, Math.max(0, policy.jitter));
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(exp * (1 - jitter * r));
}
