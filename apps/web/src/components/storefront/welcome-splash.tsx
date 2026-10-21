"use client";

// The phone welcome screen: a full-screen picture the shop chose (Christmas,
// Ramadan, a new deal) shown once when a customer opens the link on a phone.
//
// Rules, because an advert in front of a menu is only welcome if it never
// slows anyone down:
//   • phones only — on a laptop it is just a big box in the way;
//   • once a day per picture — a regular re-ordering their usual sees it
//     once, not every visit;
//   • the menu loads behind it, and if the picture isn't ready within a
//     moment it is skipped rather than waited for;
//   • "Order now", the ✕, Escape, or six seconds all close it.
//
// `?splash=preview` forces it on any screen and ignores "already seen", so
// the shop can look at it from the dashboard.

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export interface WelcomeSplashData {
  id: string;
  imageUrl: string;
  headline: string | null;
  subline: string | null;
}

const AUTO_CLOSE_MS = 6000;
const LOAD_GIVE_UP_MS = 2500;

export function WelcomeSplash({
  splash,
  storeKey,
  shopName,
  preview,
  skip,
}: {
  splash: WelcomeSplashData | null | undefined;
  /** Slug — "seen today" is remembered per shop. */
  storeKey: string;
  shopName?: string | null;
  preview?: boolean;
  /** e.g. a group-order or re-order link: they came to do one thing. */
  skip?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!splash?.imageUrl || skip) return;
    const isPhone = window.matchMedia("(max-width: 767px)").matches;
    if (!isPhone && !preview) return;

    const key = `oh-splash:${storeKey}:${splash.id}`;
    const today = new Date().toDateString();
    if (!preview) {
      try {
        if (localStorage.getItem(key) === today) return;
      } catch {
        /* private mode: show it, it just won't be remembered */
      }
    }

    let cancelled = false;
    const img = new Image();
    const giveUp = window.setTimeout(() => {
      cancelled = true;
    }, LOAD_GIVE_UP_MS);
    img.onload = () => {
      window.clearTimeout(giveUp);
      if (cancelled) return;
      setOpen(true);
      try {
        localStorage.setItem(key, today);
      } catch {
        /* ignore */
      }
    };
    img.onerror = () => window.clearTimeout(giveUp);
    img.src = splash.imageUrl;
    return () => {
      cancelled = true;
      window.clearTimeout(giveUp);
    };
  }, [splash?.id, splash?.imageUrl, storeKey, preview, skip]);

  const close = () => {
    setLeaving(true);
    window.setTimeout(() => setOpen(false), 220);
  };

  useEffect(() => {
    if (!open) return;
    closeBtn.current?.focus();
    const t = window.setTimeout(close, AUTO_CLOSE_MS);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", esc);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open || !splash) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={splash.headline ?? `Welcome to ${shopName ?? "our shop"}`}
      className={`fixed inset-0 z-[200] bg-black transition-opacity duration-200 motion-reduce:transition-none ${
        leaving ? "opacity-0" : "opacity-100 motion-safe:animate-[ohSplashIn_.35s_ease-out]"
      }`}
    >
      <style>{`@keyframes ohSplashIn{from{opacity:0;transform:scale(1.03)}to{opacity:1;transform:scale(1)}}@keyframes ohSplashBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}`}</style>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={splash.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/55 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-[45%] bg-gradient-to-t from-black/85 via-black/45 to-transparent" />

      {/* Time left before it closes itself. */}
      <div className="absolute inset-x-0 top-0 h-1 bg-white/15" style={{ marginTop: "env(safe-area-inset-top)" }}>
        <div
          className="h-full origin-left bg-white/80 motion-reduce:hidden"
          style={{ animation: `ohSplashBar ${AUTO_CLOSE_MS}ms linear forwards` }}
        />
      </div>

      <button
        ref={closeBtn}
        type="button"
        onClick={close}
        aria-label="Close and go to the menu"
        className="absolute right-4 grid h-11 w-11 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        style={{ top: "calc(env(safe-area-inset-top) + 16px)" }}
      >
        <X className="h-5 w-5" />
      </button>

      <div
        className="absolute inset-x-0 bottom-0 px-6 text-center text-white"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 28px)" }}
      >
        {splash.headline && (
          <h2 className="text-[28px] font-bold leading-tight tracking-tight [text-shadow:0_2px_12px_rgba(0,0,0,.45)]">
            {splash.headline}
          </h2>
        )}
        {splash.subline && (
          <p className="mx-auto mt-2 max-w-xs text-base text-white/85 [text-shadow:0_1px_8px_rgba(0,0,0,.5)]">
            {splash.subline}
          </p>
        )}
        <button
          type="button"
          onClick={close}
          className="mt-5 min-h-[56px] w-full max-w-sm rounded-full bg-orange-500 px-6 text-lg font-semibold text-white shadow-lg shadow-black/30 transition active:scale-[.98] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/60"
        >
          Order now
        </button>
      </div>
    </div>
  );
}
