// Auth + API service for the Order Hub Driver app. Mirrors apps/mobile:
// stores the JWT pair in expo-secure-store and attaches the access token to
// every request. Adds the driver-specific endpoints (/v1/driver/*).

import { useCallback, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import axios from "axios";
import Constants from "expo-constants";
import { canRetryRefresh, isSessionDead } from "./session-policy";

const TOKEN_KEY = "orderhub.driver.tokens";

const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  "https://orderhub-api-0re6.onrender.com/api";

export const api = axios.create({ baseURL: API_URL, timeout: 15000 });

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

let inMemoryAccess: string | null = null;
let inMemoryRefresh: string | null = null;
// Lets the axios interceptor push rotated/cleared tokens back into React state
// (so the UI logs out when the refresh token finally expires).
let onTokensChanged: ((t: AuthTokens | null) => void) | null = null;
// Refresh tokens are single-use (each refresh revokes the previous one). The app
// has two JS contexts — the foreground UI and the headless background location
// task — so only ONE may rotate the token, else they revoke each other's tokens.
// useAuth (foreground only) sets this true; the background context leaves it
// false and never refreshes (its pings just fail silently if the access expired).
let canRefresh = false;

// useAuth claims rotation on mount and releases it on unmount. Exported so the
// rule itself can be exercised in a test — never call these from the
// background location task, which is the context the rule exists to stop.
export function claimTokenRotation() {
  canRefresh = true;
}
export function releaseTokenRotation() {
  canRefresh = false;
}

// Single source of truth for persisting the token pair: in-memory (for the
// request interceptor) + secure store + React state.
async function persistTokens(next: AuthTokens | null) {
  inMemoryAccess = next?.accessToken ?? null;
  inMemoryRefresh = next?.refreshToken ?? null;
  if (next) await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(next));
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
  onTokensChanged?.(next);
}

api.interceptors.request.use(async (config) => {
  // The background location task runs in a headless JS context where the React
  // auth hydration never ran, so the in-memory token is empty there — fall back
  // to secure store so background pings still authenticate.
  if (!inMemoryAccess) {
    try {
      const stored = await SecureStore.getItemAsync(TOKEN_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as AuthTokens;
        inMemoryAccess = parsed?.accessToken ?? null;
        inMemoryRefresh = parsed?.refreshToken ?? null;
      }
    } catch {
      // ignore — request just goes out unauthenticated
    }
  }
  if (inMemoryAccess) {
    config.headers = config.headers ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config.headers as any).Authorization = `Bearer ${inMemoryAccess}`;
  }
  return config;
});

// Access tokens live ~15 min. On a 401 we rotate the pair via /auth/refresh once,
// persist the new pair, and replay the original request. Concurrent 401s share a
// single in-flight refresh.
//
// The session is cleared ONLY when the auth server says the refresh token is
// dead (see isSessionDead). A failure to reach it — tunnel, carrier handover,
// API deploy, 5xx, 429 — keeps the tokens and retries later, because signing a
// driver out mid-delivery over a dead spot is the worst thing this app can do.
let refreshInFlight: Promise<AuthTokens> | null = null;
let refreshFailures = 0;
let lastRefreshFailureAt = 0;
async function refreshTokens(): Promise<AuthTokens> {
  if (!inMemoryRefresh) throw new Error("No refresh token");
  // Bare axios (not `api`) so this request skips the interceptors below.
  // With a timeout: the default is none, and a socket left hanging in a dead
  // spot would leave refreshInFlight pending for ever, so every later 401
  // would await a promise that never settles and the app would sit there
  // unauthenticated with no way back.
  const res = await axios.post<{ accessToken: string; refreshToken: string }>(
    `${API_URL}/v1/auth/refresh`,
    { refreshToken: inMemoryRefresh },
    { timeout: 20_000 },
  );
  const next: AuthTokens = {
    accessToken: res.data.accessToken,
    refreshToken: res.data.refreshToken,
  };
  await persistTokens(next);
  return next;
}

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = error?.config as any;
    const status = error?.response?.status;
    const url: string = original?.url ?? "";
    const isAuthCall = url.includes("/auth/refresh") || url.includes("/auth/login");
    if (status === 401 && original && !original._retry && !isAuthCall) {
      original._retry = true;
      if (canRefresh && inMemoryRefresh) {
        // Foreground: rotate the pair and replay the request.
        //
        // While a refresh is backing off, don't pile on: the board polls every
        // 8s, and hammering a server that is rate-limiting or restarting is
        // what keeps it rate-limiting. The request just fails; the poll after
        // the backoff tries again.
        if (!refreshInFlight && !canRetryRefresh(refreshFailures, lastRefreshFailureAt)) {
          return Promise.reject(error);
        }
        try {
          if (!refreshInFlight) {
            refreshInFlight = refreshTokens().finally(() => {
              refreshInFlight = null;
            });
          }
          const next = await refreshInFlight;
          refreshFailures = 0;
          original.headers = original.headers ?? {};
          original.headers.Authorization = `Bearer ${next.accessToken}`;
          return api(original);
        } catch (refreshError) {
          if (isSessionDead(refreshError)) {
            // The server has rejected the refresh token itself — genuinely
            // signed out.
            refreshFailures = 0;
            await persistTokens(null);
          } else {
            // Couldn't reach the server, or it couldn't answer. Keep the
            // tokens: the driver stays signed in and the next poll retries.
            refreshFailures += 1;
            lastRefreshFailureAt = Date.now();
          }
        }
      } else {
        // Background/headless: never rotate (that would revoke the foreground's
        // token). Drop our cached token so the next request re-reads whatever the
        // foreground has since refreshed into secure store.
        inMemoryAccess = null;
      }
    }
    return Promise.reject(error);
  },
);

