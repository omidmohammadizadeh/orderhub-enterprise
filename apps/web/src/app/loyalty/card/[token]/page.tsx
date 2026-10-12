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
import { Gift, Loader2 } from "lucide-react";
import { WalletButtons } from "@/components/loyalty/wallet-buttons";
import { WalletCard } from "@/components/loyalty/wallet-card";
import { walkInPublic, type PublicCard } from "@/lib/api/loyalty-walk-in.client";

export default function LoyaltyCardPage() {
  const { token } = useParams<{ token: string }>();
  const [isNew, setIsNew] = useState(false);
  const [card, setCard] = useState<PublicCard | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    setIsNew(new URLSearchParams(window.location.search).get("new") === "1");
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

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
            stampIcon={card.stampIcon}
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

        <div className="mt-6">
          <WalletButtons token={token} wallet={card.wallet} />
        </div>

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
