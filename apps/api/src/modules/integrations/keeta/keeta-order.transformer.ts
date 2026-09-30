import {
  CanonicalOrderSchema,
  currencyDecimals,
  type CanonicalOrder,
  type OrderItem,
} from "@orderhub/shared";
import { keetaId } from "./keeta-json";

// Phase KT-2 — Keeta order (event 1001 / /order/get) → CanonicalOrder.
//
// ── What this is built from ─────────────────────────────────────────────────
//
// Keeta's official OpenAPI bundle for the Standard order API
// (FindMerchantOrderByViewIdResp → orderInfo). Keeta publish per-field
// examples but NO whole-payload example for an order, so the shape is
// spec-derived: `metadata.keetaRaw` keeps the original on every order for the
// first-real-order comparison, and the transformer is defensive about every
// optional block. Treat it as unverified until a live test-store order has
// been diffed against it.
//
// ── The things that make Keeta different ────────────────────────────────────
//
// 1. MONEY IS IN MINOR UNITS on orders (4600 = SAR 46.00), unlike the menu
//    API, which takes major-unit decimal strings. Divided by the currency's
//    own exponent — 3 for KWD/BHD/OMR — which Keeta never state; the
//    `priceStr` beside each amount is kept to check it on the first order.
//
// 2. ITEMS CARRY NAMES, and our own codes. Each line has the Keeta name AND
//    the spu/skuOpenItemCode we published, so a ticket prints without a menu
//    lookup and the code gets back to our MenuItem.
//
// 3. THE TIP IS THE RIDER'S. customerFee.tip is "gratuity given to the Keeta
//    courier". It is inside payTotal but it is not the shop's money, so it is
//    taken out of our total and never written to tipAmount — the same mistake
//    JET Go nearly made in the other direction.
//
// 4. CUSTOMER DETAILS ARRIVE ENCRYPTED ("ENC_…") and can be decrypted only for
//    orders the shop delivers itself. For a Keeta-rider order that is by
//    design, not missing data; the caller passes whatever it could decrypt.
//
// 5. NO ORDER-LEVEL NOTE. Keeta's order has per-product remarks and a
//    cutlery flag, nothing else. Both are surfaced.

// ── Keeta's shapes (only the fields we read) ────────────────────────────────

export interface KeetaOrderInfo {
  baseOrder?: {
    orderViewId?: number | string;
    chooseTableware?: number;
    deliveryTime?: number;
    ctime?: number;
    estimatedDiningReadyUrgeTime?: number;
    payType?: string;
    payTypeDesc?: string;
  };
  merchantOrder?: {
    ctime?: number;
    seqNoStr?: string;
    status?: number;
    orderViewId?: number | string;
    shopId?: number | string;
    shopName?: string;
    userId?: number | string;
    userGetMode?: "delivery" | "pickup" | string;
    estimatedDiningReadyUrgeTime?: number;
  };
  merchantOrderDeliveries?: Array<{
    deliveryMode?: string;
    deliveryStatus?: number;
    courierName?: string;
    courierPhone?: string;
    courierPrivacyPhone?: string;
  }>;
  orderPromotionDtlList?: Array<{
    type?: number;
    typeName?: string;
    reduceFee?: number;
    merchantActivityFee?: number;
    platformActivityFee?: number;
    activityId?: string;
  }>;
  recipientInfo?: {
    name?: string;
    phone?: string;
    interCode?: string;
    addressName?: string;
    houseNumber?: string;
    point?: { latitude?: number; longitude?: number };
    addressStruct?: string;
    detailAddressStruct?: string;
  };
  feeDtl?: {
    merchantFee?: Record<string, number | undefined> | null;
    customerFee?: {
      i18n?: { currency?: string };
      productPrice?: number;
      shippingFee?: number;
      platformFee?: number;
      discounts?: number;
      tip?: number;
      diffPrice?: number;
      payTotal?: number;
    } | null;
  };
  products?: KeetaProduct[];
  bigOrderTag?: boolean;
  subOrderInfoList?: Array<{ products?: KeetaProduct[] }>;
}

export interface KeetaProduct {
  spuId?: number | string;
  skuId?: number | string;
  count?: number;
  price?: number;
  priceStr?: string;
  originPrice?: number;
  name?: string;
  nameI18n?: Record<string, string>;
  currency?: string;
  groups?: KeetaProductGroup[];
  remark?: string;
  spec?: string;
  specI18n?: Record<string, string>;
  spuOpenItemCode?: string;
  skuOpenItemCode?: string;
  priceWithGroup?: { amount?: number; unitPrice?: number };
  priceWithoutGroup?: { amount?: number; unitPrice?: number };
}

