import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

// Orders placed (or opened) in this app, newest first. Customers don't sign
// in to the app, so this phone's own list is what "My orders" shows; the
// storefront's account page still has the full history for signed-in ones.
export type SavedOrder = { orderId: string; slug: string; savedAt: number };

const KEY = "orders:v1";
const MAX = 30;

type Listener = (orders: SavedOrder[]) => void;
const listeners = new Set<Listener>();
let cache: SavedOrder[] | null = null;

async function read(): Promise<SavedOrder[]> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as SavedOrder[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** Returns true when the order is new to this phone. */
export async function saveOrder(orderId: string, slug: string): Promise<boolean> {
  const orders = await read();
  const isNew = !orders.some((o) => o.orderId === orderId);
  const next = [{ orderId, slug, savedAt: Date.now() }, ...orders.filter((o) => o.orderId !== orderId)].slice(0, MAX);
  cache = next;
  listeners.forEach((l) => l(next));
  await AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
  return isNew;
}

export function useSavedOrders(): SavedOrder[] | null {
  const [orders, setOrders] = useState<SavedOrder[] | null>(cache);
  useEffect(() => {
    listeners.add(setOrders);
    read().then(setOrders);
    return () => {
      listeners.delete(setOrders);
    };
  }, []);
  return orders;
}
