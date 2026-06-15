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
    const order = await this.prisma.order.findUnique({
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
    const [itemRoutes, categoryRoutes, groupRoutes, brand] = await Promise.all([
      this.fetchItemRoutes(items),
      this.fetchCategoryRoutesForItems(items),
      this.fetchModifierGroupRoutes(items),
      this.prisma.brand.findUnique({
        where: { id: order.location.brandId },
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
        brandDefaultStationId: brand?.defaultStationId ?? null,
        locationDefaultStationId: order.location.defaultKitchenStationId ?? null,
      });
      const key = stationId ?? "__unrouted__";
      if (!buckets.has(key)) buckets.set(key, { stationId, items: [] });
      buckets.get(key)!.items.push(it);
    }

    // ── Translate buckets → targets ──────────────────────────────────
    const targets: PrintTarget[] = [];

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
          stationName: stationRow?.name ?? null,
          items: bucket.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            modifiers: i.modifiers ?? [],
            notes: i.notes ?? null,
          })),
          orderNumber: order.orderNumber ?? order.displayId ?? null,
          customerName: order.customerName ?? null,
          fulfillmentType: order.fulfillmentType,
          receivedAt: order.receivedAt ?? order.createdAt,
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
    if (receiptPrinterId) {
      targets.push({
        type: "CUSTOMER_RECEIPT",
        printerId: receiptPrinterId,
        stationId: null,
        copies: 1,
        routeKey: this.makeRouteKey(
          order.location.id,
          receiptPrinterId,
          null,
        ),
        payload: this.buildReceiptPayload(order, items),
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
        copies: 1,
        routeKey: this.makeRouteKey(
          order.location.id,
          order.location.dispatchPrinterId,
          null,
        ),
        payload: this.buildDriverSlipPayload(order),
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

  private buildReceiptPayload(order: any, items: OrderItemForRouting[]) {
    return {
      orderNumber: order.orderNumber ?? order.displayId ?? null,
      customerName: order.customerName ?? null,
      fulfillmentType: order.fulfillmentType,
      receivedAt: order.receivedAt ?? order.createdAt,
      items: items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        modifiers: i.modifiers ?? [],
      })),
      subtotal: Number(order.subtotal ?? 0),
      tax: Number(order.taxAmount ?? 0),
      delivery: Number(order.deliveryFee ?? 0),
      discount: Number(order.discount ?? 0),
      total: Number(order.total ?? 0),
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
    };
  }

  private buildDriverSlipPayload(order: any) {
    return {
      orderNumber: order.orderNumber ?? order.displayId ?? null,
      customerName: order.customerName ?? null,
      customerPhone: order.customerPhone ?? null,
      address: {
        line1: order.addressLine1 ?? null,
        line2: order.addressLine2 ?? null,
        city: order.city ?? null,
        postcode: order.postcode ?? null,
      },
      total: Number(order.total ?? 0),
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
    };
  }
}
