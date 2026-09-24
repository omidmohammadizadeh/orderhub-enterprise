"use client";

// Phase AR — Deliverect-style single-table order list.
//
// Replaces the wide Kanban board: one row per order, status pill +
// action buttons inline so staff can move an order forward without
// dragging it across columns. The full board lives behind a Filter
// strip across the top (All / New / Accepted / Preparing / Ready /
// Out for delivery / Completed / Cancelled).
//
// Clicking the row opens the existing OrderDetailDrawer; the action
// buttons swallow the row click so they don't double-trigger.

import { useMemo, useState } from "react";
import {
  AlertCircle,
  Bike,
  CheckCircle2,
  ChefHat,
  Clock,
  Loader2,
  ShoppingBag,
  XCircle,
  CreditCard,
  Send,
  Truck,
  MapPin,
  Building2,
  Printer,
  Filter as FilterIcon,
  ChevronDown,
  ListFilter,
  X as XIcon,
  Check,
  CalendarClock,
  ListChecks,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { usePendingCallerStore } from "@/stores/pending-caller.store";
import dynamic from "next/dynamic";
import { canBulkDispatch } from "./bulk-dispatch-eligibility";
import {
  isScheduledForLater,
  scheduledWhen,
  formatScheduledWhen,
} from "@/lib/orders/scheduled";
import { OrderDetailDrawer } from "./order-detail-drawer";
import { OrderActions } from "./order-actions";
import { DispatchModal } from "./dispatch-modal";
import { PaymentBadge } from "./order-card";
import { PlatformBadge, FulfillmentBadge } from "./platform-badge";
import { useLiveOrders } from "../../hooks/use-live-orders";
import type { Order } from "../../lib/api/orders.client";
import { isAwaitingOurPayment } from "@/lib/orders/awaiting-payment";

// Only loaded once someone actually opens it — it pulls in three courier
// clients the board has no use for otherwise.
const BulkDispatchModal = dynamic(
  () => import("./bulk-dispatch-modal").then((m) => m.BulkDispatchModal),
  { ssr: false },
);

// Bucket → matching predicate + chip tone for the status pill.
// One-to-one with the columns the old Kanban board surfaced.
type Bucket = {
  key: string;
  label: string;
  match: (o: Order) => boolean;
  pill: string; // tailwind classes for the status pill
  icon: React.ElementType;
};

const COLLECTION = new Set(["PICKUP", "DINE_IN"]);

// Phase AR — channel catalog for the Filter popover. Lists every
// platform we ship today plus the integrations on the roadmap so
// operators can see what's planned. `enabled: false` channels render
// as disabled "Coming soon" rows that can't be ticked.
//
// The `match` predicate maps the chip label to the platform string(s)
// each adapter writes onto Order.platform. Some legacy orders came in
// before the ONLINE marker existed and were tagged DIRECT, so the
// "Direct online ordering" chip accepts both.
type Channel = {
  key: string;
  label: string;
  match: (platform: string) => boolean;
  enabled: boolean;
};

const CHANNELS: Channel[] = [
  {
    key: "JUST_EAT",
    label: "Just Eat",
    match: (p) => p === "JUST_EAT" || p === "JUSTEAT",
    enabled: true,
  },
  {
    key: "UBER_EATS",
    label: "Uber Eats",
    match: (p) => p === "UBER_EATS" || p === "UBEREATS",
    enabled: true,
  },
  {
    key: "DELIVEROO",
    label: "Deliveroo",
    match: (p) => p === "DELIVEROO",
    enabled: true,
  },
  {
    key: "HUBRISE",
    label: "HubRise",
    match: (p) => p === "HUBRISE",
    enabled: true,
  },
  {
    key: "DIRECT",
    label: "Direct online ordering",
    match: (p) => p === "DIRECT" || p === "ONLINE",
    enabled: true,
  },
  {
    key: "WHATSAPP",
    label: "WhatsApp",
    match: (p) => p === "WHATSAPP",
    enabled: true,
  },
  {
    // Direct integration (restaurant Partners API) — orders really arrive.
    key: "GLOVO",
    label: "Glovo",
    match: (p) => p === "GLOVO",
    enabled: true,
  },
  {
    key: "CAREEM",
    label: "Careem",
    match: () => false,
    enabled: false,
  },
  {
    key: "TALABAT",
    label: "Talabat",
    match: () => false,
    enabled: false,
  },
];

// POS "Payment link" orders wait here until the customer pays: status is still
// PENDING but paymentStatus isn't PAID yet. They stay out of New (and print
// nothing) until the Stripe webhook flips them to PAID server-side, at which
// point they move into New and auto-accept/print.
const isWaitingForPayment = (o: Order): boolean =>
  // Table Tabs — an open dine-in tab is money on the floor: it sits here for
  // its whole life (through every round) until Pay & close settles it. That is
  // list-view-only, which is why it is not in the shared predicate.
  (o.fulfillmentType === "DINE_IN" &&
    o.paymentStatus !== "PAID" &&
    o.status !== "COMPLETED" &&
    o.status !== "CANCELLED" &&
    o.status !== "REJECTED") ||
  isAwaitingOurPayment(o as any);

const BUCKETS: Bucket[] = [
  {
    key: "WAITING_FOR_PAYMENT",
    label: "Waiting for payment",
    match: (o) => isWaitingForPayment(o),
    pill: "bg-violet-50 text-violet-700",
    icon: CreditCard,
  },
  {
    key: "SCHEDULED",
    label: "Scheduled",
    match: (o) => isScheduledForLater(o as any),
    pill: "bg-indigo-50 text-indigo-700",
    icon: CalendarClock,
  },
  {
    key: "PENDING",
    label: "New",
    match: (o) =>
      o.status === "PENDING" &&
      !isWaitingForPayment(o) &&
      // A pre-order is not work to start now. Without this the kitchen makes
      // a 9pm delivery at 5pm because it looked like every other new order.
      !isScheduledForLater(o as any),
    pill: "bg-blue-50 text-blue-700",
    icon: Clock,
  },
  {
    key: "ACCEPTED",
    label: "Accepted",
    // Not the pre-orders. They are accepted on arrival now, and the board
    // columns are filtered independently rather than first-match — so without
    // this the same order is listed under Scheduled AND Accepted.
    match: (o) =>
      o.status === "ACCEPTED" &&
      !isWaitingForPayment(o) &&
      !isScheduledForLater(o as any),
    pill: "bg-sky-50 text-sky-700",
    icon: CheckCircle2,
  },
  {
    key: "PREPARING",
    label: "Preparing",
    match: (o) => o.status === "PREPARING" && !isWaitingForPayment(o),
    pill: "bg-amber-50 text-amber-700",
    icon: ChefHat,
  },
  {
    key: "READY",
    label: "Ready",
    match: (o) => o.status === "READY" && !isWaitingForPayment(o),
    pill: "bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  },
  // Phase AV-2 follow-up — split the old single "Dispatch" bucket
  // into two so operators can see at a glance which orders just got
  // a driver assigned vs which are actually on the way. The platform
  // courier flow (HubRise → us) walks through both states; lumping
  // them under "Dispatch" hid the intermediate driver assignment.
  {
    key: "DRIVER_ASSIGNED",
    label: "Driver assigned",
    // RIDER_ARRIVED is overloaded: on a marketplace order it means the
    // courier is at the SHOP (pre-pickup, belongs here); on our own-fleet
    // orders the driver app sets it when they reach the CUSTOMER, which is
    // after out-for-delivery and gets its own bucket below. outForDeliveryAt
    // is the discriminator — it's only stamped once the driver has started.
    match: (o) =>
      o.status === "PENDING_DISPATCH" ||
      o.status === "ASSIGNED_DRIVER" ||
      o.status === "ACCEPTED_BY_DRIVER" ||
      (o.status === "RIDER_ARRIVED" && !o.outForDeliveryAt),
    pill: "bg-violet-50 text-violet-700",
    icon: Truck,
  },
  {
    key: "OUT_FOR_DELIVERY",
    label: "Out for delivery",
    match: (o) =>
      o.status === "OUT_FOR_DELIVERY" || o.status === "DISPATCHED",
    pill: "bg-orange-50 text-orange-700",
    icon: Truck,
  },
  {
    // Our driver has reached the customer's door — the handover moment
    // staff get asked about ("where is he?"). Deliberately its own bucket
    // rather than lumped into Out for delivery, because it is the state
    // the shop can actually answer the phone with.
    key: "AT_CUSTOMER",
    label: "At the customer",
    match: (o) => o.status === "RIDER_ARRIVED" && !!o.outForDeliveryAt,
    pill: "bg-amber-50 text-amber-700",
    icon: MapPin,
  },
  {
    key: "COMPLETED",
    label: "Completed",
    match: (o) => o.status === "COMPLETED",
    pill: "bg-zinc-100 text-zinc-700",
    icon: CheckCircle2,
  },
  {
    key: "CANCELLED",
    label: "Cancelled",
    match: (o) =>
      o.status === "CANCELLED" ||
      o.status === "REJECTED" ||
      o.status === "FAILED",
    pill: "bg-red-50 text-red-700",
    icon: XCircle,
  },
];

interface Props {
  locationId?: string;
}

export function OrderList({ locationId }: Props) {
  const { orders, isLoading, error } = useLiveOrders(locationId);
  const [selected, setSelected] = useState<Order | null>(null);

  // "Open this order" on the incoming-call card. The caller is on the phone
  // asking about an order that is already in the kitchen, so landing them on a
  // board of forty tickets and leaving them to find it is most of the job
  // undone — this opens the same detail panel tapping the card would.
  //
  // Keyed on the VALUE and on the orders arriving, never on this component's
  // mount: the card is pressed from the orders page as often as from anywhere
  // else, and the list is usually still fetching when it is pressed from
  // elsewhere.
  const pendingOpenOrderId = usePendingCallerStore((st) => st.pendingOpenOrderId);
  const setPendingOpenOrderId = usePendingCallerStore(
    (st) => st.setPendingOpenOrderId,
  );
  const [openMiss, setOpenMiss] = useState(false);
  useEffect(() => {
    if (!pendingOpenOrderId) return;
    const hit = orders.find((o) => o.id === pendingOpenOrderId);
    if (hit) {
      setSelected(hit);
      setOpenMiss(false);
      setPendingOpenOrderId(null);
      return;
    }
    if (isLoading) return;
    // Not in the list — but not necessarily missing. Arriving from another
    // screen switches the location, and the board can be showing the previous
    // shop's cached orders for a moment while the new ones fetch. Give that a
    // beat before saying anything: the effect re-runs the instant `orders`
    // changes, which cancels this.
    //
    // If it is still absent after that, it was finished or cancelled between
    // the phone ringing and the button being pressed — and saying so is the
    // point, because a button that does nothing reads as broken software.
    const t = setTimeout(() => {
      setOpenMiss(true);
      setPendingOpenOrderId(null);
    }, 2500);
    return () => clearTimeout(t);
  }, [pendingOpenOrderId, orders, isLoading, setPendingOpenOrderId]);
  const [bucketFilter, setBucketFilter] = useState<string>("ALL");
  // Empty set = "all channels". The filter popover writes the
  // selected channel keys here; live filter narrows orders by
  // matching any selected channel's predicate.
  const [channelFilter, setChannelFilter] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  // The status stages used to be thirteen chips wrapping over four rows on a
  // phone, pushing the orders themselves below the fold. One dropdown beside
  // Filter says the same thing in one line. It always opens on "All orders" —
  // deliberately not remembered, so nobody comes back to a board that looks
  // empty because it is still filtered to yesterday's "Ready".
  const [statusOpen, setStatusOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);

  // Bulk dispatch. `picks` is an ARRAY, not a set: the order they were tapped
  // in is the stop order for an own-fleet run, so it has to be kept.
  const [bulkMode, setBulkMode] = useState(false);
  const [picks, setPicks] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const orderById = useMemo(
    () => new Map(orders.map((o) => [o.id, o])),
    [orders],
  );
  // Derived, not stored: a pick the live board has since made ineligible —
  // dispatched from another tablet, cancelled, gone — simply drops out.
  const pickedOrders = picks
    .map((id) => orderById.get(id))
    .filter((o): o is Order => !!o && canBulkDispatch(o));
  const togglePick = (id: string) =>
    setPicks((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  // Numbered from the live picks, so the stop numbers stay 1..N with no gap
  // when one drops out.
  const pickedIds = pickedOrders.map((o) => o.id);
  const bulkProps = (o: Order): BulkRowProps => {
    const i = pickedIds.indexOf(o.id);
    return {
      pickable: canBulkDispatch(o),
      pickNumber: i >= 0 ? i + 1 : null,
      onPick: () => togglePick(o.id),
    };
  };
  const exitBulk = () => {
    setBulkMode(false);
    setPicks([]);
    setBulkOpen(false);
  };

  useEffect(() => {
    if (!filterOpen && !statusOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false);
      if (!statusRef.current?.contains(e.target as Node)) setStatusOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFilterOpen(false);
        setStatusOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterOpen, statusOpen]);

  const statusOptions = [
    { key: "ALL", label: "All orders" },
    ...BUCKETS.map((b) => ({ key: b.key, label: b.label })),
  ];
  const activeStatus =
    statusOptions.find((o) => o.key === bucketFilter) ?? statusOptions[0]!;

  // Pre-bucket every order so the filter chip counts stay accurate
  // even when a filter is already applied.
  const counts = useMemo(() => {
    const out: Record<string, number> = { ALL: orders.length };
    for (const b of BUCKETS) out[b.key] = orders.filter(b.match).length;
    return out;
  }, [orders]);

  const filteredOrders = useMemo(() => {
    let list = orders;
    if (bucketFilter !== "ALL") {
      const b = BUCKETS.find((x) => x.key === bucketFilter);
      if (b) list = list.filter(b.match);
    }
    if (channelFilter.size > 0) {
      const matchers = CHANNELS.filter((c) => channelFilter.has(c.key)).map(
        (c) => c.match,
      );
      list = list.filter((o) => matchers.some((m) => m(o.platform)));
    }
    return list;
  }, [orders, bucketFilter, channelFilter]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading orders…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-red-500">
        <AlertCircle className="h-4 w-4" /> Failed to load orders
      </div>
    );
  }

  return (
    <>
      {openMiss && (
        <div
          role="status"
          aria-live="polite"
          className="mb-3 flex items-start justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <span>
            That order isn&apos;t on the live board any more — it was completed
            or cancelled. Look it up in Order history.
          </span>
          <button
            onClick={() => setOpenMiss(false)}
            className="shrink-0 rounded border border-current/40 px-2 py-0.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2"
          >
            Got it
          </button>
        </div>
      )}

      {/* Status dropdown + channel Filter, one tidy row */}
      <div className="mb-3 flex items-center gap-2">
        <div className="relative" ref={statusRef}>
          <button
            type="button"
            onClick={() => {
              setStatusOpen((o) => !o);
              setFilterOpen(false);
            }}
            aria-haspopup="listbox"
            aria-expanded={statusOpen}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
              bucketFilter !== "ALL"
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
            }`}
          >
            <ListFilter className="h-3.5 w-3.5" aria-hidden="true" />
            {activeStatus.label}
            <span
              className={`rounded-full px-1.5 py-0 text-[10px] tabular-nums ${
                bucketFilter !== "ALL" ? "bg-white/15" : "bg-zinc-100 text-zinc-500"
              }`}
            >
              {counts[activeStatus.key] ?? 0}
            </span>
            <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
          </button>

          {statusOpen && (
            <div
              role="listbox"
              aria-label="Order status"
              className="absolute left-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl"
            >
              <div className="border-b border-zinc-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Status
              </div>
              <div className="max-h-80 overflow-y-auto py-1">
                {statusOptions.map((o) => {
                  const active = bucketFilter === o.key;
                  const count = counts[o.key] ?? 0;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        setBucketFilter(o.key);
                        setStatusOpen(false);
                      }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                        active ? "bg-zinc-50 font-semibold text-zinc-900" : "text-zinc-800 hover:bg-zinc-50"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="grid h-4 w-4 place-items-center">
                          {active && <Check className="h-3.5 w-3.5 text-zinc-900" />}
                        </span>
                        {o.label}
                      </span>
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                          count > 0 ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-400"
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Bulk dispatch — pick several deliveries, send them together. */}
        <button
          type="button"
          onClick={() => (bulkMode ? exitBulk() : setBulkMode(true))}
          aria-pressed={bulkMode}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
            bulkMode
              ? "border-violet-600 bg-violet-600 text-white hover:bg-violet-700"
              : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
          }`}
        >
          {bulkMode ? (
            <XIcon className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {bulkMode ? "Cancel bulk dispatch" : "Bulk dispatch"}
        </button>

        {/* Channel filter — Filter button with popover */}
        <div className="ml-auto relative" ref={filterRef}>
          <button
            type="button"
            onClick={() => {
              setFilterOpen((o) => !o);
              setStatusOpen(false);
            }}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
              channelFilter.size > 0
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
            }`}
          >
            <FilterIcon className="h-3.5 w-3.5" />
            Filter
            {channelFilter.size > 0 && (
              <span className="rounded-full bg-white/15 px-1.5 py-0 text-[10px] tabular-nums">
                {channelFilter.size}
              </span>
            )}
          </button>

          {filterOpen && (
            <div className="absolute right-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Channels
                </span>
                {channelFilter.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setChannelFilter(new Set())}
                    className="text-[11px] font-semibold text-violet-600 hover:text-violet-700"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="max-h-80 overflow-y-auto py-1">
                {CHANNELS.map((c) => {
                  const checked = channelFilter.has(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      disabled={!c.enabled}
                      onClick={() => {
                        setChannelFilter((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.key)) next.delete(c.key);
                          else next.add(c.key);
                          return next;
                        });
                      }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                        c.enabled
                          ? "text-zinc-800 hover:bg-zinc-50"
                          : "cursor-not-allowed text-zinc-400"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`grid h-4 w-4 place-items-center rounded border ${
                            checked
                              ? "border-zinc-900 bg-zinc-900"
                              : c.enabled
                                ? "border-zinc-300 bg-white"
                                : "border-zinc-200 bg-zinc-50"
                          }`}
                        >
                          {checked && <Check className="h-3 w-3 text-white" />}
                        </span>
                        {c.label}
                      </span>
                      {!c.enabled && (
                        <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500">
                          Coming soon
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Active channel chips — quick remove without re-opening popover */}
      {channelFilter.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-zinc-500">Filtering by:</span>
          {Array.from(channelFilter).map((key) => {
            const c = CHANNELS.find((x) => x.key === key);
            if (!c) return null;
            return (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-700"
              >
                {c.label}
                <button
                  type="button"
                  onClick={() =>
                    setChannelFilter((prev) => {
                      const next = new Set(prev);
                      next.delete(key);
                      return next;
                    })
                  }
                  className="text-zinc-400 hover:text-zinc-700"
                  aria-label={`Remove ${c.label} filter`}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {bulkMode && (
        <p className="mb-3 text-xs text-zinc-600">
          Tap the deliveries to send together. For your own driver, they&rsquo;re
          delivered in the order you tap them.
          {!filteredOrders.some(canBulkDispatch) &&
            " None on this board can be dispatched right now — only accepted, preparing or ready deliveries that aren't already with a courier."}
        </p>
      )}

      {/* The list */}
      {filteredOrders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-12 text-center text-sm text-zinc-500">
          No orders match this filter.
        </div>
      ) : (
        <>
        {/* Phone: one card per order.
            Ten columns cannot be made to work at 375px, and horizontal
            scroll is the worst of both worlds — you end up unable to see
            the order number and the Accept button at the same time, which
            is the one pairing that matters when you're holding the phone.
            So below md the same data is stacked instead. */}
        <div className="flex flex-col gap-2 md:hidden">
          {filteredOrders.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              onOpen={() => setSelected(o)}
              bulk={bulkMode ? bulkProps(o) : undefined}
            />
          ))}
        </div>

        <div className="hidden overflow-x-auto rounded-lg border border-zinc-200 bg-white md:block">
          {/* Auto width (not w-full) so columns hug their content — on a
              small tablet this removes the big inter-column gaps that
              pushed the Status column off-screen. */}
          <table className="divide-y divide-zinc-200 text-sm">
            <thead className="bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-500">
              <tr>
                {bulkMode && (
                  <th className="px-1.5 py-2.5 text-left font-semibold whitespace-nowrap">
                    <span className="sr-only">Pick</span>
                  </th>
                )}
                <Th>Time</Th>
                <Th>Order #</Th>
                <Th>Channel</Th>
                <Th>Brand</Th>
                <Th>Type</Th>
                <Th>Delivery</Th>
                <Th>Rider</Th>
                <Th>ETA</Th>
                <Th>Customer</Th>
                <Th>Payment</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filteredOrders.map((o) => (
                <OrderRow
                  key={o.id}
                  order={o}
                  onOpen={() => setSelected(o)}
                  bulk={bulkMode ? bulkProps(o) : undefined}
                />
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      <OrderDetailDrawer
        // Always derive from the live orders list so the drawer reflects
        // status changes the user just made (Accept, Preparing, Ready…)
        // without needing to close + reopen the panel. Fall back to the
        // captured snapshot only if the order has dropped off the page.
        order={
          selected
            ? orders.find((o) => o.id === selected.id) ?? selected
            : null
        }
        onClose={() => setSelected(null)}
      />

      {/* The pick, and the one thing to do with it. Pinned to the bottom so it
          is in reach however far down the board the last pick was. */}
      {/* Room to scroll the last orders clear of the bar below. */}
      {bulkMode && <div className="h-24" aria-hidden="true" />}
      {bulkMode && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="pointer-events-auto flex w-full max-w-lg items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-xl">
            <p className="min-w-0 flex-1 text-sm text-zinc-700" aria-live="polite">
              {pickedOrders.length === 0 ? (
                "Tap deliveries to add them"
              ) : (
                <>
                  <span className="font-semibold tabular-nums text-zinc-900">
                    {pickedOrders.length}
                  </span>{" "}
                  {pickedOrders.length === 1 ? "order" : "orders"} picked
                </>
              )}
            </p>
            {pickedOrders.length > 0 && (
              <button
                type="button"
                onClick={() => setPicks([])}
                className="rounded-lg px-2 py-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-800"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => setBulkOpen(true)}
              disabled={pickedOrders.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-40"
            >
              <Bike className="h-4 w-4" aria-hidden="true" />
              Dispatch {pickedOrders.length > 0 ? pickedOrders.length : ""}
            </button>
          </div>
        </div>
      )}

      {bulkOpen && pickedOrders.length > 0 && (
        <BulkDispatchModal
          orders={pickedOrders}
          onClose={() => setBulkOpen(false)}
          onDispatched={(sentIds, allSent) => {
            // Everything went: done with bulk mode. Some didn't (Uber refused
            // a few): keep picking with only those left.
            if (allSent) exitBulk();
            else setPicks((p) => p.filter((id) => !sentIds.includes(id)));
          }}
        />
      )}
    </>
  );
}

/** What a row needs to take part in a bulk pick. Absent when not picking. */
interface BulkRowProps {
  pickable: boolean;
  /** 1-based stop number when picked, else null. */
  pickNumber: number | null;
  onPick: () => void;
}

/**
 * The pick box: a numbered badge when picked (the number is the stop order
 * for an own-fleet run), an empty box when it can be picked, and nothing to
 * press when it can't.
 */
function PickBox({ bulk, label }: { bulk: BulkRowProps; label: string }) {
  if (!bulk.pickable) {
    return <span className="block h-6 w-6" aria-hidden="true" />;
  }
  const picked = bulk.pickNumber != null;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={picked}
      aria-label={picked ? `${label}, stop ${bulk.pickNumber}` : `Pick ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        bulk.onPick();
      }}
      className={`grid h-6 w-6 place-items-center rounded-md border text-xs font-bold tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 ${
        picked
          ? "border-violet-600 bg-violet-600 text-white"
          : "border-zinc-300 bg-white text-transparent hover:border-violet-400"
      }`}
    >
      {picked ? bulk.pickNumber : ""}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

/**
 * The same order, for a phone.
 *
 * Not a shrunken table row — a different arrangement of the same facts,
 * ordered by what someone standing up with a phone actually needs: which
 * order, how long it's been waiting, what state it's in, then the buttons.
 * Brand, channel and payment sit in the middle because they're the things
 * you glance at rather than act on.
 *
 * Deliberately shares OrderActions / PrintOrderButton / DispatchModal with
 * the table row. Two copies of "which buttons does this status get" is how
 * the phone quietly ends up unable to do something the tablet can.
 */
function OrderCard({
  order,
  onOpen,
  bulk,
}: {
  order: Order;
  onOpen: () => void;
  /** Present while bulk-picking: the card tap picks instead of opening. */
  bulk?: BulkRowProps;
}) {
  const bucket =
    BUCKETS.find((b) => b.match(order)) ?? BUCKETS[BUCKETS.length - 1]!;
  const StatusIcon = bucket.icon;
  const [showDispatch, setShowDispatch] = useState(false);

  const brandName =
    (order as any).brand?.name ?? (order as any).location?.brand?.name ?? null;
  const ref = `#${order.displayId ?? (order as any).orderNumber ?? order.id.slice(-6)}`;

  return (
    <div
      onClick={bulk ? (bulk.pickable ? bulk.onPick : undefined) : onOpen}
      className={`rounded-lg border bg-white p-3 transition-colors ${
        bulk && !bulk.pickable
          ? "cursor-default border-zinc-200 opacity-45"
          : "cursor-pointer active:bg-zinc-50"
      } ${
        bulk?.pickNumber != null
          ? "border-violet-400 bg-violet-50/60"
          : "border-zinc-200"
      }`}
    >
      {/* Order # + status — the two things worth seeing from arm's length. */}
      <div className="flex items-start justify-between gap-2">
        {bulk && (
          <div className="shrink-0 pt-0.5">
            <PickBox bulk={bulk} label={ref} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <span className="text-base font-semibold text-zinc-900">
            #{order.displayId ?? (order as any).orderNumber ?? order.id.slice(-6)}
          </span>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
            <span>
              {new Date(order.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <span>·</span>
            <span>{timeAgo(order.createdAt)}</span>
            {/* When it's due, not when it arrived. On a pre-order the placed
                time is the one number nobody needs — the slot the customer
                chose is what the kitchen works back from. */}
            {(() => {
              const due = isScheduledForLater(order as any)
                ? scheduledWhen(order as any)
                : null;
              return due ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-1.5 py-0.5 font-semibold text-indigo-700">
                  <CalendarClock className="h-3 w-3" />
                  for {formatScheduledWhen(due)}
                </span>
              ) : null;
            })()}
          </div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${bucket.pill}`}
        >
          <StatusIcon className="h-3 w-3" />
          {bucket.label}
        </span>
      </div>

      {/* Channel / type / delivery mode. Wraps rather than truncating —
          vertical space is the one thing a phone has plenty of. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <PlatformBadge
          platform={
            order.platform === "HUBRISE" &&
            (order as any).orderSource &&
            (order as any).orderSource !== "HUBRISE"
              ? (order as any).orderSource
              : order.platform
          }
        />
        <FulfillmentBadge type={order.fulfillmentType} />
        <DeliveryTypeBadge type={(order as any).deliveryType} />
        <PaymentBadge
          method={(order as any).paymentMethod}
          status={(order as any).paymentStatus}
        />
      </div>

      {/* Customer + where it's going. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-600">
        <span className="truncate font-medium text-zinc-800">
          {order.customerInfo?.name ?? "—"}
        </span>
        {typeof order.customerVisitCount === "number" &&
          order.customerVisitCount > 0 &&
          (order.customerVisitCount <= 1 ? (
            <span className="inline-flex items-center rounded-md bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-800">
              New
            </span>
          ) : (
            <span className="inline-flex items-center rounded-md bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-800">
              Returning · #{order.customerVisitCount}
            </span>
          ))}
        {brandName && (
          <span className="truncate text-zinc-500">
            · {brandName}
            {(order as any).location?.name
              ? ` · ${(order as any).location.name}`
              : ""}
          </span>
        )}
      </div>

      {/* Actions. Scrolls sideways INSIDE the card when a status carries
          three transitions — the card itself never grows past the viewport,
          so the page body still can't scroll horizontally. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="-mx-1 mt-3 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5"
      >
        <PrintOrderButton order={order} />
        <OrderActions
          orderId={order.id}
          status={order.status}
          fulfillmentType={order.fulfillmentType}
          deliveryType={(order as any).deliveryType}
          onDispatch={() => setShowDispatch(true)}
        />
        {showDispatch && (
          <DispatchModal
            orderId={order.id}
            locationId={(order as any).locationId ?? null}
            orderRef={`#${order.displayId ?? (order as any).orderNumber ?? ""}`}
            onClose={() => setShowDispatch(false)}
          />
        )}
      </div>
    </div>
  );
}

function OrderRow({
  order,
  onOpen,
  bulk,
}: {
  order: Order;
  onOpen: () => void;
  /** Present while bulk-picking: the row click picks instead of opening. */
  bulk?: BulkRowProps;
}) {
  const bucket =
    BUCKETS.find((b) => b.match(order)) ??
    BUCKETS[BUCKETS.length - 1]!;
  const StatusIcon = bucket.icon;
  const [showDispatch, setShowDispatch] = useState(false);
  const ref = `#${order.displayId ?? (order as any).orderNumber ?? order.id.slice(-6)}`;

  return (
    <tr
      onClick={bulk ? (bulk.pickable ? bulk.onPick : undefined) : onOpen}
      className={`transition-colors ${
        bulk && !bulk.pickable
          ? "cursor-default opacity-45"
          : "cursor-pointer hover:bg-zinc-50/60"
      } ${bulk?.pickNumber != null ? "bg-violet-50/70" : ""}`}
    >
      {bulk && (
        <Td>
          <PickBox bulk={bulk} label={ref} />
        </Td>
      )}
      <Td>
        <div className="flex flex-col">
          <span className="font-medium text-zinc-900">
            {new Date(order.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="text-[11px] text-zinc-500">
            {timeAgo(order.createdAt)}
          </span>
          {/* Expected delivery / collection time lives in the order
              detail popup now — keeping it out of the list row so the
              Status column stays visible on small tablets. */}
        </div>
      </Td>
      <Td>
        <span className="font-semibold text-zinc-900">
          {/* Phase AW-30 — prefer the 5-char displayId ("AB31C"). It's
              what the customer sees on their receipt + status page so
              the board should match. Marketplace orders also populate
              displayId with their platform code, so this ordering
              works for both paths. Falls back to the internal-
              sequential orderNumber for legacy rows. */}
          #{order.displayId ?? (order as any).orderNumber ?? order.id.slice(-6)}
        </span>
      </Td>
      <Td>
        {/* Phase AU — HubRise orders carry the original marketplace
            in `orderSource` (UBER_EATS / DELIVEROO / JUST_EAT). The
            operator wants to see "Uber Eats" on the board, not the
            transport. Fall back to platform for non-HubRise orders. */}
        <PlatformBadge
          platform={
            order.platform === "HUBRISE" &&
            (order as any).orderSource &&
            (order as any).orderSource !== "HUBRISE"
              ? (order as any).orderSource
              : order.platform
          }
        />
      </Td>
      {/* Brand + location — the brand the order belongs to (resolved
          from the marketplace payload for HubRise) with the fulfilling
          location beneath it. */}
      <Td>
        <div className="max-w-[160px] flex flex-col gap-0.5">
          <span className="truncate font-medium text-zinc-900">
            {(order as any).brand?.name ??
              (order as any).location?.brand?.name ??
              "—"}
          </span>
          {(order as any).location?.name && (
            <span className="truncate text-[11px] text-zinc-500">
              {(order as any).location.name}
            </span>
          )}
        </div>
      </Td>
      <Td>
        <FulfillmentBadge type={order.fulfillmentType} />
      </Td>
      <Td>
        {/* Phase AV — Delivery type pill. PLATFORM = marketplace
            courier (Uber/Deliveroo/Just Eat) drives the post-READY
            chain; MERCHANT = restaurant's own driver, operator walks
            it all the way to delivered. Null when not applicable
            (PICKUP / DINE_IN). */}
        <DeliveryTypeBadge type={(order as any).deliveryType} />
      </Td>
      <Td>
        <RiderCell order={order} />
      </Td>
      <Td>
        <PickupEtaCell order={order} />
      </Td>
      <Td>
        <div className="max-w-[150px] flex flex-col gap-0.5">
          <div className="truncate text-zinc-700">
            {order.customerInfo?.name ?? "—"}
          </div>
          {/* Phase AW-26 — NEW / RETURNING customer signal. The
              count is attached server-side by
              OrdersService.findLiveOrders. */}
          {typeof order.customerVisitCount === "number" &&
            order.customerVisitCount > 0 &&
            (order.customerVisitCount <= 1 ? (
              <span className="inline-flex w-fit items-center rounded-md bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-800">
                New
              </span>
            ) : (
              <span className="inline-flex w-fit items-center rounded-md bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-800">
                Returning · #{order.customerVisitCount}
              </span>
            ))}
        </div>
      </Td>
      <Td>
        <PaymentBadge
          method={(order as any).paymentMethod}
          status={(order as any).paymentStatus}
        />
      </Td>
      <Td>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${bucket.pill}`}
        >
          <StatusIcon className="h-3 w-3" />
          {bucket.label}
        </span>
      </Td>
      <Td>
        {/* OrderActions handles stopPropagation internally so clicks
            here don't reopen the drawer. */}
        {/* flex-nowrap + whitespace-nowrap so all action buttons + the
            reprint icon stay on one row even when the row carries 3
            status transitions (e.g. Out for delivery + Send to dispatch
            + Cancel). The Td already overflows the table cell on small
            viewports; we accept horizontal table scroll over a wrapped
            broken-looking actions column. */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex flex-nowrap items-center gap-1.5 whitespace-nowrap"
        >
          <PrintOrderButton order={order} />
          <OrderActions
            orderId={order.id}
            status={order.status}
            fulfillmentType={order.fulfillmentType}
            deliveryType={(order as any).deliveryType}
            onDispatch={() => setShowDispatch(true)}
          />
          {showDispatch && (
            <DispatchModal
              orderId={order.id}
              locationId={(order as any).locationId ?? null}
              orderRef={`#${order.displayId ?? (order as any).orderNumber ?? ""}`}
              onClose={() => setShowDispatch(false)}
            />
          )}
        </div>
      </Td>
    </tr>
  );
}

// Print icon on the list row — prints the full receipt straight to the
// Bluetooth printer via the native bridge, identical to the printer icon
// in the order detail popup. (Was a dropdown that hit the server reprint
// endpoint, which only queued a job and never printed over Bluetooth.)
function PrintOrderButton({ order }: { order: Order }) {
  const [state, setState] = useState<"idle" | "printing" | "ok" | "error">(
    "idle",
  );
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    setState("printing");
    setMsg(null);
    try {
      const { printOrderViaBridge } = await import("@/lib/printing/print-order");
      await printOrderViaBridge(order);
      setState("ok");
      setTimeout(() => setState("idle"), 2000);
    } catch (e: any) {
      setMsg(e?.message ?? "Print failed");
      setState("error");
      setTimeout(() => setState("idle"), 4000);
    }
  };
  return (
    <button
      type="button"
      onClick={run}
      disabled={state === "printing"}
      title={msg ?? "Print receipt"}
      className={`rounded-md p-1.5 ${
        state === "ok"
          ? "text-emerald-600"
          : state === "error"
            ? "text-rose-600"
            : "text-zinc-400 hover:bg-violet-50 hover:text-violet-700"
      }`}
    >
      {state === "printing" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === "ok" ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Printer className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-1.5 py-2.5 text-left font-semibold whitespace-nowrap">
      {children}
    </th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-1.5 py-2.5 align-middle">{children}</td>;
}

/**
 * Who is actually carrying this order.
 *
 * Two different things wearing one hat. A MARKETPLACE courier arrives as flat
 * columns on the order — courierName, set by the platform's rider webhook. An
 * IN-HOUSE rider is a real person with a Driver row and an assignment. The
 * operator does not care which is which; they care whether somebody has it.
 *
 * Deliberately says nothing when nobody is assigned. A dash is honest — "no
 * rider yet" is a real and common state, and inventing "Unassigned" makes an
 * empty column look like a broken one.
 */
/**
 * The rider currently on this order, or nothing.
 *
 * Cancelling a dispatch keeps the assignment row and marks it CANCELLED — the
 * history of who was sent is worth having. But the board read the row without
 * looking at its status, so taking an order off a driver left their name
 * sitting in the Rider column as though they were still bringing it.
 *
 * DELIVERED stays: the person who took it is still the answer to "who had
 * this?".
 */
function activeAssignment(order: Order) {
  const a = (order as any).driverAssignment;
  return a && a.status !== "CANCELLED" ? a : null;
}

function RiderCell({ order }: { order: Order }) {
  const assignment = activeAssignment(order);
  const inHouse = assignment?.driver
    ? [assignment.driver.firstName, assignment.driver.lastName]
        .filter(Boolean)
        .join(" ")
        .trim()
    : "";
  const platform = ((order as any).courierName ?? "").trim();

  // In-house wins when both exist: the shop dispatched it themselves, so
  // whatever a marketplace last said about a courier is stale.
  const name = inHouse || platform;
  if (!name) return <span className="text-zinc-300">—</span>;

  return (
    <div className="flex max-w-[130px] flex-col gap-0.5">
      <span className="truncate text-zinc-700">{name}</span>
      <span
        className={`w-fit rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
          inHouse
            ? "bg-violet-100 text-violet-800"
            : "bg-zinc-100 text-zinc-600"
        }`}
      >
        {inHouse ? "Ours" : "Platform"}
      </span>
    </div>
  );
}

/**
 * How long until the platform's rider reaches the SHOP.
 *
 * Platform couriers only, deliberately. An in-house driver is the shop's own
 * person — the operator knows where they are, and there is no third party
 * sending us an estimate for them. Showing a blank cell for our own riders is
 * correct rather than missing.
 *
 * Counts down from courierPickupEtaAt, which is NOT courierEtaAt: that one is
 * arrival at the customer and drives auto-completion. Two different questions,
 * two different columns.
 *
 * Recomputed on a timer rather than at render, because a board sits open on a
 * wall for hours and a number that says "8 min" from forty minutes ago is
 * worse than no number.
 */
function PickupEtaCell({ order }: { order: Order }) {
  const raw = (order as any).courierPickupEtaAt as string | null | undefined;
  const inHouse = !!activeAssignment(order)?.driver;
  // Once the rider has the food, a countdown to when they were due to ARRIVE
  // is not just useless, it is wrong — it kept reading "39 min" on an order
  // collected forty seconds earlier, because the platform stops refreshing
  // that estimate the moment it stops mattering to them.
  const collected = !!(order as any).courierPickedUpAt;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!raw || inHouse) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [raw, inHouse]);

  if (inHouse || !raw) return <span className="text-zinc-300">—</span>;

  if (collected) {
    // Said rather than blanked: "the rider has been and gone" is a different
    // fact from "we never had an estimate", and the kitchen cares which.
    return (
      <span className="text-[11px] font-medium text-zinc-400">Collected</span>
    );
  }

  const eta = new Date(raw).getTime();
  if (!Number.isFinite(eta)) return <span className="text-zinc-300">—</span>;

  const mins = Math.round((eta - now) / 60_000);

  // Past its estimate. "Due" rather than a negative number or a stale count:
  // the rider is late or already inside, and either way the number has stopped
  // being information.
  if (mins <= 0) {
    return (
      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-800">
        Due
      </span>
    );
  }
  // Arriving. The one state worth catching from across a kitchen.
  const urgent = mins <= 5;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${
        urgent ? "bg-emerald-100 text-emerald-800" : "text-zinc-600"
      }`}
    >
      {mins} min
    </span>
  );
}

// Phase AV — small badge for the new Delivery column. We deliberately
// use two distinct colour families (amber for PLATFORM, emerald for
// MERCHANT) instead of a generic neutral so operators triaging the
// board can scan the column in one glance.
function DeliveryTypeBadge({ type }: { type?: string | null }) {
  if (!type) return <span className="text-zinc-400">—</span>;
  const cfg =
    type === "PLATFORM"
      ? {
          label: "Platform",
          cls: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200",
        }
      : {
          label: "Merchant",
          cls: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
        };
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}