export interface KeetaProductGroup {
  groupId?: number | string;
  groupName?: string;
  groupOpenItemCode?: string;
  shopProductGroupSkuList?: Array<{
    groupSkuId?: number | string;
    spuName?: string;
    spuNameI18n?: Record<string, string>;
    price?: number;
    currency?: string;
    count?: number;
    groupSkuCount?: number;
    groupSkuOpenItemCode?: string;
    groups?: KeetaProductGroup[];
  }>;
}

/** Plain-text customer details, where decryption was allowed. */
export interface KeetaDecrypted {
  get(cipherOrPlain: string | undefined | null): string | undefined;
}

/** Keeta's delivery modes. Strings, not numbers — "9001", not 9001. */
export const KEETA_DELIVERY_MODE = {
  KEETA: "1001",
  DRONE: "1098",
  SELF: "9001",
} as const;

// ── helpers ─────────────────────────────────────────────────────────────────

/** Minor units → major, by the currency's own exponent. */
export function keetaMoney(minor: number | string | null | undefined, currency: string): number {
  const n = Number(minor ?? 0);
  if (!Number.isFinite(n)) return 0;
  const dp = currencyDecimals(currency);
  const f = 10 ** dp;
  return Math.round(n) / f;
}

/** English first, then whatever Keeta gave as the default. */
function i18n(map: Record<string, string> | undefined, fallback: string | undefined): string {
  const m = map ?? {};
  const pick = m.en || m.default || fallback || m.ar || m["zh-HK"] || "";
  return String(pick).trim();
}

const isEncrypted = (s: unknown) => typeof s === "string" && s.startsWith("ENC_");

/** A value, decrypted if we could, dropped if it is still ciphertext. */
function plain(raw: string | undefined | null, dec?: KeetaDecrypted): string | undefined {
  if (raw == null || raw === "") return undefined;
  const v = isEncrypted(raw) ? dec?.get(raw) : raw;
  if (v == null || v === "" || isEncrypted(v)) return undefined;
  return String(v).trim() || undefined;
}

/** Every product on the order, whether or not Keeta split it for delivery. */
export function keetaProducts(info: KeetaOrderInfo): KeetaProduct[] {
  const top = info.products ?? [];
  if (top.length) return top;
  // A "large order" is split into sub-orders for delivery. The top-level list
  // should still hold every product; if it arrives empty, the sub-orders are
  // the only record of what was bought.
  return (info.subOrderInfoList ?? []).flatMap((s) => s.products ?? []);
}

/**
 * Flatten Keeta's option tree into our modifier list.
 *
 * Options can carry their own groups (Keeta's "second-layer" add-ons), so the
 * walk recurses and records depth — the kitchen ticket indents by it.
 * `count` is per ONE of the parent item; groupSkuCount is already multiplied
 * by the item quantity, and our modifiers are per unit, so count is used.
 */
export function flattenKeetaGroups(
  groups: KeetaProductGroup[] | undefined,
  currency: string,
  depth = 0,
): Array<{ name: string; price: number; quantity: number; depth: number }> {
  const out: Array<{ name: string; price: number; quantity: number; depth: number }> = [];
  for (const g of groups ?? []) {
    for (const o of g.shopProductGroupSkuList ?? []) {
      out.push({
        name: i18n(o.spuNameI18n, o.spuName) || String(o.groupSkuOpenItemCode ?? o.groupSkuId ?? "?"),
        price: keetaMoney(o.price, o.currency || currency),
        quantity: Math.max(1, Number(o.count ?? 1)),
        depth,
      });
      if (o.groups?.length) out.push(...flattenKeetaGroups(o.groups, currency, depth + 1));
    }
  }
  return out;
}

