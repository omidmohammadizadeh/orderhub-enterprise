"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { inRestaurantApp } from "@/lib/in-restaurant-app";

/** The brand's own app, as the storefront API sends it when it's being
 *  promoted (Admin → Restaurant apps). Null/absent = say nothing. */
export type CustomerAppLinks = {
  android: string | null;
  ios: string | null;
  iosAppStoreId: string | null;
};

type Platform = "ios" | "android" | "other";

function platform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

/** Safari on iOS draws Apple's own Smart App Banner from the page's
 *  apple-itunes-app meta tag; showing ours as well would stack two. */
function appleBannerShows(app: CustomerAppLinks): boolean {
  if (!app.iosAppStoreId || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(ua) && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//i.test(ua);
}

const DISMISS_DAYS = 30;
const dismissKey = (id: string) => `oh-app-banner-dismissed:${id}`;

/**
 * "Get the app" strip at the top of the storefront, on phones only, linking
 * to the right store for the device. Not inside the app, not on desktop,
 * not where Apple's banner already shows, and quiet for 30 days after the
 * customer closes it.
 */
export function AppInstallBanner({
  app,
  brandKey,
  name,
  logoUrl,
}: {
  app: CustomerAppLinks | null | undefined;
  brandKey: string;
  name: string;
  logoUrl?: string | null;
}) {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    if (!app || inRestaurantApp() || appleBannerShows(app)) return;
    const p = platform();
    const link = p === "ios" ? app.ios : p === "android" ? app.android : null;
    if (!link) return;
    try {
      const at = Number(localStorage.getItem(dismissKey(brandKey)) || 0);
      if (at && Date.now() - at < DISMISS_DAYS * 86_400_000) return;
    } catch {
      /* storage blocked: just show it */
    }
    setHref(link);
  }, [app, brandKey]);

  if (!href) return null;

  const close = () => {
    try {
      localStorage.setItem(dismissKey(brandKey), String(Date.now()));
    } catch {
      /* fine: it hides for this visit */
    }
    setHref(null);
  };

  return (
    <div className="flex items-center gap-3 border-b border-zinc-200 bg-white px-3 py-2.5" role="region" aria-label={`${name} app`}>
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="h-10 w-10 shrink-0 rounded-xl border border-zinc-200 bg-white object-contain" />
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-zinc-900">{name}</p>
        <p className="truncate text-xs text-zinc-500">Faster ordering and live tracking in the app</p>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noopener"
        className="shrink-0 rounded-full bg-zinc-900 px-4 py-2 text-sm font-bold text-white hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
      >
        Get the app
      </a>
    </div>
  );
}

/** After ordering: "Track your next order in the app", with the store
 *  button for this phone (both stores on a computer). */
export function AppInstallCard({
  app,
  name,
  className = "",
}: {
  app: CustomerAppLinks | null | undefined;
  name: string;
  className?: string;
}) {
  const [links, setLinks] = useState<{ ios: string | null; android: string | null } | null>(null);

  useEffect(() => {
    if (!app || inRestaurantApp()) return;
    const p = platform();
    const ios = p === "android" ? null : app.ios;
    const android = p === "ios" ? null : app.android;
    if (ios || android) setLinks({ ios, android });
  }, [app]);

  if (!links) return null;

  const btn = "inline-flex items-center justify-center rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900";
  return (
    <div className={`rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-center ${className}`}>
      <p className="text-base font-extrabold text-zinc-900">Order faster with the {name} app</p>
      <p className="mt-1 text-sm text-zinc-500">Live driver tracking, order updates and offers, all in one place.</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {links.ios ? (
          <a href={links.ios} target="_blank" rel="noopener" className={btn}>
            Download on the App Store
          </a>
        ) : null}
        {links.android ? (
          <a href={links.android} target="_blank" rel="noopener" className={btn}>
            Get it on Google Play
          </a>
        ) : null}
      </div>
    </div>
  );
}
