// Which service modes a menu item is sold in.
//
// Three permanent properties of the product, not stock state. A 20" sharing
// pizza that does not survive a moped is not "out of stock" — it is simply not
// a delivery item, and should never be offered as one. That is different from
// isAvailable (hidden everywhere), outOfStock (an 86 the kitchen restores) and
// visibleToCustomers (hidden from customers but not the till).
//
// One shared resolver rather than a check per surface, because there are a lot
// of surfaces — storefront, POS, kiosk, table tabs, WhatsApp, voice, signage,
// and five marketplace publishes — and the first thing to go wrong with a rule
// like this is one of them quietly not applying it.

/** The three modes an operator ticks on the item. */
export type ServiceMode = "COLLECTION" | "DELIVERY" | "DINE_IN";

/** Just the flags, so this works on anything item-shaped. */
export interface ServiceModeFlags {
  availableCollection?: boolean | null;
  availableDelivery?: boolean | null;
  availableDineIn?: boolean | null;
}

/**
 * Our FulfillmentType values, mapped onto the three modes.
 *
 * PICKUP carries counter walk-ins as well as booked collection — the KDS
 * buckets them together and so does this. MERCHANT_DELIVERY and
 * PLATFORM_COURIER are deliveries whoever is driving.
 */
export function serviceModeFor(
  fulfillmentType: string | null | undefined,
): ServiceMode {
  switch ((fulfillmentType ?? "").toUpperCase()) {
    case "DINE_IN":
      return "DINE_IN";
    case "PICKUP":
    case "COLLECTION":
    case "TAKEAWAY":
      return "COLLECTION";
    default:
      // DELIVERY, MERCHANT_DELIVERY, PLATFORM_COURIER, and anything a
      // marketplace sends that we do not recognise. Defaulting to DELIVERY
      // is the cautious end: an item marked not-for-delivery stays hidden
      // rather than slipping through on an unfamiliar type.
      return "DELIVERY";
  }
}

/**
 * Is this item sold in this mode?
 *
 * Absent flags mean yes. Every item predates this feature, plenty of callers
 * select only the columns they need, and an item vanishing because a field was
 * not fetched would be a far worse failure than one showing when it should
 * not.
 */
export function itemAllowsMode(
  item: ServiceModeFlags | null | undefined,
  mode: ServiceMode,
): boolean {
  if (!item) return true;
  switch (mode) {
    case "COLLECTION":
      return item.availableCollection !== false;
    case "DELIVERY":
      return item.availableDelivery !== false;
    case "DINE_IN":
      return item.availableDineIn !== false;
  }
}

/** The same check straight from a fulfillment type. */
export function itemAllowsFulfillment(
  item: ServiceModeFlags | null | undefined,
  fulfillmentType: string | null | undefined,
): boolean {
  return itemAllowsMode(item, serviceModeFor(fulfillmentType));
}

/**
 * Is this item sold this way, taking its CATEGORY into account?
 *
 * A category turned off for a mode takes everything inside it, whatever the
 * individual items say — that is the point of having the switch at the level
 * people actually think in. An item can still be restricted on its own within
 * a category that is on.
 */
export function categoryItemAllowsFulfillment(
  category: ServiceModeFlags | null | undefined,
  item: ServiceModeFlags | null | undefined,
  fulfillmentType: string | null | undefined,
): boolean {
  const mode = serviceModeFor(fulfillmentType);
  return itemAllowsMode(category, mode) && itemAllowsMode(item, mode);
}

/** Every mode this item is sold in — for a badge, or a marketplace that wants
 *  the list rather than a yes/no. */
export function modesFor(item: ServiceModeFlags | null | undefined): ServiceMode[] {
  return (["COLLECTION", "DELIVERY", "DINE_IN"] as const).filter((m) =>
    itemAllowsMode(item, m),
  );
}

/**
 * An item nobody can order.
 *
 * Worth naming: all three unticked is almost always a mistake rather than an
 * intention, and it is invisible on a menu — the item simply never appears.
 */
export function isOrderableNowhere(item: ServiceModeFlags | null | undefined): boolean {
  return modesFor(item).length === 0;
}
