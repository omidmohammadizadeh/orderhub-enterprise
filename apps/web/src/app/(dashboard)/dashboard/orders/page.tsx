"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Loader2, PauseCircle, FlaskConical, History, ChevronDown, Timer } from "lucide-react";
import { PlatformLogo } from "@/components/ui/platform-logo";
import { OrderList } from "@/components/orders/order-list";
import { StopTakingOrdersModal } from "@/components/orders/stop-taking-orders-modal";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { OrderHistoryModal } from "@/components/orders/order-history-modal";
import { AutoReadyModal } from "@/components/orders/auto-ready-modal";
import { useAuthStore } from "@/stores/auth.store";
import { apiClient } from "@/lib/api/client";

// Phase AR — the test-order buttons spawn fake orders against the
// real pipeline, useful for go-live wiring checks. They are not
// something a Manager / Staff / Owner should see during normal
// operations because triggering one creates a noisy ghost order on
// the live board.
/** What each simulated platform is called on screen. */
// Mirrors SIMULATABLE_PLATFORMS on the API, which rejects anything else.
type SimPlatform =
  | "DELIVEROO"
  | "UBER_EATS"
  | "JUST_EAT"
  | "CAREEM"
  | "TALABAT"
  | "GLOVO"
  | "KEETA"
  | "ONLINE"
  | "WHATSAPP"
  | "VOICE";

const SIM_LABEL: Record<SimPlatform, string> = {
  DELIVEROO: "Deliveroo",
  UBER_EATS: "Uber Eats",
  JUST_EAT: "Just Eat",
  CAREEM: "Careem",
  TALABAT: "talabat",
  GLOVO: "Glovo",
  KEETA: "Keeta",
  ONLINE: "Online ordering",
  WHATSAPP: "WhatsApp",
  VOICE: "AI Voice",
};

const SIM_PLATFORMS = Object.keys(SIM_LABEL) as SimPlatform[];

