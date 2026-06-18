// Phase AS-1 — Print routing engine.
//
// Single pure function: given an order and a trigger, return the list
// of PrintJob templates we should enqueue. The caller (PrintQueue /
// status-change hooks) writes the rows. This file owns NO database
// writes — easier to test, easier to compose, easier to port to the
// Flutter app later (Dart can re-implement the same predicate against
// a local cache).
//
// Routing precedence per kitchen-ticket item (most-specific first):
//
//   1. MenuItemStation       — explicit product override
//   2. ModifierGroupStation  — "Dessert Extras" → label printer, even
//                              when the parent item routes elsewhere
//   3. MenuCategoryStation   — "Pizza" category → Pizza Station
//   4. Brand.defaultStation
//   5. Location.defaultKitchenStation
//   6. null                  — unrouted, surfaces as a warning
//
// On top of kitchen tickets, every order also emits:
//
//   • CUSTOMER_RECEIPT  — to Location.receiptPrinter  (if set)
//   • DRIVER_SLIP       — to Location.dispatchPrinter (if set AND
//                                                     delivery order)

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// ── Result shape ────────────────────────────────────────────────────────
//
// Each resolved target is one PrintJob row. The caller maps these
// straight into prisma.printJob.create().

export interface PrintTarget {
  type:
    | "KITCHEN_TICKET"
    | "CUSTOMER_RECEIPT"
    | "DRIVER_SLIP"
    | "DISPATCH_TICKET"
    | "LABEL"
    | "TEST_PRINT";
  printerId: string | null;
  stationId: string | null;
  copies: number;
  routeKey: string; // "loc:{locationId}|printer:{printerId}|station:{stationId}"
  payload: any;
}

export interface ResolveOptions {
  trigger:
    | "ORDER_RECEIVED"
    | "ORDER_ACCEPTED"
    | "ORDER_PREPARING"
    | "ORDER_READY"
    | "MANUAL_ONLY";
  // If true, returns kitchen targets even when their station has no
  // default printer (target.printerId is null). The caller can show
  // a "this item won't print — assign a printer" warning instead of
  // silently dropping it.
  includeUnrouted?: boolean;
}

interface OrderItemForRouting {
  menuItemId?: string | null;
  categoryId?: string | null;
  name: string;
  quantity: number;
  modifierGroupIds?: string[];
  modifiers?: { name: string; quantity?: number; price?: number }[];
  notes?: string | null;
}

