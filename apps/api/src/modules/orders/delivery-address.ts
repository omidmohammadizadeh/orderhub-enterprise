// Where an order is actually going.
//
// An Order carries its delivery address TWICE and only sometimes in both
// places. The POS/till path fills the structured columns (addressLine1, city,
// postcode); `ingestCanonical` — the path every marketplace and online order
// takes — writes only the `deliveryAddress` JSON blob and leaves those columns
// null. So "read the columns" works perfectly for a test order placed at the
// till and returns nothing at all for a real Uber Eats order, which is exactly
// how a driver ended up tapping Navigate and being told the order had no
// address.
//
// The blob's own keys differ per adapter (HubRise, Uber Eats, Deliveroo, Just
// Eat and the storefront have each had their own spelling), so read every shape
// we have seen and prefer the blob — it is the one the customer typed.

export interface DeliveryAddressParts {
  line1: string | null;
  line2: string | null;
  city: string | null;
  postcode: string | null;
}

export interface OrderAddressSource {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postcode?: string | null;
  deliveryAddress?: unknown;
}

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
};

const pick = (a: Record<string, any>, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = str(a[k]);
    if (v) return v;
  }
  return null;
};

/**
 * The delivery address as four parts, from the JSON blob first and the
 * structured columns second.
 */
export function resolveDeliveryAddress(
  order: OrderAddressSource,
): DeliveryAddressParts {
  const a =
    order.deliveryAddress && typeof order.deliveryAddress === "object"
      ? (order.deliveryAddress as Record<string, any>)
      : null;

  // A flat/estate name is part of finding the door, so keep it when the blob
  // has no second line of its own.
  const area = a ? pick(a, "area", "neighbourhood", "district") : null;
  const line2FromBlob = a
    ? pick(a, "line2", "addressLine2", "address2", "address_2")
    : null;

  return {
    line1:
      (a && pick(a, "line1", "addressLine1", "address1", "address_1", "street")) ??
      str(order.addressLine1),
    line2: line2FromBlob ?? area ?? str(order.addressLine2),
    city: (a && pick(a, "city", "town")) ?? str(order.city),
    postcode:
      (a && pick(a, "postcode", "postal_code", "postalCode", "zip")) ??
      str(order.postcode),
  };
}

/** One line, for a driver to read or hand to a maps app. */
export function formatDeliveryAddress(parts: DeliveryAddressParts): string {
  return [parts.line1, parts.line2, parts.city, parts.postcode]
    .filter(Boolean)
    .join(", ");
}

/**
 * Coordinates the marketplace already sent, if any.
 *
 * Free and exact when present — no geocoding — and it is what puts the
 * destination pin on the driver's map. Mirrors DispatchService's own reader:
 * the point may sit at the top level or inside a container. 0,0 is refused.
 */
export function coordsFromDeliveryAddress(
  deliveryAddress: unknown,
): { lat: number; lng: number } | null {
  const a =
    deliveryAddress && typeof deliveryAddress === "object"
      ? (deliveryAddress as Record<string, any>)
      : null;
  if (!a) return null;
  const containers = [
    a,
    a.coordinates,
    a.coordinate,
    a.coords,
    a.location,
    a.geo,
    a.point,
    a.position,
  ].filter((c) => c && typeof c === "object") as Record<string, any>[];
  for (const c of containers) {
    const lat = Number(c.lat ?? c.latitude ?? c.Latitude);
    const lng = Number(c.lng ?? c.lon ?? c.long ?? c.longitude ?? c.Longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      return { lat, lng };
    }
  }
  return null;
}
