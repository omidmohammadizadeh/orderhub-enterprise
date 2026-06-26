// Auth + API service for the Order Hub Driver app. Mirrors apps/mobile:
// stores the JWT pair in expo-secure-store and attaches the access token to
// every request. Adds the driver-specific endpoints (/v1/driver/*).

import { useCallback, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import axios from "axios";
import Constants from "expo-constants";

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

api.interceptors.request.use((config) => {
  if (inMemoryAccess) {
    config.headers = config.headers ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config.headers as any).Authorization = `Bearer ${inMemoryAccess}`;
  }
  return config;
});

export function useAuth() {
  const [tokens, setTokensState] = useState<AuthTokens | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(TOKEN_KEY)
      .then((stored) => {
        if (!stored) return;
        try {
          const parsed = JSON.parse(stored) as AuthTokens;
          if (parsed?.accessToken) {
            inMemoryAccess = parsed.accessToken;
            setTokensState(parsed);
          }
        } catch {
          // ignore malformed
        }
      })
      .finally(() => setHydrated(true));
  }, []);

  const setTokens = useCallback(async (next: AuthTokens | null) => {
    inMemoryAccess = next?.accessToken ?? null;
    setTokensState(next);
    if (next) await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(next));
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
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
}

export interface Job {
  id: string; // assignment id
  orderId: string;
  status: string; // DriverAssignmentStatus
  assignedAt: string;
  order: JobOrder;
}

export interface MyDay {
  active: Job[];
  history: Job[];
  cashUp: { deliveries: number; cashTotal: string; cardTotal: string; total: string };
}

export async function getMe() {
  const res = await api.get<DriverProfile>("/v1/driver/me");
  return res.data;
}
export async function getMyDay() {
  const res = await api.get<MyDay>("/v1/driver/my-day");
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
export type JobActionType = "accept" | "start" | "delivered" | "skip" | "cancel";
export async function jobAction(orderId: string, action: JobActionType) {
  await api.post(`/v1/driver/jobs/${orderId}/${action}`);
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