// The receipt QR only prints for marketplace orders, so the success message
// must not promise one for our own channels.
const SIM_MARKETPLACES = new Set<SimPlatform>([
  "DELIVEROO",
  "UBER_EATS",
  "JUST_EAT",
  "CAREEM",
  "TALABAT",
  "GLOVO",
  "KEETA",
]);

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
  // Simulated marketplace orders look exactly like the real thing on a live
  // shop's board, which is why only we can make them. The API enforces this
  // too — this just keeps the buttons out of an operator's way.
  const canSimulate = role === "PLATFORM_ADMIN";
  const [pauseModalOpen, setPauseModalOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [autoReadyOpen, setAutoReadyOpen] = useState(false);
  /** Which platform the driver-simulation chooser is open for. */
  const [simChoice, setSimChoice] = useState<SimPlatform | null>(null);
  // Eight simulate buttons wrapped over three rows on a phone. One dropdown,
  // shaped like the orders board's Filter button, keeps the header tidy.
  const [simMenuOpen, setSimMenuOpen] = useState(false);
  const simMenuRef = useRef<HTMLDivElement>(null);
  // Which edge of the button the menu hangs from. Right, as on a desktop,
  // unless the button sits too near the left of a narrow screen for a
  // right-anchored menu to fit — then it opens rightwards instead.
  const [simMenuAlign, setSimMenuAlign] = useState<"right" | "left">("right");
  const toggleSimMenu = () => {
    const rect = simMenuRef.current?.getBoundingClientRect();
    if (rect) {
      const MENU_W = 240 + 8; // w-60 plus a little air from the edge
      setSimMenuAlign(rect.right >= MENU_W ? "right" : "left");
    }
    setSimMenuOpen((o) => !o);
  };
  useEffect(() => {
    if (!simMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!simMenuRef.current?.contains(e.target as Node)) setSimMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSimMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [simMenuOpen]);

  // Simulate a marketplace order so the marketplace receipt path can be
  // exercised on a real till — the QR especially, which is only ever printed
  // for marketplace channels and so cannot be tested with a DIRECT order.
  const simulateOrder = useMutation({
    mutationFn: async (v: {
      platform: SimPlatform;
      withDriver: boolean;
    }) => {
      if (!selectedLocationId) {
        throw new Error("Select a specific location first");
      }
      const res = await apiClient.post("/v1/orders/test", {
        locationId: selectedLocationId,
        fulfillmentType: "DELIVERY",
        platform: v.platform,
        withDriver: v.withDriver,
      });
      return res.data;
    },
    onSuccess: (_data, v) => {
      setSimChoice(null);
      setFeedback(
        v.withDriver
          ? `Simulated ${SIM_LABEL[v.platform]} order created — accept it to print, then watch it go driver assigned (20s), out for delivery (45s), delivered (75s). Everyone at this location can see it.`
          : `Simulated ${SIM_LABEL[v.platform]} order created — accept it to print the ticket${SIM_MARKETPLACES.has(v.platform) ? " and its QR" : ""}. Everyone at this location can see it.`,
      );
      queryClient.invalidateQueries({ queryKey: ["orders", "live"] });
      window.setTimeout(() => setFeedback(null), 6000);
    },
    onError: (err: any) => {
      setFeedback(err?.response?.data?.message ?? err?.message ?? "Failed");
      window.setTimeout(() => setFeedback(null), 5000);
    },
  });

  // Simulate is now the only test-order button — the plain "Test delivery" /
  // "Test collection" pair it replaced is gone from the board.
  const disabled = simulateOrder.isPending || !selectedLocationId;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Live Orders</h1>
          <p className="text-sm text-zinc-500">
            Real-time order board — updates automatically via WebSocket.
          </p>
        </div>
        {/* One toolbar, right-aligned. Every button used to be its own flex
            child of the header, so on a phone they wrapped one by one and
            Simulate landed wherever the line broke — often hard left, where
            its right-anchored menu opened off the screen. Grouped, a phone
            gets the same order as a desktop, ending with Simulate. */}
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
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
          {/* Auto ready — the shop's own timer for preparing/ready, which is
              what feeds the marketplaces' prep stages. */}
          <button
            type="button"
            onClick={() => setAutoReadyOpen(true)}
            disabled={!selectedLocationId}
            title={
              selectedLocationId
                ? "Mark orders preparing and ready on a timer"
                : "Select a location first"
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Timer className="h-4 w-4" />
            Auto ready
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
          >
            <History className="h-4 w-4" />
            Order history
          </button>
          {canSimulate && (
            <div className="relative" ref={simMenuRef}>
              <button
                type="button"
                onClick={toggleSimMenu}
                disabled={disabled}
                aria-haspopup="menu"
                aria-expanded={simMenuOpen}
                title={
                  selectedLocationId
                    ? "Create a fake marketplace order on this shop's board — visible to everyone at this location"
                    : "Select a specific location to simulate an order"
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-700 hover:border-violet-300 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {simulateOrder.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FlaskConical className="h-4 w-4" />
                )}
                Simulate
                <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
              </button>
              {simMenuOpen && (
                <div
                  role="menu"
                  aria-label="Simulate an order"
                  className={`absolute ${simMenuAlign === "right" ? "right-0" : "left-0"} top-full z-40 mt-1 w-60 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl`}
                >
                  <div className="border-b border-zinc-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-violet-500">
                    Simulate an order
                  </div>
                  <div className="max-h-80 overflow-y-auto py-1">
                    {SIM_PLATFORMS.map((platform) => (
                      <button
                        key={platform}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setSimMenuOpen(false);
                          setSimChoice(platform);
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-zinc-800 hover:bg-violet-50"
                      >
                        <PlatformLogo platform={platform} size={22} />
                        {SIM_LABEL[platform]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <AutoReadyModal
        open={autoReadyOpen}
        locationId={selectedLocationId ?? null}
        onClose={() => setAutoReadyOpen(false)}
      />
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
        {/* Driver simulation chooser. Two ways to run a marketplace test and
            they rehearse different things: without a driver you check the
            ticket, the QR and the board; with one you watch the courier
            stages land the way a real rider's would. Asking beats guessing —
            a test order that finishes on its own is no use for the first. */}
        {simChoice && (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
            onClick={() => !simulateOrder.isPending && setSimChoice(null)}
          >
            <div
              className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-base font-semibold text-zinc-900">
                Simulate a {SIM_LABEL[simChoice]} order
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                A fake order on this shop&rsquo;s board, with a{" "}
                {SIM_LABEL[simChoice]} badge and a real delivery address for
                this shop&rsquo;s country. Everyone at this location sees it on
                their board, tills and driver app, like a real one.
              </p>
              <div className="mt-4 grid gap-2">
                <button
                  type="button"
                  disabled={simulateOrder.isPending}
                  onClick={() =>
                    simulateOrder.mutate({ platform: simChoice, withDriver: true })
                  }
                  className="rounded-lg bg-zinc-900 px-4 py-3 text-left text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  With driver simulation
                  <span className="mt-0.5 block text-[11px] font-normal text-zinc-300">
                    Driver assigned, out for delivery, then delivered — 20, 45
                    and 75 seconds after it lands.
                  </span>
                </button>
                <button
                  type="button"
                  disabled={simulateOrder.isPending}
                  onClick={() =>
                    simulateOrder.mutate({ platform: simChoice, withDriver: false })
                  }
                  className="rounded-lg border border-zinc-200 px-4 py-3 text-left text-sm font-semibold text-zinc-800 hover:border-zinc-300 disabled:opacity-50"
                >
                  Without driver simulation
                  <span className="mt-0.5 block text-[11px] font-normal text-zinc-500">
                    Sits on the board for you to drive by hand.
                  </span>
                </button>
              </div>
              <button
                type="button"
                onClick={() => setSimChoice(null)}
                disabled={simulateOrder.isPending}
                className="mt-3 w-full rounded-lg px-4 py-2 text-xs font-medium text-zinc-500 hover:text-zinc-800 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

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
