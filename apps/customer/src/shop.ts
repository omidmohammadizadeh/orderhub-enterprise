import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { brand, storefrontOrigin } from "./brand";

// A brand trading at several shops gets one app; the customer picks the shop
// (nearest first). The choice is applied by rewriting brand.storefrontUrl and
// brand.locationId, the two values every screen already reads — the Menu
// WebView, Home's store info, push registration, account links — so no
// screen needs to know whether the app has one shop or ten.

export type Shop = {
  locationId: string;
  storeSlug: string;
  name: string;
  address: string | null;
  postcode: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  isOpen: boolean;
};

export const multiShop = brand.multiShop === true;

const KEY = "shop:selected";
let current: Shop | null = null;
const listeners = new Set<() => void>();

function apply(shop: Shop) {
  current = shop;
  brand.storefrontUrl = `${storefrontOrigin}/order/${encodeURIComponent(shop.storeSlug)}?brand=${brand.brandId}`;
  brand.locationId = shop.locationId;
  listeners.forEach((fn) => fn());
}

/** The saved choice, applied. Null when the customer hasn't picked yet. */
export async function loadShop(): Promise<Shop | null> {
  if (!multiShop) return null;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Shop) : null;
    if (saved?.locationId && saved.storeSlug) apply(saved);
  } catch {
    /* a corrupt entry just means picking again */
  }
  return current;
}

export async function chooseShop(shop: Shop): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(shop)).catch(() => {});
  apply(shop);
}

export function currentShop(): Shop | null {
  return current;
}

/** Re-renders when the customer switches shop. */
export function useShop(): Shop | null {
  const [shop, setShop] = useState(current);
  useEffect(() => {
    const fn = () => setShop(current);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return shop;
}

export async function fetchShops(): Promise<Shop[]> {
  const res = await fetch(`${brand.apiUrl}/v1/ordering/brands/${encodeURIComponent(brand.brandId)}/shops`);
  if (!res.ok) throw new Error(`shops ${res.status}`);
  const body = (await res.json()) as { shops: Shop[] };
  return body.shops ?? [];
}

/** Straight-line distance in miles (the UK reads miles). */
export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}
