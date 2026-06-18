"use client";

import {
  Clock,
  User,
  MapPin,
  Calendar,
  Banknote,
  CheckCircle2,
  CreditCard,
  Undo2,
} from "lucide-react";
import { Card, CardContent } from "../ui/card";
import { PlatformBadge, FulfillmentBadge } from "./platform-badge";
import { OrderActions } from "./order-actions";
import type { Order } from "../../lib/api/orders.client";

interface OrderCardProps {
  order: Order;
  onClick: (order: Order) => void;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function OrderCard({ order, onClick }: OrderCardProps) {
  const itemCount = order.items.reduce((s, i) => s + i.quantity, 0);

  return (
    <Card
      className="cursor-pointer border border-zinc-200 hover:border-zinc-300 hover:shadow-sm transition-all active:scale-[0.99]"
      onClick={() => onClick(order)}
    >
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <PlatformBadge platform={order.platform} />
            <FulfillmentBadge type={order.fulfillmentType} />
          </div>
          <span className="text-xs text-zinc-400 whitespace-nowrap shrink-0">
            {timeAgo(order.createdAt)}
          </span>
        </div>

        {/* Order number + customer + payment badge.
            Phase AM + AP fix:
              • POS / DIRECT / ONLINE orders show our sequential #N
              • Marketplaces (Just Eat / Uber Eats / Deliveroo /
                HubRise) keep their own platform displayId
              • If for any reason neither is present (very old rows,
                a webhook that didn't include one), fall back to the
                short tail of the id so the card NEVER reads
                blank — operators always have something to refer to. */}
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-zinc-900">
              {order.orderNumber != null
                ? `#${order.orderNumber}`
                : order.displayId
                  ? `#${order.displayId}`
                  : `#${order.id.slice(-6).toUpperCase()}`}
            </span>
            <span className="text-sm font-medium text-zinc-700">
              {order.customerInfo.name}
            </span>
            <PaymentBadge
              method={order.paymentMethod}
              status={order.paymentStatus}
            />
            {/* Phase AW-26 — NEW / RETURNING customer signal.
                customerVisitCount is the lifetime order count attached
                server-side by OrdersService.findLiveOrders. */}
            {typeof order.customerVisitCount === "number" &&
              order.customerVisitCount > 0 &&
              (order.customerVisitCount <= 1 ? (
                <span className="inline-flex items-center rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                  New
                </span>
              ) : (
                <span className="inline-flex items-center rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-800">
                  Returning · #{order.customerVisitCount}
                </span>
              ))}
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            {itemCount} item{itemCount !== 1 ? "s" : ""} · £{order.total.toFixed(2)}
          </p>
        </div>

        {/* Phase AW-26 — Scheduled badge made unmissable so the
            counter staff don't mistake a 6pm pickup for a "now"
            order during the lunch rush. */}
        {order.scheduledFor && (
          <div className="inline-flex items-center gap-1.5 self-start rounded-md border border-amber-300 bg-amber-100 px-2 py-1 text-xs font-bold uppercase tracking-wider text-amber-900">
            <Calendar className="h-3.5 w-3.5" />
            <span>
              Scheduled ·{" "}
              {new Date(order.scheduledFor).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        )}

        {/* Special instructions */}
        {order.specialInstructions && (
          <p className="text-xs text-zinc-500 italic line-clamp-2">
            "{order.specialInstructions}"
          </p>
        )}

        {/* HubRise indicator */}
        {order.viaHubrise && (
          <div className="text-[10px] text-violet-500 font-medium">via HubRise</div>
        )}

        {/* Per-status action buttons (Phase AJ) */}
        <OrderActions
          orderId={order.id}
          status={order.status}
          fulfillmentType={order.fulfillmentType}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Payment chip shown alongside the customer name. Always renders
 * something for CARD/CASH so staff can tell at a glance whether the
 * order is paid online, owes cash at handover, or sat in some
 * intermediate state (authorised hold, refunded after cancel).
 *
 *   • CASH paid       → green "Cash"
 *   • CASH unpaid     → amber "Cash" (collect at handover)
 *   • CARD PAID       → green "Card paid"
 *   • CARD AUTHORIZED → blue "Card held" (auth captured at Accept)
 *   • CARD REFUNDED   → amber "Refunded"
 *   • CARD PENDING/   → amber "Card unpaid" (shouldn't reach the
 *     FAILED            board — live query filters PENDING out — but
 *                       safety net in case it ever does)
 *   • Marketplace pre-paid → green "Paid"
 */
export function PaymentBadge({
  method,
  status,
}: {
  method?: string | null;
  status?: string | null;
}) {
  if (method === "CASH") {
    return status === "PAID" ? (
      <Chip tone="success">
        <CheckCircle2 className="h-3 w-3" /> Cash
      </Chip>
    ) : (
      <Chip tone="amber">
        <Banknote className="h-3 w-3" /> Cash
      </Chip>
    );
  }
  if (method === "CARD") {
    if (status === "PAID") {
      return (
        <Chip tone="success">
          <CheckCircle2 className="h-3 w-3" /> Card paid
        </Chip>
      );
    }
    if (status === "AUTHORIZED") {
      return (
        <Chip tone="info">
          <CreditCard className="h-3 w-3" /> Card held
        </Chip>
      );
    }
    if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") {
      return (
        <Chip tone="amber">
          <Undo2 className="h-3 w-3" /> Refunded
        </Chip>
      );
    }
    return (
      <Chip tone="amber">
        <CreditCard className="h-3 w-3" /> Card unpaid
      </Chip>
    );
  }
  // Marketplace platforms come in pre-paid
  if (status === "PAID") {
    return (
      <Chip tone="success">
        <CheckCircle2 className="h-3 w-3" /> Paid
      </Chip>
    );
  }
  return null;
}

function Chip({
  tone,
  children,
}: {
  tone: "success" | "amber" | "info";
  children: React.ReactNode;
}) {
  const cls =
    tone === "success"
      ? "bg-emerald-50 text-emerald-700"
      : tone === "info"
        ? "bg-sky-50 text-sky-700"
        : "bg-amber-50 text-amber-700";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}
    >
      {children}
    </span>
  );
}
