"use client";

// Incoming-call popup (Phase BB).
//
// A caller-ID source (the Comet USB hub tablet, the Order Hub Caller ID phone
// app, or a VoIP webhook) POSTs the ringing number to the API, which matches it
// against past orders and broadcasts "callerid:ring" to that location's room.
// This card then shows on EVERY dashboard screen (mounted globally in the
// layout) for ANY of the user's locations — known callers get their name +
// previous addresses to tap straight into a new order.

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChefHat, Phone, RotateCcw, X } from "lucide-react";
import {
  formatMoney,
  type CallerIdOrderSummary,
  type CallerIdRingPayload,
} from "@orderhub/shared";
import {
  getSocket,
  joinLocationRoom,
  leaveLocationRoom,
} from "@/lib/socket/socket.client";
import { useAuthStore } from "@/stores/auth.store";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { usePendingCallerStore } from "@/stores/pending-caller.store";
import { apiClient } from "@/lib/api/client";
import { attachHubLogBridge, hubRecord } from "@/lib/callerid/hub-log";

/** Payload the POS cart panel consumes via the "pos:callerid-fill" event. */
export interface CallerIdFill {
  phone: string;
  name: string | null;
  address: {
    line1: string;
    line2: string | null;
    city: string | null;
    postcode: string | null;
  } | null;
}

// A fill stashed here is picked up by the POS cart panel on mount — used when
// the operator taps "Start order" from a NON-POS screen and we navigate to POS.
export const PENDING_FILL_KEY = "pos:pending-callerid-fill";

export function fillOrderFromCaller(detail: CallerIdFill) {
  window.dispatchEvent(new CustomEvent("pos:callerid-fill", { detail }));
}

