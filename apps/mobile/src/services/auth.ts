// Auth service — stores the JWT in expo-secure-store (Keychain on iOS,
// Keystore on Android). On launch we hydrate from secure storage so a
// returning operator doesn't have to log in again.
//
// All three login paths (email/pass, Google native, Apple native) end
// here: they exchange their respective credential for an OrderHub JWT
// via the API, then setToken() persists + flips the React state that
// gates the WebView screen.

import { useEffect, useState, useCallback } from "react";
import * as SecureStore from "expo-secure-store";
import axios from "axios";
import Constants from "expo-constants";

const TOKEN_KEY = "orderhub.token";

const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  "https://orderhub-api.onrender.com/api";

export const api = axios.create({
  baseURL: API_URL,
  timeout: 15000,
});

let inMemoryToken: string | null = null;

api.interceptors.request.use((config) => {
  if (inMemoryToken) {
    config.headers = config.headers ?? {};
    (config.headers as any).Authorization = `Bearer ${inMemoryToken}`;
  }
  return config;
});

export function useAuth() {
  const [token, setTokenState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(TOKEN_KEY)
      .then((stored) => {
        if (stored) {
          inMemoryToken = stored;
          setTokenState(stored);
        }
      })
      .finally(() => setHydrated(true));
  }, []);

  const setToken = useCallback(async (next: string | null) => {
    inMemoryToken = next;
    setTokenState(next);
    if (next) {
      await SecureStore.setItemAsync(TOKEN_KEY, next);
    } else {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    }
  }, []);

  return { token, hydrated, setToken };
}

export async function loginWithEmailPassword(
  email: string,
  password: string,
): Promise<string> {
  const res = await api.post<{ accessToken: string }>("/v1/auth/login", {
    email,
    password,
  });
  return res.data.accessToken;
}

export async function exchangeGoogleIdToken(idToken: string): Promise<string> {
  // Posts the Google ID token to our existing customer/staff Google auth
  // endpoint. The server validates the token against Google, finds-or-
  // creates the user, and returns our own JWT.
  const res = await api.post<{ accessToken: string }>(
    "/v1/auth/google/native",
    { idToken },
  );
  return res.data.accessToken;
}

export async function exchangeAppleIdToken(
  idToken: string,
  fullName?: { givenName?: string | null; familyName?: string | null },
  email?: string | null,
): Promise<string> {
  const res = await api.post<{ accessToken: string }>("/v1/auth/apple/native", {
    idToken,
    fullName,
    email,
  });
  return res.data.accessToken;
}
