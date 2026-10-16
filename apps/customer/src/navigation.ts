import { createNavigationContainerRef, StackActions } from "@react-navigation/native";
import { storefrontUrlFor } from "./brand";
import { orderFromUrl } from "./storefront-bridge";

export type TabParams = {
  Home: undefined;
  Order: { url?: string; nonce?: number } | undefined;
  Orders: undefined;
  Settings: undefined;
};

export type RootParams = {
  Tabs: { screen?: keyof TabParams; params?: TabParams[keyof TabParams] } | undefined;
  OrderStatus: { orderId: string; slug: string };
};

export const navigationRef = createNavigationContainerRef<RootParams>();

let pending: (() => void) | null = null;

/** Runs now, or as soon as the navigator mounts (a notification tapped while
 *  the app was closed arrives before there is anything to navigate). */
function whenReady(fn: () => void) {
  if (navigationRef.isReady()) fn();
  else pending = fn;
}

export function flushPendingNavigation() {
  const fn = pending;
  pending = null;
  fn?.();
}

export function openOrder(orderId: string, slug: string) {
  whenReady(() => {
    // Push rather than navigate: navigate() would reuse a tracker that is
    // already open for a different order. Same order on top → nothing to do.
    const current = navigationRef.getCurrentRoute();
    if (current?.name === "OrderStatus" && (current.params as RootParams["OrderStatus"])?.orderId === orderId) return;
    navigationRef.dispatch(StackActions.push("OrderStatus", { orderId, slug }));
  });
}

export function openStorefront(path?: string | null) {
  const url = storefrontUrlFor(path);
  whenReady(() => navigationRef.navigate("Tabs", { screen: "Order", params: { url, nonce: Date.now() } }));
}

/** Where a tapped notification's data.url (a relative storefront path)
 *  lands: an order page opens the native tracker, anything else opens in the
 *  storefront tab. */
export function openPushTarget(path: unknown) {
  const p = typeof path === "string" ? path : null;
  const order = p ? orderFromUrl(p) : null;
  if (order) openOrder(order.orderId, order.slug);
  else openStorefront(p);
}
