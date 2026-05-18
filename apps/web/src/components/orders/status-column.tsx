"use client";

import type { ReactNode } from "react";
import type { Order } from "../../lib/api/orders.client";
import { OrderCard } from "./order-card";

interface StatusColumnProps {
  title: string;
  status: string;
  orders: Order[];
  color: string;
  icon: ReactNode;
  onOrderClick: (order: Order) => void;
}

export function StatusColumn({
  title,
  status,
  orders,
  color,
  icon,
  onOrderClick,
}: StatusColumnProps) {
  return (
    <div className="flex flex-col min-h-0">
      {/* Column header */}
      <div className="flex items-center gap-2 mb-3 px-1">
        <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${color} bg-opacity-15`}>
          <span className={color.replace("bg-", "text-")}>{icon}</span>
        </div>
        <span className="text-sm font-semibold text-zinc-800">{title}</span>
        <span className="ml-auto flex h-5 min-w-[20px] items-center justify-center rounded-full bg-zinc-200 px-1.5 text-[11px] font-semibold text-zinc-700 tabular-nums">
          {orders.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-2 overflow-y-auto">
        {orders.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-zinc-200 py-10 text-center">
            <p className="text-xs text-zinc-400">No {title.toLowerCase()} orders</p>
          </div>
        ) : (
          orders.map((order) => (
            <OrderCard key={order.id} order={order} onClick={onOrderClick} />
          ))
        )}
      </div>
    </div>
  );
}
