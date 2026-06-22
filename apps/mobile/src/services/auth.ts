// Auth service — stores both access + refresh JWTs in expo-secure-store
// (Keychain on iOS, Keystore on Android). On launch we hydrate from
// secure storage so a returning operator doesn't have to log in again.
//
// All three login paths (email/pass, Google native, Apple native) end
// here: they exchange their respective credential for an OrderHub JWT
// pair via the API, then setTokens() persists + flips the React state
// that gates the WebView screen. We keep BOTH tokens so the WebView
// can hand them to the web's /auth/oauth/callback page, which is the
// only path that populates the web's Zustand auth store correctly.

import { useEffect, useState, useCallback } from "react";
import * as SecureStore from "expo-secure-store";
import axios from "axios";
import Constants from "expo-constants";

const TOKEN_KEY = "orderhub.tokens"; // JSON: { accessToken, refreshToken }

const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  "https://orderhub-api.onrender.com/api";

export const api = axios.create({
  baseURL: API_URL,
  timeout: 15000,
});

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

let inMemoryAccess: string | null = null;

api.interceptors.request.use((config) => {
  if (inMemoryAccess) {
    config.headers = config.headers ?? {};
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
          // Old single-string token from a previous app version — discard.
        }
      })
      .finally(() => setHydrated(true));
  }, []);

  const setTokens = useCallback(async (next: AuthTokens | null) => {
    inMemoryAccess = next?.accessToken ?? null;
    setTokensState(next);
    if (next) {
      await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(next));
    } else {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    }
  }, []);

  return { tokens, hydrated, setTokens };
}

// API login responses: { tokens: { accessToken, refreshToken, ... }, user }.
// We keep BOTH tokens so the web's auth callback page can rebuild its
// Zustand auth store (it persists refreshToken too).
type LoginResponse = {
  tokens: { accessToken: string; refreshToken: string };
};

function toTokens(res: { data: LoginResponse }): AuthTokens {
  return {
    accessToken: res.data.tokens.accessToken,
    refreshToken: res.data.tokens.refreshToken,
  };
}

export async function loginWithEmailPassword(
  email: string,
  password: string,
): Promise<AuthTokens> {
  const res = await api.post<LoginResponse>("/v1/auth/login", {
    email,
    password,
  });
  return toTokens(res);
}

export async function exchangeGoogleIdToken(
  idToken: string,
): Promise<AuthTokens> {
  const res = await api.post<LoginResponse>("/v1/auth/google/native", {
    idToken,
  });
  return toTokens(res);
}

export async function exchangeAppleIdToken(
  idToken: string,
  fullName?: { givenName?: string | null; familyName?: string | null },
  email?: string | null,
): Promise<AuthTokens> {
  const res = await api.post<LoginResponse>("/v1/auth/apple/native", {
    idToken,
    fullName,
    email,
  });
  return toTokens(res);
}
