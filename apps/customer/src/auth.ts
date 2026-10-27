import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { brand } from "./brand";

// The customer's storefront session, shared by the native screens and the
// storefront in the Order tab's WebView.
//
// Google refuses its OAuth page inside a WebView ("disallowed_useragent"),
// so the app signs in with the native Google / Apple SDKs, swaps the ID
// token for a storefront session at POST /customer-auth/native, and writes
// that session into the WebView's localStorage under the key the
// storefront's useCustomerAuth reads. The WebView reports every change the
// storefront makes to that key (email sign-in, sliding refresh, sign-out), so
// whichever side signed in or out last wins.

/** apps/web/src/hooks/use-customer-auth.ts TOKEN_KEY. */
export const STOREFRONT_TOKEN_KEY = "orderhub.customerToken";
const STORE_KEY = "orderhub.session";

export type Provider = "apple" | "google";

export type Customer = { firstName: string | null; lastName: string | null; email: string | null };

export type AuthState = {
  token: string | null;
  customer: Customer | null;
  /** Set by a native sign-out until the WebView has cleared its own copy. */
  signOutNonce: string | null;
  /** Bumped when the WebView must reload to pick up a new session. */
  version: number;
};

type SignInConfig = {
  apple: boolean;
  google: { iosClientId: string; webClientId: string; android: boolean } | null;
};

const signInConfig: SignInConfig = brand.signIn ?? { apple: false, google: null };

let state: AuthState = { token: null, customer: null, signOutNonce: null, version: 0 };
const listeners = new Set<(s: AuthState) => void>();

function setState(patch: Partial<AuthState>, opts: { reloadWebView?: boolean } = {}) {
  state = { ...state, ...patch, version: state.version + (opts.reloadWebView ? 1 : 0) };
  listeners.forEach((l) => l(state));
  const { token, customer, signOutNonce } = state;
  AsyncStorage.setItem(STORE_KEY, JSON.stringify({ token, customer, signOutNonce })).catch(() => {});
}

export function getAuth(): AuthState {
  return state;
}

export function useAuth(): AuthState {
  const [s, set] = useState(state);
  useEffect(() => {
    listeners.add(set);
    set(state);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return s;
}

/** Before the first screen renders, so the WebView starts with the session. */
export async function loadAuth(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state = {
      token: typeof saved.token === "string" ? saved.token : null,
      customer: saved.customer ?? null,
      signOutNonce: typeof saved.signOutNonce === "string" ? saved.signOutNonce : null,
      version: 0,
    };
  } catch {
    // A corrupt entry just means signed out.
  }
}

// ── native SDKs ─────────────────────────────────────────────────────────
//
// Required lazily: an over-the-air update can reach a build made before these
// native modules were added, and a top-level import would crash it on launch.
// There, the buttons simply don't show.

function appleModule(): typeof import("expo-apple-authentication") | null {
  try {
    return require("expo-apple-authentication");
  } catch {
    return null;
  }
}

function googleModule(): typeof import("@react-native-google-signin/google-signin") | null {
  try {
    return require("@react-native-google-signin/google-signin");
  } catch {
    return null;
  }
}

/** What the build can offer: native module present and configured. */
async function buildProviders(): Promise<Provider[]> {
  const out: Provider[] = [];
  if (Platform.OS === "ios" && signInConfig.apple) {
    const apple = appleModule();
    if (apple && (await apple.isAvailableAsync().catch(() => false))) out.push("apple");
  }
  const g = signInConfig.google;
  if (g && (Platform.OS === "ios" || (Platform.OS === "android" && g.android)) && googleModule()) {
    out.push("google");
  }
  return out;
}

// ── Admin switch (Admin Dashboard → Social login) ───────────────────────
//
// Which buttons this brand's app may show, per platform. Off unless the
// platform team switched it on, so an app submitted without social sign-in
// stays that way. The last answer is kept for offline launches; with none
// at all, nothing shows.

type SocialLoginFlags = { ios: { apple: boolean; google: boolean }; android: { google: boolean } };
const FLAGS_KEY = "orderhub.socialLogin";
const FLAGS_TTL_MS = 5 * 60 * 1000;
let flagsCache: { at: number; value: Promise<SocialLoginFlags | null> } | null = null;

async function fetchFlags(): Promise<SocialLoginFlags | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(
      `${brand.apiUrl}/v1/public/customer-app/${encodeURIComponent(brand.brandId)}/social-login`,
      { signal: ctrl.signal },
    );
    if (!res.ok) throw new Error(String(res.status));
    const flags = (await res.json()) as SocialLoginFlags;
    AsyncStorage.setItem(FLAGS_KEY, JSON.stringify(flags)).catch(() => {});
    return flags;
  } catch {
    const saved = await AsyncStorage.getItem(FLAGS_KEY).catch(() => null);
    return saved ? (JSON.parse(saved) as SocialLoginFlags) : null;
  } finally {
    clearTimeout(timer);
  }
}

