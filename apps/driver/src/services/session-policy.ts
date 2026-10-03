// When a failed token refresh means the driver is signed out — and when it
// just means the phone is in a dead spot.
//
// Reported from a live shop: drivers were being logged out mid-shift. The app
// cleared the session on ANY refresh failure, so a tunnel, a carrier handover,
// an API deploy, a 5xx or a rate-limit all threw the driver back to the login
// screen — in the middle of a delivery, with the job card gone.
//
// A driver cannot re-enter a password one-handed at a doorstep, so the rule is
// the same one the dashboard already uses: only a DEFINITIVE answer from the
// auth server (401/403 — this refresh token is dead) ends the session.
// Everything else keeps the tokens and tries again on the next request.
//
// Pure on purpose: no expo, no axios instance, no React. It is the one piece of
// this that must never be wrong, so it can be tested on its own.

/** Shape of the bits of an axios error this cares about. */
interface MaybeAxiosError {
  response?: { status?: number };
}

/**
 * True only when the auth server has actually rejected the refresh token.
 *
 * A thrown Error with no response (network down, DNS, timeout, TLS) is NOT a
 * rejection — it is the phone failing to ask the question.
 */
export function isSessionDead(err: unknown): boolean {
  const status = (err as MaybeAxiosError)?.response?.status;
  return status === 401 || status === 403;
}

/**
 * How long to wait before trying another refresh after one failed.
 *
 * The board polls every 8 seconds, so without this a refusal that lasts —
 * a 429, or the API restarting during a deploy — would be met with a fresh
 * refresh attempt every 8 seconds from every driver at once, which is exactly
 * what earns the 429 in the first place. Backs off 5s → 10s → 20s → 40s → 60s
 * and stays there until something succeeds.
 */
export function refreshBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(5_000 * 2 ** (consecutiveFailures - 1), 60_000);
}

/** Whether enough of the backoff has passed to try refreshing again. */
export function canRetryRefresh(
  consecutiveFailures: number,
  lastFailureAt: number,
  now: number = Date.now(),
): boolean {
  if (consecutiveFailures <= 0) return true;
  return now - lastFailureAt >= refreshBackoffMs(consecutiveFailures);
}
