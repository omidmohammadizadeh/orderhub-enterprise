"use client";

// Scan loyalty card — the card on its own, no sale.
//
// For shops that only want the loyalty card from us (their till is someone
// else's, or there is no till at all): scan the customer's wallet card with a
// USB/Bluetooth scanner or the tablet's camera, or find it by email or card
// number, and give a stamp. Rewards are handed over here too, and new
// customers can be signed up on the spot.
//
// Stamps given here have no order behind them; each tap carries a request key
// so a double tap or a retry can never give two. Undo is there for a few
// minutes after each action, because the wrong customer gets stamped sooner
// or later.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertTriangle,
  Camera,
  Check,
  Gift,
  Loader2,
  Minus,
  Plus,
  QrCode,
  ScanLine,
  Search,
  Undo2,
  UserPlus,
  X,
} from "lucide-react";
import { StampRow } from "@/components/loyalty/wallet-card";
import { CameraScanModal, isCameraScanSupported } from "@/components/pos/camera-scan-modal";
import { walkInTill, type TillMember } from "@/lib/api/loyalty-walk-in.client";
import { useBarcodeScanner } from "@/lib/pos/barcode-scanner";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useAuthStore } from "@/stores/auth.store";

const AUTO_KEY = "orderhub.loyaltyScan.autoStamp";
/** A second scan of the same card inside this window asks before stamping. */
const REPEAT_WINDOW_MS = 2 * 60_000;
/** Matches the server's undo window. */
const UNDO_WINDOW_MS = 10 * 60_000;
const SETUP_ROLES = new Set(["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "DARK_KITCHEN_MANAGER", "MANAGER"]);

type LastAction =
  | { kind: "stamp"; memberId: string; stampIds: string[]; count: number; at: number }
  | { kind: "reward"; memberId: string; rewardId: string; label: string; at: number };

function errorText(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { message?: string | string[] } }; message?: string };
  const m = e?.response?.data?.message;
  return (Array.isArray(m) ? m[0] : m) ?? e?.message ?? "Something went wrong.";
}

function newRequestKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"} ago`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? "" : "s"} ago`;
}

function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
}

