"use client";

// Registers the offline app-shell service worker (public/sw.js). The SW is
// network-first, so it never changes online behaviour — it only serves its
// cache when the device is offline, letting the POS boot with no connection.

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator) ||
      // Skip in dev to avoid caching the HMR dev server.
      process.env.NODE_ENV !== "production"
    ) {
      return;
    }
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* SW registration is best-effort — never block the app */
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
