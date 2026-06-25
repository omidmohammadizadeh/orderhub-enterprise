"use client";

import { useEffect, useState } from "react";

// Phase AX — dependency-free Google Maps JS loader. Injects the script once
// (guarded by a module-level promise on window) and resolves when the API is
// ready. Uses the referrer-restricted browser key NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google?: any;
    __ohGoogleMapsPromise?: Promise<void>;
  }
}

export function useGoogleMaps(): { ready: boolean; error: string | null } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key) {
      setError("Maps key not configured (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY)");
      return;
    }
    if (window.google?.maps) {
      setReady(true);
      return;
    }
    if (!window.__ohGoogleMapsPromise) {
      window.__ohGoogleMapsPromise = new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=marker`;
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Google Maps"));
        document.head.appendChild(script);
      });
    }
    let cancelled = false;
    window.__ohGoogleMapsPromise
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { ready, error };
}
