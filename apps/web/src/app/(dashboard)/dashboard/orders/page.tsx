import type { Metadata } from "next";
import { OrderBoard } from "@/components/orders/order-board";

export const metadata: Metadata = { title: "Live Orders" };

export default function OrdersPage() {
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-lg font-semibold text-zinc-900">Live Orders</h1>
        <p className="text-sm text-zinc-500">Real-time order board — updates automatically via WebSocket.</p>
      </div>
      <OrderBoard />
    </div>
  );
}