export function useAuth() {
  const [tokens, setTokensState] = useState<AuthTokens | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Keep React state in sync when the interceptor rotates or clears tokens.
    onTokensChanged = setTokensState;
    claimTokenRotation(); // this is the foreground context — it owns token rotation
    SecureStore.getItemAsync(TOKEN_KEY)
      .then((stored) => {
        if (!stored) return;
        try {
          const parsed = JSON.parse(stored) as AuthTokens;
          if (!parsed?.accessToken) return;
          // If a pair is already in memory, something rotated while this read
          // was in flight (a background ping can 401 before hydration lands).
          // That pair is the newer one — adopting the one we just read would
          // re-present a refresh token the server has already revoked, and a
          // replay more than a minute after rotation reads as token theft:
          // the server kills the whole chain and the driver is logged out for
          // real. So never let a stale read win.
          if (inMemoryRefresh) {
            setTokensState({
              accessToken: inMemoryAccess ?? parsed.accessToken,
              refreshToken: inMemoryRefresh,
            });
            return;
          }
          inMemoryAccess = parsed.accessToken;
          inMemoryRefresh = parsed.refreshToken ?? null;
          setTokensState(parsed);
        } catch {
          // ignore malformed
        }
      })
      .finally(() => setHydrated(true));
    return () => {
      onTokensChanged = null;
      releaseTokenRotation();
    };
  }, []);

  const setTokens = useCallback(async (next: AuthTokens | null) => {
    await persistTokens(next);
  }, []);

  return { tokens, hydrated, setTokens };
}

type LoginResponse = { tokens: { accessToken: string; refreshToken: string } };
function toTokens(res: { data: LoginResponse }): AuthTokens {
  return {
    accessToken: res.data.tokens.accessToken,
    refreshToken: res.data.tokens.refreshToken,
  };
}

export async function loginWithEmailPassword(email: string, password: string) {
  const res = await api.post<LoginResponse>("/v1/auth/login", { email, password });
  return toTokens(res);
}
export async function exchangeGoogleIdToken(idToken: string) {
  const res = await api.post<LoginResponse>("/v1/auth/google/native", { idToken });
  return toTokens(res);
}
export async function exchangeAppleIdToken(
  idToken: string,
  fullName?: { givenName?: string | null; familyName?: string | null },
  email?: string | null,
) {
  const res = await api.post<LoginResponse>("/v1/auth/apple/native", { idToken, fullName, email });
  return toTokens(res);
}

// ── Driver endpoints ─────────────────────────────────────────────────────────

export interface DriverProfile {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  vehicleType: string | null;
  presence: { status: "OFFLINE" | "ONLINE" | "ON_JOB"; locationId: string | null } | null;
}

