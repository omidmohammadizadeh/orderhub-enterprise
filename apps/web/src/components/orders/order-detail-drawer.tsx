"use client";

import { useState } from "react";
import { X, Clock, CheckCircle, ChefHat, Bike, XCircle, Check, AlertCircle } from "lucide-react";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { PlatformBadge, FulfillmentBadge } from "./platform-badge";
import { useUpdateOrderStatus } from "../../hooks/use-live-orders";
import type { Order } from "../../lib/api/orders.client";

const NEXT_ACTIONS: Record<string, Array<{ status: string; label: string; variant: "default" | "outline" | "destructive" }>> = {
  PENDING: [
    { status: "ACCEPTED", label: "Accept", variant: "default" },
    { status: "REJECTED", label: "Reject", variant: "destructive" },
  ],
  ACCEPTED: [
    { status: "PREPARING", label: "Start preparing", variant: "default" },
    { status: "CANCELLED", label: "Cancel", variant: "destructive" },
  ],
  PREPARING: [
    { status: "READY", label: "Mark ready", variant: "default" },
    { status: "CANCELLED", label: "Cancel", variant: "destructive" },
  ],
  READY: [
    { status: "DISPATCHED", label: "Dispatched", variant: "default" },
    { status: "COMPLETED", label: "Complete", variant: "default" },
  ],
  DISPATCHED: [
    { status: "COMPLETED", label: "Mark delivered", variant: "default" },
  ],
};

interface Props {
  order: Order | null;
  onClose: () => void;
}

