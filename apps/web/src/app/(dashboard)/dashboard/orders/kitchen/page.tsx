"use client";

import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChefHat, CheckCircle, Clock, AlertTriangle } from "lucide-react";

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
  items: OrderItem[];
  createdAt: string;
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

function ageSeconds(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
}

function bgColor(ageS: number): string {
  if (ageS > 420) return "bg-red-900 border-red-700";
  if (ageS > 240) return "bg-orange-900 border-orange-700";
  return "bg-gray-900 border-gray-700";
}

function timeLabel(ageS: number) {
  const m = Math.floor(ageS / 60);
  const s = ageS % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function KdsCard({
  order,
  focused,
  onBump,
  onClick,
}: {
  order: Order;
  focused: boolean;
  onBump: (id: string) => void;
  onClick: () => void;
}) {
  const [age, setAge] = useState(ageSeconds(order.createdAt));

  useEffect(() => {
    const t = setInterval(() => setAge(ageSeconds(order.createdAt)), 1000);
    return () => clearInterval(t);
  }, [order.createdAt]);

  return (
    <div
      onClick={onClick}
      className={`rounded-2xl border-2 p-5 cursor-pointer transition-all
        ${bgColor(age)}
        ${focused ? "ring-2 ring-white ring-offset-2 ring-offset-gray-950" : ""}`}
    >
      {/* Ticket header */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-2xl font-black text-white">#{order.displayId}</span>
        <span className={`text-xl font-bold tabular-nums ${age > 420 ? "text-red-300 animate-pulse" : age > 240 ? "text-orange-300" : "text-gray-400"}`}>
          {timeLabel(age)}
        </span>
      </div>

      {/* Items — large, readable across kitchen */}
      <div className="space-y-2 mb-5">
        {order.items.map((item, i) => (
          <div key={i}>
            <p className="text-xl font-bold text-white">
              <span className="text-yellow-400">{item.quantity}×</span> {item.name}
            </p>
            {item.notes && (
              <p className="text-sm text-orange-300 ml-6 mt-0.5">{item.notes}</p>
            )}
          </div>
        ))}
      </div>

      {/* BUMP button */}
      <button
        onClick={(e) => { e.stopPropagation(); onBump(order.id); }}
        className="w-full py-4 rounded-xl bg-green-500 hover:bg-green-400 active:scale-95 text-white text-xl font-black transition-all flex items-center justify-center gap-2"
      >
        <CheckCircle className="w-6 h-6" />
        BUMP {focused && <span className="text-sm opacity-70">Space</span>}
      </button>
    </div>
  );
}

export default function KitchenPage() {
  const qc = useQueryClient();
  const [focusedIdx, setFocusedIdx] = useState(0);

  const { data: orders } = useQuery<Order[]>({
    queryKey: ["orders-kitchen"],
    queryFn: () =>
      apiFetch("/v1/orders?status=ACCEPTED,PREPARING&limit=20&sort=createdAt:asc"),
    refetchInterval: 8_000,
  });

  const bump = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/orders/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "READY" }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders-kitchen"] }),
  });

  const active = orders ?? [];

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!active.length) return;
      const focused = active[focusedIdx];
      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          setFocusedIdx((i) => Math.min(i + 1, active.length - 1));
          break;
        case "ArrowLeft":
          e.preventDefault();
          setFocusedIdx((i) => Math.max(i - 1, 0));
          break;
        case " ":
          e.preventDefault();
          if (focused) bump.mutate(focused.id);
          break;
      }
    },
    [active, focusedIdx, bump],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (active.length > 0) setFocusedIdx((i) => Math.min(i, active.length - 1));
  }, [active.length]);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <ChefHat className="w-6 h-6 text-yellow-400" />
          <span className="text-xl font-black">Kitchen Display</span>
        </div>
        {active.length > 0 && (
          <span className="text-gray-400 text-sm">{active.length} tickets</span>
        )}
        <div className="ml-auto text-xs text-gray-500 hidden md:block">
          ← → navigate · Space BUMP
        </div>
      </div>

      {/* Ticket grid */}
      <div className="p-4">
        {active.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[70vh] text-gray-700">
            <ChefHat className="w-16 h-16 mb-4" />
            <p className="text-2xl font-bold">Kitchen is clear</p>
            <p className="text-sm mt-1">No orders in preparation.</p>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {active.map((order, i) => (
              <KdsCard
                key={order.id}
                order={order}
                focused={focusedIdx === i}
                onBump={(id) => bump.mutate(id)}
                onClick={() => setFocusedIdx(i)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
