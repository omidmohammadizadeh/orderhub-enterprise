"use client";

// The till's loyalty card desk.
//
// Opens on its own when a wallet card is scanned (the QR says "OHL:…"), or
// from the Loyalty button. Three things happen here, in the order a counter
// actually works:
//   1. find the card — scan, card number, or the customer's phone;
//   2. put it on this order (the stamp lands when the order is paid), and add
//      the free item if a reward is ready;
//   3. or sign a new customer up — the card is texted to them, and a brand
//      new card can also be scanned straight off this screen.

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Gift, Loader2, MessageSquare, QrCode, Search, UserPlus, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { StampRow } from "@/components/loyalty/wallet-card";
import { CameraScanModal, isCameraScanSupported } from "@/components/pos/camera-scan-modal";
import { walkInTill, type TillMember } from "@/lib/api/loyalty-walk-in.client";

type View = "find" | "member" | "enrol" | "join-qr";

function errorText(err: unknown): string {
  const e = err as { response?: { data?: { message?: string | string[] } }; message?: string };
  const m = e?.response?.data?.message;
  return (Array.isArray(m) ? m[0] : m) ?? e?.message ?? "Something went wrong.";
}

export function LoyaltyTillModal({
  locationId,
  joinUrl,
  initialQuery,
  attached,
  attachedRewardId,
  onAttach,
  onRedeem,
  onDetach,
  onClose,
}: {
  locationId: string;
  joinUrl: string | null;
  /** What the scanner just read, to look up straight away. */
  initialQuery?: string;
  attached: TillMember | null;
  attachedRewardId: string | null;
  onAttach: (member: TillMember) => void;
  onRedeem: (member: TillMember, reward: TillMember["rewards"][number]) => void;
  onDetach: () => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>(attached ? "member" : "find");
  const [query, setQuery] = useState("");
  const [member, setMember] = useState<TillMember | null>(attached);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newCardUrl, setNewCardUrl] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [phone, setPhone] = useState("");
  const [firstName, setFirstName] = useState("");
  const [consent, setConsent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const lookup = useCallback(
    async (q: string) => {
      const v = q.trim();
      if (!v) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      setNewCardUrl(null);
      try {
        const found = await walkInTill.lookup(locationId, v);
        setMember(found);
        setView("member");
      } catch (err) {
        setError(errorText(err));
        setView("find");
      } finally {
        setBusy(false);
      }
    },
    [locationId],
  );

  useEffect(() => {
    if (initialQuery) void lookup(initialQuery);
  }, [initialQuery, lookup]);

  useEffect(() => {
    if (view === "find") inputRef.current?.focus();
  }, [view]);

  async function enrol(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await walkInTill.enrol({ locationId, phone, firstName: firstName || undefined, marketingConsent: consent });
      setMember(res.member);
      setNewCardUrl(res.cardUrl);
      setNotice(
        res.existing
          ? res.smsSent
            ? "That number already had a card — we've texted it to them again."
            : "That number already has a card. The text didn't send, so look it up by phone each visit."
          : res.smsSent
            ? `Card created and texted to ${res.member.phoneHint ?? "their phone"}.`
            : "Card created. The text didn't send — let them scan the QR below.",
      );
      onAttach(res.member);
      setView("member");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function showCardQr() {
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      const { cardUrl } = await walkInTill.cardLink(member.id);
      setNewCardUrl(cardUrl);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      await walkInTill.resend(member.id);
      setNotice(`Card link texted to ${member.phoneHint ?? "their phone"}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const isAttached = !!attached && !!member && attached.id === member.id;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="loyalty-till-title"
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:max-w-md sm:rounded-2xl"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-100 bg-white px-5 py-3.5">
          <h2 id="loyalty-till-title" className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <Gift className="h-5 w-5 text-amber-600" /> Loyalty card
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-4 p-5">
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">
              {error}
            </p>
          )}
          {notice && (
            <p className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
            </p>
          )}

          {view === "find" && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void lookup(query);
                }}
                className="space-y-2"
              >
                <label htmlFor="loyalty-q" className="block text-sm font-medium text-zinc-700">
                  Scan the card, or type the card number or phone
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                    <input
                      id="loyalty-q"
                      ref={inputRef}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      autoComplete="off"
                      placeholder="Card number or 07…"
                      className="h-12 w-full rounded-xl border border-zinc-300 pl-9 pr-3 text-base focus:border-zinc-900 focus:outline-none"
                    />
                  </div>
                  {isCameraScanSupported() && (
                    <button
                      type="button"
                      onClick={() => setCamera(true)}
                      aria-label="Scan with camera"
                      className="flex h-12 w-12 items-center justify-center rounded-xl border border-zinc-300 text-zinc-700 hover:bg-zinc-50"
                    >
                      <Camera className="h-5 w-5" />
                    </button>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={busy || !query.trim()}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} Find card
                </button>
              </form>

              <div className="grid grid-cols-2 gap-2 border-t border-zinc-100 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setView("enrol");
                  }}
                  className="flex h-12 items-center justify-center gap-2 rounded-xl border border-zinc-300 text-sm font-semibold text-zinc-800 hover:bg-zinc-50"
                >
                  <UserPlus className="h-4 w-4" /> New member
                </button>
                <button
                  type="button"
                  onClick={() => setView("join-qr")}
                  disabled={!joinUrl}
                  className="flex h-12 items-center justify-center gap-2 rounded-xl border border-zinc-300 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-40"
                >
                  <QrCode className="h-4 w-4" /> Join QR
                </button>
              </div>
            </>
          )}

          {view === "join-qr" && joinUrl && (
            <div className="flex flex-col items-center text-center">
              <p className="text-sm font-medium text-zinc-700">Turn the screen to the customer</p>
              <div className="mt-3 rounded-2xl border border-zinc-200 p-4">
                <QRCodeSVG value={joinUrl} size={220} marginSize={0} />
              </div>
              <p className="mt-3 max-w-xs text-sm text-zinc-500">
                They scan it with their camera, join, and add the card to their wallet. Scan their new card to
                stamp this order.
              </p>
              <button
                type="button"
                onClick={() => setView("find")}
                className="mt-4 h-11 w-full rounded-xl border border-zinc-300 text-sm font-semibold text-zinc-800"
              >
                Back
              </button>
            </div>
          )}

          {view === "enrol" && (
            <form onSubmit={enrol} className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">Mobile number</span>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  type="tel"
                  inputMode="tel"
                  required
                  autoFocus
                  placeholder="07…"
                  className="h-12 w-full rounded-xl border border-zinc-300 px-3 text-base focus:border-zinc-900 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">First name</span>
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  maxLength={40}
                  placeholder="Optional"
                  className="h-12 w-full rounded-xl border border-zinc-300 px-3 text-base focus:border-zinc-900 focus:outline-none"
                />
              </label>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-zinc-700">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="h-4 w-4" />
                Customer agreed to receive offers by text
              </label>
              <p className="text-xs text-zinc-500">We text them a link to add the card to Apple or Google Wallet.</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setView("find")}
                  className="h-12 rounded-xl border border-zinc-300 text-sm font-semibold text-zinc-800"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={busy || !phone.trim()}
                  className="flex h-12 items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create card
                </button>
              </div>
            </form>
          )}

          {view === "member" && member && (
            <>
              <div className="rounded-2xl bg-zinc-900 p-4 text-white">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-lg font-semibold">{member.firstName ?? "Member"}</p>
                    <p className="text-xs text-white/60">
                      {member.phoneHint ?? "No phone"} · {member.code.slice(0, 4)} {member.code.slice(4)}
                    </p>
                  </div>
                  <p className="shrink-0 text-right text-sm font-semibold tabular-nums">
                    {member.stamps}/{member.stampsRequired}
                    <span className="block text-[11px] font-normal text-white/60">stamps</span>
                  </p>
                </div>
                <div className="mt-3">
                  <StampRow stamps={member.stamps} required={member.stampsRequired} fg="#FFFFFF" bg="#18181B" size="sm" />
                </div>
                {!member.cardActive && (
                  <p className="mt-3 rounded-md bg-amber-400/20 px-2 py-1.5 text-xs text-amber-100">
                    The loyalty card is switched off — this order won&apos;t earn a stamp.
                  </p>
                )}
                {member.minimumSpend != null && member.minimumSpend > 0 && (
                  <p className="mt-2 text-[11px] text-white/60">Orders over the minimum spend earn a stamp.</p>
                )}
              </div>

              {member.rewards.length > 0 && (
                <div className="space-y-2">
                  {member.rewards.map((r) => {
                    const added = attachedRewardId === r.id;
                    return (
                      <div
                        key={r.id}
                        className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3"
                      >
                        <Gift className="h-5 w-5 shrink-0 text-amber-600" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-zinc-900">{r.label}</p>
                          {r.expiresAt && (
                            <p className="text-[11px] text-zinc-500">
                              Use by {new Date(r.expiresAt).toLocaleDateString()}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={added || (!!attachedRewardId && !added)}
                          onClick={() => onRedeem(member, r)}
                          className="shrink-0 rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white disabled:bg-emerald-600 disabled:opacity-100"
                        >
                          {added ? (
                            <span className="inline-flex items-center gap-1">
                              <Check className="h-3.5 w-3.5" /> Added
                            </span>
                          ) : (
                            "Add free"
                          )}
                        </button>
                      </div>
                    );
                  })}
                  {attachedRewardId && (
                    <p className="text-[11px] text-zinc-500">One reward per order.</p>
                  )}
                </div>
              )}

              {newCardUrl && (
                <div className="flex flex-col items-center rounded-xl border border-zinc-200 p-3 text-center">
                  <p className="text-xs font-medium text-zinc-600">
                    Customer scans this to open their card and add it to their wallet
                  </p>
                  <div className="mt-2">
                    <QRCodeSVG value={newCardUrl} size={150} marginSize={0} />
                  </div>
                </div>
              )}

              <div className="grid gap-2">
                {isAttached ? (
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex h-12 items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-semibold text-white"
                  >
                    <Check className="h-4 w-4" /> On this order — done
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onAttach(member);
                      onClose();
                    }}
                    className="h-12 rounded-xl bg-zinc-900 text-sm font-semibold text-white"
                  >
                    Add card to this order
                  </button>
                )}
                {!newCardUrl && (
                  <button
                    type="button"
                    onClick={showCardQr}
                    disabled={busy}
                    className="flex h-11 items-center justify-center gap-2 rounded-xl border border-zinc-300 text-sm font-medium text-zinc-700 disabled:opacity-40"
                  >
                    <QrCode className="h-4 w-4" /> Show card QR (new or second phone)
                  </button>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={resend}
                    disabled={busy || !member.phoneHint}
                    className="h-11 rounded-xl border border-zinc-300 text-sm font-medium text-zinc-700 disabled:opacity-40"
                  >
                    Text card link
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (isAttached) onDetach();
                      setMember(null);
                      setQuery("");
                      setNotice(null);
                      setNewCardUrl(null);
                      setView("find");
                    }}
                    className="h-11 rounded-xl border border-zinc-300 text-sm font-medium text-zinc-700"
                  >
                    {isAttached ? "Remove card" : "Different card"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {camera && (
        <CameraScanModal
          onClose={() => setCamera(false)}
          onDetected={(code) => {
            setCamera(false);
            void lookup(code);
          }}
        />
      )}
    </div>
  );
}
