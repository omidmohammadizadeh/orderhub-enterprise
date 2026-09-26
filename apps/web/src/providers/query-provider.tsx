"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useState, type ReactNode } from "react";

export function QueryProvider({ children }: { children: ReactNode }) {
  // One QueryClient per browser session, created once.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,         // 30 s before refetch
            gcTime: 5 * 60_000,        // 5 min garbage collection
            // Don't retry anything the server answered with a 4xx: a
            // rate-limit (429) or an auth/permission failure (401/403) only
            // gets worse for being hammered, and a 400/404 will never come
            // good. Everything else — a network drop, a 502 from the edge
            // mid-deploy, a 500 — is transient by nature, so retry three
            // times with backoff (1s, 2s, 4s) before showing a failure. The
            // old policy gave up after ONE immediate retry, which is well
            // inside the window of a Render restart.
            retry: (failureCount, error) => {
              const status = (error as { response?: { status?: number } })
                ?.response?.status;
              if (status !== undefined && status >= 400 && status < 500) {
                return false;
              }
              return failureCount < 3;
            },
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === "development" && (
        <ReactQueryDevtools initialIsOpen={false} position="bottom" />
      )}
    </QueryClientProvider>
  );
}
