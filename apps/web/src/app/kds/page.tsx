"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, RotateCcw, Clock, Maximize2, Volume2, VolumeX, Settings } from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { socketClient } from "@/lib/socket/socket.client";
import { cn } from "@/lib/utils";

interface KdsTicket {
  kdsScreenId: string;
  orderId: string;
  createdAt: string;
  bumpedAt: string | null;
  recalledAt: string | null;
  order: {
    id: string;
    displayId: string | null;
    platform: string;
    fulfillmentType: string;
    status: string;
    customerInfo: { name: string; phone?: string };
    specialInstructions?: string | null;
    items: Array<{
      id: string;
      name: string;
      quantity: number;
      modifiers: Array<{ name: string }>;
      notes?: string | null;
    }>;
    location: { id: string; name: string };
  };
}

const SLA_THRESHOLDS = { warn: 8 * 60, crit: 15 * 60 }; // seconds

function useElapsedSeconds(createdAt: string) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  return elapsed;
}

function formatElapsed(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function KdsPage() {
  const params = useSearchParams();
  const screenId = params.get("screen") ?? "";
  const qc = useQueryClient();
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { data: tickets = [], isLoading } = useQuery<KdsTicket[]>({
    queryKey: ["kds-tickets", screenId],
    queryFn: () =>
      apiClient
        .get(`/v1/kds/screens/${screenId}/tickets`)
        .then((r) => r.data),
    enabled: !!screenId,
    refetchInterval: 30_000,
  });

  const bumpMutation = useMutation({
    mutationFn: (orderId: string) =>
      apiClient
        .post(`/v1/kds/screens/${screenId}/tickets/${orderId}/bump`, {})
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kds-tickets", screenId] }),
  });

  const recallMutation = useMutation({
    mutationFn: (orderId: string) =>
      apiClient
        .post(`/v1/kds/screens/${screenId}/tickets/${orderId}/recall`, {})
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kds-tickets", screenId] }),
  });

  // Real-time updates via WebSocket
  useEffect(() => {
    if (!screenId) return;
    const socket = socketClient.getSocket();
    if (!socket) return;

    const handler = (data: { orderId: string }) => {
      qc.invalidateQueries({ queryKey: ["kds-tickets", screenId] });
      if (soundEnabled && audioRef.current) {
        audioRef.current.play().catch(() => {});
      }
    };

    socket.on("kds:order:new", handler);
    socket.on("kds:ticket:recalled", () => qc.invalidateQueries({ queryKey: ["kds-tickets", screenId] }));

    return () => {
      socket.off("kds:order:new", handler);
      socket.off("kds:ticket:recalled");
    };
  }, [screenId, soundEnabled, qc]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  }, []);

  if (!screenId) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950">
        <div className="text-center">
          <p className="text-zinc-400 text-lg font-medium mb-2">No screen configured</p>
          <p className="text-zinc-600 text-sm">
            Add <code className="text-zinc-400">?screen=SCREEN_ID</code> to the URL
          </p>
        </div>
      </div>
    );
  }

  const activeTickets = tickets.filter((t) => !t.bumpedAt);

  return (
    <div className="h-screen bg-zinc-950 flex flex-col overflow-hidden">
      {/* KDS toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-sm font-semibold text-white">KITCHEN DISPLAY</span>
          <span className="text-xs text-zinc-500 bg-zinc-800 rounded-md px-2 py-0.5">
            {activeTickets.length} active
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSoundEnabled((p) => !p)}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </button>
          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Ticket grid */}
      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-64 rounded-xl bg-zinc-900 animate-pulse" />
            ))}
          </div>
        ) : activeTickets.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="h-16 w-16 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-4">
                <Check className="h-8 w-8 text-emerald-500" />
              </div>
              <p className="text-zinc-400 text-lg font-medium">All clear</p>
              <p className="text-zinc-600 text-sm mt-1">No active tickets</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {activeTickets.map((ticket) => (
              <KdsTicketCard
                key={ticket.orderId}
                ticket={ticket}
                onBump={() => bumpMutation.mutate(ticket.orderId)}
                isBumping={bumpMutation.isPending}
              />
            ))}
          </div>
        )}
      </div>

      {/* Recalled / bumped bar */}
      {tickets.filter((t) => t.bumpedAt).length > 0 && (
        <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 flex-shrink-0">
          <p className="text-xs text-zinc-500 mb-2 font-medium uppercase tracking-wider">Completed</p>
          <div className="flex gap-2 overflow-x-auto">
            {tickets
              .filter((t) => t.bumpedAt)
              .slice(-10)
              .map((ticket) => (
                <button
                  key={ticket.orderId}
                  onClick={() => recallMutation.mutate(ticket.orderId)}
                  className="flex-shrink-0 flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  <RotateCcw className="h-3 w-3" />
                  #{ticket.order.displayId ?? ticket.orderId.slice(-4)}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Ticket card ───────────────────────────────────────────────────────────────

function KdsTicketCard({ ticket, onBump, isBumping }: { ticket: KdsTicket; onBump: () => void; isBumping: boolean }) {
  const elapsed = useElapsedSeconds(ticket.createdAt);
  const slaState =
    elapsed >= SLA_THRESHOLDS.crit ? "crit" :
    elapsed >= SLA_THRESHOLDS.warn ? "warn" : "ok";

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border-2 overflow-hidden transition-all",
        slaState === "crit" && "border-red-500 bg-red-500/5 animate-pulse-slow",
        slaState === "warn" && "border-amber-500 bg-amber-500/5",
        slaState === "ok" && "border-zinc-700 bg-zinc-900",
      )}
    >
      {/* Card header */}
      <div className={cn(
        "px-3 py-2 flex items-center justify-between",
        slaState === "crit" ? "bg-red-500/20" : slaState === "warn" ? "bg-amber-500/20" : "bg-zinc-800",
      )}>
        <div>
          <p className="text-white font-bold text-lg leading-none">
            #{ticket.order.displayId ?? ticket.orderId.slice(-4).toUpperCase()}
          </p>
          <p className="text-xs text-zinc-400 mt-0.5">{ticket.order.fulfillmentType.replace("_", " ")}</p>
        </div>
        <div className={cn(
          "flex items-center gap-1 text-sm font-mono font-semibold",
          slaState === "crit" ? "text-red-400" : slaState === "warn" ? "text-amber-400" : "text-zinc-400",
        )}>
          <Clock className="h-3.5 w-3.5" />
          {formatElapsed(elapsed)}
        </div>
      </div>

      {/* Items */}
      <div className="flex-1 px-3 py-3 space-y-2 overflow-y-auto max-h-72">
        {ticket.order.items.map((item, i) => (
          <div key={i}>
            <p className="text-white font-semibold text-sm leading-tight">
              <span className="text-zinc-400 mr-1">{item.quantity}×</span>
              {item.name.toUpperCase()}
            </p>
            {item.modifiers?.map((mod, j) => (
              <p key={j} className="text-xs text-zinc-500 ml-4">+ {mod.name}</p>
            ))}
            {item.notes && (
              <p className="text-xs text-amber-400 ml-4 font-medium">★ {item.notes}</p>
            )}
          </div>
        ))}
        {ticket.order.specialInstructions && (
          <div className="mt-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-2 py-1.5">
            <p className="text-xs text-amber-400 font-medium">{ticket.order.specialInstructions}</p>
          </div>
        )}
      </div>

      {/* Bump button */}
      <button
        onClick={onBump}
        disabled={isBumping}
        className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-bold text-sm transition-colors flex items-center justify-center gap-2"
      >
        <Check className="h-4 w-4" />
        BUMP
      </button>
    </div>
  );
}
