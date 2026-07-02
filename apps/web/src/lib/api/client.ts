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

// ── Request interceptor: attach access token ──────────────
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = tokenCallbacks?.getAccessToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// ── Response interceptor: handle 401 with silent refresh ──
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };

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
