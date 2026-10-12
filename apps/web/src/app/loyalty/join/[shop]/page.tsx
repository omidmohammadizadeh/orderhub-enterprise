"use client";

// Join a shop's loyalty card — where the QR poster on the counter lands.
//
// One screen, thumb-sized: the card they are about to get, two fields, one
// button. A new number goes straight to its card; a number that already has
// one is texted its link instead of shown it (whoever is typing may not own
// that phone).

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, Loader2, MessageSquare } from "lucide-react";
import { WalletCard } from "@/components/loyalty/wallet-card";
import { walkInPublic, type JoinInfo } from "@/lib/api/loyalty-walk-in.client";

export default function JoinLoyaltyPage() {
  const { shop } = useParams<{ shop: string }>();
  const router = useRouter();
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [texted, setTexted] = useState<boolean | null>(null);

  useEffect(() => {
    walkInPublic
      .joinInfo(shop)
      .then(setInfo)
      .catch((e: Error) => setLoadError(e.message));
  }, [shop]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await walkInPublic.join(shop, { firstName: firstName.trim() || undefined, phone, marketingConsent: consent });
      if (res.status === "CREATED") {
        router.replace(`/loyalty/card/${res.token}?new=1`);
        return;
      }
      setTexted(res.smsSent);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const color = info?.color ?? "#1F2937";

  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-[55vh] opacity-60"
        style={{ background: `radial-gradient(80% 60% at 50% 0%, ${color} 0%, transparent 70%)` }}
      />
      <div className="relative mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-10 pt-8">
        {!info && !loadError && (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-white/50" />
          </div>
        )}

        {loadError && (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <p className="text-lg font-semibold">We couldn&apos;t find that shop</p>
            <p className="mt-1 text-sm text-white/60">{loadError}</p>
          </div>
        )}

        {info && !info.available && (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <p className="text-lg font-semibold">{info.title}</p>
            <p className="mt-2 text-sm text-white/60">
              The loyalty card isn&apos;t running right now. Ask at the counter.
            </p>
          </div>
        )}

        {info?.available && texted === null && (
          <>
            <p className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
              Loyalty card
            </p>
            <h1 className="mt-2 text-center text-[28px] font-semibold leading-tight tracking-tight text-balance">
              Collect {info.stampsRequired} stamps, get {info.rewardLabel?.toLowerCase()}
            </h1>

            <div className="mt-6">
              <WalletCard
                title={info.title}
                color={color}
                logoUrl={info.logoUrl}
                stamps={0}
                stampsRequired={info.stampsRequired ?? 6}
                rewardLabel={info.rewardLabel ?? "Free item"}
              />
            </div>

            <form onSubmit={submit} className="mt-7 space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-white/80">First name</span>
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoComplete="given-name"
                  maxLength={40}
                  placeholder="Optional"
                  className="h-12 w-full rounded-xl border border-white/15 bg-white/[0.06] px-4 text-base text-white placeholder:text-white/35 focus:border-white/60 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-white/80">Mobile number</span>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  required
                  placeholder="07…"
                  className="h-12 w-full rounded-xl border border-white/15 bg-white/[0.06] px-4 text-base text-white placeholder:text-white/35 focus:border-white/60 focus:outline-none"
                />
                <span className="mt-1.5 block text-xs text-white/50">
                  So you can get your card back if you change phone.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl px-1 py-2">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-white/30 bg-transparent accent-white"
                />
                <span className="text-sm text-white/70">Text me offers from {info.title}. Reply STOP any time.</span>
              </label>

              {error && (
                <p role="alert" className="rounded-xl bg-red-500/15 px-4 py-3 text-sm text-red-200">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy || !phone.trim()}
                className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-white text-base font-semibold text-zinc-950 transition active:scale-[0.99] disabled:opacity-50"
              >
                {busy && <Loader2 className="h-5 w-5 animate-spin" />}
                Get my card
              </button>
              <p className="pt-1 text-center text-xs leading-relaxed text-white/45">
                {info.earnRule} Add it to Apple Wallet or Google Wallet on the next screen.
              </p>
            </form>
          </>
        )}

        {texted !== null && (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            {texted ? (
              <>
                <MessageSquare className="h-10 w-10 text-white/80" />
                <p className="mt-4 text-xl font-semibold">You already have a card</p>
                <p className="mt-2 max-w-xs text-sm text-white/60">
                  We&apos;ve texted the link to that number. Open it on your phone to add the card to your wallet.
                </p>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-10 w-10 text-white/80" />
                <p className="mt-4 text-xl font-semibold">That number already has a card</p>
                <p className="mt-2 max-w-xs text-sm text-white/60">
                  Ask at the counter and we&apos;ll send it to you again.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
