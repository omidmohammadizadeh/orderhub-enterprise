// Phase AW-30 — single source of truth for customer visit counting.
//
// Same logic must produce the same number in three places: the orders
// board card (orders.service.ts), the receipt formatter, and the
// kitchen ticket formatter. Previously each had its own implementation
// and they disagreed — phone-only counts vs. name+phone+postcode
// identity vs. another variant. Now they all import this.
//
// Counts are scoped to (tenantId, brandId) so a customer who's been to
// brand A four times and brand B once sees "RETURNING #4" at A and
// "RETURNING #1" at B — never a cross-brand sum.

import type { PrismaService } from "../../infrastructure/database/prisma.service";

export const MARKETPLACE_SOURCES = new Set([
  "JUST_EAT",
  "UBER_EATS",
  "DELIVEROO",
  "HUBRISE",
]);

const norm = (s: string | null | undefined) =>
  (s ?? "").replace(/\s+/g, "").toLowerCase();

export interface VisitIdentityInput {
  customerName: string | null;
  customerPhone: string | null;
  postcode: string | null;
  platform: string | null;
  orderSource: string | null;
  integrationSource: string | null;
  viaHubrise: boolean | null;
}

/**
 * Returns the canonical identity key for an order's customer, or null
 * when there isn't enough signal to safely match. Marketplaces mask
 * the customer's phone so we key by name+postcode for those; direct /
 * POS / online use name + phone + postcode.
 */
export function identityFor(o: VisitIdentityInput): string | null {
  const isMarketplace =
    MARKETPLACE_SOURCES.has(o.integrationSource ?? "") ||
    MARKETPLACE_SOURCES.has(o.platform ?? "") ||
    !!o.viaHubrise;
  const name = norm(o.customerName);
  const postcode = norm(o.postcode);
  const phone = norm(o.customerPhone);
  if (isMarketplace) {
    if (!name) return null;
    return `mkt|${name}|${postcode}`;
  }
  if (!name) return null;
  if (!phone && !postcode) return null;
  return `dir|${name}|${phone}|${postcode}`;
}

/**
 * Count how many non-cancelled orders share the same customer identity
 * inside this (tenant, brand) scope. Returns 1 when the order has no
 * identifying signal (so the receipt shows NEW CUSTOMER, not nothing).
 *
 * The brandId is optional: legacy single-brand kitchens don't pin a
 * brand on the Order row and fall back to tenant-only scope, which
 * matches the pre-AW-30 behaviour for those tenants.
 */
export async function computeVisitCountForOrder(
  prisma: PrismaService,
  order: VisitIdentityInput & {
    tenantId: string;
    brandId: string | null;
  },
): Promise<number> {
  const id = identityFor(order);
  if (!id) return 1;

  // Build the where clause from the components we have. We don't filter
  // by the derived identity (Prisma can't express it), so we pull the
  // candidate rows and bucket in JS — same approach as the orders board.
  const where: any = {
    tenantId: order.tenantId,
    isSandbox: false,
    status: { not: "CANCELLED" },
  };
  if (order.brandId) where.brandId = order.brandId;

  const isMarketplace =
    MARKETPLACE_SOURCES.has(order.integrationSource ?? "") ||
    MARKETPLACE_SOURCES.has(order.platform ?? "") ||
    !!order.viaHubrise;

  if (isMarketplace) {
    if (!order.customerName) return 1;
    where.customerName = order.customerName;
    if (order.postcode) where.postcode = order.postcode;
  } else {
    if (!order.customerName) return 1;
    where.customerName = order.customerName;
    if (order.customerPhone) where.customerPhone = order.customerPhone;
    if (order.postcode) where.postcode = order.postcode;
  }

  try {
    return await (prisma as any).order.count({ where });
  } catch {
    return 1;
  }
}

export function visitTagFor(count: number): string {
  return count <= 1
    ? "*** NEW CUSTOMER ***"
    : `*** RETURNING CUSTOMER · ORDER #${count} ***`;
}
