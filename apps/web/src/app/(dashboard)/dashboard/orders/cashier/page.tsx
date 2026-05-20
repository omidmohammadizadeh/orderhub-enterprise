"use client";

import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShoppingBag, CheckCircle, Clock, DollarSign, CreditCard, Banknote, Printer } from "lucide-react";

interface OrderItem {
  name: string;
  quantity: number;
  price: number;
  notes?: string;
}

interface Order {
  id: string;
  displayId: string;
  platform: string;
  status: string;
  total: number;
  subtotal: number;
  tax: number;
  items: OrderItem[];
  createdAt: string;
  customerName?: string;
  paymentMethod?: string;
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

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function ageMinutes(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
}

function OrderDetail({ order, onCollect, onPrint }: {
  order: Order;
  onCollect: (id: string, method: string) => void;
  onPrint: (id: string) => void;
}) {
  const [payMethod, setPayMethod] = useState<"CASH" | "CARD">("CARD");

  return (
    <div className="bg-white rounded-xl border border-gray-200 flex flex-col h-full">
      {/* Header */}
      <div className="p-5 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-2xl font-black text-gray-900">#{order.displayId}</span>
            {order.customerName && (
              <p className="text-sm text-gray-500 mt-0.5">{order.customerName}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-400 flex items-center gap-1 justify-end">
              <Clock className="w-3 h-3" /> {ageMinutes(order.createdAt)}m ago
            </p>
            <p className="text-xs text-gray-400">{order.platform.replace(/_/g, " ")}</p>
          </div>
        </div>
      </div>

      {/* Items */}
      <div className="flex-1 p-5 space-y-2 overflow-y-auto">
        {order.items.map((item, i) => (
          <div key={i} className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-gray-800">
                <span className="text-gray-400">{item.quantity}×</span> {item.name}
              </p>
              {item.notes && <p className="text-xs text-orange-600 ml-5">{item.notes}</p>}
            </div>
            <p className="text-sm text-gray-700 shrink-0">{fmt(item.price * item.quantity)}</p>
          </div>
        ))}
      </div>

      {/* Totals */}
      <div className="p-5 border-t border-gray-100 space-y-1.5">
        <div className="flex justify-between text-sm text-gray-500">
          <span>Subtotal</span><span>{fmt(order.subtotal)}</span>
        </div>
        <div className="flex justify-between text-sm text-gray-500">
          <span>Tax</span><span>{fmt(order.tax)}</span>
        </div>
        <div className="flex justify-between text-base font-bold text-gray-900 pt-1 border-t border-gray-100">
          <span>Total</span><span className="text-lg">{fmt(order.total)}</span>
        </div>
      </div>

      {/* Payment */}
      {order.status === "READY" && !order.paymentMethod && (
        <div className="p-5 border-t border-gray-100">
          <p className="text-xs font-medium text-gray-500 mb-2">Payment Method</p>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setPayMethod("CARD")}
              className={`flex-1 py-2.5 rounded-lg border-2 text-sm font-semibold flex items-center justify-center gap-1.5 transition-colors
                ${payMethod === "CARD" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:border-gray-300"}`}
            >
              <CreditCard className="w-4 h-4" /> Card
            </button>
            <button
              onClick={() => setPayMethod("CASH")}
              className={`flex-1 py-2.5 rounded-lg border-2 text-sm font-semibold flex items-center justify-center gap-1.5 transition-colors
                ${payMethod === "CASH" ? "border-green-500 bg-green-50 text-green-700" : "border-gray-200 text-gray-600 hover:border-gray-300"}`}
            >
              <Banknote className="w-4 h-4" /> Cash
            </button>
          </div>
          <button
            onClick={() => onCollect(order.id, payMethod)}
            className="w-full py-3 rounded-xl bg-gray-900 hover:bg-gray-700 text-white font-bold text-base transition-colors flex items-center justify-center gap-2"
          >
            <CheckCircle className="w-5 h-5" /> Collect {fmt(order.total)}
          </button>
        </div>
      )}

      {order.status === "COMPLETED" && (
        <div className="p-5 border-t border-gray-100 flex gap-2">
          <div className="flex-1 flex items-center gap-2 text-green-600 text-sm font-semibold">
            <CheckCircle className="w-4 h-4" /> Paid
          </div>
          <button
            onClick={() => onPrint(order.id)}
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 flex items-center gap-1.5 transition-colors"
          >
            <Printer className="w-4 h-4" /> Receipt
          </button>
        </div>
      )}
    </div>
  );
}

export default function CashierPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: orders, isLoading } = useQuery<Order[]>({
    queryKey: ["orders-cashier"],
    queryFn: () =>
      apiFetch("/v1/orders?status=READY,COMPLETED&limit=50&sort=createdAt:asc"),
    refetchInterval: 8_000,
  });

  const collect = useMutation({
    mutationFn: ({ id, paymentMethod }: { id: string; paymentMethod: string }) =>
      apiFetch(`/v1/orders/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "COMPLETED", paymentMethod }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders-cashier"] }),
  });

  const printReceipt = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/v1/orders/${id}/print-receipt`, { method: "POST" }),
  });

  const ready = orders?.filter((o) => o.status === "READY") ?? [];
  const completed = orders?.filter((o) => o.status === "COMPLETED") ?? [];
  const selected = orders?.find((o) => o.id === selectedId) ?? ready[0];

  // Auto-select first ready order
  useEffect(() => {
    if (!selectedId && ready.length > 0) setSelectedId(ready[0]!.id);
  }, [ready.length]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!orders?.length) return;
    const readyIds = ready.map((o) => o.id);
    const idx = selectedId ? readyIds.indexOf(selectedId) : -1;
    if (e.key === "ArrowDown" && idx < readyIds.length - 1) setSelectedId(readyIds[idx + 1]!);
    if (e.key === "ArrowUp" && idx > 0) setSelectedId(readyIds[idx - 1]!);
  }, [orders, selectedId, ready]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <ShoppingBag className="w-5 h-5 text-gray-700" />
          <span className="font-bold text-gray-900">Cashier</span>
        </div>
        <span className="text-sm text-gray-500">
          {ready.length} ready to collect · {completed.length} completed today
        </span>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: order list */}
        <div className="w-72 bg-white border-r border-gray-200 flex flex-col overflow-hidden shrink-0">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Ready to Collect ({ready.length})
            </p>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {ready.length === 0 && (
              <p className="text-xs text-gray-400 px-4 py-3">No orders waiting.</p>
            )}
            {ready.map((order) => (
              <button
                key={order.id}
                onClick={() => setSelectedId(order.id)}
                className={`w-full text-left px-4 py-3 transition-colors ${
                  selected?.id === order.id ? "bg-blue-50 border-r-2 border-blue-500" : "hover:bg-gray-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-gray-900">#{order.displayId}</span>
                  <span className="text-sm font-semibold text-gray-700">{fmt(order.total)}</span>
                </div>
                {order.customerName && (
                  <p className="text-xs text-gray-400 mt-0.5">{order.customerName}</p>
                )}
                <p className="text-xs text-gray-400">{ageMinutes(order.createdAt)}m ago</p>
              </button>
            ))}
          </div>
        </div>

        {/* Right: order detail */}
        <div className="flex-1 p-6 overflow-y-auto">
          {selected ? (
            <OrderDetail
              order={selected}
              onCollect={(id, method) => collect.mutate({ id, paymentMethod: method })}
              onPrint={(id) => printReceipt.mutate(id)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <ShoppingBag className="w-12 h-12 mb-3" />
              <p className="text-lg font-medium">Select an order</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
