import type { Metadata } from "next";
import { OrdersPage } from "@/components/eatforless/order/orders-pages";

export const metadata: Metadata = { title: "Your orders", robots: { index: false, follow: false } };

export default function Page() {
  return <OrdersPage />;
}
