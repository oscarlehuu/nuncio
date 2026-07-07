/**
 * Full-jitter exponential backoff for reconnect storms. The uncapped window
 * doubles each attempt (`base * 2^(attempt-1)`), is clamped to `cap`, and the
 * actual delay is a uniform random point in `[0, window)`. Full jitter (rather
 * than a fixed or "equal" jitter) spreads a fleet of phones reconnecting after
 * the same Wi-Fi blip so they do not thunder the desktop in lockstep.
 *
 * `attempt` is 1-based: attempt 1 is the first retry. `random` is injectable so
 * the jitter bounds are deterministically testable.
 */
export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  random?: () => number;
}

const DEFAULT_BASE_MS = 500;
const DEFAULT_CAP_MS = 8000;

export function fullJitterBackoff(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const capMs = options.capMs ?? DEFAULT_CAP_MS;
  const random = options.random ?? Math.random;
  // attempt 1 → base, attempt 2 → 2*base, … then clamp. Guard attempt < 1 so a
  // caller that miscounts never produces a negative exponent / sub-base window.
  const safeAttempt = attempt < 1 ? 1 : attempt;
  const exponential = baseMs * 2 ** (safeAttempt - 1);
  const window = Math.min(capMs, exponential);
  return random() * window;
}