@Injectable()
export class PrintRoutingService {
  private readonly logger = new Logger(PrintRoutingService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Public API ──────────────────────────────────────────────────────

  async resolveForOrder(
    orderId: string,
    opts: ResolveOptions,
  ): Promise<PrintTarget[]> {
    const order = await (this.prisma.order as any).findUnique({
      where: { id: orderId },
      include: {
        items: true,
        location: {
          select: {
            id: true,
            defaultKitchenStationId: true,
            receiptPrinterId: true,
            dispatchPrinterId: true,
            brandId: true,
          },
        },
      },
    });
    if (!order || !order.location) return [];

    // Phase AW — receipts must reflect the BRAND the customer ordered
    // from, not the kitchen's primary brand. When the storefront pinned
    // a virtual brand via ?brand=<id>, Order.brandId is set and wins;
    // otherwise we fall back to the location's primary brand so POS
    // walk-ins and manual orders still get a brand-name header.
    const headerBrandId = order.brandId ?? order.location.brandId;

    // Pull richer header context once so every payload (receipt, kitchen,
    // driver slip) renders the brand banner + shop address consistently.
    // Cheap: one indexed lookup per print, payload size is tiny.
    const [brand, locationFull] = await Promise.all([
      this.prisma.brand.findUnique({
        where: { id: headerBrandId },
        select: {
          name: true,
          logoUrl: true,
          // Phase AW — brand-level customer-facing identity. When the
          // operator filled these in (Brand → Settings → Address /
          // Phone), they take precedence on the receipt so the
          // customer sees the brand's address, not the kitchen's.
          phone: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          postcode: true,
          country: true,
        } as any,
      }) as any,
      this.prisma.location.findUnique({
        where: { id: order.location.id },
        select: { name: true, address: true, phone: true },
      }),
    ]);
    const brandAddressLines = [
      brand?.addressLine1,
      brand?.addressLine2,
      [brand?.city, brand?.postcode].filter(Boolean).join(" "),
    ]
      .map((s) => (s ?? "").trim())
      .filter(Boolean);
    const brandAddress = brandAddressLines.length
      ? brandAddressLines.join(", ")
      : null;
    const header = {
      brandName: brand?.name ?? null,
      brandLogoUrl: brand?.logoUrl ?? null,
      // Brand-name only on the receipt banner. Operators called this
      // out as a hard requirement: ghost-kitchen brands must not leak
      // the kitchen's trading name onto the customer's printout.
      locationName: brand?.name ?? locationFull?.name ?? null,
      locationAddress:
        brandAddress ?? this.formatAddressJson(locationFull?.address),
      locationPhone: brand?.phone ?? locationFull?.phone ?? null,
    };

    const items: OrderItemForRouting[] = (order.items as any[]).map((i) => ({
      menuItemId: i.menuItemId,
      categoryId: null, // resolved per-item below
      name: i.name,
      quantity: i.quantity,
      modifierGroupIds: this.extractModifierGroupIds(i.modifiers),
      modifiers: i.modifiers as any,
      notes: i.notes,
    }));

    // Pull all routing rows in three indexed lookups. Cheaper than
    // walking N items × N joins.
    const [itemRoutes, categoryRoutes, groupRoutes, brandRouting] = await Promise.all([
      this.fetchItemRoutes(items),
      this.fetchCategoryRoutesForItems(items),
      this.fetchModifierGroupRoutes(items),
      this.prisma.brand.findUnique({
        where: { id: headerBrandId },
        select: { defaultStationId: true },
      }),
    ]);

    // ── Bucket items by resolved station ─────────────────────────────
    type Bucket = { stationId: string | null; items: OrderItemForRouting[] };
    const buckets = new Map<string, Bucket>();

    for (const it of items) {
      const stationId = this.resolveStation({
        item: it,
        itemRoutes,
        categoryRoutes,
        groupRoutes,
        brandDefaultStationId: brandRouting?.defaultStationId ?? null,
        locationDefaultStationId: order.location.defaultKitchenStationId ?? null,
      });
      const key = stationId ?? "__unrouted__";
      if (!buckets.has(key)) buckets.set(key, { stationId, items: [] });
      buckets.get(key)!.items.push(it);
    }

    // ── Translate buckets → targets ──────────────────────────────────
    const targets: PrintTarget[] = [];

    // Phase AW-26 — lifetime visit count for this customer at the
    // tenant. Used by every payload built below (kitchen tickets +
    // customer receipt + driver slip) so they all carry a "NEW
    // CUSTOMER" / "RETURNING #N" banner. Phone is the most stable
    // identifier across guest checkouts + POS + marketplace ingests.
    const phone = (order.customerPhone ?? "").replace(/\s+/g, "");
    const customerVisitCount = phone
      ? await this.prisma.order.count({
          where: {
            tenantId: order.tenantId,
            isSandbox: false,
            status: { not: "CANCELLED" },
            customerPhone: phone,
          },
        })
      : 1;
    const customerVisitTag =
      customerVisitCount <= 1
        ? "*** NEW CUSTOMER ***"
        : `*** RETURNING CUSTOMER · ORDER #${customerVisitCount} ***`;

    // Kitchen tickets, one per station.
    const stationDetails = await this.prisma.printerStation.findMany({
      where: {
        id: {
          in: Array.from(buckets.keys()).filter((k) => k !== "__unrouted__"),
        },
      },
      select: { id: true, defaultPrinterId: true, name: true },
    });
    const stationMap = new Map(stationDetails.map((s) => [s.id, s]));

    for (const [, bucket] of buckets) {
      const stationRow = bucket.stationId
        ? stationMap.get(bucket.stationId)
        : null;
      const printerId = stationRow?.defaultPrinterId ?? null;

      if (!printerId && !opts.includeUnrouted) continue;

      targets.push({
        type: "KITCHEN_TICKET",
        printerId,
        stationId: bucket.stationId,
        copies: 1,
        routeKey: this.makeRouteKey(
          order.location.id,
          printerId,
          bucket.stationId,
        ),
        payload: {
          ...header,
          stationName: stationRow?.name ?? null,
          items: bucket.items.map((i) => ({
            name: this.cleanItemName(i.name),
            quantity: i.quantity,
            modifiers: i.modifiers ?? [],
            notes: i.notes ?? null,
          })),
          orderNumber: order.orderNumber ?? order.displayId ?? null,
          displayId: order.displayId ?? null,
          platform: order.platform ?? null,
          orderSource: order.orderSource ?? null,
          customerName: order.customerName ?? null,
          customerPhone: order.customerPhone ?? null,
          fulfillmentType: order.fulfillmentType,
          deliveryAddress: this.formatDeliveryAddress(order),
          specialInstructions: order.specialInstructions ?? null,
          receivedAt: order.receivedAt ?? order.createdAt,
          customerVisitCount,
          customerVisitTag,
        },
      });
    }

    // Customer receipt — one per order. Prefer the explicit binding on
    // Location; for first-time setups where the operator hasn't
    // nominated one yet, fall back to any active receipt-capable
    // printer at the location. Without this fallback a one-printer
    // shop's reprint button silently produces zero targets and the
    // operator has no way to know why.
    let receiptPrinterId = order.location.receiptPrinterId;
    if (!receiptPrinterId) {
      const fallback = await this.prisma.printer.findFirst({
        where: {
          locationId: order.location.id,
          isActive: true,
          deletedAt: null,
          supportsReceipts: true,
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      receiptPrinterId = fallback?.id ?? null;
    }
    // The operator's "Copies" setting on the printer (Defaults section
    // of the printer drawer) is stored as `printer.defaults.copies` and
    // was previously ignored — every receipt was forced to 1 copy. Pull
    // it once for the receipt + driver-slip printers below so the UI
    // setting actually takes effect.
    const copiesByPrinter = new Map<string, number>();
    const printerIdsForCopies = [
      receiptPrinterId,
      order.location.dispatchPrinterId,
    ].filter((x): x is string => !!x);
    if (printerIdsForCopies.length) {
      const rows = await this.prisma.printer.findMany({
        where: { id: { in: printerIdsForCopies } },
        select: { id: true, defaults: true },
      });
      for (const r of rows) {
        const raw = (r.defaults as any)?.copies;
        const n = Math.max(1, Math.min(10, Number(raw) || 1));
        copiesByPrinter.set(r.id, n);
      }
    }

    if (receiptPrinterId) {
      targets.push({
        type: "CUSTOMER_RECEIPT",
        printerId: receiptPrinterId,
        stationId: null,
        copies: copiesByPrinter.get(receiptPrinterId) ?? 1,
        routeKey: this.makeRouteKey(
          order.location.id,
          receiptPrinterId,
          null,
        ),
        payload: this.buildReceiptPayload(order, items, header, {
          customerVisitCount,
          customerVisitTag,
        }),
      });
    }

    // Driver slip — only delivery orders with a dispatch printer.
    if (
      order.location.dispatchPrinterId &&
      order.fulfillmentType === "DELIVERY"
    ) {
      targets.push({
        type: "DRIVER_SLIP",
        printerId: order.location.dispatchPrinterId,
        stationId: null,
        copies: copiesByPrinter.get(order.location.dispatchPrinterId) ?? 1,
        routeKey: this.makeRouteKey(
          order.location.id,
          order.location.dispatchPrinterId,
          null,
        ),
        payload: this.buildDriverSlipPayload(order, header, {
          customerVisitCount,
          customerVisitTag,
        }),
      });
    }

    return targets;
  }

  // ── Per-item station resolver (the "most specific wins" walk) ──────

  private resolveStation(args: {
    item: OrderItemForRouting;
    itemRoutes: Map<string, string>; // menuItemId → stationId
    categoryRoutes: Map<string, string>; // categoryId → stationId
    groupRoutes: Map<string, string>; // modifierGroupId → stationId
    brandDefaultStationId: string | null;
    locationDefaultStationId: string | null;
  }): string | null {
    const { item } = args;

    // 1. Menu item override.
    if (item.menuItemId) {
      const hit = args.itemRoutes.get(item.menuItemId);
      if (hit) return hit;
    }

    // 2. Modifier group override — first matching group wins.
    for (const gid of item.modifierGroupIds ?? []) {
      const hit = args.groupRoutes.get(gid);
      if (hit) return hit;
    }

    // 3. Category fallback.
    if (item.categoryId) {
      const hit = args.categoryRoutes.get(item.categoryId);
      if (hit) return hit;
    }

    // 4. Brand default.
    if (args.brandDefaultStationId) return args.brandDefaultStationId;

    // 5. Location default kitchen station.
    if (args.locationDefaultStationId) return args.locationDefaultStationId;

    // 6. Unrouted.
    return null;
  }

  // ── Routing lookups (indexed queries) ──────────────────────────────

  private async fetchItemRoutes(
    items: OrderItemForRouting[],
  ): Promise<Map<string, string>> {
    const ids = items
      .map((i) => i.menuItemId)
      .filter((x): x is string => !!x);
    if (!ids.length) return new Map();
    const rows = await this.prisma.menuItemStation.findMany({
      where: { menuItemId: { in: ids } },
      select: { menuItemId: true, stationId: true },
    });
    return new Map(rows.map((r) => [r.menuItemId, r.stationId]));
  }

  private async fetchCategoryRoutesForItems(
    items: OrderItemForRouting[],
  ): Promise<Map<string, string>> {
    const itemIds = items
      .map((i) => i.menuItemId)
      .filter((x): x is string => !!x);
    if (!itemIds.length) return new Map();

    // We need to know which category each item belongs to. Items can
    // appear in many categories; we take the first route hit per
    // category. The link table is MenuItemOnCategory.
    const links = await this.prisma.menuItemOnCategory.findMany({
      where: { itemId: { in: itemIds } },
      select: { itemId: true, categoryId: true },
    });

    // Mutate the caller's items so resolveStation can read categoryId.
    const byItem = new Map<string, string>();
    for (const l of links) {
      if (!byItem.has(l.itemId)) byItem.set(l.itemId, l.categoryId);
    }
    for (const it of items) {
      if (it.menuItemId && byItem.has(it.menuItemId)) {
        it.categoryId = byItem.get(it.menuItemId)!;
      }
    }

    const categoryIds = Array.from(new Set(links.map((l) => l.categoryId)));
    if (!categoryIds.length) return new Map();
    const rows = await this.prisma.menuCategoryStation.findMany({
      where: { categoryId: { in: categoryIds } },
      select: { categoryId: true, stationId: true },
    });
    return new Map(rows.map((r) => [r.categoryId, r.stationId]));
  }

  private async fetchModifierGroupRoutes(
    items: OrderItemForRouting[],
  ): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const it of items) {
      for (const gid of it.modifierGroupIds ?? []) ids.add(gid);
    }
    if (!ids.size) return new Map();
    const rows = await this.prisma.modifierGroupStation.findMany({
      where: { modifierGroupId: { in: Array.from(ids) } },
      select: { modifierGroupId: true, stationId: true },
    });
    return new Map(rows.map((r) => [r.modifierGroupId, r.stationId]));
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private extractModifierGroupIds(modifiers: any): string[] {
    if (!Array.isArray(modifiers)) return [];
    const ids = new Set<string>();
    for (const m of modifiers) {
      if (m?.groupId) ids.add(m.groupId);
      if (m?.modifierGroupId) ids.add(m.modifierGroupId);
    }
    return Array.from(ids);
  }

  private makeRouteKey(
    locationId: string,
    printerId: string | null,
    stationId: string | null,
  ): string {
    return `loc:${locationId}|printer:${printerId ?? "_"}|station:${stationId ?? "_"}`;
  }

  private buildReceiptPayload(
    order: any,
    items: OrderItemForRouting[],
    header: HeaderContext = EMPTY_HEADER,
    visit: { customerVisitCount?: number; customerVisitTag?: string } = {},
  ) {
    return {
      ...header,
      customerVisitCount: visit.customerVisitCount,
      customerVisitTag: visit.customerVisitTag,
      orderNumber: order.orderNumber ?? order.displayId ?? null,
      displayId: order.displayId ?? null,
      // Order origin shown above the items so the kitchen instantly knows
      // whether to honour Uber's flow vs DIRECT etc. Both fields ship —
      // platform is the cross-channel taxonomy, orderSource is the
      // operational source (POS / DIRECT / PLATFORM).
      platform: order.platform ?? null,
      orderSource: order.orderSource ?? null,
      customerName: order.customerName ?? null,
      customerPhone: order.customerPhone ?? null,
      fulfillmentType: order.fulfillmentType,
      receivedAt: order.receivedAt ?? order.createdAt,
      deliveryAddress: this.formatDeliveryAddress(order),
      items: items.map((i) => ({
        name: this.cleanItemName(i.name),
        quantity: i.quantity,
        modifiers: i.modifiers ?? [],
        notes: i.notes ?? null,
      })),
      subtotal: Number(order.subtotal ?? 0),
      taxAmount: Number(order.taxAmount ?? 0),
      deliveryFee: Number(order.deliveryFee ?? 0),
      discount: Number(order.discount ?? 0),
      total: Number(order.total ?? 0),
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      paymentLabel: paymentLabelFor(order.paymentMethod, order.paymentStatus),
      specialInstructions: order.specialInstructions ?? null,
    };
  }

  private buildDriverSlipPayload(
    order: any,
    header: HeaderContext = EMPTY_HEADER,
    visit: { customerVisitCount?: number; customerVisitTag?: string } = {},
  ) {
    return {
      ...header,
      customerVisitCount: visit.customerVisitCount,
      customerVisitTag: visit.customerVisitTag,
      orderNumber: order.orderNumber ?? order.displayId ?? null,
      displayId: order.displayId ?? null,
      platform: order.platform ?? null,
      orderSource: order.orderSource ?? null,
      customerName: order.customerName ?? null,
      customerPhone: order.customerPhone ?? null,
      fulfillmentType: order.fulfillmentType,
      deliveryAddress: this.formatDeliveryAddress(order),
      address: {
        line1: order.addressLine1 ?? null,
        line2: order.addressLine2 ?? null,
        city: order.city ?? null,
        postcode: order.postcode ?? null,
      },
      total: Number(order.total ?? 0),
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      paymentLabel: paymentLabelFor(order.paymentMethod, order.paymentStatus),
      specialInstructions: order.specialInstructions ?? null,
    };
  }

  // POS / storefront cart writes the OrderItem.name as
  //   "10\" bolognese (salami, classic) - Note: thin base"
  // so the KDS parser regex can pull modifiers + note back out without
  // having to join three columns. The printer payload already carries
  // modifiers and notes as STRUCTURED fields, so leaving the embedded
  // suffix in the name causes them to print twice. Strip it here for
  // print only — never touch the stored value, KDS still depends on
  // it.
  private cleanItemName(raw: string | null | undefined): string {
    if (!raw) return "";
    let s = String(raw);
    // Drop trailing " - Note: ..." (case-sensitive, mirrors buildCartItemName).
    const noteIdx = s.indexOf(" - Note: ");
    if (noteIdx >= 0) s = s.slice(0, noteIdx);
    // Drop the last "(...)" group which holds the modifier list.
    s = s.replace(/\s*\([^()]*\)\s*$/, "");
    return s.trim();
  }

  // Joins the order's address columns into one printable string. Uses
  // `addressLine1` / `addressLine2` / `city` / `postcode` from the Order
  // row (POS path) and falls back to the legacy `deliveryAddress` JSON
  // blob (older platform imports).
  private formatDeliveryAddress(order: any): string | null {
    const parts = [
      order.addressLine1,
      order.addressLine2,
      order.city,
      order.postcode,
    ].filter((s) => typeof s === "string" && s.trim().length > 0);
    if (parts.length) return parts.join(", ");
    const blob = order.deliveryAddress as Record<string, any> | null;
    if (blob) {
      const more = [blob.line1, blob.line2, blob.city, blob.postcode].filter(
        (s) => typeof s === "string" && s.trim().length > 0,
      );
      if (more.length) return more.join(", ");
    }
    return null;
  }

  // Location.address is free-form JSON. Most rows store
  // { line1, line2, city, postcode } but older imports may differ.
  formatAddressJson(addr: any): string | null {
    if (!addr || typeof addr !== "object") return null;
    const parts = [addr.line1, addr.line2, addr.city, addr.postcode].filter(
      (s) => typeof s === "string" && s.trim().length > 0,
    );
    return parts.length ? parts.join(", ") : null;
  }
}

type HeaderContext = {
  brandName: string | null;
  brandLogoUrl: string | null;
  locationName: string | null;
  locationAddress: string | null;
  locationPhone: string | null;
};
const EMPTY_HEADER: HeaderContext = {
  brandName: null,
  brandLogoUrl: null,
  locationName: null,
  locationAddress: null,
  locationPhone: null,
};

// Mirrors apps/api/.../formatters/receipt.formatter.ts:paymentLabelFor.
// Keeps the kitchen-banner wording identical across every print client.
function paymentLabelFor(
  method: string | null | undefined,
  status: string | null | undefined,
): string {
  if (method === "CARD") {
    if (status === "PAID" || status === "AUTHORIZED") return "*** PAID (CARD) ***";
    if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED")
      return "*** REFUNDED ***";
    return "*** CARD NOT PAID ***";
  }
  if (method === "CASH") {
    if (status === "PAID") return "*** PAID (CASH) ***";
    return "*** CASH ON HANDOVER ***";
  }
  if (status === "PAID") return "*** PAID ***";
  return "*** UNPAID ***";
}
