import Constants from "expo-constants";

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string };

/** OrderHub API base, e.g. https://orderhub-api-0re6.onrender.com/api (no trailing slash). */
export const API_URL = (
  process.env.EXPO_PUBLIC_EFL_API_URL ||
  extra.apiUrl ||
  "https://orderhub-api-0re6.onrender.com/api"
).replace(/\/+$/, "");

/**
 * DEV-ONLY sample-data mode (EXPO_PUBLIC_EFL_MOCK=1). Every API call is
 * answered from src/api/mock so each screen can be shown before any shop is
 * listed. It is ignored in release builds, so a stray env var can never ship
 * an app that takes fake orders.
 */
export const MOCK = __DEV__ && process.env.EXPO_PUBLIC_EFL_MOCK === "1";

export const STRIPE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
export const APPLE_PAY_MERCHANT_ID = "merchant.com.eatforless.app";

export const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? "";
export const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? "";

/** Where we start before the customer gives an address: central Newcastle (pilot area). */
export const PILOT_CENTRE = { lat: 54.9738, lng: -1.6132, label: "Newcastle upon Tyne" };
