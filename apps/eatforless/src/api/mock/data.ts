// ─────────────────────────────────────────────────────────────────────────────
// DEV-ONLY SAMPLE DATA (EXPO_PUBLIC_EFL_MOCK=1). Nothing here is real except the
// Pizza Pizza menu snapshot (pizza-pizza-menu.json, trimmed from its live
// storefront on 2026-10-25, plus one invented nested "Make it a meal" group so
// nested modifiers can be exercised). Other shop names are placeholders taken
// from the design canvas. Inert unless MOCK is true, which release builds
// never are (see config.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { Customer, LatLng, Shop, Storefront } from "../types";
import menu from "./pizza-pizza-menu.json";

export const mockStore = menu as unknown as Storefront;

const photo = (name: string) =>
  mockStore.menu?.categories
    .flatMap((c) => c.items)
    .find((r) => r.item.name.toLowerCase().includes(name))?.item.imageUrl ?? null;

export const mockShops: Shop[] = [
  {
    id: "mock-pizza-pizza",
    sponsored: { token: "mock-ad-token-pizza-pizza" },
    deal: "Buy 1, get 1",
    rating: { value: 4.7, count: 320 },
    name: "Pizza Pizza",
    area: "Westerhope",
    logoUrl: null,
    heroImageUrl: photo("pepperoni"),
    cuisines: ["Pizza", "Kebab", "Burgers"],
    distanceMiles: 3.1,
    isOpen: true,
    delivery: { available: true, fee: 1.49, minOrder: 10, etaMinutes: { min: 20, max: 30 } },
    collection: { available: true, readyInMinutes: 15 },
  },
  {
    id: "mock-hot-bitez",
    deal: "15% off £20+",
    rating: { value: 4.6, count: 150 },
    name: "Hot Bitez",
    area: "South Shields",
    logoUrl: null,
    heroImageUrl: null,
    cuisines: ["Burgers", "Chicken"],
    distanceMiles: 4.2,
    isOpen: true,
    delivery: { available: true, fee: 1.99, minOrder: 10, etaMinutes: { min: 25, max: 35 } },
    collection: { available: true, readyInMinutes: 15 },
  },
  {
    id: "mock-tyne-grill",
    deal: "Free chips",
    rating: { value: 4.4, count: 200 },
    name: "Tyne Grill",
    area: "Gateshead",
    logoUrl: null,
    heroImageUrl: photo("donner kebab"),
    cuisines: ["Kebab", "Grill"],
    distanceMiles: 1.4,
    isOpen: true,
    delivery: { available: true, fee: 0.99, minOrder: 10, etaMinutes: { min: 15, max: 25 } },
    collection: { available: true, readyInMinutes: 15 },
  },
  {
    id: "mock-quayside-curry",
    deal: "20% off",
    rating: { value: 4.8, count: 410 },
    name: "Quayside Curry House",
    area: "Quayside",
    logoUrl: null,
    heroImageUrl: null,
    cuisines: ["Indian", "Curry"],
    distanceMiles: 0.8,
    isOpen: true,
    delivery: { available: true, fee: 2.49, minOrder: 10, etaMinutes: { min: 15, max: 25 } },
    collection: { available: true, readyInMinutes: 15 },
  },
  {
    id: "mock-wing-shack",
    deal: "£5 off £25+",
    rating: { value: 4.6, count: 90 },
    name: "Wing Shack",
    area: "Heaton",
    logoUrl: null,
    heroImageUrl: null,
    cuisines: ["Chicken", "Fast food"],
    distanceMiles: 2.2,
    isOpen: true,
    delivery: { available: true, fee: 1.49, minOrder: 10, etaMinutes: { min: 20, max: 30 } },
    collection: { available: true, readyInMinutes: 15 },
  },
  {
    id: "mock-sweet-spot",
    deal: "Buy 1, get 1",
    rating: { value: 4.5, count: 120 },
    name: "Sweet Spot Desserts",
    area: "Jesmond",
    logoUrl: null,
    heroImageUrl: null,
    cuisines: ["Desserts"],
    distanceMiles: 1.9,
    isOpen: true,
    delivery: { available: true, fee: 1.99, minOrder: 10, etaMinutes: { min: 20, max: 30 } },
    collection: { available: false, readyInMinutes: null },
  },
  {
    id: "mock-golden-dragon",
    deal: null,
    rating: { value: 4.3, count: 60 },
    name: "Golden Dragon",
    area: "Chinatown",
    logoUrl: null,
    heroImageUrl: null,
    cuisines: ["Chinese"],
    distanceMiles: 0.6,
    isOpen: false,
    delivery: { available: true, fee: 1.99, minOrder: 10, etaMinutes: { min: 10, max: 20 } },
    collection: { available: true, readyInMinutes: 15 },
  },
];

export const mockCustomer: Customer = {
  id: "mock-customer",
  email: "sample.customer@example.com",
  firstName: "Sam",
  lastName: "Sample",
  phone: "+447700900482",
  isVerified: true,
};

/** Where the sample order is delivered: Grey Street, central Newcastle. */
export const MOCK_DESTINATION: LatLng = { lat: 54.97222, lng: -1.61213 };
/** The sample shop, west of the centre. */
export const MOCK_SHOP_POINT: LatLng = { lat: 54.97418, lng: -1.62452 };

/**
 * The sample driver's route, shop → door, along real streets near
 * Westgate Road / Grainger Street so the car turns at real corners.
 */
export const MOCK_ROUTE: LatLng[] = [
  MOCK_SHOP_POINT,
  { lat: 54.97142, lng: -1.62403 },
  { lat: 54.97101, lng: -1.61852 },
  { lat: 54.97218, lng: -1.6181 },
  { lat: 54.97262, lng: -1.61432 },
  { lat: 54.97118, lng: -1.61395 },
  MOCK_DESTINATION,
];
