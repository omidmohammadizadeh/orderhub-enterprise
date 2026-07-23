import type { PrismaService } from "../../infrastructure/database/prisma.service";

// ── Admin agent tool registry (Phase 1 — READ ONLY) ─────────────────────────
//
// Every tool is tenant-scoped by the SERVER (the caller passes tenantId from
// the authenticated JWT — the model never supplies it), and every tool only
// READS. No tool here mutates anything. Write tools (create/edit/86/publish)
// are a separate, confirmation-gated phase and deliberately not in this file.
//
// Tools query Prisma directly with narrow selects rather than injecting a dozen
// services — read-only + tenant-filtered is the safest, lowest-coupling shape.

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Runs the read. `input` is model-supplied and untrusted; `tenantId` is
   *  server-supplied and authoritative. Never let `input` carry a tenantId. */
  run: (
    prisma: PrismaService,
    tenantId: string,
    input: Record<string, any>,
  ) => Promise<unknown>;
}

const money = (v: unknown): number => Number(v ?? 0);
const p = (prisma: PrismaService) => prisma as any;

/** All brand ids for a tenant — the scoping key for product/menu reads. */
async function tenantBrandIds(prisma: PrismaService, tenantId: string): Promise<string[]> {
  const brands = await p(prisma).brand.findMany({
    where: { tenantId },
    select: { id: true },
  });
  return brands.map((b: any) => b.id);
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "list_brands",
    description:
      "List all brands for the business (id, name, whether active, online-ordering slug). Use to find a brand's id before other calls.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: async (prisma, tenantId) =>
      p(prisma).brand.findMany({
        where: { tenantId },
        select: { id: true, name: true, isActive: true, onlineOrderingSlug: true },
        orderBy: { name: "asc" },
      }),
  },
  {
    name: "list_locations",
    description:
      "List all physical locations/stores (id, name, city/postcode, active). Use to find a location's id.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: async (prisma, tenantId) =>
      p(prisma).location.findMany({
        where: { tenantId },
        select: { id: true, name: true, city: true, postcode: true, isActive: true, hubriseCatalogId: true },
        orderBy: { name: "asc" },
      }),
  },
  {
    name: "list_menus",
    description:
      "List menus, optionally filtered by brandId or locationId. Returns id, name, status, active, home location/brand, and item count. Use to see what menus exist and their publish state.",
    input_schema: {
      type: "object",
      properties: {
        brandId: { type: "string", description: "Optional brand id to filter by." },
        locationId: { type: "string", description: "Optional location id to filter by." },
      },
      additionalProperties: false,
    },
    run: async (prisma, tenantId, input) => {
      const brandIds = await tenantBrandIds(prisma, tenantId);
      const where: any = { brandId: { in: brandIds }, deletedAt: null };
      if (input.brandId) where.brandId = input.brandId;
      if (input.locationId) where.locationId = input.locationId;
      const menus = await p(prisma).menu.findMany({
        where,
        select: {
          id: true, name: true, status: true, isActive: true,
          brandId: true, locationId: true,
          _count: { select: { categories: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 100,
      });
      return menus;
    },
  },
  {
    name: "get_menu",
    description:
      "Get one menu in full: its categories in order, each with its items (name, price, description, whether it has a photo, PLU, availability). Use to inspect or audit a specific menu.",
    input_schema: {
      type: "object",
      properties: { menuId: { type: "string" } },
      required: ["menuId"],
      additionalProperties: false,
    },
    run: async (prisma, tenantId, input) => {
      const brandIds = await tenantBrandIds(prisma, tenantId);
      const menu = await p(prisma).menu.findFirst({
        where: { id: input.menuId, brandId: { in: brandIds } },
        select: {
          id: true, name: true, status: true, isActive: true,
          categories: {
            orderBy: { sortOrder: "asc" },
            select: {
              id: true, name: true,
              items: {
                orderBy: { sortOrder: "asc" },
                select: {
                  item: {
                    select: {
                      id: true, name: true, basePrice: true, description: true,
                      imageUrl: true, plu: true, isAvailable: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!menu) return { error: "Menu not found for this business." };
      // Flatten to a compact shape the model can read cheaply.
      return {
        id: menu.id, name: menu.name, status: menu.status, isActive: menu.isActive,
        categories: menu.categories.map((c: any) => ({
          name: c.name,
          items: c.items.map((ci: any) => ({
            name: ci.item.name,
            price: money(ci.item.basePrice),
            hasPhoto: !!ci.item.imageUrl,
            plu: ci.item.plu ?? null,
            available: ci.item.isAvailable,
            description: ci.item.description ?? null,
          })),
        })),
      };
    },
  },
  {
    name: "search_products",
    description:
      "Search products/menu items by name across the business (optionally within a brand or location). Returns name, price, brand, location, whether it has a photo, PLU, availability. Use to find items to inspect or to check for issues.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match in the product name (case-insensitive)." },
        brandId: { type: "string" },
        locationId: { type: "string" },
      },
      additionalProperties: false,
    },
    run: async (prisma, tenantId, input) => {
      const brandIds = await tenantBrandIds(prisma, tenantId);
      const where: any = { brandId: { in: brandIds } };
      if (input.brandId) where.brandId = input.brandId;
      if (input.locationId) where.locationId = input.locationId;
      if (input.query) where.name = { contains: String(input.query), mode: "insensitive" };
      const items = await p(prisma).menuItem.findMany({
        where,
        select: {
          id: true, name: true, basePrice: true, imageUrl: true, plu: true,
          isAvailable: true, brandId: true, locationId: true, platformSource: true,
        },
        take: 60,
        orderBy: { name: "asc" },
      });
      return items.map((i: any) => ({
        id: i.id, name: i.name, price: money(i.basePrice),
        hasPhoto: !!i.imageUrl, plu: i.plu ?? null, available: i.isAvailable,
        brandId: i.brandId, locationId: i.locationId, source: i.platformSource ?? "manual",
      }));
    },
  },
  {
    name: "menu_health",
    description:
      "Audit product data quality for a location (or the whole business): counts of items missing a photo, with a £0/blank price, missing a PLU, and duplicate names. Use to answer 'what needs fixing on my menu'.",
    input_schema: {
      type: "object",
      properties: { locationId: { type: "string" }, brandId: { type: "string" } },
      additionalProperties: false,
    },
    run: async (prisma, tenantId, input) => {
      const brandIds = await tenantBrandIds(prisma, tenantId);
      const where: any = { brandId: { in: brandIds } };
      if (input.brandId) where.brandId = input.brandId;
      if (input.locationId) where.locationId = input.locationId;
      const items = await p(prisma).menuItem.findMany({
        where,
        select: { name: true, basePrice: true, imageUrl: true, plu: true },
        take: 5000,
      });
      const byName = new Map<string, number>();
      let noPhoto = 0, zeroPrice = 0, noPlu = 0;
      for (const i of items) {
        if (!i.imageUrl) noPhoto++;
        if (money(i.basePrice) <= 0) zeroPrice++;
        if (!i.plu) noPlu++;
        const k = String(i.name ?? "").trim().toLowerCase();
        byName.set(k, (byName.get(k) ?? 0) + 1);
      }
      const duplicateNames = [...byName.entries()].filter(([, n]) => n > 1).length;
      return {
        totalItems: items.length,
        missingPhoto: noPhoto,
        zeroOrBlankPrice: zeroPrice,
        missingPlu: noPlu,
        duplicateNameGroups: duplicateNames,
      };
    },
  },
  {
    name: "duplicate_products_scan",
    description:
      "Find products that appear more than once (same name within the same brand+location) — the classic duplicate-catalog problem. Returns the worst offenders with their copy counts. Read-only; proposes nothing.",
    input_schema: {
      type: "object",
      properties: { locationId: { type: "string" } },
      additionalProperties: false,
    },
    run: async (prisma, tenantId, input) => {
      const brandIds = await tenantBrandIds(prisma, tenantId);
      const where: any = { brandId: { in: brandIds } };
      if (input.locationId) where.locationId = input.locationId;
      const items = await p(prisma).menuItem.findMany({
        where,
        select: { name: true, brandId: true, locationId: true },
        take: 8000,
      });
      const groups = new Map<string, { name: string; brandId: string; locationId: string | null; count: number }>();
      for (const i of items) {
        const k = `${i.brandId}|${i.locationId}|${String(i.name ?? "").trim().toLowerCase()}`;
        const g = groups.get(k) ?? { name: i.name, brandId: i.brandId, locationId: i.locationId, count: 0 };
        g.count++;
        groups.set(k, g);
      }
      const dups = [...groups.values()].filter((g) => g.count > 1).sort((a, b) => b.count - a.count);
      return {
        duplicateGroups: dups.length,
        totalExcessRows: dups.reduce((n, g) => n + (g.count - 1), 0),
        worst: dups.slice(0, 25),
      };
    },
  },
  {
    name: "list_orders",
    description:
      "List recent orders (default last 25), optionally filtered by status (e.g. OUT_FOR_DELIVERY, ACCEPTED, COMPLETED) or channel/platform. Returns order number, status, platform, brand, total, courier status, age. Use to find stuck or recent orders.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional order status filter, e.g. OUT_FOR_DELIVERY." },
        platform: { type: "string", description: "Optional platform filter, e.g. DELIVEROO / JUST_EAT / UBER_EATS." },
        locationId: { type: "string" },
        limit: { type: "number", description: "Max rows (default 25, cap 100)." },
      },
      additionalProperties: false,
    },
    run: async (prisma, tenantId, input) => {
      const where: any = { tenantId };
      if (input.status) where.status = String(input.status).toUpperCase();
      if (input.platform) where.platform = String(input.platform).toUpperCase();
      if (input.locationId) where.locationId = input.locationId;
      const rows = await p(prisma).order.findMany({
        where,
        select: {
          id: true, displayId: true, orderNumber: true, status: true, platform: true,
          total: true, courierStatus: true, createdAt: true, brandId: true,
          customerName: true,
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Number(input.limit) || 25, 100),
      });
      return rows.map((o: any) => ({
        ref: o.displayId ?? o.orderNumber ?? o.id,
        status: o.status,
        platform: o.platform,
        total: money(o.total),
        courierStatus: o.courierStatus ?? null,
        customer: o.customerName ?? null,
        placedAt: o.createdAt,
      }));
    },
  },
  {
    name: "get_order",
    description:
      "Get one order in detail by its number/ref (or id): status, platform, totals, courier tracking, and the full status timeline. Use to diagnose why an order is stuck or what happened to it.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "The order number, displayId, or id." } },
      required: ["ref"],
      additionalProperties: false,
    },
    run: async (prisma, tenantId, input) => {
      const ref = String(input.ref).replace(/^#/, "");
      const order = await p(prisma).order.findFirst({
        where: {
          tenantId,
          OR: [{ id: ref }, { displayId: ref }, { orderNumber: ref }],
        },
        select: {
          id: true, displayId: true, orderNumber: true, status: true, platform: true,
          brandId: true, locationId: true, total: true, subtotal: true,
          paymentStatus: true, paymentMethod: true, fulfillmentType: true,
          customerName: true, courierName: true, courierPhone: true, courierStatus: true,
          courierAssignedAt: true, courierPickedUpAt: true, courierDeliveredAt: true,
          receivedAt: true, acceptedAt: true, preparingAt: true, readyAt: true,
          outForDeliveryAt: true, deliveredAt: true, cancelledAt: true, cancelReason: true,
          createdAt: true,
        },
      });
      if (!order) return { error: "Order not found for this business." };
      return order;
    },
  },
];

export const AGENT_TOOL_MAP: Record<string, AgentTool> = Object.fromEntries(
  AGENT_TOOLS.map((t) => [t.name, t]),
);
