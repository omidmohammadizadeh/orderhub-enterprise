"use client";

// "Add to Apple Wallet" / "Add to Google Wallet" for a loyalty card, chosen by
// the phone: an iPhone sees Apple, an Android sees Google, a computer sees
// both. Used by the walk-in card page and the storefront Rewards page, so a
// customer gets the same buttons wherever they open their card.

import { useEffect, useState } from "react";
import { Loader2, Smartphone } from "lucide-react";
import { walkInPublic } from "@/lib/api/loyalty-walk-in.client";

type Platform = "ios" | "android" | "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

export function WalletButtons({
  token,
  wallet,
  fallbackText = "Bookmark this page or add it to your home screen, and show the QR at the till each time you order.",
}: {
  token: string;
  wallet: { apple: boolean; google: boolean };
  /** Shown when neither wallet is available on this phone. */
  fallbackText?: string;
}) {
  const [platform, setPlatform] = useState<Platform>("other");
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPlatform(detectPlatform()), []);

  const apple = wallet.apple && platform !== "android";
  const google = wallet.google && platform !== "ios";

  async function addToGoogle() {
    setError(null);
    setGoogleBusy(true);
    try {
      const { url } = await walkInPublic.googleUrl(token);
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
      setGoogleBusy(false);
    }
  }

  if (!apple && !google) {
    return (
      <div className="flex items-start gap-3 rounded-2xl bg-white/[0.06] px-4 py-3.5 text-sm text-white/70">
        <Smartphone className="mt-0.5 h-5 w-5 shrink-0" />
        <p>{fallbackText}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {apple && (
        <a
          href={walkInPublic.appleUrl(token)}
          className="flex h-14 w-full items-center justify-center gap-3 rounded-2xl bg-black text-base font-semibold text-white ring-1 ring-white/25 transition active:scale-[0.99]"
        >
          <AppleWalletGlyph />
          Add to Apple Wallet
        </a>
      )}
      {google && (
        <button
          type="button"
          onClick={addToGoogle}
          disabled={googleBusy}
          className="flex h-14 w-full items-center justify-center gap-3 rounded-2xl bg-white text-base font-semibold text-zinc-950 transition active:scale-[0.99] disabled:opacity-60"
        >
          {googleBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : <GoogleWalletGlyph />}
          Add to Google Wallet
        </button>
      )}
      {error && <p className="text-center text-sm text-red-300">{error}</p>}
      <p className="text-center text-xs text-white/50">Once it&apos;s in your wallet, stamps appear on it by themselves.</p>
    </div>
  );
}

function AppleWalletGlyph() {
  // Stacked cards — the Wallet motif, drawn rather than Apple's badge artwork.
  return (
    <svg viewBox="0 0 28 22" className="h-6 w-7" aria-hidden>
      <rect x="1" y="1" width="26" height="20" rx="4" fill="#fff" />
      <rect x="3" y="3" width="22" height="6" rx="1.5" fill="#3D9BF4" />
      <rect x="3" y="6" width="22" height="6" rx="1.5" fill="#F7B500" />
      <rect x="3" y="9" width="22" height="6" rx="1.5" fill="#FF5B3A" />
      <path d="M1 13h7.5a5.5 5.5 0 0 0 11 0H27v4a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4z" fill="#D9D9D9" />
    </svg>
  );
}

function GoogleWalletGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
      <path d="M3 7.5A3.5 3.5 0 0 1 6.5 4h11A3.5 3.5 0 0 1 21 7.5V9H3z" fill="#4285F4" />
      <path d="M3 9h18v2.5H3z" fill="#34A853" />
      <path d="M3 11.5h18V14H3z" fill="#FBBC04" />
      <path d="M3 14h18v2.5A3.5 3.5 0 0 1 17.5 20h-11A3.5 3.5 0 0 1 3 16.5z" fill="#EA4335" />
    </svg>
  );
}
