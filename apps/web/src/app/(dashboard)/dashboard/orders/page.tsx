"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Beaker, Loader2 } from "lucide-react";
import { OrderBoard } from "@/components/orders/order-board";
import { LocationSelector } from "@/components/dashboard/location-selector";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { apiClient } from "@/lib/api/client";

// Phase AJ — the live orders board with location filter and a "Create test
// order" affordance for go-live verification. This page itself is a thin
// client wrapper; the actual board/columns/cards live in components/orders.

export default function OrdersPage() {
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string | null>(null);

  const testOrder = useMutation({
    mutationFn: async () => {
      if (!selectedLocationId) {
        throw new Error("Select a specific location first");
      }
      const res = await apiClient.post("/v1/orders/test", {
        locationId: selectedLocationId,
      });
      return res.data;
    },
    onSuccess: () => {
      setFeedback("Test order created — it should appear on the board.");
      queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
      window.setTimeout(() => setFeedback(null), 4000);
    },
    onError: (err: any) => {
      setFeedback(err?.response?.data?.message ?? err?.message ?? "Failed");
      window.setTimeout(() => setFeedback(null), 5000);
    },
  });

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Live Orders</h1>
          <p className="text-sm text-zinc-500">
            Real-time order board — updates automatically via WebSocket.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LocationSelector allowAll />
          <button
            type="button"
            onClick={() => testOrder.mutate()}
            disabled={testOrder.isPending || !selectedLocationId}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              selectedLocationId
                ? "Create a sandbox order at the selected location"
                : "Select a specific location to create a test order"
            }
          >
            {testOrder.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Beaker className="h-4 w-4" />
            )}
            Create test order
          </button>
        </div>
      </div>
      {feedback && (
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
          {feedback}
        </div>
      )}
      <OrderBoard locationId={selectedLocationId ?? undefined} />
    </div>
  );
}
