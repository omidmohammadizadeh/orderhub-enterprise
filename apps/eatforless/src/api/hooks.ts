import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/auth/session";
import { getMyOrder, getMyOrders, getShopMenu, getShops } from "./efl";
import type { OrderDetail } from "./types";

const TERMINAL = new Set(["DELIVERED", "COLLECTED", "COMPLETED", "CANCELLED", "REJECTED", "FAILED"]);
export const isFinished = (status: string) => TERMINAL.has(status);

export function useShops(point: { lat: number; lng: number; postcode?: string }) {
  return useQuery({
    queryKey: ["shops", point.lat.toFixed(4), point.lng.toFixed(4), point.postcode ?? ""],
    queryFn: () => getShops(point),
    staleTime: 60_000,
  });
}

export function useShopMenu(listingId: string) {
  return useQuery({
    queryKey: ["menu", listingId],
    queryFn: () => getShopMenu(listingId),
    staleTime: 5 * 60_000,
  });
}

export function useMyOrders() {
  const signedIn = useSession((s) => !!s.token);
  return useQuery({ queryKey: ["orders"], queryFn: getMyOrders, enabled: signedIn, refetchInterval: 20_000 });
}

/** Polls every 4s while the order is live — the driver's position comes with it. */
export function useMyOrder(orderId: string) {
  return useQuery<OrderDetail>({
    queryKey: ["order", orderId],
    queryFn: () => getMyOrder(orderId),
    refetchInterval: (q) => (q.state.data && isFinished(q.state.data.status) ? false : 4_000),
  });
}
