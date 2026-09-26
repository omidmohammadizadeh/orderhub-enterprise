"use client";

// What the orders views show when GET /v1/orders/live is failing.
//
// The rule these two components encode: a broken FETCH is not a broken BOARD.
// Both views used to replace everything with a bare "Failed to load orders"
// the instant the query errored — so a transient blip (a deploy restart, a
// rate-limit cooldown, a shop's wifi dropping a packet) blanked a board that
// was still holding forty live tickets, and the operator lost sight of the
// kitchen over a request that would have succeeded ten seconds later.
//
// Now: tickets on screen → keep them and warn in a strip above (Banner).
// Nothing on screen at all → the full message (Error), and in both cases we
// name WHY and offer a manual retry, because "Failed to load orders" with no
// reason gave nobody — operator or us — anything to act on.

import { AlertCircle, Loader2, RefreshCw } from "lucide-react";

type ApiError = {
  code?: string;
  response?: { status?: number };
};

/** A short, honest reason for the failure. Operators read this out to us on
 *  the phone, so it has to distinguish "your internet" from "our server". */
export function describeFeedError(error: unknown): string {
  const err = error as ApiError | null;
  const status = err?.response?.status;
  if (err?.code === "ERR_RATE_LIMIT_COOLDOWN" || status === 429) {
    return "too many requests — backing off";
  }
  if (status === 401 || status === 403) return "session not accepted";
  if (status === undefined) return "can't reach the server";
  if (status >= 500) return `server error (${status})`;
  return `request failed (${status})`;
}

/** Full-height failure state — only when there is nothing at all to show. */
export function OrdersFeedError({
  error,
  isRetrying,
  onRetry,
}: {
  error: unknown;
  isRetrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex h-64 flex-col items-center justify-center gap-3 text-sm"
    >
      <div className="flex items-center gap-2 text-red-500">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <span>Failed to load orders — {describeFeedError(error)}</span>
      </div>
      <p className="text-xs text-zinc-500">
        Retrying automatically every 10 seconds.
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-zinc-300 px-4 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-zinc-500 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {isRetrying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Try again
        </button>
      )}
    </div>
  );
}

/** Strip shown ABOVE orders we already have while the feed is failing. */
export function OrdersFeedBanner({
  error,
  isRetrying,
  onRetry,
}: {
  error: unknown;
  isRetrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-3 flex items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <span className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        Not updating — {describeFeedError(error)}. Showing the last orders we
        received; retrying automatically.
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-current/40 px-2 py-0.5 text-xs font-medium disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-amber-600"
        >
          {isRetrying ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
          )}
          Retry now
        </button>
      )}
    </div>
  );
}
