"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Beaker, Bike, ShoppingBag, Loader2, PauseCircle, FlaskConical, History } from "lucide-react";
import { OrderList } from "@/components/orders/order-list";
import { StopTakingOrdersModal } from "@/components/orders/stop-taking-orders-modal";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { OrderHistoryModal } from "@/components/orders/order-history-modal";
import { useAuthStore } from "@/stores/auth.store";
import { apiClient } from "@/lib/api/client";

// Phase AR — the test-order buttons spawn fake orders against the
// real pipeline, useful for go-live wiring checks. They are not
// something a Manager / Staff / Owner should see during normal
// operations because triggering one creates a noisy ghost order on
// the live board.
/** What each simulated platform is called on screen. */
const SIM_LABEL: Record<"DELIVEROO" | "UBER_EATS" | "JUST_EAT", string> = {
  DELIVEROO: "Deliveroo",
  UBER_EATS: "Uber Eats",
  JUST_EAT: "Just Eat",
};

const CAN_RUN_TEST_ORDERS = new Set(["PLATFORM_ADMIN", "ONBOARDING_AGENT"]);

// Phase AJ — the live orders board with location filter and a "Create test
// order" affordance for go-live verification. This page itself is a thin
// client wrapper; the actual board/columns/cards live in components/orders.
//
// We expose two test buttons (delivery + collection) so operators can
// verify both branches of the lifecycle — collection orders go
// READY → COMPLETED (with a "Mark collected" button), delivery orders go
// READY → OUT_FOR_DELIVERY → COMPLETED (with "Out for delivery" then
// "Mark delivered" buttons).

export default function OrdersPage() {
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string | null>(null);
  const role = useAuthStore((s) => s.user?.role);
  const canRunTests = !!role && CAN_RUN_TEST_ORDERS.has(role);
  // Simulated marketplace orders look exactly like the real thing on a live
  // shop's board, which is why only we can make them. The API enforces this
  // too — this just keeps the buttons out of an operator's way.
  const canSimulate = role === "PLATFORM_ADMIN";
  const [pauseModalOpen, setPauseModalOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Simulate a marketplace order so the marketplace receipt path can be
  // exercised on a real till — the QR especially, which is only ever printed
  // for marketplace channels and so cannot be tested with a DIRECT order.
  const simulateOrder = useMutation({
    mutationFn: async (platform: "DELIVEROO" | "UBER_EATS" | "JUST_EAT") => {
      if (!selectedLocationId) {
        throw new Error("Select a specific location first");
      }
      const res = await apiClient.post("/v1/orders/test", {
        locationId: selectedLocationId,
        fulfillmentType: "DELIVERY",
        platform,
      });
      return res.data;
    },
    onSuccess: (_data, platform) => {
      setFeedback(
        `Simulated ${SIM_LABEL[platform]} order created — accept it to print the ticket and its QR. Only you can see it.`,
      );
      queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
      window.setTimeout(() => setFeedback(null), 6000);
    },
    onError: (err: any) => {
      setFeedback(err?.response?.data?.message ?? err?.message ?? "Failed");
      window.setTimeout(() => setFeedback(null), 5000);
    },
  });

  const testOrder = useMutation({
    mutationFn: async (fulfillmentType: "DELIVERY" | "PICKUP") => {
      if (!selectedLocationId) {
        throw new Error("Select a specific location first");
      }
      const res = await apiClient.post("/v1/orders/test", {
        locationId: selectedLocationId,
        fulfillmentType,
      });
      return res.data;
    },
    onSuccess: (_data, fulfillmentType) => {
      setFeedback(
        `Test ${fulfillmentType === "PICKUP" ? "collection" : "delivery"} order created — should appear on the board.`,
      );
      queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
      window.setTimeout(() => setFeedback(null), 4000);
    },
    onError: (err: any) => {
      setFeedback(err?.response?.data?.message ?? err?.message ?? "Failed");
      window.setTimeout(() => setFeedback(null), 5000);
    },
  });

  const disabled = testOrder.isPending || !selectedLocationId;
  const tooltip = selectedLocationId
    ? "Create a sandbox order at the selected location"
    : "Select a specific location to create a test order";

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Live Orders</h1>
          <p className="text-sm text-zinc-500">
            Real-time order board — updates automatically via WebSocket.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Phase AW-15 — Stop taking orders. Available to every role
              the orders page itself is visible to; the modal handles
              the duration / reason flow + the active-pause list with
              one-click resume. */}
          <button
            type="button"
            onClick={() => setPauseModalOpen(true)}
            disabled={!selectedLocationId}
            title={
              selectedLocationId
                ? "Pause or busy-mode this location"
                : "Select a location first"
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:border-red-300 hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <PauseCircle className="h-4 w-4" />
            Stop taking orders
          </button>
        </div>
        {canRunTests && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => testOrder.mutate("DELIVERY")}
              disabled={disabled}
              title={tooltip}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testOrder.isPending && testOrder.variables === "DELIVERY" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Bike className="h-4 w-4" />
              )}
              Test delivery
            </button>
            <button
              type="button"
              onClick={() => testOrder.mutate("PICKUP")}
              disabled={disabled}
              title={tooltip}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testOrder.isPending && testOrder.variables === "PICKUP" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShoppingBag className="h-4 w-4" />
              )}
              Test collection
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
        >
          <History className="h-4 w-4" />
          Order history
        </button>
        {canSimulate && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-500">
              Simulate
            </span>
            {(
              ["DELIVEROO", "UBER_EATS", "JUST_EAT"] as const
            ).map((platform) => (
              <button
                key={platform}
                type="button"
                onClick={() => simulateOrder.mutate(platform)}
                disabled={disabled}
                title={`Create a fake ${SIM_LABEL[platform]} order on this shop's board — visible to platform admins only`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-700 hover:border-violet-300 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {simulateOrder.isPending &&
                simulateOrder.variables === platform ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FlaskConical className="h-4 w-4" />
                )}
                {SIM_LABEL[platform]}
              </button>
            ))}
          </div>
        )}
      </div>
      <OrderHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        locationId={selectedLocationId ?? undefined}
      />
      {feedback && (
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
          {feedback}
        </div>
      )}
      <OrderList locationId={selectedLocationId ?? undefined} />
      {selectedLocationId && (
        <StopTakingOrdersModal
          open={pauseModalOpen}
          locationId={selectedLocationId}
          onClose={() => setPauseModalOpen(false)}
        />
      )}
    </div>
  );
}
