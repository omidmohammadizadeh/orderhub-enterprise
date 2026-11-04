import type { Metadata } from "next";
import { OrderPage } from "@/components/eatforless/order/orders-pages";

export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false } };

type Props = { params: Promise<{ orderId: string }> };

export default async function Page({ params }: Props) {
  const { orderId } = await params;
  return <OrderPage orderId={orderId} />;
}
