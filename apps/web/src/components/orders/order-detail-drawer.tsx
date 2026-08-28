"use client";

import { useState } from "react";
import { UberEatsOrderActionsPanel } from "./ubereats-order-actions-panel";
import { useRouter } from "next/navigation";
import { X, Clock, CheckCircle, ChefHat, Bike, XCircle, Check, AlertCircle, Pencil, Printer, Loader2, QrCode, CreditCard, Banknote } from "lucide-react";
import { PaymentLinkModal } from "../pos/payment-link-modal";
import { ChargeReaderModal } from "../pos/charge-reader-modal";
import { CashPaymentModal } from "../pos/cash-payment-modal";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { PlatformBadge, FulfillmentBadge } from "./platform-badge";
import { useUpdateOrderStatus } from "../../hooks/use-live-orders";
import { useAuthStore } from "../../stores/auth.store";
import { DispatchModal } from "./dispatch-modal";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { stuartClient } from "../../lib/api/stuart.client";
import { uberDirectClient } from "../../lib/api/uber-direct.client";
import { unassignOrder } from "../../lib/api/dispatch.client";
import { printOrderViaBridge } from "../../lib/printing/print-order";
import type { Order } from "../../lib/api/orders.client";
import { modifierDepth, formatMoney } from "@orderhub/shared";

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
  // The ORDER's own currency — the board can be showing every location at
  // once, so this must not follow whichever one is selected.
  const money = (n: number | string | null | undefined) =>
    formatMoney(n, (order as any)?.location?.currency, { compact: true });
  const [cancelReason, setCancelReason] = useState("");
  const [showCancelInput, setShowCancelInput] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printMsg, setPrintMsg] = useState<string | null>(null);

  // Reprint the order to every BT printer at this location via the
  // native bridge. Used both for the auto-print recovery (when an
  // order missed its first print) and as a manual "print again"
  // button on tablets where the operator wants a second copy.
  const onPrint = async () => {
    if (!order) return;
    setPrinting(true);
    setPrintMsg(null);
    try {
      const msg = await printOrderViaBridge(order);
      setPrintMsg(msg);
      setTimeout(() => setPrintMsg(null), 2500);
    } catch (e: any) {
      setPrintMsg(e?.message ?? "Print failed");
      setTimeout(() => setPrintMsg(null), 4000);
    } finally {
      setPrinting(false);
    }
  };
  const updateStatus = useUpdateOrderStatus();
  const router = useRouter();
  const userRole = useAuthStore((s) => s.user?.role);
  const [showDispatch, setShowDispatch] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showPayModal, setShowPayModal] = useState(false);
  const [showChargeModal, setShowChargeModal] = useState(false);
  const [showCashModal, setShowCashModal] = useState(false);

  // POS "Payment link" / "QR code" orders can re-open the payment modal (QR +
  // copyable link + SMS) so staff can show the customer the QR again or resend
  // the link. Only meaningful while the order is still unpaid.
  const payMethodUpper = ((order as any)?.paymentMethod ?? "")
    .toString()
    .toUpperCase();
  const isLinkOrQrOrder =
    payMethodUpper === "PAYMENT_LINK" || payMethodUpper === "QR_CODE";
  const canReshowPayment =
    isLinkOrQrOrder &&
    ((order as any)?.paymentStatus ?? "").toString().toUpperCase() !== "PAID";
  // Customers change their mind at the counter or on the phone — an order
  // taken as cash gets paid by card instead. Previously the only way was to
  // void and re-key it. Offered for any unpaid POS order regardless of the
  // method it was placed under; the charge modal drives the same readers the
  // POS does, and settles this order on success.
  const canTakeCardPayment =
    (order as any)?.orderSource === "POS" &&
    ((order as any)?.paymentStatus ?? "").toString().toUpperCase() !== "PAID" &&
    !!(order as any)?.locationId;
  const queryClient = useQueryClient();

  async function handleCancelDispatch() {
    if (!order) return;
    setCancelling(true);
    try {
      if ((order as any).courierProvider === "STUART") {
        await stuartClient.cancel(order.id);
      } else if ((order as any).courierProvider === "UBER_DIRECT") {
        await uberDirectClient.cancel(order.id);
      } else {
        // Own fleet — pull the delivery back from the driver.
        await unassignOrder(order.id);
      }
      toast.success("Dispatch cancelled — you can dispatch again");
      queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
    } catch (e: any) {
      toast.error(
        e?.response?.data?.message ?? "Couldn't cancel the dispatch",
      );
    } finally {
      setCancelling(false);
    }
  }

  if (!order) return null;

  const actions = NEXT_ACTIONS[order.status] ?? [];
  const total = order.items.reduce((s, i) => s + i.quantity, 0);

  // Edit eligibility mirrors the server-side gate so the button never shows
  // up for an order the API would reject: till roles, POS, status < READY,
  // and the money not already taken by card.
  //
  // Must list BOTH generations of role name. This set previously omitted
  // OWNER — the Team Roles equivalent of TENANT_OWNER — so an owner the API
  // would have accepted was shown no button at all, which is how this looked
  // like "admin only" from the floor.
  const EDIT_ROLES = new Set([
    "PLATFORM_ADMIN",
    "TENANT_OWNER",
    "OWNER",
    "MANAGER",
    "DARK_KITCHEN_MANAGER",
    "CASHIER",
    "STAFF",
  ]);
  const editableStatus = ["PENDING", "ACCEPTED", "PREPARING"].includes(
    order.status,
  );
  const isCash =
    ((order as any).paymentMethod ?? "").toString().toUpperCase() === "CASH";
  const isPos = (order as any).orderSource === "POS";
  // Mirrors the widened server gate: cash stays editable as before, and any
  // other method is editable while the money hasn't actually moved. A PAID
  // card order is excluded — amending it would need a top-up or refund.
  const alreadyPaid =
    ((order as any).paymentStatus ?? "").toString().toUpperCase() === "PAID";
  const canEdit =
    !!userRole &&
    EDIT_ROLES.has(userRole) &&
    editableStatus &&
    isPos &&
    (isCash || !alreadyPaid);

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
        <div className="flex items-center gap-1">
          {printMsg && (
            <span
              className={`mr-1 text-[11px] font-semibold ${
                printMsg.includes("Print") && !printMsg.includes("failed")
                  ? "text-emerald-600"
                  : "text-rose-600"
              }`}
            >
              {printMsg}
            </span>
          )}
          <button
            onClick={onPrint}
            disabled={printing}
            title="Print receipt"
            className="rounded-lg p-1.5 hover:bg-violet-50 hover:text-violet-700 disabled:opacity-50 transition-colors"
          >
            {printing ? (
              <Loader2 className="h-4 w-4 text-zinc-500 animate-spin" />
            ) : (
              <Printer className="h-4 w-4 text-zinc-500" />
            )}
          </button>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-zinc-100 transition-colors">
            <X className="h-4 w-4 text-zinc-500" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Expected delivery / collection time (moved here from the
            order card so the card stays uncluttered). Compact one-liner
            so it doesn't push the status/action footer off small screens. */}
        {(() => {
          const isDelivery = /DELIV/i.test(order.fulfillmentType ?? "");
          const label = isDelivery ? "Expected delivery" : "Expected collection";
          const when =
            order.scheduledFor ?? (order as any).estimatedReadyAt ?? null;
          let value = "ASAP";
          if (when) {
            const d = new Date(when);
            const time = d.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            value = order.scheduledFor
              ? `${d.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" })} · ${time}`
              : time;
          }
          return (
            <div className="flex items-center justify-between gap-2 px-5 py-2 border-b border-zinc-100 bg-zinc-50">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                <Clock className="h-3.5 w-3.5" />
                {label}
              </span>
              <span
                className={`text-sm font-bold ${order.scheduledFor ? "text-amber-700" : "text-zinc-900"}`}
              >
                {order.scheduledFor ? `Scheduled · ${value}` : value}
              </span>
            </div>
          );
        })()}

        {/* Customer */}
        <div className="px-5 py-4 border-b border-zinc-100">
          <p className="text-sm font-semibold text-zinc-900">{order.customerInfo.name}</p>
          {order.customerInfo.phone && (
            <p className="text-xs text-zinc-500 mt-0.5">
              <a
                href={`tel:${order.customerInfo.phone}${
                  (order.customerInfo as any).phoneAccessCode
                    ? `,${String((order.customerInfo as any).phoneAccessCode).replace(/\s+/g, "")}`
                    : ""
                }`}
                className="hover:text-violet-700"
              >
                {order.customerInfo.phone}
              </a>
              {(order.customerInfo as any).phoneAccessCode && (
                <>
                  {" · PIN "}
                  <span className="font-mono tracking-wider">
                    {(order.customerInfo as any).phoneAccessCode}
                  </span>
                </>
              )}
            </p>
          )}
          {order.deliveryAddress && (
            <p className="text-xs text-zinc-500 mt-1">
              {[order.deliveryAddress.line1, order.deliveryAddress.line2, order.deliveryAddress.city, order.deliveryAddress.postcode]
                .filter(Boolean)
                .join(", ")}
            </p>
          )}
        </div>

        {/* Phase BH — unified dispatch chooser + cancel. A delivery order is
            "dispatched" when it's on a courier (courierJobId) OR handed to an
            own-fleet driver (status). Show Dispatch when free, Cancel when
            dispatched (cancel frees it to dispatch again).

            PLATFORM deliveries (Deliveroo / Uber Eats / marketplace) are driven
            by the platform's OWN riders — the operator never arranges a courier,
            so the whole chooser is hidden. The platform rider's details show in
            the courier panel below instead. Only MERCHANT (and legacy/unknown
            null) delivery orders get the Dispatch button. */}
        {order.fulfillmentType === "DELIVERY" &&
          (order as any).deliveryType !== "PLATFORM" &&
          (() => {
            const OWN_FLEET_ASSIGNED = [
              "ASSIGNED_DRIVER",
              "ACCEPTED_BY_DRIVER",
              "RIDER_ARRIVED",
              "OUT_FOR_DELIVERY",
            ];
            const courierProvider = (order as any).courierProvider as
              | string
              | null;
            const dispatched =
              !!(order as any).courierJobId ||
              (!courierProvider &&
                OWN_FLEET_ASSIGNED.includes(order.status as string));
            return (
              <div className="px-5 py-4 border-b border-zinc-100">
                {!dispatched ? (
                  <>
                    <button
                      onClick={() => setShowDispatch(true)}
                      className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700"
                    >
                      <Bike className="h-4 w-4" />
                      Dispatch
                    </button>
                    <p className="mt-1.5 text-[11px] text-zinc-400">
                      Choose a courier — see the price before you send.
                    </p>
                  </>
                ) : (
                  <>
                    <button
                      onClick={handleCancelDispatch}
                      disabled={cancelling}
                      className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {cancelling ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <XCircle className="h-4 w-4" />
                      )}
                      Cancel dispatch
                    </button>
                    <p className="mt-1.5 text-[11px] text-zinc-400">
                      {courierProvider === "STUART"
                        ? "Cancels the Stuart job and frees the order to dispatch again."
                        : "Pulls the order back from the driver so you can dispatch again."}
                    </p>
                  </>
                )}
              </div>
            );
          })()}

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
                {/* Marketplace partners route courier calls through a
                    masking number. The PIN goes in the DTMF post-dial
                    string (`,` = 2s pause) so a single tap dials,
                    waits, then sends the code. Falls back to a plain
                    number if no PIN is present. */}
                <a
                  href={`tel:${(order as any).courierPhone}${
                    (order as any).courierPhoneAccessCode
                      ? `,${String((order as any).courierPhoneAccessCode).replace(/\s+/g, "")}`
                      : ""
                  }`}
                  className="hover:text-violet-700"
                >
                  {(order as any).courierPhone}
                </a>
                {(order as any).courierPhoneAccessCode && (
                  <>
                    {" · PIN "}
                    <span className="font-mono tracking-wider">
                      {(order as any).courierPhoneAccessCode}
                    </span>
                  </>
                )}
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
                  <span className="text-sm text-zinc-700">{money(item.totalPrice)}</span>
                </div>
                {item.modifiers?.length > 0 && (
                  <div className="mt-1 ml-3 space-y-0.5">
                    {item.modifiers.map((m, j) => (
                      <p
                        key={j}
                        className="text-xs text-zinc-500"
                        // Nested selections indent under the option that opened
                        // them, so a meal deal reads as one choice rather than
                        // four unrelated extras.
                        style={{ paddingLeft: `${modifierDepth(m) * 12}px` }}
                      >
                        + {m.name}{m.price > 0 ? ` (${money(m.price)})` : ""}
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
                <span>Subtotal</span><span>{money(order.subtotal)}</span>
              </div>
              {order.deliveryFee > 0 && (
                <div className="flex justify-between text-sm text-zinc-600">
                  <span>Delivery</span><span>{money(order.deliveryFee)}</span>
                </div>
              )}
              {Number((order as any).tipAmount ?? 0) > 0 && (
                <div className="flex justify-between text-sm text-zinc-600">
                  <span>Tip</span>
                  <span>{money(Number((order as any).tipAmount))}</span>
                </div>
              )}
              {order.taxAmount > 0 && (
                <div className="flex justify-between text-sm text-zinc-600">
                  <span>Tax</span><span>{money(order.taxAmount)}</span>
                </div>
              )}
              {order.discount > 0 && (
                <div className="flex justify-between text-sm text-emerald-600">
                  <span>Discount</span><span>−{money(order.discount)}</span>
                </div>
              )}
            </>
          )}
          <div className="flex justify-between text-sm font-bold text-zinc-900">
            <span>Total</span><span>{money(order.total)}</span>
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
      {order.platform === "UBER_EATS" && (
          <UberEatsOrderActionsPanel
                orderId={order.id}
                currency={(order as any)?.location?.currency} />
        )}
      </div>

      {canTakeCardPayment && (
        <div className="grid grid-cols-2 gap-2 border-t border-zinc-200 px-5 py-4">
          <Button
            size="sm"
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => setShowChargeModal(true)}
          >
            <CreditCard className="h-3.5 w-3.5 mr-1.5" />
            Card
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowCashModal(true)}
          >
            <Banknote className="h-3.5 w-3.5 mr-1.5" />
            Cash
          </Button>
        </div>
      )}

      {/* Payment link / QR re-show — for unpaid POS Payment-link or QR orders,
          staff can pull the QR + link back up to show or resend to the
          customer. */}
      {canReshowPayment && (
        <div className="border-t border-zinc-200 px-5 py-4">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setShowPayModal(true)}
          >
            <QrCode className="h-3.5 w-3.5 mr-1.5" />
            {payMethodUpper === "QR_CODE"
              ? "Show QR code again"
              : "Resend payment link"}
          </Button>
        </div>
      )}

      {/* Actions footer */}
      {(actions.length > 0 || canEdit) && (
        <div className="border-t border-zinc-200 px-5 py-4 space-y-2">
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                router.push(`/dashboard/pos?editOrderId=${order.id}`);
                onClose();
              }}
            >
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              Edit order
            </Button>
          )}
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

      {showDispatch && (
        <DispatchModal
          orderId={order.id}
          locationId={(order as any).locationId ?? null}
          orderRef={`#${order.displayId ?? (order as any).orderNumber ?? ""}`}
          onClose={() => setShowDispatch(false)}
        />
      )}

      <CashPaymentModal
        open={showCashModal}
        orderId={showCashModal ? order.id : null}
        locationId={(order as any).locationId ?? null}
        amount={Number(order.total ?? 0)}
        onClose={() => setShowCashModal(false)}
        onPaid={() => {
          queryClient.invalidateQueries({ queryKey: ["orders"] });
        }}
      />

      <ChargeReaderModal
        open={showChargeModal}
        orderId={showChargeModal ? order.id : null}
        locationId={(order as any).locationId ?? ""}
        amount={Number(order.total ?? 0)}
        onClose={() => setShowChargeModal(false)}
        onPaid={() => {
          // Refresh the board so the order flips to PAID without a manual
          // reload — same invalidation the status actions use.
          queryClient.invalidateQueries({ queryKey: ["orders"] });
        }}
      />

      <PaymentLinkModal
        open={showPayModal}
        orderId={showPayModal ? order.id : null}
        orderNumber={order.displayId ? `#${order.displayId}` : undefined}
        amount={Number(order.total ?? 0)}
        customerPhone={(order as any).customerPhone ?? null}
        onClose={() => setShowPayModal(false)}
      />
    </div>
  );
}

// Build the ESC/POS receipt payload from a live Order object so the
// manual reprint button produces the same output as the auto-print
// path (which uses the API's PrintJob.payload). The Order object now
// includes location.address / location.phone from the updated
// ORDER_INCLUDE, so the restaurant header prints correctly.
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
    // Deliveroo rider.status_update vocabulary
    // (https://api-docs.deliveroo.com/docs/listen-to-rider-status-webhook)
    rider_assigned: "Rider assigned",
    rider_arrived: "Rider arrived at restaurant",
    rider_confirmed_at_restaurant: "Rider confirmed at restaurant",
    rider_check_in: "Rider checked in (on-site)",
    rider_in_transit: "Rider on the way to customer",
    rider_delivered: "Delivered",
    rider_unassigned: "Rider unassigned",
  };
  return map[s] ?? s.replace(/_/g, " ");
}
