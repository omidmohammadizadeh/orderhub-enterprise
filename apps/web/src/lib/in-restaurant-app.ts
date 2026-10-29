"use client";

import { useEffect, useState } from "react";

/** The white-label restaurant apps (apps/customer) show the storefront in a
 *  WebView whose user agent ends in "OrderHubApp/<brand>". */
export function inRestaurantApp(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("OrderHubApp/");
}

/** Same answer as a hook. False on the server and the first client render, so
 *  the HTML the server sent and the first paint agree. */
export function useInRestaurantApp(): boolean {
  const [inApp, setInApp] = useState(false);
  useEffect(() => setInApp(inRestaurantApp()), []);
  return inApp;
}

/** The restaurant app's URL scheme ("orderhub-<brand>"), read from the
 *  WebView user agent "OrderHubApp/<brand>". Null outside an app. */
export function restaurantAppScheme(): string | null {
  if (typeof navigator === "undefined") return null;
  const slug = navigator.userAgent.match(/OrderHubApp\/([a-z0-9]+)/)?.[1];
  return slug ? `orderhub-${slug}` : null;
}

/**
 * A payment page opened from a restaurant app on Android runs in a Chrome
 * tab, not the app (Google Pay needs real Chrome there). When it lands back
 * on one of our return pages carrying `appReturn=<scheme>`, hand the
 * customer to the app, which closes the tab and shows this page itself.
 *
 * Only outside the app: inside it (iOS payment sheet, or the storefront
 * WebView) the param is inert. Returns true when it redirected.
 */
export function bounceBackToRestaurantApp(): boolean {
  const target = restaurantAppReturnUrl();
  if (!target) return false;
  window.location.replace(target);
  return true;
}

/** The app link bounceBackToRestaurantApp follows — also for a button, since
 *  Chrome may refuse to open an app from script without a tap. */
export function restaurantAppReturnUrl(): string | null {
  if (typeof window === "undefined" || inRestaurantApp()) return null;
  const url = new URL(window.location.href);
  const scheme = url.searchParams.get("appReturn");
  if (!scheme || !/^orderhub-[a-z0-9]{1,40}$/.test(scheme)) return null;
  url.searchParams.delete("appReturn");
  return `${scheme}://payment-return?to=${encodeURIComponent(url.toString())}`;
}