export default function LoyaltyScanPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const role = useAuthStore((s) => s.user?.role);

  const status = useQuery({
    queryKey: ["loyalty-walk-in-status", locationId],
    queryFn: () => walkInTill.status(locationId!),
    enabled: !!locationId,
    staleTime: 60_000,
  });

  const [query, setQuery] = useState("");
  const [member, setMember] = useState<TillMember | null>(null);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState<null | "find" | "stamp" | "reward" | "undo" | "enrol" | "link">(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [repeatWarning, setRepeatWarning] = useState<string | null>(null);
  const [last, setLast] = useState<LastAction | null>(null);
  const [camera, setCamera] = useState(false);
  const [autoStamp, setAutoStamp] = useState(false);
  const [panel, setPanel] = useState<null | "enrol" | "join-qr" | "card-qr">(null);
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [consent, setConsent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // One key per pending tap: kept until the tap succeeds, so a retry after a
  // network blip re-sends the SAME key and the server adds nothing twice.
  const pendingKey = useRef<string | null>(null);

  useEffect(() => setAutoStamp(readAuto()), []);

  const focusSearch = useCallback(() => {
    // Not on touch screens: popping the keyboard after every tap is worse
    // than the field not being focused.
    if (window.matchMedia?.("(pointer: fine)").matches) inputRef.current?.focus();
  }, []);

  useEffect(() => {
    focusSearch();
  }, [focusSearch, locationId]);

  const resetMessages = () => {
    setError(null);
    setSuccess(null);
    setNotFound(null);
    setRepeatWarning(null);
  };

  const stamp = useCallback(
    async (m: TillMember, n: number) => {
      if (!locationId) return;
      setBusy("stamp");
      setError(null);
      setRepeatWarning(null);
      pendingKey.current ??= newRequestKey();
      try {
        const res = await walkInTill.stamp({ locationId, memberId: m.id, count: n, requestKey: pendingKey.current });
        pendingKey.current = null;
        setMember(res.member);
        setCount(1);
        setLast({ kind: "stamp", memberId: m.id, stampIds: res.stampIds, count: n, at: Date.now() });
        const who = res.member.firstName ?? "Customer";
        setSuccess(
          res.rewardsEarned > 0
            ? `${n === 1 ? "Stamp" : `${n} stamps`} added — ${who}'s card is full! Their reward is ready below.`
            : `${n === 1 ? "Stamp" : `${n} stamps`} added for ${who} — ${res.member.stamps} of ${res.member.stampsRequired}.`,
        );
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(null);
        focusSearch();
      }
    },
    [locationId, focusSearch],
  );

  const lookup = useCallback(
    async (raw: string, fromScan: boolean) => {
      const q = raw.trim();
      if (!q || !locationId) return;
      resetMessages();
      setPanel(null);
      setCardUrl(null);
      setCount(1);
      pendingKey.current = null;
      setBusy("find");
      try {
        const found = await walkInTill.lookup(locationId, q);
        setMember(found);
        setQuery("");
        if (fromScan && readAuto()) {
          const recent = found.lastStampAt && Date.now() - new Date(found.lastStampAt).getTime() < REPEAT_WINDOW_MS;
          if (recent) {
            setRepeatWarning(`This card was stamped ${ago(found.lastStampAt!)}. Add another?`);
          } else {
            setBusy(null);
            await stamp(found, 1);
            return;
          }
        }
      } catch (err) {
        setMember(null);
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404) {
          setNotFound(q);
          if (q.includes("@")) setEmail(q);
        } else {
          setError(errorText(err));
        }
      } finally {
        setBusy(null);
        focusSearch();
      }
    },
    [locationId, stamp, focusSearch],
  );

  // A USB / Bluetooth scanner works anywhere on the page, not only when the
  // search box has focus.
  useBarcodeScanner(!!status.data?.enabled && !camera, (code) => void lookup(code, true));

  async function redeem(reward: TillMember["rewards"][number]) {
    if (!member || !locationId) return;
    setBusy("reward");
    resetMessages();
    try {
      const res = await walkInTill.redeem({ locationId, memberId: member.id, rewardId: reward.id });
      setMember(res.member);
      setLast({ kind: "reward", memberId: member.id, rewardId: reward.id, label: reward.label, at: Date.now() });
      setSuccess(`${reward.label} handed over to ${member.firstName ?? "the customer"}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
      focusSearch();
    }
  }

  async function undo() {
    if (!last || !locationId) return;
    setBusy("undo");
    resetMessages();
    try {
      const res = await walkInTill.undo(
        last.kind === "stamp"
          ? { locationId, memberId: last.memberId, stampIds: last.stampIds }
          : { locationId, memberId: last.memberId, rewardId: last.rewardId },
      );
      setMember(res.member);
      setSuccess(last.kind === "stamp" ? "Stamp taken back." : "Reward put back on their card.");
      setLast(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function enrol(e: React.FormEvent) {
    e.preventDefault();
    if (!locationId) return;
    setBusy("enrol");
    setError(null);
    try {
      const res = await walkInTill.enrol({
        locationId,
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        marketingConsent: consent,
      });
      setMember(res.member);
      setNotFound(null);
      setPanel(res.cardUrl ? "card-qr" : null);
      setCardUrl(res.cardUrl);
      setEmail("");
      setFirstName("");
      setConsent(false);
      setSuccess(
        res.existing
          ? res.sent
            ? "That email already had a card — we've sent it to them again."
            : "That email already has a card. The email didn't send — use Show card QR."
          : res.sent
            ? `Card created and emailed to ${res.member.contactHint ?? "them"}. Add their first stamp below.`
            : "Card created. The email didn't send — let them scan the QR to add it to their wallet.",
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function showCardQr() {
    if (!member) return;
    setBusy("link");
    setError(null);
    try {
      const { cardUrl: url } = await walkInTill.cardLink(member.id);
      setCardUrl(url);
      setPanel("card-qr");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function resend() {
    if (!member) return;
    setBusy("link");
    setError(null);
    try {
      await walkInTill.resend(member.id);
      setSuccess(`Card link sent to ${member.contactHint ?? "them"}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  function clearMember() {
    setMember(null);
    setPanel(null);
    setCardUrl(null);
    resetMessages();
    pendingKey.current = null;
    focusSearch();
  }

  function toggleAuto(v: boolean) {
    setAutoStamp(v);
    try {
      localStorage.setItem(AUTO_KEY, v ? "1" : "0");
    } catch {
      /* private mode — the toggle still works for this visit */
    }
  }

  if (!locationId) {
    return <div className="grid h-full place-items-center p-8 text-sm text-zinc-500">Select a location.</div>;
  }
  if (status.isLoading) {
    return (
      <div className="grid h-full place-items-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }
  if (status.isError) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
          {errorText(status.error)}
        </p>
      </div>
    );
  }
  if (!status.data?.enabled) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-50 text-amber-600">
            <Gift className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-lg font-semibold text-zinc-900">The loyalty card isn&apos;t switched on here yet</h1>
          <p className="mt-2 text-sm text-zinc-600">
            Turn on the loyalty card with <strong>walk-in cards</strong> (Apple &amp; Google Wallet) for this location,
            then come back here to scan cards and give stamps.
          </p>
          {role && SETUP_ROLES.has(role) ? (
            <Link
              href="/dashboard/marketing"
              className="mt-5 inline-flex h-11 items-center rounded-xl bg-zinc-900 px-5 text-sm font-semibold text-white"
            >
              Set up the loyalty card
            </Link>
          ) : (
            <p className="mt-4 text-sm text-zinc-500">Ask a manager to set it up in Marketing.</p>
          )}
        </div>
      </div>
    );
  }

  const canUndo = !!last && !!member && last.memberId === member.id && Date.now() - last.at < UNDO_WINDOW_MS;
  const n = Math.min(10, Math.max(1, count));

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900">
            <ScanLine className="h-5 w-5 text-amber-600" /> Scan loyalty card
          </h1>
          <p className="text-sm text-zinc-500">Give a stamp without making a sale.</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={autoStamp}
            onChange={(e) => toggleAuto(e.target.checked)}
            className="h-4 w-4"
          />
          Stamp as soon as a card is scanned
        </label>
      </div>

      {/* Find */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookup(query, false);
        }}
        className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm"
      >
        <label htmlFor="loyalty-scan-q" className="block text-sm font-medium text-zinc-700">
          Scan the card, or type the card number or email
        </label>
        <div className="mt-2 flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              id="loyalty-scan-q"
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Card number or email"
              className="h-12 w-full rounded-xl border border-zinc-300 pl-9 pr-3 text-base focus:border-zinc-900 focus:outline-none"
            />
          </div>
          {isCameraScanSupported() && (
            <button
              type="button"
              onClick={() => setCamera(true)}
              className="flex h-12 items-center gap-2 rounded-xl border border-zinc-300 px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-50"
            >
              <Camera className="h-5 w-5" /> <span className="hidden sm:inline">Camera</span>
              <span className="sr-only sm:hidden">Scan with camera</span>
            </button>
          )}
          <button
            type="submit"
            disabled={busy === "find" || !query.trim()}
            className="flex h-12 items-center gap-2 rounded-xl bg-zinc-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy === "find" && <Loader2 className="h-4 w-4 animate-spin" />} Find
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              resetMessages();
              setMember(null);
              setPanel("enrol");
            }}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <UserPlus className="h-4 w-4" /> New member
          </button>
          <button
            type="button"
            onClick={() => setPanel(panel === "join-qr" ? null : "join-qr")}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <QrCode className="h-4 w-4" /> Join QR
          </button>
        </div>
      </form>

      {/* Messages */}
      <div aria-live="polite" className="space-y-2">
        {error && (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}
        {success && (
          <div className="flex items-center gap-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <Check className="h-5 w-5 shrink-0" />
            <span className="flex-1">{success}</span>
            {canUndo && (
              <button
                type="button"
                onClick={undo}
                disabled={busy === "undo"}
                className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-emerald-800 disabled:opacity-50"
              >
                <Undo2 className="h-3.5 w-3.5" /> Undo
              </button>
            )}
          </div>
        )}
        {notFound && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p>
              No loyalty card found for <strong>{notFound}</strong>.
            </p>
            <button
              type="button"
              onClick={() => {
                setNotFound(null);
                setPanel("enrol");
              }}
              className="mt-2 inline-flex items-center gap-1.5 font-semibold underline underline-offset-2"
            >
              <UserPlus className="h-4 w-4" /> Sign them up
            </button>
          </div>
        )}
      </div>

      {panel === "join-qr" && status.data.joinUrl && (
        <div className="flex flex-col items-center rounded-2xl border border-zinc-200 bg-white p-5 text-center shadow-sm">
          <p className="text-sm font-medium text-zinc-700">Turn the screen to the customer</p>
          <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-4">
            <QRCodeSVG value={status.data.joinUrl} size={220} marginSize={0} />
          </div>
          <p className="mt-3 max-w-xs text-sm text-zinc-500">
            They scan it with their phone camera, join, and add the card to their wallet. Then scan their new card here.
          </p>
          <button type="button" onClick={() => setPanel(null)} className="mt-3 text-sm font-medium text-zinc-600 underline">
            Close
          </button>
        </div>
      )}

      {panel === "enrol" && (
        <form onSubmit={enrol} className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-zinc-900">Sign up a new member</h2>
            <button type="button" onClick={() => setPanel(null)} aria-label="Close" className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-700">Email</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              placeholder="customer@example.com"
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
            Customer agreed to receive offers by email
          </label>
          <p className="text-xs text-zinc-500">We email them a link to add the card to Apple or Google Wallet.</p>
          <button
            type="submit"
            disabled={busy === "enrol" || !email.trim()}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy === "enrol" && <Loader2 className="h-4 w-4 animate-spin" />} Create card
          </button>
        </form>
      )}

      {/* Member */}
      {member && (
        <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="rounded-2xl bg-zinc-900 p-4 text-white">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold">{member.firstName ?? "Member"}</p>
                <p className="text-xs text-white/60">
                  {member.contactHint ?? "No email"} · {member.code.slice(0, 4)} {member.code.slice(4)}
                </p>
              </div>
              <div className="flex items-start gap-3">
                <p className="text-right text-sm font-semibold tabular-nums">
                  {member.stamps}/{member.stampsRequired}
                  <span className="block text-[11px] font-normal text-white/60">
                    {member.lifetimeStamps} all time
                  </span>
                </p>
                <button
                  type="button"
                  onClick={clearMember}
                  aria-label="Close this card"
                  className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="mt-3">
              <StampRow
                stamps={member.stamps}
                required={member.stampsRequired}
                fg="#FFFFFF"
                bg="#18181B"
                size="sm"
                icon={member.stampIcon}
              />
            </div>
            <p className="mt-3 text-xs text-white/60">Reward: {member.rewardLabel}</p>
          </div>

          {repeatWarning && (
            <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {repeatWarning}
            </p>
          )}

          {/* Stamp */}
          <div className="flex gap-2">
            <div className="flex h-14 items-center rounded-xl border border-zinc-300">
              <button
                type="button"
                onClick={() => setCount(Math.max(1, n - 1))}
                disabled={n <= 1}
                aria-label="One fewer stamp"
                className="grid h-full w-12 place-items-center text-zinc-700 disabled:opacity-30"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="w-8 text-center text-lg font-semibold tabular-nums" aria-live="polite">
                {n}
              </span>
              <button
                type="button"
                onClick={() => setCount(Math.min(10, n + 1))}
                disabled={n >= 10}
                aria-label="One more stamp"
                className="grid h-full w-12 place-items-center text-zinc-700 disabled:opacity-30"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => void stamp(member, n)}
              disabled={busy === "stamp"}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-amber-600 text-base font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
            >
              {busy === "stamp" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
              {n === 1 ? "Add stamp" : `Add ${n} stamps`}
            </button>
          </div>

          {/* Rewards */}
          {member.rewards.length > 0 && (
            <div className="space-y-2">
              {member.rewards.map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
                  <Gift className="h-5 w-5 shrink-0 text-amber-600" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-900">{r.rewardItemName ?? r.label}</p>
                    <p className="text-[11px] text-zinc-500">
                      Reward ready{r.expiresAt ? ` · use by ${new Date(r.expiresAt).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void redeem(r)}
                    disabled={busy === "reward"}
                    className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    Hand over
                  </button>
                </div>
              ))}
            </div>
          )}

          {panel === "card-qr" && cardUrl && (
            <div className="flex flex-col items-center rounded-xl border border-zinc-200 p-3 text-center">
              <p className="text-xs font-medium text-zinc-600">
                Customer scans this to open their card and add it to their wallet
              </p>
              <div className="mt-2">
                <QRCodeSVG value={cardUrl} size={160} marginSize={0} />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={showCardQr}
              disabled={busy === "link" || panel === "card-qr"}
              className="flex h-11 items-center justify-center gap-2 rounded-xl border border-zinc-300 text-sm font-medium text-zinc-700 disabled:opacity-40"
            >
              <QrCode className="h-4 w-4" /> Show card QR
            </button>
            <button
              type="button"
              onClick={resend}
              disabled={busy === "link" || !member.contactHint}
              className="h-11 rounded-xl border border-zinc-300 text-sm font-medium text-zinc-700 disabled:opacity-40"
            >
              Email card link
            </button>
          </div>
        </section>
      )}

      {!member && !panel && !notFound && (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">
          <ScanLine className="mx-auto mb-2 h-8 w-8 text-zinc-300" />
          Scan a customer&apos;s loyalty card with your scanner or the camera, or look them up by email.
        </div>
      )}

      {camera && (
        <CameraScanModal
          title="Scan loyalty card"
          onClose={() => setCamera(false)}
          onDetected={(code) => {
            setCamera(false);
            void lookup(code, true);
          }}
        />
      )}
    </div>
  );
}
