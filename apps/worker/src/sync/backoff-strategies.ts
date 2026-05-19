/**
 * Rate-limit-aware backoff strategy for the ORDER_SYNC Bull queue.
 *
 * When a sync job fails with a provider 429, the processor encodes the
 * Retry-After delay in the error message as "RATE_LIMITED:<ms>". This
 * strategy reads that value and delays by exactly that many milliseconds,
 * so the next retry honours the provider's stated cool-down window.
 *
 * For all other failures the strategy falls back to exponential backoff
 * with a 3-second base delay — identical to Bull's built-in exponential
 * behaviour (delay = (2^attemptsMade - 1) * baseMs).
 */

const RATE_LIMIT_PREFIX = "RATE_LIMITED:";
const EXPONENTIAL_BASE_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;

export function rateLimitAwareBackoff(attemptsMade: number, err: Error): number {
  if (err?.message?.startsWith(RATE_LIMIT_PREFIX)) {
    const ms = parseInt(err.message.slice(RATE_LIMIT_PREFIX.length), 10);
    if (!isNaN(ms) && ms > 0) {
      return Math.min(ms, MAX_BACKOFF_MS);
    }
  }
  // Fallback: standard exponential
  return Math.min(
    Math.round((Math.pow(2, attemptsMade) - 1) * EXPONENTIAL_BASE_MS),
    MAX_BACKOFF_MS,
  );
}