function socialLoginFlags(): Promise<SocialLoginFlags | null> {
  if (!flagsCache || Date.now() - flagsCache.at > FLAGS_TTL_MS) {
    flagsCache = { at: Date.now(), value: fetchFlags() };
  }
  return flagsCache.value;
}

/** The buttons to show: what the build can do AND what the admin switched on. */
export async function availableProviders(): Promise<Provider[]> {
  const [canDo, flags] = await Promise.all([buildProviders(), socialLoginFlags()]);
  if (!flags) return [];
  const on = (p: Provider) =>
    Platform.OS === "ios"
      ? p === "apple"
        ? flags.ios?.apple === true
        : flags.ios?.google === true && flags.ios?.apple === true
      : p === "google" && flags.android?.google === true;
  const shown = canDo.filter(on);
  // Never Google alone on iOS, even if this build can't offer Apple (4.8).
  if (Platform.OS === "ios" && !shown.includes("apple")) return [];
  return shown;
}

export class SignInCancelled extends Error {}

async function appleIdToken(): Promise<{ idToken: string; firstName?: string; lastName?: string }> {
  const apple = appleModule();
  if (!apple) throw new Error("Sign in with Apple isn't available in this version of the app.");
  try {
    const cred = await apple.signInAsync({
      requestedScopes: [
        apple.AppleAuthenticationScope.FULL_NAME,
        apple.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!cred.identityToken) throw new Error("Apple didn't return a sign-in token.");
    // Only present the first time this Apple ID signs in to this app; the
    // API saves it then.
    return {
      idToken: cred.identityToken,
      firstName: cred.fullName?.givenName ?? undefined,
      lastName: cred.fullName?.familyName ?? undefined,
    };
  } catch (err: any) {
    if (err?.code === "ERR_REQUEST_CANCELED") throw new SignInCancelled();
    throw err;
  }
}

let googleConfigured = false;

async function googleIdToken(): Promise<{ idToken: string }> {
  const mod = googleModule();
  const g = signInConfig.google;
  if (!mod || !g) throw new Error("Sign in with Google isn't available in this version of the app.");
  const { GoogleSignin, isSuccessResponse, isErrorWithCode, statusCodes } = mod;
  if (!googleConfigured) {
    // webClientId makes the ID token's audience the web client the API
    // checks, on both platforms.
    GoogleSignin.configure({ webClientId: g.webClientId, iosClientId: g.iosClientId });
    googleConfigured = true;
  }
  try {
    if (Platform.OS === "android") await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const res = await GoogleSignin.signIn();
    if (!isSuccessResponse(res)) throw new SignInCancelled();
    if (!res.data.idToken) throw new Error("Google didn't return a sign-in token.");
    return { idToken: res.data.idToken };
  } catch (err) {
    if (isErrorWithCode(err) && err.code === statusCodes.SIGN_IN_CANCELLED) throw new SignInCancelled();
    throw err;
  } finally {
    // Our session is the storefront's, not Google's: forget the Google one so
    // the next sign-in offers the account picker again.
    GoogleSignin.signOut().catch(() => {});
  }
}

const api = `${brand.apiUrl}/v1/customer-auth`;

/** Native sign-in → storefront session. Throws SignInCancelled on cancel. */
export async function signIn(provider: Provider): Promise<Customer> {
  const native = provider === "apple" ? await appleIdToken() : await googleIdToken();
  const res = await fetch(`${api}/native`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, brandId: brand.brandId, ...native }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.accessToken) {
    throw new Error(body?.message ? String(body.message) : `Sign-in failed (${res.status})`);
  }
  const customer = toCustomer(body.customer);
  setState({ token: body.accessToken, customer, signOutNonce: null }, { reloadWebView: true });
  return customer;
}

export function signOut() {
  setState({ token: null, customer: null, signOutNonce: String(Date.now()) }, { reloadWebView: true });
}

/** App Store guideline 5.1.1(v): delete the account from inside the app. */
export async function deleteAccount(): Promise<void> {
  if (!state.token) throw new Error("Not signed in");
  const res = await fetch(`${api}/me`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
    body: JSON.stringify({ confirm: "DELETE" }),
  });
  if (!res.ok && res.status !== 401) throw new Error(`Couldn't delete the account (${res.status})`);
  signOut();
}

