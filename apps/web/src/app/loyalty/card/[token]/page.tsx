"use client";

// A customer's walk-in loyalty card. The link (texted, or reached straight
// after joining) is the only credential.
//
// The job of this page is to get the card into Apple Wallet or Google Wallet,
// after which the customer never needs it again — the pass updates by itself.
// Until then it is the card: it shows the QR the till scans and refreshes
// while open, so a stamp appears while they are still at the counter.

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Gift, Loader2, Smartphone } from "lucide-react";
import { WalletCard } from "@/components/loyalty/wallet-card";
import { walkInPublic, type PublicCard } from "@/lib/api/loyalty-walk-in.client";

type Platform = "ios" | "android" | "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

export default function LoyaltyCardPage() {
  const { token } = useParams<{ token: string }>();
  const [isNew, setIsNew] = useState(false);
  const [card, setCard] = useState<PublicCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>("other");
  const [googleBusy, setGoogleBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [popStamp, setPopStamp] = useState(false);
  const lastStamps = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await walkInPublic.card(token);
      // Animate a stamp that arrived while the page was open.
      if (lastStamps.current !== null && next.stamps !== lastStamps.current) setPopStamp(true);
      lastStamps.current = next.stamps;
      setCard(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token]);

  useEffect(() => {
    setPlatform(detectPlatform());
    setIsNew(new URLSearchParams(window.location.search).get("new") === "1");
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function addToGoogle() {
    setWalletError(null);
    setGoogleBusy(true);
    try {
      const { url } = await walkInPublic.googleUrl(token);
      window.location.href = url;
    } catch (e) {
      setWalletError((e as Error).message);
      setGoogleBusy(false);
    }
  }

  if (error && !card) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-center text-white">
        <div>
          <p className="text-lg font-semibold">Card not found</p>
          <p className="mt-1 text-sm text-white/60">Check the link, or ask at the counter for a new one.</p>
        </div>
      </main>
    );
  }
  if (!card) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950">
        <Loader2 className="h-6 w-6 animate-spin text-white/50" />
      </main>
    );
  }

  const apple = card.wallet.apple && platform !== "android";
  const google = card.wallet.google && platform !== "ios";
  const ready = card.rewards.length;

  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-[60vh] opacity-60"
        style={{ background: `radial-gradient(80% 60% at 50% 0%, ${card.color} 0%, transparent 70%)` }}
      />
      <div className="relative mx-auto w-full max-w-md px-4 pb-12 pt-7">
        <p className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
          {isNew ? "Welcome — here's your card" : "Your loyalty card"}
        </p>

        <div className="mt-5">
          <WalletCard
            title={card.title}
            color={card.color}
            logoUrl={card.logoUrl}
            stamps={card.stamps}
            stampsRequired={card.stampsRequired}
            rewardLabel={card.rewardLabel}
            rewardsReady={ready}
            firstName={card.firstName}
            scan={card.scan}
            code={card.code}
            highlightLast={popStamp}
          />
        </div>

        {!card.active && (
          <p className="mt-4 rounded-xl bg-amber-500/15 px-4 py-3 text-center text-sm text-amber-100">
            {card.title} has paused its loyalty card. Your stamps are kept.
          </p>
        )}

        {ready > 0 && (
          <div className="mt-4 flex items-center gap-3 rounded-2xl bg-white/[0.08] px-4 py-3.5 ring-1 ring-white/15">
            <Gift className="h-6 w-6 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {ready === 1 ? "Your reward is ready" : `${ready} rewards ready`}
              </p>
              <p className="truncate text-xs text-white/65">
                Show this card at the till to claim {card.rewards[0]!.label.toLowerCase()}.
              </p>
            </div>
          </div>
        )}

        {(apple || google) && (
          <div className="mt-6 space-y-3">
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
            {walletError && <p className="text-center text-sm text-red-300">{walletError}</p>}
            <p className="text-center text-xs text-white/50">
              Once it&apos;s in your wallet, stamps appear on it by themselves.
            </p>
          </div>
        )}

        {!apple && !google && (
          <div className="mt-6 flex items-start gap-3 rounded-2xl bg-white/[0.06] px-4 py-3.5 text-sm text-white/70">
            <Smartphone className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              Bookmark this page or add it to your home screen, and show the QR at the till each time you
              order.
            </p>
          </div>
        )}

        <section className="mt-8 space-y-3 text-sm text-white/65">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">How it works</h2>
          <p>{card.earnRule}</p>
          <p>Show this card at the till when you pay — the staff scan it and your stamp lands straight away.</p>
          {card.expiryNote && <p>{card.expiryNote}</p>}
        </section>
      </div>
    </main>
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
