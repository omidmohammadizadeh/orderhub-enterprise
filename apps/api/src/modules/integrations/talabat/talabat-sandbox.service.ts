import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { SANDBOX_PLUGIN_SECRET, apiOrigin } from "./talabat-client.service";
import { signTalabatJwt } from "./talabat-jwt";
import { ADDONS_CATEGORY_ID } from "./talabat-menu.transformer";
import { TALABAT_AFTER_ACCEPT_REASONS, TALABAT_REJECT_REASONS, type TalabatOrder } from "./talabat-types";

// Phase TB-7 — Delivery Hero's middleware, played by us.
//
// Talabat won't issue credentials until the contract is countersigned, and
// staging access only comes after that. This lets the whole integration be
// driven end to end before then: our client logs in to it, publishes
// catalogs to it, accepts/rejects/marks-ready against it — and it calls our
// real plugin endpoints back, with a signed JWT, exactly as theirs would.
//
// It enforces the rules their spec STATES, so a passing run means something:
//
//   • accept: acceptanceTime a valid date-time ≥ 2 min ahead; remoteOrderId
//     present; not after a reject; 409 with currentState when out of order
//   • reject: reason from their enum; after acceptance only the "after
//     acceptance" reasons
//   • prepared: own-delivery orders only, not when cancelled
//   • picked up: vendor-delivery and pickup orders only
//   • prep time: within the order's min/max window, not after the vendor
//     accepted AND the rider accepted
//   • modification: after acceptance, one at a time, result sent back to our
//     plugin as PRODUCT_ORDER_MODIFICATION_SUCCESSFUL with the updated order
//   • catalog: their validation rules (category exists, every product in a
//     category, references resolve, Talabat's two-topping-level rule, https
//     images), then a signed callback with done / failed
//   • availability: platformKey + platformRestaurantId must match, closes need
//     a reason, closingMinutes only with CLOSED_UNTIL
//
// Off unless TALABAT_SANDBOX=true, and refused when TALABAT_ENV=production.
// In memory: a restart is a reset.

export interface SandboxOrder {
  order: TalabatOrder;
  remoteId: string;
  chainCode: string;
  remoteOrderId: string | null;
  state: "RECEIVED" | "ACCEPTED" | "REJECTED" | "CANCELLED" | "PREPARED" | "PICKED_UP";
  riderAccepted: boolean;
  modificationPending: boolean;
  history: Array<{ at: string; event: string; detail?: unknown }>;
}

export interface SandboxCall {
  at: string;
  method: string;
  path: string;
  status: number;
  note: string;
  body?: unknown;
}

const PLATFORM_KEY = "TB";

@Injectable()
export class TalabatSandboxService {
  private readonly logger = new Logger(TalabatSandboxService.name);
  readonly orders = new Map<string, SandboxOrder>();
  readonly catalogs: Array<{ id: string; chainCode: string; vendors: string[]; status: string; at: string; errors: string[]; productCount: number }> = [];
  readonly availability = new Map<string, { state: string; closedReason: string | null; closedUntil: string | null; changeable: boolean }>();
  readonly itemAvailability: Array<{ at: string; vendor: string; type: string; items: string[]; isAvailable: boolean; until?: string }> = [];
  private readonly calls: SandboxCall[] = [];

  get enabled(): boolean {
    return process.env.TALABAT_SANDBOX === "true" && process.env.TALABAT_ENV !== "production";
  }

  get base(): string {
    return `${apiOrigin()}/api/v1/talabat-sandbox/middleware`;
  }

  record(call: Omit<SandboxCall, "at">) {
    this.calls.unshift({ ...call, at: new Date().toISOString() });
    if (this.calls.length > 200) this.calls.length = 200;
  }

  recent(limit = 50) {
    return this.calls.slice(0, limit);
  }

  reset() {
    this.orders.clear();
    this.catalogs.length = 0;
    this.availability.clear();
    this.itemAvailability.length = 0;
    this.calls.length = 0;
  }

