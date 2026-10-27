// Every API call the app makes, in one place. In MOCK mode (dev only) each one
// is answered by src/api/mock instead of the network.

import { MOCK } from "@/config";
import { request } from "./client";
import * as mock from "./mock/mockApi";
import type {
  AddressBody,
  AppConfig,
  AuthResult,
  CheckoutBody,
  CheckoutResult,
  Customer,
  EflMe,
  OrderDetail,
  OrderMessage,
  OrderSummary,
  Shop,
  SavedAddress,
  ShopMenu,
} from "./types";

// ── Browsing (public) ──────────────────────────────────────────────────────

export function getConfig(): Promise<AppConfig> {
  if (MOCK) return Promise.resolve({ stripePublishableKey: null });
  return request("GET", "/v1/efl/config", undefined, { auth: false });
}

export function getShops(point: { lat: number; lng: number; postcode?: string }): Promise<Shop[]> {
  if (MOCK) return mock.getShops();
  const q = `lat=${point.lat}&lng=${point.lng}${point.postcode ? `&postcode=${encodeURIComponent(point.postcode)}` : ""}`;
  return request("GET", `/v1/efl/shops?${q}`, undefined, { auth: false });
}

/** A tap on a sponsored shop. Fire-and-forget: never rejects, and a failure
 *  must never stand between the customer and the shop. */
export function adTap(token: string): Promise<void> {
  if (MOCK) return Promise.resolve();
  return request<unknown>("POST", "/v1/efl/ads/tap", { token }, { auth: false, timeoutMs: 15_000 }).then(
    () => undefined,
    () => undefined,
  );
}

export function getShopMenu(listingId: string): Promise<ShopMenu> {
  if (MOCK) return mock.getShopMenu(listingId);
  return request("GET", `/v1/efl/shops/${encodeURIComponent(listingId)}/menu`, undefined, { auth: false });
}

// ── Ordering (customer) ────────────────────────────────────────────────────

export function checkout(listingId: string, body: CheckoutBody): Promise<CheckoutResult> {
  if (MOCK) return mock.checkout(listingId, body);
  return request("POST", `/v1/efl/shops/${encodeURIComponent(listingId)}/checkout`, body, { timeoutMs: 60_000 });
}

export function getMyOrders(): Promise<OrderSummary[]> {
  if (MOCK) return mock.getMyOrders();
  return request("GET", "/v1/efl/me/orders");
}

export function getMyOrder(orderId: string): Promise<OrderDetail> {
  if (MOCK) return mock.getMyOrder(orderId);
  return request("GET", `/v1/efl/me/orders/${encodeURIComponent(orderId)}`);
}

export function getOrderMessages(orderId: string): Promise<OrderMessage[]> {
  if (MOCK) return mock.getOrderMessages(orderId);
  return request("GET", `/v1/efl/me/orders/${encodeURIComponent(orderId)}/messages`);
}

export function sendOrderMessage(orderId: string, body: string): Promise<OrderMessage> {
  if (MOCK) return mock.sendOrderMessage(orderId, body);
  return request("POST", `/v1/efl/me/orders/${encodeURIComponent(orderId)}/messages`, { body });
}

// ── Phone check (S1) and consent ───────────────────────────────────────────

export function startPhone(phone: string): Promise<{ sent: true; phone: string }> {
  if (MOCK) return mock.startPhone(phone);
  return request("POST", "/v1/efl/me/phone/start", { phone });
}

export function verifyPhone(code: string): Promise<{ verified: true }> {
  if (MOCK) return mock.verifyPhone(code);
  return request("POST", "/v1/efl/me/phone/verify", { code });
}

export function setMarketing(optIn: boolean): Promise<{ eflMarketingOptIn: boolean }> {
  if (MOCK) return mock.setMarketing(optIn);
  return request("PATCH", "/v1/efl/me/marketing", { optIn });
}

export function getEflMe(): Promise<EflMe> {
  if (MOCK) return mock.getEflMe();
  return request("GET", "/v1/efl/me");
}

// ── Saved addresses and favourites (on the account) ────────────────────────

export function getAddresses(): Promise<SavedAddress[]> {
  if (MOCK) return mock.getAddresses();
  return request("GET", "/v1/efl/me/addresses");
}

export function addAddress(body: AddressBody): Promise<SavedAddress> {
  if (MOCK) return mock.addAddress(body);
  return request("POST", "/v1/efl/me/addresses", body);
}

export function updateAddress(id: string, body: Partial<AddressBody>): Promise<SavedAddress> {
  if (MOCK) return mock.updateAddress(id, body);
  return request("PATCH", `/v1/efl/me/addresses/${encodeURIComponent(id)}`, body);
}

export function deleteAddress(id: string): Promise<{ ok: true }> {
  if (MOCK) return mock.deleteAddress(id);
  return request("DELETE", `/v1/efl/me/addresses/${encodeURIComponent(id)}`);
}

export function getFavourites(): Promise<string[]> {
  if (MOCK) return mock.getFavourites();
  return request("GET", "/v1/efl/me/favourites");
}

export function setFavourite(listingId: string, on: boolean): Promise<{ ok: true }> {
  if (MOCK) return mock.setFavourite(listingId, on);
  return request(on ? "PUT" : "DELETE", `/v1/efl/me/favourites/${encodeURIComponent(listingId)}`);
}

// ── Push ───────────────────────────────────────────────────────────────────

export function registerPush(body: { token: string; platform: "ios" | "android"; marketingOptIn?: boolean }): Promise<{ ok: true }> {
  if (MOCK) return Promise.resolve({ ok: true });
  return request("POST", "/v1/efl/me/push", body);
}

export function unregisterPush(token: string): Promise<{ ok: true }> {
  if (MOCK) return Promise.resolve({ ok: true });
  return request("POST", "/v1/efl/me/push/unregister", { token });
}

// ── Account (customer-auth: unversioned routes) ────────────────────────────

export function loginEmail(email: string, password: string): Promise<AuthResult> {
  if (MOCK) return mock.signIn();
  return request("POST", "/customer-auth/login", { email, password }, { auth: false });
}

export function signupEmail(input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  marketingOptIn: boolean;
}): Promise<{ pendingVerification: true; email: string }> {
  if (MOCK) return Promise.resolve({ pendingVerification: true, email: input.email });
  return request("POST", "/customer-auth/signup", input, { auth: false });
}

export function signInNative(input: {
  provider: "apple" | "google";
  idToken: string;
  firstName?: string;
  lastName?: string;
}): Promise<AuthResult> {
  if (MOCK) return mock.signIn();
  return request("POST", "/customer-auth/native", input, { auth: false });
}

/** Validates the stored token and returns a fresh one (sliding session). */
export function getMe(): Promise<Customer & { accessToken: string }> {
  if (MOCK) return mock.getMe();
  return request("GET", "/customer-auth/me");
}

export function updateMe(patch: Partial<Customer>): Promise<Customer> {
  if (MOCK) return mock.updateMe(patch);
  return request("PATCH", "/customer-auth/me", patch);
}

export function deleteAccount(): Promise<{ ok: true }> {
  if (MOCK) return Promise.resolve({ ok: true });
  return request("DELETE", "/customer-auth/me", { confirm: "DELETE" });
}
