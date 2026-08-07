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

// Same-tab fan-out.
//
// Every caller of useCustomerAuth() gets its OWN useState, and the `storage`
// event that syncs other tabs deliberately does NOT fire in the tab that wrote
// it. So when the login modal signed someone in, the storefront page and the
// header — separate instances — never found out: the token was saved
// correctly, the header still said "Sign in", and the pending "place order"
// replay never fired. The customer concludes login is broken and signs in
// again, which is the "why do I have to log in every time" complaint.
//
// A module-level subscriber list keeps every instance in step within the tab;
// the storage listener still covers other tabs.
type AuthSnapshot = { customer: Customer | null; token: string | null };
const authSubscribers = new Set<(s: AuthSnapshot) => void>();
function broadcastAuth(snapshot: AuthSnapshot) {
  for (const fn of authSubscribers) fn(snapshot);
}

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
    // No token in localStorage is NOT proof of being signed out any more.
    // The session also lives in an HttpOnly cookie, which survives the two
    // things that were logging customers out: iOS Safari purging
    // script-writable storage after 7 days, and in-app webviews (WhatsApp,
    // Instagram) that start with empty storage every time a shared ordering
    // link is opened. So ask /me regardless — the cookie rides along
    // automatically because the storefront proxies /api on its own origin.
    if (stored) setToken(stored);
    const meUrl = `${API_BASE}/v1/customer-auth/me`;
    // eslint-disable-next-line no-console
    console.log(`[customer-auth] GET ${meUrl}`);
    axios
      .get(meUrl, {
        headers: stored ? { Authorization: `Bearer ${stored}` } : undefined,
        // Same-origin via the /api rewrite, but explicit so a future change
        // of base URL does not silently stop sending the cookie.
        withCredentials: true,
      })
      .then((res) => {
        // eslint-disable-next-line no-console
        console.log("[customer-auth] /me 200 →", res.data);
        // /me re-signs a fresh 90-day token on every call (sliding
        // session) — persist it over the one we sent so an actively
        // returning customer's login never actually expires.
        const { accessToken: freshToken, ...customerData } = res.data ?? {};
        setCustomer(customerData);
        if (freshToken) {
          setToken(freshToken);
          persistToken(freshToken);
        }
        broadcastAuth({ customer: customerData, token: freshToken ?? stored });
      })
      .catch((err: any) => {
        const status = err?.response?.status;
        // eslint-disable-next-line no-console
        console.error(
          `[customer-auth] /me FAILED status=${status} message=${err?.response?.data?.message ?? err?.message}`,
        );
        // ONLY drop the session on a real auth failure (401/403 = token
        // expired or revoked). A network blip, CORS hiccup, or 5xx must
        // NOT log the customer out — otherwise a transient error on revisit
        // wipes their 30-day session and forces a needless re-login. Keep
        // the token so the next request retries; leave customer null so the
        // header briefly shows "Sign in" until /me succeeds.
        if (status === 401 || status === 403) {
          window.localStorage.removeItem(TOKEN_KEY);
          setToken(null);
          setCustomer(null);
        }
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Same-tab sync — every other instance of this hook follows immediately.
  useEffect(() => {
    const onLocal = (snap: AuthSnapshot) => {
      setCustomer(snap.customer);
      setToken(snap.token);
      setIsLoading(false);
    };
    authSubscribers.add(onLocal);
    return () => {
      authSubscribers.delete(onLocal);
    };
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
    const res = await axios.post(
      `${API_BASE}/v1/customer-auth/login`,
      { email, password },
      // So the server's Set-Cookie is stored, not discarded.
      { withCredentials: true },
    );
    setToken(res.data.accessToken);
    setCustomer(res.data.customer);
    persistToken(res.data.accessToken);
    broadcastAuth({ customer: res.data.customer, token: res.data.accessToken });
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
    broadcastAuth({ customer: null, token: null });
    // Clear the cookie too, or the next /me would sign them straight back in
    // — the session outliving a deliberate sign-out is worse than the problem
    // this cookie was added to solve. Fire-and-forget: the local state is
    // already cleared, and a failed call must not leave them stuck.
    void axios
      .post(
        `${API_BASE}/v1/customer-auth/logout`,
        {},
        { withCredentials: true },
      )
      .catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const res = await axios.get(`${API_BASE}/v1/customer-auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const { accessToken: freshToken, ...customerData } = res.data ?? {};
      setCustomer(customerData);
      if (freshToken) {
        setToken(freshToken);
        persistToken(freshToken);
      }
      broadcastAuth({ customer: customerData, token: freshToken ?? token });
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
