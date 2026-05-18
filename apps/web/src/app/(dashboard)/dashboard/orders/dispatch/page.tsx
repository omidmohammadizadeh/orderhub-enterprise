"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Truck, MapPin, Phone, Clock, CheckCircle, AlertCircle, RefreshCw } from "lucide-react";

interface Order {
  id: string;
  displayId: string;
  platform: string;
  status: string;
  total: number;
  createdAt: string;
  customerName?: string;
  deliveryAddress?: string;
  estimatedReadyAt?: string;
  driver?: { name: string; phone: string };
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

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  READY: { label: "Ready", color: "bg-green-50 text-green-700 border-green-200", dot: "bg-green-500" },
  DISPATCHED: { label: "Out for Delivery", color: "bg-blue-50 text-blue-700 border-blue-200", dot: "bg-blue-500" },
  COMPLETED: { label: "Delivered", color: "bg-gray-50 text-gray-500 border-gray-200", dot: "bg-gray-400" },
};

function ageMinutes(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
}

function DispatchCard({ order, onDispatch, onComplete }: {
  order: Order;
  onDispatch: (id: string) => void;
  onComplete: (id: string) => void;
}) {
  const age = ageMinutes(order.createdAt);
  const cfg = STATUS_CONFIG[order.status] ?? { label: order.status, color: "bg-gray-50 text-gray-600 border-gray-200", dot: "bg-gray-400" };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 hover:border-gray-300 transition-colors">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-gray-900">#{order.displayId}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cfg.color}`}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${cfg.dot}`} />
              {cfg.label}
            </span>
          </div>
          {order.customerName && (
            <p className="text-sm text-gray-600 mt-0.5">{order.customerName}</p>
          )}
        </div>
        <div className="text-right text-xs text-gray-400">
          <p className="flex items-center gap-1 justify-end"><Clock className="w-3 h-3" />{age}m ago</p>
          <p className="font-semibold text-gray-700 mt-0.5">${(order.total / 100).toFixed(2)}</p>
        </div>
      </div>

      {order.deliveryAddress && (
        <p className="text-xs text-gray-500 flex items-start gap-1 mb-3">
          <MapPin className="w-3 h-3 mt-0.5 shrink-0 text-gray-400" />
          {order.deliveryAddress}
        </p>
      )}

      {order.driver ? (
        <div className="flex items-center gap-2 text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2 mb-3">
          <Truck className="w-3.5 h-3.5 text-blue-500" />
          <span className="font-medium">{order.driver.name}</span>
          <span className="text-gray-400">·</span>
          <a href={`tel:${order.driver.phone}`} className="flex items-center gap-1 text-blue-600 hover:underline">
            <Phone className="w-3 h-3" /> {order.driver.phone}
          </a>
        </div>
      ) : null}

      <div className="flex gap-2">
        {order.status === "READY" && (
          <button
            onClick={() => onDispatch(order.id)}
            className="flex-1 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-1.5"
          >
            <Truck className="w-4 h-4" /> Dispatch
          </button>
        )}
        {order.status === "DISPATCHED" && (
          <button
            onClick={() => onComplete(order.id)}
            className="flex-1 py-2 rounded-lg bg-green-500 hover:bg-green-600 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-1.5"
          >
            <CheckCircle className="w-4 h-4" /> Delivered
          </button>
        )}
        {order.status === "DELIVERED" && (
          <div className="flex-1 py-2 text-center text-xs text-gray-400">Completed</div>
        )}
      </div>
    </div>
  );
}

export default function DispatchPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "ready" | "out">("all");

  const { data: orders, isLoading } = useQuery<Order[]>({
    queryKey: ["orders-dispatch"],
    queryFn: () =>
      apiFetch("/v1/orders?status=READY,DISPATCHED,COMPLETED&limit=100&sort=createdAt:desc"),
    refetchInterval: 10_000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/v1/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders-dispatch"] }),
  });

  const filtered = (orders ?? []).filter((o) => {
    if (filter === "ready") return o.status === "READY";
    if (filter === "out") return o.status === "DISPATCHED";
    return ["READY", "DISPATCHED"].includes(o.status);
  });

  const readyCount = orders?.filter((o) => o.status === "READY").length ?? 0;
  const outCount = orders?.filter((o) => o.status === "DISPATCHED").length ?? 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Truck className="w-6 h-6 text-blue-600" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Dispatch</h1>
            <p className="text-sm text-gray-500">
              {readyCount} ready · {outCount} out for delivery
            </p>
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {([
          { key: "all", label: "Active", count: readyCount + outCount },
          { key: "ready", label: "Ready", count: readyCount },
          { key: "out", label: "Out for Delivery", count: outCount },
        ] as const).map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === key
                ? "bg-gray-900 text-white"
                : "bg-white text-gray-600 border border-gray-200 hover:border-gray-300"
            }`}
          >
            {label} {count > 0 && <span className="ml-1 opacity-70">({count})</span>}
          </button>
        ))}
      </div>

      {/* Cards */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Truck className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">No orders in this view.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((order) => (
            <DispatchCard
              key={order.id}
              order={order}
              onDispatch={(id) => updateStatus.mutate({ id, status: "DISPATCHED" })}
              onComplete={(id) => updateStatus.mutate({ id, status: "COMPLETED" })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
