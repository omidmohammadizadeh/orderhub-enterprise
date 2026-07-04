"use client";

// Global route error boundary.
//
// The most common production "Application error" is a ChunkLoadError: a tab
// opened before a deploy navigates to a route whose JS chunk no longer
// exists on the new build. That's self-healing — a hard reload fetches the
// fresh manifest — so do it automatically exactly once (sessionStorage
// guard prevents a reload loop if the error is real).

import { useEffect } from "react";

const RELOAD_GUARD = "oh:chunk-reload";

function isStaleChunkError(error: Error): boolean {
  const text = `${error?.name ?? ""} ${error?.message ?? ""}`;
  return (
    text.includes("ChunkLoadError") ||
    text.includes("Loading chunk") ||
    text.includes("Failed to fetch dynamically imported module") ||
    text.includes("Importing a module script failed")
  );
}

export default function GlobalRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (isStaleChunkError(error) && !sessionStorage.getItem(RELOAD_GUARD)) {
      sessionStorage.setItem(RELOAD_GUARD, "1");
      window.location.reload();
      return;
    }
    // A successful fresh load clears the guard for the next deploy.
    const t = setTimeout(() => sessionStorage.removeItem(RELOAD_GUARD), 10_000);
    return () => clearTimeout(t);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <div className="text-center max-w-sm">
        <p className="text-lg font-semibold text-zinc-900">
          Something went wrong
        </p>
        <p className="text-sm text-zinc-500 mt-2">
          This usually happens right after an update. Reloading fixes it.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-zinc-900 text-white px-4 py-2 text-sm font-semibold hover:bg-zinc-800"
          >
            Reload
          </button>
          <button
            onClick={() => reset()}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
