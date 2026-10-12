"use client";

// Join a shop's loyalty card — where the QR poster on the counter lands.
//
// One screen, thumb-sized: the card they are about to get, two fields, one
// button. A new number goes straight to its card. A number that already has
// one (new phone, second phone, deleted pass) gets a 6-digit code by email and
// opens the SAME card here once it is typed in — never straight on screen,
// because whoever is typing may not own that address.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { WalletCard } from "@/components/loyalty/wallet-card";
import { walkInPublic, type JoinInfo } from "@/lib/api/loyalty-walk-in.client";

export default function JoinLoyaltyPage() {
  const { shop } = useParams<{ shop: string }>();
  const router = useRouter();
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Existing address: waiting for the emailed code. null = not at that step.
  const [verifyHint, setVerifyHint] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [noSms, setNoSms] = useState(false);

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
      const res = await walkInPublic.join(shop, { firstName: firstName.trim() || undefined, email: email.trim(), marketingConsent: consent });
      if (res.status === "CREATED") {
        router.replace(`/loyalty/card/${res.token}?new=1`);
        return;
      }
      if (res.status === "VERIFY") {
        setCode("");
        setVerifyHint(res.contactHint);
        return;
      }
      setNoSms(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token } = await walkInPublic.verify(shop, { email: email.trim(), code });
      router.replace(`/loyalty/card/${token}`);
    } catch (err) {
      setError((err as Error).message);
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

        {info?.available && verifyHint === null && !noSms && (
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
                stampIcon={info.stampIcon}
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
                <span className="mb-1.5 block text-sm font-medium text-white/80">Email</span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  placeholder="you@example.com"
                  className="h-12 w-full rounded-xl border border-white/15 bg-white/[0.06] px-4 text-base text-white placeholder:text-white/35 focus:border-white/60 focus:outline-none"
                />
                <span className="mt-1.5 block text-xs text-white/50">
                  We&apos;ll email you your card, so you can get it back if you change phone.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl px-1 py-2">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-white/30 bg-transparent accent-white"
                />
                <span className="text-sm text-white/70">Email me offers from {info.title}. Unsubscribe any time.</span>
              </label>

              {error && (
                <p role="alert" className="rounded-xl bg-red-500/15 px-4 py-3 text-sm text-red-200">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy || !email.trim()}
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

        {verifyHint !== null && (
          <form onSubmit={submitCode} className="flex flex-1 flex-col justify-center">
            <p className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
              Welcome back
            </p>
            <h1 className="mt-2 text-center text-[26px] font-semibold leading-tight tracking-tight">
              You already have a card
            </h1>
            <p className="mx-auto mt-2 max-w-xs text-center text-sm text-white/60">
              We&apos;ve emailed a 6-digit code to {verifyHint}. Enter it to open your card on this phone — your
              stamps come with it. Check your spam folder if it isn&apos;t there in a minute.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              aria-label="6-digit code"
              placeholder="••••••"
              className="mx-auto mt-6 h-16 w-full max-w-[16rem] rounded-2xl border border-white/15 bg-white/[0.06] text-center font-mono text-3xl tracking-[0.4em] text-white placeholder:text-white/25 focus:border-white/60 focus:outline-none"
            />
            {error && (
              <p role="alert" className="mt-4 rounded-xl bg-red-500/15 px-4 py-3 text-center text-sm text-red-200">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="mt-6 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-white text-base font-semibold text-zinc-950 transition active:scale-[0.99] disabled:opacity-50"
            >
              {busy && <Loader2 className="h-5 w-5 animate-spin" />}
              Open my card
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => void submit(e as unknown as React.FormEvent)}
              className="mt-3 h-11 text-sm font-medium text-white/70 underline-offset-4 hover:underline disabled:opacity-50"
            >
              Send a new code
            </button>
            <button
              type="button"
              onClick={() => {
                setVerifyHint(null);
                setError(null);
              }}
              className="h-11 text-sm text-white/50"
            >
              Use a different email
            </button>
          </form>
        )}

        {noSms && (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <CheckCircle2 className="h-10 w-10 text-white/80" />
            <p className="mt-4 text-xl font-semibold">That email already has a card</p>
            <p className="mt-2 max-w-xs text-sm text-white/60">
              We couldn&apos;t send you a code just now. Ask at the counter — staff can show your card on the till
              for you to scan.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
