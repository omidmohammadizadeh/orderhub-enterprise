"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Zap,
  CheckCircle,
  Clock,
  AlertTriangle,
  ChevronRight,
  ChevronUp,
} from "lucide-react";

interface OrderItem {
  name: string;
  quantity: number;
  notes?: string;
}

interface Order {
  id: string;
  displayId: string;
  platform: string;
  status: string;
  total: number;
  items: OrderItem[];
  createdAt: string;
  customerName?: string;
  estimatedReadyAt?: string;
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const PLATFORM_COLORS: Record<string, string> = {
  UBER_EATS: "bg-black text-white",
  DELIVEROO: "bg-teal-500 text-white",
  JUST_EAT: "bg-orange-500 text-white",
  HUBRISE: "bg-purple-500 text-white",
  DIRECT: "bg-blue-500 text-white",
  POS: "bg-gray-500 text-white",
  ONLINE: "bg-indigo-500 text-white",
};

function ageSeconds(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
}

function urgencyClass(ageS: number, status: string): string {
  if (status !== "PENDING" && status !== "CONFIRMED") return "";
  if (ageS > 300) return "ring-2 ring-red-500 animate-pulse";
  if (ageS > 180) return "ring-2 ring-orange-400";
  return "";
}

function OrderCard({
  order,
  index,
  focused,
  onAccept,
  onReady,
  onClick,
}: {
  order: Order;
  index: number;
  focused: boolean;
  onAccept: (id: string) => void;
  onReady: (id: string) => void;
  onClick: () => void;
}) {
  const age = ageSeconds(order.createdAt);
  const ageMin = Math.floor(age / 60);
  const ageSec = age % 60;
  const isPending = order.status === "PENDING";
  const isConfirmed = order.status === "CONFIRMED";

  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl border border-gray-200 p-4 cursor-pointer transition-all select-none
        ${focused ? "ring-2 ring-blue-500 shadow-md" : "hover:border-gray-300"}
        ${urgencyClass(age, order.status)}`}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-gray-900">#{order.displayId}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PLATFORM_COLORS[order.platform] ?? "bg-gray-200 text-gray-700"}`}>
            {order.platform.replace(/_/g, " ")}
          </span>
          {focused && (
            <span className="text-xs text-blue-600 font-mono">[{index + 1}]</span>
          )}
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-gray-800">${(order.total / 100).toFixed(2)}</p>
          <p className={`text-xs flex items-center gap-1 ${age > 300 ? "text-red-600 font-semibold" : age > 180 ? "text-orange-500" : "text-gray-400"}`}>
            <Clock className="w-3 h-3" />
            {ageMin}:{ageSec.toString().padStart(2, "0")}
          </p>
        </div>
      </div>

      {/* Items (compact) */}
      <div className="space-y-0.5 mb-3">
        {order.items.slice(0, 4).map((item, i) => (
          <p key={i} className="text-sm text-gray-700">
            <span className="font-semibold">{item.quantity}×</span> {item.name}
            {item.notes && <span className="text-xs text-orange-600 ml-1">({item.notes})</span>}
          </p>
        ))}
        {order.items.length > 4 && (
          <p className="text-xs text-gray-400">+{order.items.length - 4} more items</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {isPending && (
          <button
            onClick={(e) => { e.stopPropagation(); onAccept(order.id); }}
            className="flex-1 py-2.5 rounded-lg bg-green-500 hover:bg-green-600 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-1"
          >
            <CheckCircle className="w-4 h-4" />
            Accept {focused && <span className="text-xs opacity-70 ml-1">A</span>}
          </button>
        )}
        {isConfirmed && (
          <button
            onClick={(e) => { e.stopPropagation(); onReady(order.id); }}
            className="flex-1 py-2.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-1"
          >
            <ChevronRight className="w-4 h-4" />
            Ready {focused && <span className="text-xs opacity-70 ml-1">R</span>}
          </button>
        )}
        {!isPending && !isConfirmed && (
          <div className="flex-1 py-2.5 text-center text-xs text-gray-400">{order.status}</div>
        )}
      </div>
    </div>
  );
}

export default function RushHourPage() {
  const qc = useQueryClient();
  const [focusedIdx, setFocusedIdx] = useState(0);

  const { data: orders } = useQuery<Order[]>({
    queryKey: ["orders-rush"],
    queryFn: () =>
      apiFetch("/v1/orders?status=PENDING,CONFIRMED&limit=50&sort=createdAt:asc"),
    refetchInterval: 5_000,
  });

  const accept = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status: "CONFIRMED" }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders-rush"] }),
  });

  const ready = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status: "READY" }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders-rush"] }),
  });

  const pending = orders?.filter((o) => o.status === "PENDING") ?? [];
  const confirmed = orders?.filter((o) => o.status === "CONFIRMED") ?? [];
  const allActive = [...pending, ...confirmed];

  const focused = allActive[focusedIdx];

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!allActive.length) return;
      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          setFocusedIdx((i) => Math.min(i + 1, allActive.length - 1));
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          setFocusedIdx((i) => Math.max(i - 1, 0));
          break;
        case "a":
        case "A":
          if (focused?.status === "PENDING") accept.mutate(focused.id);
          break;
        case "r":
        case "R":
          if (focused?.status === "CONFIRMED") ready.mutate(focused.id);
          break;
      }
    },
    [allActive, focused, accept, ready],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Clamp focus index when orders change
  useEffect(() => {
    if (allActive.length > 0) setFocusedIdx((i) => Math.min(i, allActive.length - 1));
  }, [allActive.length]);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header bar */}
      <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-yellow-400" />
          <span className="font-bold text-lg">Rush Hour</span>
        </div>
        <div className="flex gap-4 text-sm">
          {pending.length > 0 && (
            <span className="flex items-center gap-1.5 text-red-400">
              <AlertTriangle className="w-4 h-4" />
              {pending.length} pending
            </span>
          )}
          {confirmed.length > 0 && (
            <span className="flex items-center gap-1.5 text-blue-400">
              <Clock className="w-4 h-4" />
              {confirmed.length} in prep
            </span>
          )}
        </div>
        <div className="ml-auto text-xs text-gray-500 hidden md:block">
          ↑↓ navigate · A accept · R ready
        </div>
      </div>

      <div className="p-4">
        {allActive.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-80 text-gray-600">
            <CheckCircle className="w-12 h-12 mb-3" />
            <p className="text-lg font-medium">All clear!</p>
            <p className="text-sm">No pending or in-progress orders.</p>
          </div>
        ) : (
          <>
            {/* Pending section */}
            {pending.length > 0 && (
              <div className="mb-6">
                <h2 className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5" /> Needs Acceptance ({pending.length})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {pending.map((order, i) => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      index={i}
                      focused={focusedIdx === i}
                      onAccept={(id) => accept.mutate(id)}
                      onReady={(id) => ready.mutate(id)}
                      onClick={() => setFocusedIdx(i)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Confirmed / In prep section */}
            {confirmed.length > 0 && (
              <div>
                <h2 className="text-xs font-semibold text-blue-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5" /> In Preparation ({confirmed.length})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {confirmed.map((order, i) => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      index={pending.length + i}
                      focused={focusedIdx === pending.length + i}
                      onAccept={(id) => accept.mutate(id)}
                      onReady={(id) => ready.mutate(id)}
                      onClick={() => setFocusedIdx(pending.length + i)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