/** Who the token belongs to, for the Settings screen; drops a dead token. */
export async function refreshCustomer(): Promise<void> {
  const token = state.token;
  if (!token) return;
  try {
    const res = await fetch(`${api}/me`, { headers: { authorization: `Bearer ${token}` } });
    if (state.token !== token) return;
    if (res.status === 401 || res.status === 403) {
      setState({ token: null, customer: null });
      return;
    }
    if (!res.ok) return;
    const body = await res.json();
    setState({ customer: toCustomer(body), token: body.accessToken ?? token });
  } catch {
    // Offline: keep what we have.
  }
}

/** The storefront wrote or removed its session (reported by the bridge). */
export function storefrontSessionChanged(token: string | null) {
  if (token === state.token && !state.signOutNonce) return;
  if (token) {
    const sameUser = state.token != null && state.customer != null;
    setState({ token, signOutNonce: null, customer: sameUser ? state.customer : null });
    if (!sameUser) refreshCustomer();
  } else if (!state.signOutNonce) {
    setState({ token: null, customer: null });
  }
}

/** The WebView finished a native sign-out; stop re-applying it. */
export function storefrontSignedOut(nonce: string) {
  if (state.signOutNonce === nonce) setState({ signOutNonce: null });
}

function toCustomer(c: any): Customer {
  return { firstName: c?.firstName || null, lastName: c?.lastName || null, email: c?.email || null };
}

/**
 * Runs before the storefront's own scripts on every page load, so its
 * useCustomerAuth starts with the app's session. After a native sign-out it
 * clears the storefront's token and its HttpOnly cookie (the API's logout
 * route, through both the storefront's /api proxy and the API host), then
 * reloads once so nothing signed-in survives on the page.
 */
export function sessionScript(s: AuthState, providers: Provider[]): string {
  const j = JSON.stringify;
  // Once per document: OrderScreen injects this before load AND after it
  // (Android can lose the first), and a second run mid-sign-out would log
  // out and reload twice.
  return `(function () {
  if (window.__ohSession) return;
  window.__ohSession = true;
  var K = ${j(STOREFRONT_TOKEN_KEY)}, D = "orderhub.app.signedOut";
  var want = ${j(s.token)}, out = ${j(s.signOutNonce)}, api = ${j(brand.apiUrl)};
  window.OrderHubApp = {
    signInProviders: ${j(providers)},
    signIn: function (p) {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: "sign-in", provider: p }));
    }
  };
  try {
    if (out && localStorage.getItem(D) !== out) {
      window.__ohSigningOut = true;
      localStorage.removeItem(K);
      var post = function (u) { return fetch(u, { method: "POST", credentials: "include" }).catch(function () {}); };
      Promise.all([post(location.origin + "/api/v1/customer-auth/logout"), post(api + "/v1/customer-auth/logout")]).then(function () {
        localStorage.removeItem(K);
        localStorage.setItem(D, out);
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: "signed-out", nonce: out }));
        location.reload();
      });
    } else if (out) {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: "signed-out", nonce: out }));
    } else if (want && localStorage.getItem(K) !== want) {
      localStorage.setItem(K, want);
    }
  } catch (e) {}
})();
`;
}
