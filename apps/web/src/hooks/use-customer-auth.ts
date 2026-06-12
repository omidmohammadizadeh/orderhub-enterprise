"use client";

// Phase AP-AUTH — storefront customer auth state.
//
// One hook covers everything the storefront needs:
//   * Current customer (or null) + isLoading
//   * signup / login / logout actions
//   * Token persistence in localStorage
//   * Cross-tab sync via a `storage` event listener — log out in one
//     tab and the other tabs follow within a tick
//
// Why localStorage not cookies: the storefront is rendered statically;
// SSR doesn't need to know who the customer is. The Stripe checkout
// flow always carries the token as a Bearer header on requests, so
// CSRF isn't a concern for this surface.

import { useEffect, useState, useCallback } from "react";
import axios from "axios";

// On Render: NEXT_PUBLIC_API_URL = "/api" so requests hit the Next.js
// rewrite layer (apps/web/next.config.js) which proxies to the API.
// In local dev when the env var is unset, we point straight at the
// hosted API and include "/api" so the call hits NestJS's global
// prefix. The route paths below DO NOT include "/api" — the base
// always carries it. This avoids the "/api/api/v1/..." double-prefix
// bug.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  "https://orderhub-api-0re6.onrender.com/api";
const TOKEN_KEY = "orderhub.customerToken";

export interface Customer {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
}

export interface UseCustomerAuthReturn {
  customer: Customer | null;
  isLoading: boolean;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (input: SignupInput) => Promise<{ pendingVerification: boolean }>;
  logout: () => void;
  refresh: () => Promise<void>;
}

export interface SignupInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  marketingOptIn?: boolean;
  storeSlug?: string;
}

export function useCustomerAuth(): UseCustomerAuthReturn {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Initial hydration from localStorage + fetch /me to validate.
  //
  // Verbose console logging deliberately retained so that any future
  // "header still shows Sign in" regression can be diagnosed by the
  // operator opening DevTools and grepping for "[customer-auth]".
  useEffect(() => {
    if (typeof window === "undefined") {
      setIsLoading(false);
      return;
    }
    const stored = window.localStorage.getItem(TOKEN_KEY);
    // eslint-disable-next-line no-console
    console.log(
      `[customer-auth] init origin=${window.location.origin} token=${stored ? `present(${stored.slice(0, 20)}...)` : "missing"}`,
    );
    if (!stored) {
      setIsLoading(false);
      return;
    }
    setToken(stored);
    const meUrl = `${API_BASE}/v1/customer-auth/me`;
    // eslint-disable-next-line no-console
    console.log(`[customer-auth] GET ${meUrl}`);
    axios
      .get(meUrl, {
        headers: { Authorization: `Bearer ${stored}` },
      })
      .then((res) => {
        // eslint-disable-next-line no-console
        console.log("[customer-auth] /me 200 →", res.data);
        setCustomer(res.data);
      })
      .catch((err: any) => {
        // eslint-disable-next-line no-console
        console.error(
          `[customer-auth] /me FAILED status=${err?.response?.status} message=${err?.response?.data?.message ?? err?.message}`,
        );
        // Token expired / invalid → drop it silently. The next gated
        // action will reopen the login modal.
        window.localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setCustomer(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Cross-tab sync — log out in one tab, others follow.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TOKEN_KEY) return;
      if (!e.newValue) {
        setToken(null);
        setCustomer(null);
      } else if (e.newValue !== token) {
        setToken(e.newValue);
        // Re-fetch /me with the new token.
        axios
          .get(`${API_BASE}/v1/customer-auth/me`, {
            headers: { Authorization: `Bearer ${e.newValue}` },
          })
          .then((res) => setCustomer(res.data))
          .catch(() => setCustomer(null));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [token]);

  const persistToken = (t: string | null) => {
    if (typeof window === "undefined") return;
    if (t) {
      window.localStorage.setItem(TOKEN_KEY, t);
    } else {
      window.localStorage.removeItem(TOKEN_KEY);
    }
  };

  const login = useCallback(async (email: string, password: string) => {
    const res = await axios.post(`${API_BASE}/v1/customer-auth/login`, {
      email,
      password,
    });
    setToken(res.data.accessToken);
    setCustomer(res.data.customer);
    persistToken(res.data.accessToken);
  }, []);

  const signup = useCallback(async (input: SignupInput) => {
    await axios.post(`${API_BASE}/v1/customer-auth/signup`, input);
    // Customer is NOT signed in yet — they need to click the email
    // confirmation link first. The modal shows the "check your email"
    // state when this resolves.
    return { pendingVerification: true };
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setCustomer(null);
    persistToken(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const res = await axios.get(`${API_BASE}/v1/customer-auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setCustomer(res.data);
    } catch {
      logout();
    }
  }, [token, logout]);

  return { customer, isLoading, token, login, signup, logout, refresh };
}

/**
 * Helper for components that need to call API endpoints on behalf of
 * the customer. Reads the token off localStorage so it works in
 * non-React contexts (mutation callbacks, etc.) without prop drilling.
 */
export function getCustomerAuthHeader(): Record<string, string> | undefined {
  if (typeof window === "undefined") return undefined;
  const t = window.localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : undefined;
}
