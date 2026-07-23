import axios, {
  AxiosInstance,
  AxiosError,
  InternalAxiosRequestConfig,
} from "axios";

// This module is the single Axios instance used by all API calls.
// It handles:
//   - Attaching the access token to every request
//   - Automatic silent refresh on 401 (access token expired)
//   - Redirecting to /login if the refresh also fails
//
// Circular reference prevention: this file cannot import the auth store
// directly (the store imports this). Instead, we use a lazy getter pattern:
// the auth store registers its token getter/setter callbacks after init.

interface TokenCallbacks {
  getAccessToken: () => string | null;
  getRefreshToken: () => string | null;
  setTokens: (accessToken: string, refreshToken: string) => void;
  clearTokens: () => void;
}

let tokenCallbacks: TokenCallbacks | null = null;
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else if (token) resolve(token);
  });
  failedQueue = [];
}

export function registerAuthCallbacks(callbacks: TokenCallbacks) {
  tokenCallbacks = callbacks;
}

export const apiClient: AxiosInstance = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "/api",
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

// ── 429 cooldown (Retry-After aware) ──────────────────────
//
// When the server rate-limits an endpoint it says how long to back off
// (Retry-After). React Query already never RETRIES a 429 — but a query
// with a fixed refetchInterval would fire again on its next tick as if
// nothing happened, and the client never read the header at all. These
// two interceptors close that gap: a 429 opens a per-endpoint cooldown
// window; any request to that endpoint during the window is rejected
// LOCALLY (no network, same 429 shape for callers) until it expires.
// Scoped per endpoint path — a cooldown on /orders/live never blocks
// /alerts or anything else.
const cooldownUntil = new Map<string, number>();
const cooldownStrikes = new Map<string, number>();

/** Endpoint identity for cooldown purposes: the path without the query
 *  string, so /orders/live?locationId=A and ?locationId=B share one
 *  window (they share one server-side bucket too). */
function endpointKey(config: InternalAxiosRequestConfig): string {
  return (config.url ?? "").split("?")[0] ?? "";
}

/** Parse Retry-After (delta-seconds or HTTP-date) / X-RateLimit-Reset
 *  (seconds until reset) into a millisecond delay. */
function retryAfterMs(headers: Record<string, unknown> | undefined): number | null {
  const raw =
    (headers?.["retry-after"] as string | undefined) ??
    (headers?.["x-ratelimit-reset"] as string | undefined);
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 120_000);
  const date = Date.parse(String(raw));
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 120_000));
  return null;
}

/** Local stand-in for a rate-limited response so callers (and React
 *  Query's retry logic, which checks response.status) treat a cooldown
 *  rejection exactly like the original 429 — without touching the network. */
function cooldownError(config: InternalAxiosRequestConfig): AxiosError {
  const err = new AxiosError(
    "Rate-limited — cooling down before retrying this endpoint",
    "ERR_RATE_LIMIT_COOLDOWN",
    config,
  );
  (err as AxiosError & { response: unknown }).response = {
    status: 429,
    statusText: "Too Many Requests",
    headers: {},
    config,
    data: { statusCode: 429, message: "Client cooldown (rate-limited)" },
  };
  return err;
}

// ── Request interceptor: attach access token + enforce cooldown ──────
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const until = cooldownUntil.get(endpointKey(config));
    if (until && Date.now() < until) {
      return Promise.reject(cooldownError(config));
    }
    const token = tokenCallbacks?.getAccessToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// ── Response interceptor: 429 cooldown + handle 401 with silent refresh ──
apiClient.interceptors.response.use(
  (response) => {
    // A clean response ends any strike streak for this endpoint.
    const key = endpointKey(response.config as InternalAxiosRequestConfig);
    cooldownStrikes.delete(key);
    return response;
  },
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };

    // Real 429 from the server (not our local cooldown rejection, which
    // has code ERR_RATE_LIMIT_COOLDOWN and never reaches the network):
    // open/extend the endpoint's cooldown window. Honour the server's
    // Retry-After; when absent, back off exponentially with jitter
    // (5s → 10s → 20s → 40s, capped at 60s).
    if (
      error.response?.status === 429 &&
      error.code !== "ERR_RATE_LIMIT_COOLDOWN" &&
      originalRequest
    ) {
      const key = endpointKey(originalRequest);
      const serverMs = retryAfterMs(
        error.response.headers as Record<string, unknown>,
      );
      const strikes = (cooldownStrikes.get(key) ?? 0) + 1;
      cooldownStrikes.set(key, strikes);
      const backoffMs = Math.min(5_000 * 2 ** (strikes - 1), 60_000);
      const jitterMs = Math.floor(Math.random() * 1_000);
      cooldownUntil.set(key, Date.now() + (serverMs ?? backoffMs) + jitterMs);
      return Promise.reject(error);
    }

    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }

    // Don't try to refresh on the login or refresh endpoints themselves
    const url = originalRequest.url ?? "";
    if (url.includes("/auth/login") || url.includes("/auth/refresh")) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      // Another request is already refreshing — queue this one
      return new Promise<string>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      })
        .then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return apiClient(originalRequest);
        })
        .catch((err) => Promise.reject(err));
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      const refreshToken = tokenCallbacks?.getRefreshToken();
      if (!refreshToken) {
        // Genuinely signed out — nothing to preserve, go to login.
        processQueue(new Error("No refresh token"), null);
        tokenCallbacks?.clearTokens();
        if (typeof window !== "undefined") window.location.href = "/login";
        return Promise.reject(error);
      }

      const { data } = await axios.post<{
        accessToken: string;
        refreshToken: string;
      }>("/api/v1/auth/refresh", { refreshToken });

      tokenCallbacks?.setTokens(data.accessToken, data.refreshToken);
      processQueue(null, data.accessToken);

      originalRequest.headers.Authorization = `Bearer ${data.accessToken}`;
      return apiClient(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError, null);
      // Only a DEFINITIVE rejection from the auth server means the session is
      // dead. A network error (tablet wifi still reconnecting after sleep) or
      // a transient 5xx must NOT log the user out — keep the tokens and let
      // the next request retry the refresh.
      const status = (refreshError as { response?: { status?: number } })
        ?.response?.status;
      if (status === 401 || status === 403) {
        tokenCallbacks?.clearTokens();
        // Redirect to login — works in Next.js client components
        if (typeof window !== "undefined") {
          window.location.href = "/login";
        }
      }
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