/** Keeta's address blocks are JSON STRINGS; parse leniently. */
function parseStruct(raw: string | undefined): Record<string, unknown> {
  if (!raw || isEncrypted(raw)) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface KeetaTransformContext {
  country?: string;
  /** The shop's currency, used only if the order names none. */
  currency?: string;
  /** Our brand for the connection the order came through. */
  brandId?: string;
  decrypted?: KeetaDecrypted;
}

export function transformKeetaOrder(info: KeetaOrderInfo, ctx: KeetaTransformContext = {}): CanonicalOrder {
  const mo = info.merchantOrder ?? {};
  const bo = info.baseOrder ?? {};
  const orderViewId = keetaId(mo.orderViewId ?? bo.orderViewId);
  if (!orderViewId) throw new Error("Keeta order has no orderViewId");

  const products = keetaProducts(info);
  // The fee block names its currency (i18n.currency); products carry it too.
  // One of them is always present in a real order; AED is the last resort.
  const currency = String(
    info.feeDtl?.customerFee?.i18n?.currency ??
      products.find((p) => p.currency)?.currency ??
      ctx.currency ??
      "AED",
  ).toUpperCase();
  const money = (v: number | undefined | null) => keetaMoney(v, currency);

  const delivery = (info.merchantOrderDeliveries ?? [])[0];
  const pickup = String(mo.userGetMode ?? "").toLowerCase() === "pickup";
  const selfDelivery = !pickup && String(delivery?.deliveryMode ?? "") === KEETA_DELIVERY_MODE.SELF;

  const items: OrderItem[] = products.map((p) => {
    const quantity = Math.max(1, Number(p.count ?? 1));
    const baseName = i18n(p.nameI18n, p.name) || String(p.spuOpenItemCode ?? p.spuId ?? "Item");
    const spec = i18n(p.specI18n, p.spec);
    const modifiers = flattenKeetaGroups(p.groups, p.currency || currency);
    // priceWithGroup is the line INCLUDING its options, after discounts —
    // the number that matches what the customer was charged for it. Older
    // or thinner payloads may carry only `price`, documented as the SKU's
    // discounted price; scaled by quantity if it looks per-unit.
    const lineTotal =
      p.priceWithGroup?.amount != null
        ? money(p.priceWithGroup.amount)
        : money(Number(p.price ?? 0) * quantity);
    const unit =
      p.priceWithoutGroup?.unitPrice != null
        ? money(p.priceWithoutGroup.unitPrice)
        : money(p.price);
    return {
      name: spec && !baseName.toLowerCase().includes(spec.toLowerCase()) ? `${baseName} (${spec})` : baseName,
      quantity,
      unitPrice: Math.max(0, unit),
      totalPrice: Math.max(0, lineTotal),
      modifiers,
      ...(p.remark?.trim() ? { notes: p.remark.trim() } : {}),
      // Our own code, published as openItemCode — how a KDS rule or a report
      // gets back to the MenuItem. The SPU code is the item; the SKU code may
      // carry a size suffix.
      ...(p.skuOpenItemCode || p.spuOpenItemCode
        ? { sku: String(p.skuOpenItemCode || p.spuOpenItemCode) }
        : {}),
      ...(p.spuOpenItemCode ? { externalId: String(p.spuOpenItemCode) } : {}),
    };
  });

  const fee = info.feeDtl?.customerFee ?? {};
  const productPrice = money(fee.productPrice);
  const deliveryFee = money(fee.shippingFee);
  const platformFee = money(fee.platformFee);
  const smallOrderFee = money(fee.diffPrice);
  const discount = money(fee.discounts);
  const courierTip = money(fee.tip);
  const payTotal = money(fee.payTotal);

  // Keeta's own total is authoritative. The rider's tip is inside it and is
  // not ours, so it comes off; everything else stays exactly as they charged.
  const total = Math.max(0, round(payTotal - courierTip, currency));
  // Service-type fees the customer paid on top of goods and delivery.
  const serviceCharge = round(platformFee + smallOrderFee, currency);

  const r = info.recipientInfo ?? {};
  const name = plain(r.name, ctx.decrypted);
  const rawPhone = plain(r.phone, ctx.decrypted);
  const inter = String(r.interCode ?? "").trim();
  const phone =
    rawPhone && inter && !rawPhone.startsWith("+") && !rawPhone.startsWith(inter.replace("+", ""))
      ? `${inter}${rawPhone}`
      : rawPhone;

  const struct = parseStruct(plain(r.addressStruct, ctx.decrypted));
  const detail = parseStruct(plain(r.detailAddressStruct, ctx.decrypted));
  const lat = Number(r.point?.latitude);
  const lng = Number(r.point?.longitude);
  const houseNumber = plain(r.houseNumber, ctx.decrypted);
  const addressName = plain(r.addressName, ctx.decrypted) ?? (struct.address as string | undefined);
  const city = String(struct.city ?? struct.district ?? "").trim();

  const notes: string[] = [];
  if (Number(bo.chooseTableware) === 1) notes.push("Cutlery requested");
  const directions = String((detail as any).additionalDirection ?? "").trim();
  if (selfDelivery && directions) notes.push(`Directions: ${directions}`);

  const payType = String(bo.payType ?? "").trim();
  const cash = payType.toLowerCase() === "cash";

  const seq = String(mo.seqNoStr ?? "").trim();
  const courierName = String(delivery?.courierName ?? "").trim();
  const courierPhone = String(delivery?.courierPrivacyPhone || delivery?.courierPhone || "").trim();

  const canonical = CanonicalOrderSchema.parse({
    externalId: orderViewId,
    platform: "KEETA",
    orderSource: "KEETA",
    integrationSource: "DIRECT",
    viaHubrise: false,
    fulfillmentType: pickup ? "PICKUP" : selfDelivery ? "DELIVERY" : "PLATFORM_COURIER",
    // Keeta's seqNoStr is what the customer sees in their app — the number a
    // rider or customer will quote at the counter.
    displayId: `KT-${seq || orderViewId.slice(-5)}`,
    customerInfo: {
      name: name || "Keeta customer",
      ...(phone ? { phone } : {}),
    },
    ...(selfDelivery && (addressName || houseNumber)
      ? {
          deliveryAddress: {
            line1: [houseNumber, (detail as any).aptNumber, (detail as any).building]
              .map((s) => String(s ?? "").trim())
              .filter(Boolean)
              .join(", ") || addressName || "",
            ...(addressName ? { line2: addressName } : {}),
            city,
            ...(struct.area || struct.district ? { area: String(struct.area ?? struct.district) } : {}),
            country: ctx.country ?? "AE",
            ...(Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)
              ? { coordinates: { lat, lng } }
              : {}),
          },
        }
      : {}),
    items,
    subtotal: Math.max(0, productPrice),
    // Keeta prices are what the customer pays — VAT is inside them, not added.
    taxAmount: 0,
    deliveryFee: Math.max(0, deliveryFee),
    ...(serviceCharge > 0 ? { serviceCharge } : {}),
    discount: Math.max(0, discount),
    total,
    ...(notes.length ? { specialInstructions: notes.join(" · ") } : {}),
    metadata: {
      keetaOrderViewId: orderViewId,
      keetaShopId: keetaId(mo.shopId),
      keetaShopName: mo.shopName ?? null,
      keetaSeqNo: seq || null,
      keetaStatus: mo.status ?? null,
      keetaUserGetMode: mo.userGetMode ?? null,
      keetaDeliveryMode: delivery?.deliveryMode ?? null,
      // OUR vocabulary. PLATFORM hands the post-READY chain to Keeta's rider;
      // MERCHANT walks staff through to delivered. Pickup is neither.
      ...(pickup ? {} : { deliveryType: selfDelivery ? "MERCHANT" : "PLATFORM" }),
      paymentMethod: cash ? "CASH" : "CARD",
      // Card/wallet orders are paid to Keeta before we ever see them. Cash is
      // collected at the door — by Keeta's rider or, for self-delivery, ours.
      paymentStatus: cash ? "PENDING" : "PAID",
      keetaPayType: payType || null,
      keetaPayTypeDesc: bo.payTypeDesc ?? null,
      currency,
      courierTip,
      keetaPlatformFee: platformFee,
      keetaSmallOrderFee: smallOrderFee,
      keetaPayTotal: payTotal,
      keetaPromotions: (info.orderPromotionDtlList ?? []).map((p) => ({
        type: p.type ?? null,
        name: p.typeName ?? null,
        amount: money(p.reduceFee),
        merchantFunded: money(p.merchantActivityFee),
        keetaFunded: money(p.platformActivityFee),
      })),
      // Settlement can arrive late or incomplete ("must not be a hard
      // dependency"); recorded as-is and re-read later, never relied on here.
      keetaMerchantFee: info.feeDtl?.merchantFee ?? null,
      keetaBigOrder: !!info.bigOrderTag,
      keetaCutlery: Number(bo.chooseTableware ?? 0) === 1,
      keetaEta: bo.deliveryTime ? new Date(Number(bo.deliveryTime)).toISOString() : null,
      keetaReadyBy:
        mo.estimatedDiningReadyUrgeTime || bo.estimatedDiningReadyUrgeTime
          ? new Date(Number(mo.estimatedDiningReadyUrgeTime ?? bo.estimatedDiningReadyUrgeTime)).toISOString()
          : null,
      keetaRaw: info,
    },
  });

  // Fields ingestCanonical reads off the canonical object itself.
  const extra = canonical as CanonicalOrder & Record<string, unknown>;
  if (ctx.brandId) extra.brandId = ctx.brandId;
  if (courierName) extra.courierName = courierName;
  if (courierPhone) extra.courierPhone = courierPhone;
  return extra;
}

function round(n: number, currency: string): number {
  const f = 10 ** currencyDecimals(currency);
  return Math.round(n * f) / f;
}
