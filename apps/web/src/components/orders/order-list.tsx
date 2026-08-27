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
  X as XIcon,
  Check,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { OrderDetailDrawer } from "./order-detail-drawer";
import { OrderActions } from "./order-actions";
import { DispatchModal } from "./dispatch-modal";
import { PaymentBadge } from "./order-card";
import { PlatformBadge, FulfillmentBadge } from "./platform-badge";
import { useLiveOrders } from "../../hooks/use-live-orders";
import type { Order } from "../../lib/api/orders.client";
import { isAwaitingOurPayment } from "@/lib/orders/awaiting-payment";

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
    key: "PENDING",
    label: "New",
    match: (o) => o.status === "PENDING" && !isWaitingForPayment(o),
    pill: "bg-blue-50 text-blue-700",
    icon: Clock,
  },
  {
    key: "ACCEPTED",
    label: "Accepted",
    match: (o) => o.status === "ACCEPTED" && !isWaitingForPayment(o),
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
  const [bucketFilter, setBucketFilter] = useState<string>("ALL");
  // Empty set = "all channels". The filter popover writes the
  // selected channel keys here; live filter narrows orders by
  // matching any selected channel's predicate.
  const [channelFilter, setChannelFilter] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filterOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [filterOpen]);

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
      {/* Status filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <FilterChip
          label="All"
          count={counts.ALL ?? 0}
          active={bucketFilter === "ALL"}
          onClick={() => setBucketFilter("ALL")}
        />
        {BUCKETS.map((b) => (
          <FilterChip
            key={b.key}
            label={b.label}
            count={counts[b.key] ?? 0}
            active={bucketFilter === b.key}
            onClick={() => setBucketFilter(b.key)}
          />
        ))}
        {/* Channel filter — Filter button with popover */}
        <div className="ml-auto relative" ref={filterRef}>
          <button
            type="button"
            onClick={() => setFilterOpen((o) => !o)}
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
            <OrderCard key={o.id} order={o} onOpen={() => setSelected(o)} />
          ))}
        </div>

        <div className="hidden overflow-x-auto rounded-lg border border-zinc-200 bg-white md:block">
          {/* Auto width (not w-full) so columns hug their content — on a
              small tablet this removes the big inter-column gaps that
              pushed the Status column off-screen. */}
          <table className="divide-y divide-zinc-200 text-sm">
            <thead className="bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-500">
              <tr>
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
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 py-0 text-[10px] tabular-nums ${
          active ? "bg-white/15 text-white" : "bg-zinc-100 text-zinc-500"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

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
function OrderCard({ order, onOpen }: { order: Order; onOpen: () => void }) {
  const bucket =
    BUCKETS.find((b) => b.match(order)) ?? BUCKETS[BUCKETS.length - 1]!;
  const StatusIcon = bucket.icon;
  const [showDispatch, setShowDispatch] = useState(false);

  const brandName =
    (order as any).brand?.name ?? (order as any).location?.brand?.name ?? null;

  return (
    <div
      onClick={onOpen}
      className="cursor-pointer rounded-lg border border-zinc-200 bg-white p-3 transition-colors active:bg-zinc-50"
    >
      {/* Order # + status — the two things worth seeing from arm's length. */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
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
}: {
  order: Order;
  onOpen: () => void;
}) {
  const bucket =
    BUCKETS.find((b) => b.match(order)) ??
    BUCKETS[BUCKETS.length - 1]!;
  const StatusIcon = bucket.icon;
  const [showDispatch, setShowDispatch] = useState(false);

  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer hover:bg-zinc-50/60 transition-colors"
    >
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
function RiderCell({ order }: { order: Order }) {
  const assignment = (order as any).driverAssignment;
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
  const inHouse = !!(order as any).driverAssignment?.driver;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!raw || inHouse) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [raw, inHouse]);

  if (inHouse || !raw) return <span className="text-zinc-300">—</span>;

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
