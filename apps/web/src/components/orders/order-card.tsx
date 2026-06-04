"use client";

import { Clock, User, MapPin, Calendar, Banknote, CheckCircle2 } from "lucide-react";
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
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            {itemCount} item{itemCount !== 1 ? "s" : ""} · £{order.total.toFixed(2)}
          </p>
        </div>

        {/* Scheduled indicator */}
        {order.scheduledFor && (
          <div className="flex items-center gap-1.5 text-xs text-amber-600 font-medium">
            <Calendar className="h-3.5 w-3.5" />
            <span>
              Scheduled {new Date(order.scheduledFor).toLocaleTimeString([], {
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
 * Phase AM — payment chip shown alongside the customer name.
 *   • Cash + unpaid → amber "Cash" (money still owed at handover)
 *   • Cash + paid   → green "Cash" with check (kept the cash already)
 *   • Card terminal / online / external + PAID → green "Paid"
 *   • Anything else → no badge
 *
 * Marketplace orders (Uber/Deliveroo/Just Eat) come in pre-paid, so they
 * also render the green "Paid" chip — no manual checkbox needed.
 */
function PaymentBadge({
  method,
  status,
}: {
  method?: string | null;
  status?: string | null;
}) {
  const paid = status === "PAID";
  if (method === "CASH") {
    return paid ? (
      <Chip tone="success">
        <CheckCircle2 className="h-3 w-3" /> Cash
      </Chip>
    ) : (
      <Chip tone="amber">
        <Banknote className="h-3 w-3" /> Cash
      </Chip>
    );
  }
  if (paid) {
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
  tone: "success" | "amber";
  children: React.ReactNode;
}) {
  const cls =
    tone === "success"
      ? "bg-emerald-50 text-emerald-700"
      : "bg-amber-50 text-amber-700";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}
    >
      {children}
    </span>
  );
}