export interface JobOrder {
  id: string;
  displayId: string | null;
  orderNumber: number | null;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  total: string;
  paymentMethod: string | null;
  deliveryAddress: unknown;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postcode: string | null;
  deliveryLat: number | null;
  deliveryLng: number | null;
  specialInstructions: string | null;
  // Platform + masked-call fields. Marketplace orders (Just Eat / Uber Eats /
  // Deliveroo) hide the customer's real number behind courierPhone, and some
  // require dialling courierPhoneAccessCode after a pause to connect.
  platform: string | null;
  courierPhone: string | null;
  courierPhoneAccessCode: string | null;
  // Same idea for the customer's own masked number (Uber Eats puts the code
  // on customerInfo; the API flattens it onto the job).
  customerPhoneAccessCode: string | null;
  // When the order is "due" (ISO) — mirrors the dispatch console countdown.
  deadlineAt: string | null;
}

export interface Job {
  id: string; // assignment id
  orderId: string;
  status: string; // DriverAssignmentStatus
  assignedAt: string;
  sequence: number | null; // stop number within a multi-drop run (1..N)
  arrivedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  order: JobOrder;
}

export interface MyDay {
  active: Job[];
  history: Job[];
  cashUp: {
    deliveries: number;
    cashTotal: string;
    cardTotal: string;
    total: string;
    // Phase BG — the driver's own pay so far today.
    startupFee: string;
    deliveryFees: string;
    earning: string;
  };
}

export async function getMe() {
  const res = await api.get<DriverProfile>("/v1/driver/me");
  return res.data;
}
export async function getMyDay() {
  const res = await api.get<MyDay>("/v1/driver/my-day");
  return res.data;
}

export interface CashUp {
  from: string;
  to: string;
  deliveries: number;
  cashCount: number;
  cardCount: number;
  cashTotal: string;
  cardTotal: string;
  total: string;
  // Phase BG — driver pay for the period.
  startupFee: string;
  deliveryFees: string;
  earning: string;
}
export async function getCashUp(from?: string, to?: string) {
  const res = await api.get<CashUp>("/v1/driver/cash-up", { params: { from, to } });
  return res.data;
}
export async function goOnline(locationId?: string) {
  // locationId optional — the server resolves the tenant's location if omitted.
  await api.post("/v1/driver/online", locationId ? { locationId } : {});
}
export async function goOffline() {
  await api.post("/v1/driver/offline");
}
export async function sendPing(p: { lat: number; lng: number; heading?: number; speed?: number }) {
  await api.post("/v1/driver/ping", p);
}
export async function registerPushToken(token: string) {
  await api.post("/v1/driver/push-token", { token });
}
export type JobActionType = "accept" | "start" | "arrived" | "delivered" | "skip" | "cancel";
export async function jobAction(orderId: string, action: JobActionType) {
  await api.post(`/v1/driver/jobs/${orderId}/${action}`);
}

// ── Chat ─────────────────────────────────────────────────────────────────────
export interface ChatMessage {
  id: string;
  senderType: "OPERATOR" | "DRIVER" | "CUSTOMER";
  senderName: string | null;
  body: string;
  createdAt: string;
}
export async function getOperatorChat() {
  const res = await api.get<{ messages: ChatMessage[] }>("/v1/driver/chat");
  return res.data.messages;
}
export async function sendOperatorChat(body: string) {
  await api.post("/v1/driver/chat", { body });
}
export async function getOperatorChatUnread() {
  const res = await api.get<{ unread: number }>("/v1/driver/chat/unread");
  return res.data.unread;
}
export async function getCustomerChat(orderId: string) {
  const res = await api.get<{ messages: ChatMessage[] }>(`/v1/driver/orders/${orderId}/chat`);
  return res.data.messages;
}
export async function sendCustomerChat(orderId: string, body: string) {
  await api.post(`/v1/driver/orders/${orderId}/chat`, { body });
}

// ── Account (mirrors the web dashboard) ──────────────────────────────────────
export async function changePassword(newPassword: string, currentPassword?: string) {
  await api.post("/v1/auth/change-password", { newPassword, currentPassword });
}
export async function deleteMyAccount() {
  // Backend requires the exact confirmation phrase.
  await api.delete("/v1/auth/me", { data: { confirm: "DELETE MY ACCOUNT" } });
}

// Accessible locations for the online-at picker.
export interface LocationSummary {
  id: string;
  name: string;
}
export async function getLocations() {
  const res = await api.get<LocationSummary[]>("/v1/locations");
  return res.data;
}