export function OrderDetailDrawer({ order, onClose }: Props) {
  const [cancelReason, setCancelReason] = useState("");
  const [showCancelInput, setShowCancelInput] = useState(false);
  const updateStatus = useUpdateOrderStatus();

  if (!order) return null;

  const actions = NEXT_ACTIONS[order.status] ?? [];
  const total = order.items.reduce((s, i) => s + i.quantity, 0);

  function handleAction(status: string) {
    if ((status === "CANCELLED" || status === "REJECTED") && !showCancelInput) {
      setShowCancelInput(true);
      return;
    }
    updateStatus.mutate({
      orderId: order!.id,
      status,
      cancelReason: cancelReason || undefined,
    });
    setShowCancelInput(false);
    setCancelReason("");
  }

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-white shadow-2xl border-l border-zinc-200">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
        <div className="flex items-center gap-3">
          <PlatformBadge platform={order.platform} />
          <FulfillmentBadge type={order.fulfillmentType} />
          {order.displayId && (
            <span className="text-sm font-bold text-zinc-900">#{order.displayId}</span>
          )}
        </div>
        <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-zinc-100 transition-colors">
          <X className="h-4 w-4 text-zinc-500" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Customer */}
        <div className="px-5 py-4 border-b border-zinc-100">
          <p className="text-sm font-semibold text-zinc-900">{order.customerInfo.name}</p>
          {order.customerInfo.phone && (
            <p className="text-xs text-zinc-500 mt-0.5">{order.customerInfo.phone}</p>
          )}
          {order.deliveryAddress && (
            <p className="text-xs text-zinc-500 mt-1">
              {[order.deliveryAddress.line1, order.deliveryAddress.line2, order.deliveryAddress.city, order.deliveryAddress.postcode]
                .filter(Boolean)
                .join(", ")}
            </p>
          )}
        </div>

        {/* Phase AV-2 — Courier panel for PLATFORM orders. Populated
            from HubRise delivery.* webhooks. The phone number is a
            tel: link so the operator can call the driver in one tap
            from a phone/tablet; the tracking URL opens HubRise's
            live courier map. Status is the raw HubRise enum
            translated to something operators read at a glance. */}
        {((order as any).courierName ||
          (order as any).courierPhone ||
          (order as any).courierTrackingUrl ||
          (order as any).courierStatus) && (
          <div className="px-5 py-4 border-b border-zinc-100">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-2">
              Courier
            </p>
            {(order as any).courierName && (
              <p className="text-sm font-semibold text-zinc-900">
                {(order as any).courierName}
              </p>
            )}
            {(order as any).courierPhone && (
              <p className="text-xs text-zinc-500 mt-0.5">
                <a
                  href={`tel:${(order as any).courierPhone}`}
                  className="hover:text-violet-700"
                >
                  {(order as any).courierPhone}
                </a>
              </p>
            )}
            {(order as any).courierStatus && (
              <p className="text-[11px] text-zinc-500 mt-1">
                {humanCourierStatus((order as any).courierStatus)}
              </p>
            )}
            {(order as any).courierTrackingUrl && (
              <a
                href={(order as any).courierTrackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-violet-700 hover:text-violet-900"
              >
                Track live →
              </a>
            )}
          </div>
        )}

        {/* Items */}
        <div className="px-5 py-4 border-b border-zinc-100">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-3">
            Items ({total})
          </p>
          <div className="space-y-3">
            {order.items.map((item, i) => (
              <div key={i}>
                <div className="flex justify-between">
                  <span className="text-sm font-medium text-zinc-900">
                    {item.quantity}× {item.name}
                  </span>
                  <span className="text-sm text-zinc-700">£{item.totalPrice.toFixed(2)}</span>
                </div>
                {item.modifiers?.length > 0 && (
                  <div className="mt-1 ml-3 space-y-0.5">
                    {item.modifiers.map((m, j) => (
                      <p key={j} className="text-xs text-zinc-500">
                        + {m.name}{m.price > 0 ? ` (£${m.price.toFixed(2)})` : ""}
                      </p>
                    ))}
                  </div>
                )}
                {item.notes && (
                  <p className="mt-1 ml-3 text-xs italic text-zinc-400">Note: {item.notes}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Totals */}
        <div className="px-5 py-4 border-b border-zinc-100 space-y-1.5">
          {order.subtotal !== order.total && (
            <>
              <div className="flex justify-between text-sm text-zinc-600">
                <span>Subtotal</span><span>£{order.subtotal.toFixed(2)}</span>
              </div>
              {order.deliveryFee > 0 && (
                <div className="flex justify-between text-sm text-zinc-600">
                  <span>Delivery</span><span>£{order.deliveryFee.toFixed(2)}</span>
                </div>
              )}
              {order.taxAmount > 0 && (
                <div className="flex justify-between text-sm text-zinc-600">
                  <span>Tax</span><span>£{order.taxAmount.toFixed(2)}</span>
                </div>
              )}
              {order.discount > 0 && (
                <div className="flex justify-between text-sm text-emerald-600">
                  <span>Discount</span><span>−£{order.discount.toFixed(2)}</span>
                </div>
              )}
            </>
          )}
          <div className="flex justify-between text-sm font-bold text-zinc-900">
            <span>Total</span><span>£{order.total.toFixed(2)}</span>
          </div>
        </div>

        {/* Special instructions */}
        {order.specialInstructions && (
          <div className="px-5 py-4 border-b border-zinc-100">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-1">
              Instructions
            </p>
            <p className="text-sm text-zinc-700 italic">"{order.specialInstructions}"</p>
          </div>
        )}

        {/* Status history */}
        {order.statusHistory && order.statusHistory.length > 0 && (
          <div className="px-5 py-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-3">
              Timeline
            </p>
            <div className="space-y-2">
              {order.statusHistory.map((h) => (
                <div key={h.id} className="flex items-start gap-2 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-700">{h.toStatus}</span>
                  <span>·</span>
                  <span>{new Date(h.createdAt).toLocaleTimeString()}</span>
                  {h.note && <span className="italic">— {h.note}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions footer */}
      {actions.length > 0 && (
        <div className="border-t border-zinc-200 px-5 py-4 space-y-2">
          {showCancelInput && (
            <input
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              placeholder="Reason for cancellation (optional)"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          )}
          <div className="flex gap-2">
            {actions.map((action) => (
              <Button
                key={action.status}
                variant={action.variant}
                size="sm"
                className="flex-1"
                disabled={updateStatus.isPending}
                onClick={() => handleAction(action.status)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Phase AV-2 — translate HubRise's delivery status enum into
// something a human reads at a glance. We never hide the raw value
// (operators can still see it in the audit log) but the drawer
// shouldn't make them parse "pickup_enroute".
function humanCourierStatus(s: string): string {
  const map: Record<string, string> = {
    pending: "Awaiting driver",
    pickup_enroute: "Driver on the way to collect",
    pickup_approaching: "Driver arriving at restaurant",
    pickup_waiting: "Driver at restaurant",
    dropoff_enroute: "Driver on the way to customer",
    dropoff_approaching: "Driver arriving at customer",
    dropoff_waiting: "Driver at customer",
    delivered: "Delivered",
    cancelled: "Cancelled",
  };
  return map[s] ?? s.replace(/_/g, " ");
}