  /** A JWT our plugin will accept, signed the way the middleware signs. */
  jwt(): string {
    const secret = process.env.TALABAT_PLUGIN_SECRET?.trim() || SANDBOX_PLUGIN_SECRET;
    return signTalabatJwt({ service: "middleware", iat: Math.floor(Date.now() / 1000) }, secret);
  }

  /** Call one of OUR plugin endpoints, as the middleware would. */
  async callPlugin(method: "POST" | "PUT" | "GET", path: string, body?: unknown) {
    const res = await fetch(`${apiOrigin()}/api/v1/talabat-plugin${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.jwt()}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* raw */
    }
    return { status: res.status, data };
  }

  // ── order builder ──────────────────────────────────────────────────────

  /**
   * A dispatch payload built from a catalog we published — the remoteCodes are
   * real catalog ids, and toppings are picked to satisfy each group's minimum,
   * so what our transformer receives is what Talabat would send for a real
   * basket. Its callbackUrls point at this sandbox.
   */
  buildOrder(args: {
    catalog: { items: Record<string, any> };
    remoteId: string;
    chainCode: string;
    platformVendorId: string;
    kind: "OWN_DELIVERY" | "VENDOR_DELIVERY" | "PICKUP";
    test?: boolean;
    withDiscount?: boolean;
    itemCount?: number;
  }): TalabatOrder {
    const items = args.catalog.items;
    const menu = Object.values(items).find((i: any) => i.type === "Menu") as any;
    const productIds = Object.keys(menu?.products ?? {}).filter((id) => items[id]?.active !== false);
    const categoryOf = (pid: string) =>
      (Object.values(items).find((i: any) => i.type === "Category" && i.id !== ADDONS_CATEGORY_ID && i.products?.[pid]) as any)
        ?.title?.default ?? "";
    // Prefer products with toppings, so the order exercises the nesting.
    productIds.sort((a, b) => Number(!!items[b]?.toppings) - Number(!!items[a]?.toppings));
    const chosen = productIds.slice(0, Math.max(1, Math.min(5, args.itemCount ?? 2)));

    const pickToppings = (owner: any, depth: number): any[] => {
      const out: any[] = [];
      for (const ref of Object.values(owner?.toppings ?? {}) as any[]) {
        const t = items[ref.id];
        if (!t) continue;
        const need = Math.max(t.quantity?.minimum ?? 0, depth === 0 ? 1 : 0);
        const options = Object.values(t.products ?? {}) as any[];
        for (const o of options.slice(0, Math.min(need, options.length))) {
          const p = items[o.id];
          out.push({
            id: `plat-${o.id}`,
            name: p?.title?.default ?? o.id,
            price: String(o.price ?? p?.price ?? "0.00"),
            quantity: 1,
            remoteCode: o.id,
            type: String(ref.id).endsWith("__size") ? "VARIANT" : "PRODUCT",
            itemUnavailabilityHandling: "REMOVE",
            discounts: [],
            children: depth === 0 ? pickToppings(p, 1) : [],
          });
        }
      }
      return out;
    };

    const round2 = (n: number) => Math.round(n * 100) / 100;
    let lines = 0;
    const products = chosen.map((pid, i) => {
      const p = items[pid];
      const toppings = pickToppings(p, 0);
      const sumToppings = (ts: any[]): number => ts.reduce((a, t) => a + Number(t.price) + sumToppings(t.children ?? []), 0);
      const qty = i === 0 ? 2 : 1;
      const unit = Number(p.price) + sumToppings(toppings);
      const paid = round2(unit * qty);
      lines += paid;
      return {
        id: `plat-${pid}`,
        categoryName: categoryOf(pid),
        name: p.title?.default ?? pid,
        paidPrice: paid.toFixed(2),
        quantity: String(qty),
        remoteCode: pid,
        selectedToppings: toppings,
        unitPrice: Number(p.price).toFixed(2),
        comment: i === 0 ? "No onions please" : null,
        itemUnavailabilityHandling: i === 0 ? "REDUCE_QUANTITY" : "REMOVE",
        discounts: [] as any[],
      };
    });

    const discounts: any[] = [];
    if (args.withDiscount && products.length) {
      const amount = round2(Math.min(lines * 0.2, Number(products[0]!.paidPrice)));
      const half = round2(amount / 2);
      discounts.push({
        name: "20% off (sandbox)",
        amount: amount.toFixed(2),
        type: "PERCENTAGE",
        sponsorships: [
          { sponsor: "PLATFORM", amount: half.toFixed(2) },
          { sponsor: "VENDOR", amount: round2(amount - half).toFixed(2) },
        ],
      });
      products[0]!.discounts = [{ ...discounts[0] }];
    }
    const discountTotal = discounts.reduce((a, d) => a + Number(d.amount), 0);
    const deliveryFee = args.kind === "PICKUP" ? 0 : 7;
    const grand = round2(lines - discountTotal + deliveryFee);
    const now = Date.now();
    const token = randomUUID();
    const iso = (ms: number) => new Date(ms).toISOString();
    const cb = (path: string) => `${this.base}${path}`;

    return {
      token,
      code: `tb-${token.slice(0, 8)}`,
      shortCode: String(10 + Math.floor(Math.random() * 89)),
      comments: { customerComment: "Sandbox order — please ring the bell", vendorComment: "" },
      createdAt: iso(now),
      expiryDate: iso(now + 10 * 60_000),
      customer: { firstName: "Sandbox", lastName: "Customer", mobilePhone: "+971500000000", id: "cust-sandbox" },
      delivery:
        args.kind === "PICKUP"
          ? null
          : {
              address:
                args.kind === "VENDOR_DELIVERY"
                  ? {
                      street: "Sheikh Mohammed bin Rashid Blvd",
                      number: "1",
                      building: "Burj Vista",
                      flatNumber: "1204",
                      floor: "12",
                      city: "Dubai",
                      deliveryArea: "Downtown Dubai",
                      deliveryInstructions: "Leave with concierge",
                      latitude: 25.1949,
                      longitude: 55.2783,
                    }
                  : null,
              expectedDeliveryTime: iso(now + 45 * 60_000),
              expressDelivery: false,
              riderPickupTime: args.kind === "OWN_DELIVERY" ? iso(now + 20 * 60_000) : null,
            },
      discounts,
      expeditionType: args.kind === "PICKUP" ? "pickup" : "delivery",
      localInfo: { countryCode: "AE", currencySymbol: "AED", platform: "Talabat", platformKey: PLATFORM_KEY },
      payment: { status: "paid", type: "online" },
      test: !!args.test,
      preOrder: false,
      pickup: args.kind === "PICKUP" ? { pickupCode: "4321", pickupTime: iso(now + 20 * 60_000) } : null,
      platformRestaurant: { id: args.platformVendorId },
      price: {
        deliveryFees: deliveryFee ? [{ name: "DeliveryFee", value: deliveryFee }] : [],
        deliveryFee: deliveryFee.toFixed(2),
        grandTotal: grand.toFixed(2),
        totalNet: grand.toFixed(2),
        vatTotal: round2((grand * 5) / 105).toFixed(2),
        payRestaurant: "0",
        collectFromCustomer: "0",
        riderTip: "0",
        discountAmountTotal: discountTotal.toFixed(2),
      },
      products,
      corporateTaxId: "",
      preparationTimeAdjustmentInformation:
        args.kind === "OWN_DELIVERY"
          ? {
              minPickUpTimestamp: iso(now + 10 * 60_000),
              maxPickUpTimestamp: iso(now + 50 * 60_000),
              preparationTimeChangeIntervalsInMinutes: [-5, 5, 10, 15],
            }
          : null,
      callbackUrls: {
        orderAcceptedUrl: cb(`/v2/order/status/${token}`),
        orderRejectedUrl: cb(`/v2/order/status/${token}`),
        orderPickedUpUrl: args.kind === "OWN_DELIVERY" ? null : cb(`/v2/order/status/${token}`),
        orderPreparedUrl: args.kind === "OWN_DELIVERY" ? cb(`/v2/orders/${token}/preparation-completed`) : null,
        orderProductModificationUrl: cb(`/v2/order/${token}/modifications/product`),
        orderPreparationTimeAdjustmentUrl:
          args.kind === "OWN_DELIVERY" ? cb(`/v2/orders/${token}/adjust-preparation-time`) : null,
      },
    } as TalabatOrder;
  }

  // ── the middleware's rules ─────────────────────────────────────────────

  /** POST /v2/order/status/{token} — accept / reject / picked up. */
  orderStatus(token: string, body: any): { status: number; body: unknown } {
    const o = this.orders.get(token);
    if (!o) return { status: 400, body: { code: "ORDER_NOT_FOUND", message: `No order ${token}` } };
    const kind = o.order.expeditionType === "pickup" ? "PICKUP" : o.order.delivery?.riderPickupTime ? "OWN_DELIVERY" : "VENDOR_DELIVERY";
    const status = String(body?.status ?? "");
    const at = new Date().toISOString();

    if (status === "order_accepted") {
      if (o.state === "CANCELLED" || o.state === "REJECTED") {
        return { status: 409, body: { code: "INVALID_REQUEST", message: "Order is no longer acceptable", currentState: "CANCELLED" } };
      }
      if (o.state !== "RECEIVED") return { status: 400, body: { code: "INVALID_ORDER_STATUS", message: `Order is ${o.state}` } };
      const t = Date.parse(String(body?.acceptanceTime ?? ""));
      if (!Number.isFinite(t) || !/T\d{2}:\d{2}/.test(String(body?.acceptanceTime))) {
        return { status: 400, body: { code: "INVALID_REQUEST", message: "acceptanceTime must be an RFC 3339 date-time" } };
      }
      if (t < Date.now() + 2 * 60_000) {
        return { status: 400, body: { code: "INVALID_REQUEST", message: "acceptanceTime must be at least 2 minutes in the future" } };
      }
      if (!body?.remoteOrderId) {
        return { status: 400, body: { code: "INVALID_REQUEST", message: "remoteOrderId is mandatory for direct integrations" } };
      }
      o.state = "ACCEPTED";
      o.remoteOrderId = String(body.remoteOrderId);
      o.history.push({ at, event: "accepted", detail: { acceptanceTime: body.acceptanceTime } });
      return { status: 200, body: { message: "Order status successfully changed." } };
    }

    if (status === "order_rejected") {
      const reason = String(body?.reason ?? "");
      if (!(TALABAT_REJECT_REASONS as readonly string[]).includes(reason)) {
        return { status: 400, body: { code: "INVALID_REQUEST", message: `"${reason}" is not a valid reject reason` } };
      }
      if (o.state === "CANCELLED" || o.state === "REJECTED") {
        return { status: 400, body: { code: "INVALID_ORDER_STATUS", message: `Order is already ${o.state}` } };
      }
      if (o.state !== "RECEIVED" && !TALABAT_AFTER_ACCEPT_REASONS.has(reason)) {
        return { status: 400, body: { code: "INVALID_REQUEST", message: `${reason} is only applicable before acceptance` } };
      }
      o.state = "REJECTED";
      o.history.push({ at, event: "rejected", detail: { reason, message: body?.message } });
      return { status: 200, body: { message: "Order status successfully changed." } };
    }

    if (status === "order_picked_up") {
      if (kind === "OWN_DELIVERY") {
        return { status: 400, body: { code: "INVALID_REQUEST", message: "order_picked_up is only for vendor delivery and pickup orders" } };
      }
      if (o.state !== "ACCEPTED" && o.state !== "PREPARED") {
        return { status: 409, body: { code: "INVALID_REQUEST", message: `Order is ${o.state}`, currentState: o.state } };
      }
      o.state = "PICKED_UP";
      o.history.push({ at, event: "picked_up" });
      return { status: 200, body: { message: "Order status successfully changed." } };
    }
    return { status: 400, body: { code: "INVALID_REQUEST", message: `Unknown status "${status}"` } };
  }

  /** POST /v2/orders/{token}/preparation-completed */
  prepared(token: string): { status: number; body: unknown } {
    const o = this.orders.get(token);
    if (!o) return { status: 404, body: { code: "NOT_FOUND" } };
    if (!o.order.delivery?.riderPickupTime) {
      return { status: 409, body: { code: "INVALID_ORDER_STATUS", message: "Only for orders delivered by Talabat riders" } };
    }
    if (o.state !== "ACCEPTED") return { status: 409, body: { code: "INVALID_ORDER_STATUS", message: `Order is ${o.state}` } };
    o.state = "PREPARED";
    o.history.push({ at: new Date().toISOString(), event: "prepared" });
    return { status: 200, body: { code: "OK" } };
  }

  /** POST /v2/orders/{token}/adjust-preparation-time */
  adjustPrep(token: string, body: any): { status: number; body: unknown } {
    const o = this.orders.get(token);
    if (!o) return { status: 404, body: { code: "NOT_FOUND", message: "Order Not Found" } };
    // Their table: vendor accepted AND rider accepted = no adjustments.
    // "Vendor accepted" includes every state after it (prepared, picked up).
    const vendorAccepted = ["ACCEPTED", "PREPARED", "PICKED_UP"].includes(o.state);
    if (vendorAccepted && o.riderAccepted) {
      return { status: 409, body: { code: "conflict-error", message: "The current order state does not allow preparation time adjustment." } };
    }
    const t = Date.parse(String(body?.expectedPickupAt ?? ""));
    const info = o.order.preparationTimeAdjustmentInformation ?? {};
    const min = Date.parse(String(info.minPickUpTimestamp ?? info.minPickupTimestamp ?? ""));
    const max = Date.parse(String(info.maxPickUpTimestamp ?? ""));
    if (!Number.isFinite(t)) return { status: 400, body: { code: "PREPARATION_TIME_BELOW_ALLOWED_MIN_TIME", message: "expectedPickupAt is not a date-time" } };
    if (Number.isFinite(min) && t < min) return { status: 400, body: { code: "PREPARATION_TIME_BELOW_ALLOWED_MIN_TIME", message: "Too soon" } };
    if (Number.isFinite(max) && t > max) return { status: 400, body: { code: "PREPARATION_TIME_EXCEEDS_ALLOWED_MAX_TIME", message: "Too late" } };
    o.history.push({ at: new Date().toISOString(), event: "prep_time", detail: { expectedPickupAt: body.expectedPickupAt } });
    return { status: 204, body: null };
  }

  /** POST /v2/order/{token}/modifications/product */
  modify(token: string, body: any): { status: number; body: unknown; then?: () => Promise<void> } {
    const o = this.orders.get(token);
    if (!o) return { status: 404, body: { code: "NOT_FOUND", message: "POS order not found" } };
    if (o.state !== "ACCEPTED" && o.state !== "PREPARED") {
      return { status: 409, body: { code: "INVALID_REQUEST", message: "Order is not in a state allowed for product modification" } };
    }
    if (o.modificationPending) return { status: 409, body: { code: "INVALID_REQUEST", message: "Another modification request is ongoing" } };
    const changes: any[] = body?.modifications?.products ?? [];
    if (!changes.length) return { status: 400, body: { code: "INVALID_REQUEST", message: "PRODUCTS_MUST_BE_SET_FOR_MODIFICATION" } };
    o.modificationPending = true;
    const then = async () => {
      const products = [...(o.order.products ?? [])];
      let failed: string | null = null;
      for (const c of changes) {
        const i = products.findIndex((p) => p.id === c.id);
        if (i < 0) {
          failed = "UNKNOWN_PRODUCT_ID";
          break;
        }
        if (c.modification?.type === "REMOVAL") products.splice(i, 1);
        else if (c.modification?.type === "CHANGE") {
          const q = Number(c.quantity);
          if (!(q > 0)) {
            failed = "QUANTITY_CANNOT_BE_ZERO";
            break;
          }
          const p = products[i]!;
          const unit = Number(p.paidPrice) / Number(p.quantity);
          products[i] = { ...p, quantity: String(q), paidPrice: (unit * q).toFixed(2) };
        }
      }
      o.modificationPending = false;
      if (failed || !products.length) {
        await this.callPlugin("PUT", `/remoteId/${o.remoteId}/remoteOrder/${o.remoteOrderId}/posOrderStatus`, {
          status: "PRODUCT_ORDER_MODIFICATION_FAILED",
          message: failed ?? "PARTIAL_REMOVAL_NOT_ALLOWED",
        });
        return;
      }
      const lines = products.reduce((a, p) => a + Number(p.paidPrice), 0);
      const fee = Number(o.order.price?.deliveryFee ?? 0);
      const disc = (o.order.discounts ?? []).reduce((a, d) => a + Number(d.amount), 0);
      o.order = {
        ...o.order,
        products,
        price: { ...o.order.price, grandTotal: Math.max(0, lines - disc + fee).toFixed(2) },
      };
      o.history.push({ at: new Date().toISOString(), event: "modified", detail: changes });
      await this.callPlugin("PUT", `/remoteId/${o.remoteId}/remoteOrder/${o.remoteOrderId}/posOrderStatus`, {
        status: "PRODUCT_ORDER_MODIFICATION_SUCCESSFUL",
        message: "ok",
        updatedOrder: o.order,
      });
    };
    return { status: 202, body: { message: "Order modification request has been accepted." }, then };
  }

  /** PUT /v2/chains/{chain}/catalog — their validation rules, then a callback. */
  validateCatalog(body: any): string[] {
    const errors: string[] = [];
    const items: Record<string, any> = body?.catalog?.items ?? {};
    if (!Array.isArray(body?.vendors) || !body.vendors.length) errors.push("vendors must list at least one POS vendor id");
    const all = Object.values(items);
    const categories = all.filter((i) => i.type === "Category");
    if (!categories.length) errors.push("A catalog must contain at least one Category");
    const inCategory = new Set(categories.flatMap((c) => Object.keys(c.products ?? {})));
    for (const [id, it] of Object.entries(items)) {
      if (it.id !== id) errors.push(`Item key ${id} does not match its id ${it.id}`);
      if (it.type === "Product") {
        if (!it.title?.default) errors.push(`Product ${id} has no title`);
        if (it.price != null && !/^\d+(\.\d{1,2})?$/.test(String(it.price))) errors.push(`Product ${id} price "${it.price}" is not a decimal string`);
        if (!inCategory.has(id) && !it.parent) errors.push(`Product ${id} does not belong to a category`);
        for (const img of Object.keys(it.images ?? {})) {
          const url = items[img]?.url;
          if (!url) errors.push(`Product ${id} references missing image ${img}`);
          else if (!/^https:\/\//.test(url)) errors.push(`Image ${img} is not https`);
        }
      }
      for (const field of ["products", "toppings", "schedule", "variants"]) {
        for (const ref of Object.values((it as any)[field] ?? {}) as any[]) {
          if (!items[ref.id]) errors.push(`${id}.${field} references missing ${ref.id}`);
        }
      }
      if (it.type === "Topping") {
        const max = Number(it.quantity?.maximum);
        const min = Number(it.quantity?.minimum ?? 0);
        if (!(max >= 1)) errors.push(`Topping ${id} quantity.maximum is required`);
        if (min > max) errors.push(`Topping ${id} minimum exceeds maximum`);
      }
    }
    // Talabat: at most two topping levels; a first level that opens a second
    // must be mutually exclusive.
    const menus = all.filter((i) => i.type === "Menu");
    for (const m of menus) {
      for (const pid of Object.keys(m.products ?? {})) {
        for (const t1 of Object.keys(items[pid]?.toppings ?? {})) {
          const top1 = items[t1];
          for (const o1 of Object.keys(top1?.products ?? {})) {
            const second = Object.keys(items[o1]?.toppings ?? {});
            if (!second.length) continue;
            if (!(top1.quantity?.minimum === 1 && top1.quantity?.maximum === 1)) {
              errors.push(`Talabat: ${t1} opens a second topping level but is not mutually exclusive (min 1 / max 1)`);
            }
            for (const t2 of second) {
              for (const o2 of Object.keys(items[t2]?.products ?? {})) {
                if (Object.keys(items[o2]?.toppings ?? {}).length) errors.push(`Talabat: more than two topping levels under ${pid} (${o2})`);
              }
            }
          }
        }
      }
    }
    return [...new Set(errors)].slice(0, 50);
  }

  /** PUT …/availability — their rules for the body. */
  setVendorAvailability(remoteId: string, body: any, platformRestaurantId: string): { status: number; body: unknown } {
    if (body?.platformKey !== PLATFORM_KEY || String(body?.platformRestaurantId) !== platformRestaurantId) {
      return { status: 400, body: { code: "INVALID_REQUEST", message: "platformKey / platformRestaurantId don't match the GET" } };
    }
    const state = String(body?.availabilityState ?? "");
    if (!["OPEN", "CLOSED", "CLOSED_TODAY", "CLOSED_UNTIL"].includes(state)) {
      return { status: 400, body: { code: "INVALID_REQUEST", message: `availabilityState ${state} not allowed` } };
    }
    if (state !== "OPEN" && !body?.closedReason) {
      return { status: 400, body: { code: "INVALID_REQUEST", message: "closedReason is required to close" } };
    }
    if (body?.closingMinutes != null && state !== "CLOSED_UNTIL") {
      return { status: 400, body: { code: "INVALID_REQUEST", message: "closingMinutes only works with CLOSED_UNTIL" } };
    }
    if (state === "CLOSED_UNTIL" && !(Number(body?.closingMinutes) > 0)) {
      return { status: 400, body: { code: "INVALID_REQUEST", message: "CLOSED_UNTIL needs closingMinutes" } };
    }
    const prev = this.availability.get(remoteId);
    if (prev && !prev.changeable) return { status: 400, body: { code: "FORBIDDEN", message: "Not changeable" } };
    this.availability.set(remoteId, {
      state,
      closedReason: state === "OPEN" ? null : String(body.closedReason),
      closedUntil: state === "CLOSED_UNTIL" ? new Date(Date.now() + Number(body.closingMinutes) * 60_000).toISOString() : null,
      changeable: true,
    });
    return { status: 200, body: {} };
  }

  vendorAvailability(remoteId: string, platformRestaurantId: string) {
    const a = this.availability.get(remoteId) ?? { state: "OPEN", closedReason: null, closedUntil: null, changeable: true };
    return [
      {
        availabilityState: a.state,
        changeable: a.changeable,
        closedReason: a.closedReason,
        closedUntil: a.closedUntil,
        platformKey: PLATFORM_KEY,
        platformRestaurantId,
        platformId: "talabat",
        platformType: "TALABAT",
        availabilityStates: ["OPEN", "CLOSED", "CLOSED_UNTIL", "CLOSED_TODAY"],
        closingReasons: ["TOO_BUSY_NO_DRIVERS", "TOO_BUSY_KITCHEN", "UPDATES_IN_MENU", "TECHNICAL_PROBLEM", "CLOSED", "OTHER"],
      },
    ];
  }
}
