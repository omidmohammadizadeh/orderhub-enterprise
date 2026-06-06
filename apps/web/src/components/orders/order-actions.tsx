"use client";

// ── OrderActions ────────────────────────────────────────────────────────────
// The contextual button row on each order card. Buttons rendered are derived
// from the order's current status using the same per-status whitelist the
// API state machine enforces — clicking a button is therefore guaranteed to
// produce a valid transition (or surface a clean error if it doesn't, e.g.
// because the order moved on via a webhook between render and click).
//
// Optimistic UX: the mutation in useUpdateOrderStatus applies the new
// status to the local store immediately and rolls back on error. So the
// card visually jumps to the next column before the API responds.
//
// Phase AJ scope: implements the natural-forward buttons + Cancel. The
// "Add Time" affordance (Base44 lets staff add 5/10/15 min to prep) is
// deferred until prep-time configuration ships in a later phase.

import { useState } from "react";
import { Check, ChefHat, PackageCheck, Bike, X, Loader2, Send } from "lucide-react";
import { useUpdateOrderStatus } from "../../hooks/use-live-orders";

interface Props {
  orderId: string;
  status: string;
  fulfillmentType?: string;
}

interface ButtonSpec {
  label: string;
  toStatus: string;
  icon: typeof Check;
  variant: "primary" | "secondary" | "danger";
  /** Reason prompt for cancel-style transitions. */
  promptForReason?: boolean;
}

function buttonsForStatus(
  status: string,
  fulfillmentType?: string,
): ButtonSpec[] {
  const isCollection = fulfillmentType === "PICKUP" || fulfillmentType === "DINE_IN";
  switch (status) {
    case "PENDING":
      return [
        { label: "Accept", toStatus: "ACCEPTED", icon: Check, variant: "primary" },
        {
          label: "Deny",
          toStatus: "REJECTED",
          icon: X,
          variant: "danger",
          promptForReason: true,
        },
      ];
    case "ACCEPTED":
      return [
        {
          label: "Mark preparing",
          toStatus: "PREPARING",
          icon: ChefHat,
          variant: "primary",
        },
        {
          label: "Cancel",
          toStatus: "CANCELLED",
          icon: X,
          variant: "danger",
          promptForReason: true,
        },
      ];
    case "PREPARING":
      return [
        {
          label: "Mark ready",
          toStatus: "READY",
          icon: PackageCheck,
          variant: "primary",
        },
        {
          label: "Cancel",
          toStatus: "CANCELLED",
          icon: X,
          variant: "danger",
          promptForReason: true,
        },
      ];
    case "READY":
      return isCollection
        ? [
            {
              label: "Mark collected",
              toStatus: "COMPLETED",
              icon: Check,
              variant: "primary",
            },
            {
              label: "Cancel",
              toStatus: "CANCELLED",
              icon: X,
              variant: "danger",
              promptForReason: true,
            },
          ]
        : [
            {
              label: "Out for delivery",
              toStatus: "OUT_FOR_DELIVERY",
              icon: Bike,
              variant: "primary",
            },
            {
              label: "Send to dispatch",
              toStatus: "PENDING_DISPATCH",
              icon: Send,
              variant: "secondary",
            },
            {
              label: "Cancel",
              toStatus: "CANCELLED",
              icon: X,
              variant: "danger",
              promptForReason: true,
            },
          ];
    case "PENDING_DISPATCH":
      return [
        {
          label: "Driver assigned",
          toStatus: "ASSIGNED_DRIVER",
          icon: Bike,
          variant: "primary",
        },
        {
          label: "Cancel",
          toStatus: "CANCELLED",
          icon: X,
          variant: "danger",
          promptForReason: true,
        },
      ];
    case "ASSIGNED_DRIVER":
    case "ACCEPTED_BY_DRIVER":
      // Primary: rider just walked in → "Rider arrived". Secondary
      // skip-ahead: "Out for delivery" for couriers who never check in
      // physically (door-dash style, or merchant delivery).
      return [
        {
          label: "Rider arrived",
          toStatus: "RIDER_ARRIVED",
          icon: Bike,
          variant: "primary",
        },
        {
          label: "Out for delivery",
          toStatus: "OUT_FOR_DELIVERY",
          icon: Bike,
          variant: "secondary",
        },
        {
          label: "Cancel",
          toStatus: "CANCELLED",
          icon: X,
          variant: "danger",
          promptForReason: true,
        },
      ];
    case "RIDER_ARRIVED":
      // Bag handed over → rider leaves. Cancel still allowed in case
      // the courier has to abort (lost bag, broken bike, etc.).
      return [
        {
          label: "Out for delivery",
          toStatus: "OUT_FOR_DELIVERY",
          icon: Bike,
          variant: "primary",
        },
        {
          label: "Cancel",
          toStatus: "CANCELLED",
          icon: X,
          variant: "danger",
          promptForReason: true,
        },
      ];
    case "OUT_FOR_DELIVERY":
    case "DISPATCHED":
      return [
        {
          label: "Mark delivered",
          toStatus: "COMPLETED",
          icon: Check,
          variant: "primary",
        },
      ];
    default:
      return [];
  }
}

const VARIANT_CLASSES: Record<ButtonSpec["variant"], string> = {
  primary:
    "bg-zinc-900 text-white hover:bg-zinc-800 disabled:bg-zinc-400 disabled:cursor-not-allowed",
  secondary:
    "bg-white text-zinc-700 border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50",
  danger:
    "bg-white text-red-600 border border-red-200 hover:border-red-300 hover:bg-red-50",
};

export function OrderActions({ orderId, status, fulfillmentType }: Props) {
  const buttons = buttonsForStatus(status, fulfillmentType);
  const mutation = useUpdateOrderStatus();
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);

  if (buttons.length === 0) return null;

  const handleClick = (e: React.MouseEvent, b: ButtonSpec) => {
    // Buttons sit inside an OrderCard which is also clickable to open the
    // drawer. Don't let that fire when staff click an action.
    e.stopPropagation();

    let reason: string | undefined;
    if (b.promptForReason) {
      const input = window.prompt(`Reason for ${b.label.toLowerCase()}?`);
      // Empty / cancelled prompt aborts the action — better than silently
      // submitting an empty reason.
      if (input === null) return;
      reason = input.trim() || undefined;
    }

    setPendingStatus(b.toStatus);
    mutation.mutate(
      {
        orderId,
        status: b.toStatus,
        cancelReason: b.variant === "danger" ? reason : undefined,
        note: b.variant !== "danger" ? reason : undefined,
      },
      {
        onSettled: () => setPendingStatus(null),
      },
    );
  };

  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {buttons.map((b) => {
        const isPending = pendingStatus === b.toStatus;
        return (
          <button
            key={b.toStatus + b.label}
            type="button"
            onClick={(e) => handleClick(e, b)}
            disabled={mutation.isPending}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${VARIANT_CLASSES[b.variant]}`}
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <b.icon className="h-3.5 w-3.5" />
            )}
            {b.label}
          </button>
        );
      })}
    </div>
  );
}
