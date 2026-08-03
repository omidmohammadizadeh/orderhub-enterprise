"use client";

// Registers the shared service worker (public/sw.js), which does two jobs:
// the offline app-shell for the POS (network-first, so online behaviour is
// unchanged — the cache is only reached for when the device has no
// connection), and Web Push for customer order updates on the storefront.
//
// Registration is skipped outside production, which also means push cannot be
// exercised against a dev server — it needs a production build.

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