export function CallerIdPopup({
  locationIds,
  nativeLocationId,
  locationNames,
}: {
  /** Every location room to listen on (the user's accessible locations). */
  locationIds: string[];
  /** The active location the Comet-USB hub tablet forwards rings for. */
  nativeLocationId?: string | null;
  /** id → shop name, so a multi-location operator sees which shop is ringing. */
  locationNames?: Record<string, string>;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const setSelectedLocationId = useSelectedLocationStore(
    (s) => s.setSelectedLocationId,
  );
  const setPendingCaller = usePendingCallerStore((st) => st.setPendingCaller);
  const setPendingRepeatOrderId = usePendingCallerStore(
    (st) => st.setPendingRepeatOrderId,
  );
  const setPendingOpenOrderId = usePendingCallerStore(
    (st) => st.setPendingOpenOrderId,
  );
  const router = useRouter();
  const pathname = usePathname();
  const [ring, setRing] = useState<CallerIdRingPayload | null>(null);

  const roomKey = locationIds.join(",");
  useEffect(() => {
    if (!accessToken || locationIds.length === 0) return;
    const socket = getSocket(accessToken);
    // Refcounted joins — shared with the orders board / alert player, and
    // released on cleanup so switching the selected location doesn't leave
    // this popup listening to every room it has ever joined.
    for (const id of locationIds) joinLocationRoom(socket, id);
    const onRing = (payload: CallerIdRingPayload) => {
      if (!locationIds.includes(payload.locationId)) return;
      setRing(payload);
    };
    socket.on("callerid:ring", onRing);
    return () => {
      socket.off("callerid:ring", onRing);
      for (const id of locationIds) leaveLocationRoom(socket, id);
    };
    // roomKey captures the location set; re-join if it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, accessToken]);

  // Auto-dismiss after 60s so a missed call doesn't sit on screen all night.
  useEffect(() => {
    if (!ring) return;
    const t = setTimeout(() => setRing(null), 60_000);
    return () => clearTimeout(t);
  }, [ring]);

  // How long this call has been on screen. A counter with three people on it
  // needs to know whether the phone just started ringing or has been ringing
  // for forty seconds, and "Incoming call" alone never said.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!ring) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ring]);

  // Esc dismisses. The card sits over the till and the operator's hands are
  // already on a keyboard when they are typing an order.
  useEffect(() => {
    if (!ring) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ring]);

  // Caller-ID HUB role: when this tablet hosts the Comet USB reader, the native
  // shell dispatches "native:callerid" with the ringing number. Forward it to
  // the API (which matches + broadcasts "callerid:ring" back to every tablet).
  useEffect(() => {
    const recent = new Map<string, number>();
    const onNative = (e: Event) => {
      const d = (e as CustomEvent).detail as { phone?: string };
      const phone = d?.phone?.trim();
      if (!phone) return;
      // The listener is registered even without a location so a dropped ring
      // is VISIBLE. Previously we returned early and the box's number went
      // nowhere with no trace — indistinguishable from broken hardware.
      if (!nativeLocationId) {
        const why = `ring from ${phone} dropped — no single location selected in the switcher, so we don't know whose line rang`;
        console.warn(`caller-id: ${why}`);
        hubRecord("dropped", why);
        return;
      }
      const now = Date.now();
      if (now - (recent.get(phone) ?? 0) < 10_000) {
        hubRecord("dropped", `ring from ${phone} ignored — duplicate within 10s`);
        return;
      }
      recent.set(phone, now);
      apiClient
        .post("/v1/customers/caller-id/ring", { locationId: nativeLocationId, phone })
        .then(() => hubRecord("sent", `ring from ${phone} sent to the API`))
        .catch((err) => {
          hubRecord(
            "error",
            `couldn't send the ring for ${phone}: ${err?.response?.status ?? err?.message ?? err}`,
          );
          // Best-effort (the next ring retries), but say so — a silently
          // swallowed 401/403 here looks exactly like a dead Comet box.
          console.error(
            `caller-id: couldn't broadcast the ring for ${phone}:`,
            err?.response?.status ?? err?.message ?? err,
          );
        });
    };
    attachHubLogBridge();
    window.addEventListener("native:callerid", onNative);
    return () => window.removeEventListener("native:callerid", onNative);
  }, [nativeLocationId]);

  if (!ring) return null;
  const { phone, match, locationId: ringLocationId } = ring;
  const shopName =
    locationNames && locationIds.length > 1
      ? locationNames[ringLocationId]
      : undefined;

  const use = (address: CallerIdFill["address"]) => {
    const detail: CallerIdFill = { phone, name: match?.name ?? null, address };
    // startsWith, not equality. Any POS route that isn't the bare path — a
    // trailing slash, an order being edited — fell to the branch below, and
    // that branch pushes to the page the operator is already on: no remount,
    // so the stashed fill was never read and nothing appeared in the fields.
    if (pathname?.startsWith("/dashboard/pos")) {
      // Already on POS — fill the open cart directly.
      fillOrderFromCaller(detail);
    } else {
      // Elsewhere (e.g. the Orders tab) — carry the caller to POS and switch
      // to the ringing shop. Held in a store rather than sessionStorage: POS
      // reacts to the value, so it no longer matters whether the location
      // change below remounts POS after it has already read the caller.
      // sessionStorage is written too, purely so a full page reload mid-
      // navigation still lands the caller.
      setPendingCaller(detail);
      try {
        sessionStorage.setItem(PENDING_FILL_KEY, JSON.stringify(detail));
      } catch {
        /* ignore */
      }
      setSelectedLocationId(ringLocationId);
      router.push("/dashboard/pos");
    }
    setRing(null);
  };

  /**
   * Open the order the caller is ringing about, on the board they already know.
   *
   * Deep-linked rather than shown inline: everything staff do next — accept it,
   * amend it, reprint it, chase the driver — already lives on the board's
   * drawer, and a second, thinner copy of that inside a popup would be the one
   * that goes stale.
   */
  const openExistingOrder = (orderId: string) => {
    setPendingOpenOrderId(orderId);
    setSelectedLocationId(ringLocationId);
    if (!pathname?.startsWith("/dashboard/orders")) router.push("/dashboard/orders");
    setRing(null);
  };

  /**
   * "The usual." Loads the caller's last order into a NEW basket at the till.
   *
   * The caller travels with it, which is the whole point — the repeat carries
   * the items, and the number/name/address still come from this card, so the
   * operator gets a finished order rather than a basket they have to introduce
   * to a customer.
   */
  const repeatOrder = (order: CallerIdOrderSummary) => {
    const detail: CallerIdFill = {
      phone,
      name: match?.name ?? null,
      address: match?.addresses[0] ?? null,
    };
    setPendingCaller(detail);
    try {
      sessionStorage.setItem(PENDING_FILL_KEY, JSON.stringify(detail));
    } catch {
      /* ignore */
    }
    setPendingRepeatOrderId(order.id);
    setSelectedLocationId(ringLocationId);
    if (!pathname?.startsWith("/dashboard/pos")) router.push("/dashboard/pos");
    setRing(null);
  };

  return (
    <IncomingCallCard
      phone={phone}
      match={match}
      shopName={shopName}
      elapsedSeconds={elapsed}
      onDismiss={() => setRing(null)}
      onUseAddress={use}
      onOpenOrder={openExistingOrder}
      onRepeat={repeatOrder}
    />
  );
}

/**
 * The card itself, with no idea a socket exists.
 *
 * Split from the listener above so what staff actually read can be rendered
 * from fixtures — an incoming call is the one screen in the till you cannot
 * summon on demand to look at, and a card nobody can look at is a card nobody
 * fixes.
 */
export function IncomingCallCard({
  phone,
  match,
  shopName,
  elapsedSeconds,
  onDismiss,
  onUseAddress,
  onOpenOrder,
  onRepeat,
}: {
  phone: string;
  match: CallerIdRingPayload["match"];
  shopName?: string;
  elapsedSeconds: number;
  onDismiss: () => void;
  onUseAddress: (address: CallerIdFill["address"]) => void;
  onOpenOrder: (orderId: string) => void;
  onRepeat: (order: CallerIdOrderSummary) => void;
}) {
  const ringingFor = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;

  const openOrder = match?.openOrder ?? null;
  // Their usual, offered only when there is nothing live to deal with first.
  // A customer with an order in the kitchen is ringing about THAT, and putting
  // "repeat this order" under their nose is how a second dinner gets made.
  const lastOrder = !openOrder ? (match?.lastOrder ?? null) : null;

  return (
    <div
      // A call arrives without anyone pressing anything, so it has to announce
      // itself rather than just appear.
      role="status"
      aria-live="polite"
      // max-w so the card never runs off a phone: 360 + the two 1rem insets is
      // wider than a 375px screen, and the overflow lands on the dismiss button.
      className="fixed bottom-4 right-4 z-50 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-2xl"
    >
      <div className="flex items-center justify-between bg-emerald-600 px-4 py-2.5">
        <p className="flex items-center gap-2 text-sm font-bold text-white">
          <Phone aria-hidden="true" className="h-4 w-4 animate-pulse motion-reduce:animate-none" />
          Incoming call{shopName ? ` · ${shopName}` : ""}
        </p>
        <div className="flex items-center gap-2">
          {/* How long it has been ringing. On a busy counter this is the
              difference between "just rang" and "nobody has picked up". */}
          <span className="tabular-nums text-xs font-semibold text-emerald-100">
            {ringingFor}
          </span>
          <button
            onClick={onDismiss}
            className="rounded text-emerald-100 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            aria-label="Dismiss"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="max-h-[70vh] space-y-3 overflow-y-auto overscroll-contain p-4">
        {match ? (
          <>
            <div>
              <div className="flex min-w-0 items-baseline justify-between gap-2">
                <p className="min-w-0 truncate text-base font-bold text-zinc-900">
                  {match.name}
                </p>
                {match.orders >= 10 && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                    Regular
                  </span>
                )}
              </div>
              <p className="text-sm font-semibold tracking-wide text-zinc-600">
                {phone}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                {[
                  `${match.orders} order${match.orders === 1 ? "" : "s"}`,
                  // Grouped, not compact: a lifetime figure is read as a
                  // number ("£1,284.50"), and £1284.50 makes staff count digits.
                  match.lifetimeSpend
                    ? `${formatMoney(match.lifetimeSpend, match.currency)} spent`
                    : null,
                  match.lastOrderAt
                    ? `last ordered ${sinceWords(match.lastOrderAt)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>

            {openOrder && (
              <OrderBlock
                tone="live"
                heading="Order in progress now"
                icon={<ChefHat aria-hidden="true" className="h-3.5 w-3.5" />}
                order={openOrder}
                subline={`${statusWords(openOrder.status)} · placed ${sinceWords(openOrder.placedAt)}`}
                actionLabel="Open this order"
                onAction={() => onOpenOrder(openOrder.id)}
              />
            )}

            {lastOrder && (
              <OrderBlock
                tone="past"
                heading="Last order"
                icon={<RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />}
                order={lastOrder}
                subline={`${sinceWords(lastOrder.placedAt)} · ${formatMoney(
                  lastOrder.total,
                  lastOrder.currency,
                  { compact: true },
                )}`}
                actionLabel="Repeat this order"
                onAction={() => onRepeat(lastOrder)}
              />
            )}

            {match.addresses.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  Deliver to
                </p>
                {match.addresses.map((a, i) => (
                  <button
                    key={i}
                    onClick={() => onUseAddress(a)}
                    className="w-full touch-manipulation break-words rounded-lg border border-zinc-200 px-3 py-2 text-left text-xs text-zinc-700 hover:border-emerald-400 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-emerald-500"
                  >
                    {[a.line1, a.line2, a.city, a.postcode]
                      .filter(Boolean)
                      .join(", ")}
                  </button>
                ))}
              </div>
            )}

            <button
              onClick={() => onUseAddress(match.addresses[0] ?? null)}
              className="w-full touch-manipulation rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-emerald-500"
            >
              {openOrder || lastOrder ? "Start a new order" : "Start order"} for{" "}
              {match.name.split(" ")[0]}
            </button>
          </>
        ) : (
          <>
            <p className="text-lg font-bold tracking-wide text-zinc-900">{phone}</p>
            <p className="text-sm text-zinc-500">New caller — no order history.</p>
            <button
              onClick={() => onUseAddress(null)}
              className="w-full touch-manipulation rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-emerald-500"
            >
              Start order with this number
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One order on the card: what it was, and the single thing to do about it.
 *
 * Two tones rather than two components — a live order and a finished one are
 * read the same way and differ only in urgency, and keeping them one shape
 * means the second can never quietly drift into looking like the first.
 */
function OrderBlock({
  tone,
  heading,
  icon,
  order,
  subline,
  actionLabel,
  onAction,
}: {
  tone: "live" | "past";
  heading: string;
  icon: React.ReactNode;
  order: CallerIdOrderSummary;
  subline: string;
  actionLabel: string;
  onAction: () => void;
}) {
  const live = tone === "live";
  return (
    <div
      className={`rounded-lg border p-2.5 ${
        live ? "border-amber-300 bg-amber-50" : "border-zinc-200 bg-zinc-50"
      }`}
    >
      <p
        className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider ${
          live ? "text-amber-800" : "text-zinc-500"
        }`}
      >
        {icon}
        {heading}
      </p>
      <p
        className={`mt-1 text-xs font-semibold ${live ? "text-amber-900" : "text-zinc-800"}`}
      >
        #{order.reference} · {subline}
      </p>
      <p className={`mt-0.5 break-words text-[11px] ${live ? "text-amber-800" : "text-zinc-600"}`}>
        {order.summary || `${order.itemCount} item${order.itemCount === 1 ? "" : "s"}`}
      </p>
      <button
        onClick={onAction}
        className={`mt-2 w-full touch-manipulation rounded-lg px-3 py-2 text-xs font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
          live
            ? "bg-amber-600 hover:bg-amber-700 focus-visible:ring-amber-600"
            : "bg-zinc-800 hover:bg-zinc-900 focus-visible:ring-zinc-800"
        }`}
      >
        {actionLabel}
      </button>
    </div>
  );
}

/** "3 days ago" / "25 minutes ago" — a clock time makes staff do the sum. */
function sinceWords(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/** The board's own words for a status — staff never see SCREAMING_SNAKE. */
function statusWords(status: string): string {
  const words: Record<string, string> = {
    PENDING: "Waiting to be accepted",
    ACCEPTED: "Accepted",
    PREPARING: "In the kitchen",
    READY: "Ready",
    PENDING_DISPATCH: "Waiting for a driver",
    ASSIGNED_DRIVER: "Driver assigned",
    ACCEPTED_BY_DRIVER: "Driver on the way",
    RIDER_ARRIVED: "Rider at the shop",
    OUT_FOR_DELIVERY: "Out for delivery",
    DISPATCHED: "Out for delivery",
  };
  return words[status] ?? status.replace(/_/g, " ").toLowerCase();
}
