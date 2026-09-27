// Retail R1 — per-location stock for barcoded variants.
//
// Every change is a ProductStockMovement plus a matching nudge to the running
// ProductStockLevel, written together. Each movement carries a dedupeKey and
// is inserted with ON CONFLICT DO NOTHING; the level only moves when the
// movement row was actually new. That is what makes the order listener safe
// to fire twice (ACCEPTED then COMPLETED, a retried event, two API pods):
// the second attempt inserts nothing and changes nothing.

import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { randomUUID } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { isRetailType, resolveVariantForLine, type VariantRef } from "./retail.logic";

type MovementType =
  | "PURCHASE"
  | "SALE_DEDUCTION"
  | "WASTE"
  | "ADJUSTMENT"
  | "RETURN"
  | "COUNT_CORRECTION";

export interface StockMove {
  tenantId: string;
  locationId: string;
  variantId: string;
  type: MovementType;
  /** Signed: + into stock, − out of it. */
  quantity: number;
  reason?: string | null;
  orderId?: string | null;
  refundId?: string | null;
  recordedBy?: string | null;
  /** Omit for manual moves that are allowed to repeat (two genuine +5s). */
  dedupeKey?: string | null;
}

// A sale takes stock the moment the shop commits to it. Walk-in retail sales
// jump straight to COMPLETED; an online order is committed at ACCEPTED.
const COMMITTED = new Set(["ACCEPTED", "PREPARING", "READY", "DISPATCHED", "DELIVERED", "COMPLETED"]);
const UNDONE = new Set(["CANCELLED", "REJECTED", "FAILED"]);

@Injectable()
export class RetailStockService {
  private readonly logger = new Logger(RetailStockService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Apply stock movements atomically. Returns how many were new — a replayed
   * dedupeKey counts as zero and leaves the level untouched.
   *
   * Pass `tx` to join a caller's transaction (the returns flow books the
   * refund and the restock together).
   */
  async applyMoves(moves: StockMove[], tx?: any): Promise<number> {
    if (!moves.length) return 0;
    const run = async (db: any) => {
      let applied = 0;
      for (const m of moves) {
        if (!Number.isInteger(m.quantity) || m.quantity === 0) continue;
        // createMany + skipDuplicates is ON CONFLICT DO NOTHING. A plain
        // create() hitting the unique key would abort the whole Postgres
        // transaction (25P02), not just this statement.
        const { count } = await db.productStockMovement.createMany({
          data: [
            {
              id: randomUUID(),
              tenantId: m.tenantId,
              locationId: m.locationId,
              variantId: m.variantId,
              type: m.type,
              quantity: m.quantity,
              reason: m.reason ?? null,
              orderId: m.orderId ?? null,
              refundId: m.refundId ?? null,
              recordedBy: m.recordedBy ?? null,
              dedupeKey: m.dedupeKey ?? null,
            },
          ],
          skipDuplicates: true,
        });
        if (count === 0) continue;
        await db.productStockLevel.upsert({
          where: { variantId_locationId: { variantId: m.variantId, locationId: m.locationId } },
          create: { variantId: m.variantId, locationId: m.locationId, quantity: m.quantity },
          update: { quantity: { increment: m.quantity } },
        });
        applied++;
      }
      return applied;
    };
    return tx ? run(tx) : this.prisma.$transaction((db) => run(db));
  }

  /**
   * Manual change from the stock screen: either a delta ("+12 delivered",
   * "−2 damaged") or a counted total ("there are 7 on the shelf"). A count is
   * booked as the difference, so the ledger still explains the new figure.
   */
  async adjust(args: {
    tenantId: string;
    locationId: string;
    variantId: string;
    userId: string;
    mode: "delta" | "count";
    quantity: number;
    reason?: string;
  }) {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: args.variantId, tenantId: args.tenantId },
      select: { id: true },
    });
    if (!variant) throw new NotFoundException("Product not found");
    if (!Number.isInteger(args.quantity)) {
      throw new BadRequestException("Quantity must be a whole number");
    }

    return this.prisma.$transaction(async (tx) => {
      let delta = args.quantity;
      let type: MovementType = args.quantity >= 0 ? "PURCHASE" : "WASTE";
      if (args.mode === "count") {
        if (args.quantity < 0) throw new BadRequestException("A count can't be negative");
        // Read inside the transaction so a sale landing mid-count is not lost.
        const level = await tx.productStockLevel.findUnique({
          where: { variantId_locationId: { variantId: args.variantId, locationId: args.locationId } },
          select: { quantity: true },
        });
        delta = args.quantity - (level?.quantity ?? 0);
        type = "COUNT_CORRECTION";
      } else if (args.reason && /adjust|correct/i.test(args.reason)) {
        type = "ADJUSTMENT";
      }
      if (delta !== 0) {
        await this.applyMoves(
          [
            {
              tenantId: args.tenantId,
              locationId: args.locationId,
              variantId: args.variantId,
              type,
              quantity: delta,
              reason: args.reason?.trim() || null,
              recordedBy: args.userId,
            },
          ],
          tx,
        );
      }
      const after = await tx.productStockLevel.findUnique({
        where: { variantId_locationId: { variantId: args.variantId, locationId: args.locationId } },
        select: { quantity: true },
      });
      return { variantId: args.variantId, quantity: after?.quantity ?? 0, change: delta };
    });
  }

  /**
   * R2-lite — goods in. A delivery scanned in at the back door, booked as one
   * batch: every line is a PURCHASE movement carrying the delivery reference,
   * all in one transaction so a half-received delivery never exists.
   */
  async receive(args: {
    tenantId: string;
    locationId: string;
    userId: string;
    reference?: string;
    lines: Array<{ variantId: string; quantity: number }>;
  }) {
    const lines = (args.lines ?? []).filter((l) => l && Number.isInteger(l.quantity) && l.quantity !== 0);
    if (!lines.length) throw new BadRequestException("Scan at least one item");
    if (lines.some((l) => l.quantity < 0)) {
      throw new BadRequestException("A delivery only adds stock — use Adjust to take stock off");
    }
    const ids = [...new Set(lines.map((l) => l.variantId))];
    const found = await this.prisma.productVariant.count({ where: { id: { in: ids }, tenantId: args.tenantId } });
    if (found !== ids.length) throw new NotFoundException("One of those products no longer exists");
    const ref = args.reference?.trim() || null;
    const units = lines.reduce((s, l) => s + l.quantity, 0);
    await this.prisma.$transaction((tx) =>
      this.applyMoves(
        lines.map((l) => ({
          tenantId: args.tenantId,
          locationId: args.locationId,
          variantId: l.variantId,
          type: "PURCHASE" as const,
          quantity: l.quantity,
          reason: ref ? `Delivery ${ref}` : "Delivery received",
          recordedBy: args.userId,
        })),
        tx,
      ),
    );
    return { lines: lines.length, units, reference: ref };
  }

  /**
   * R2-lite — stock report: every counted variant at this location with its
   * quantity and value at cost, plus how many are at or under their alert.
   */
  async report(tenantId: string, locationId: string) {
    const variants = await this.prisma.productVariant.findMany({
      where: { tenantId, isActive: true },
      include: {
        menuItem: { select: { name: true, basePrice: true, locationId: true } },
        stockLevels: { where: { locationId }, select: { quantity: true } },
      },
      orderBy: [{ menuItem: { name: "asc" } }, { sortOrder: "asc" }],
    });
    const rows = variants
      // This shop's products: made here, or holding stock here.
      .filter((v) => v.menuItem.locationId === locationId || v.stockLevels.length > 0)
      .map((v) => {
        const quantity = v.stockLevels[0]?.quantity ?? 0;
        const cost = v.costPrice === null ? null : Number(v.costPrice);
        return {
          variantId: v.id,
          product: v.menuItem.name,
          variant: v.name,
          barcode: v.barcode,
          sku: v.sku,
          quantity,
          price: Number(v.price ?? v.menuItem.basePrice),
          cost,
          value: cost === null ? null : Math.round(cost * Math.max(0, quantity) * 100) / 100,
          lowStockAt: v.lowStockAt,
          low: v.trackStock && quantity <= (v.lowStockAt ?? 0),
          trackStock: v.trackStock,
        };
      });
    return {
      rows,
      totals: {
        variants: rows.length,
        units: rows.reduce((s, r) => s + Math.max(0, r.quantity), 0),
        valueAtCost: Math.round(rows.reduce((s, r) => s + (r.value ?? 0), 0) * 100) / 100,
        low: rows.filter((r) => r.low).length,
        uncosted: rows.filter((r) => r.cost === null).length,
      },
    };
  }

  async history(tenantId: string, locationId: string, variantId: string, limit = 50) {
    return this.prisma.productStockMovement.findMany({
      where: { tenantId, locationId, variantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  // ── Orders → stock ────────────────────────────────────────────────────────

  /**
   * Take stock for a sale, and give it back if the sale is undone.
   *
   * Only at shop locations — a restaurant's menu items have no variants, and
   * this must cost a restaurant nothing beyond one indexed lookup. Never
   * throws into the status transition that fired it: a stock count being
   * wrong must not stop a customer being served.
   */
  @OnEvent("order.status_changed")
  async onOrderStatusChanged(ev: {
    orderId?: string;
    tenantId?: string;
    locationId?: string;
    toStatus?: string;
  }): Promise<void> {
    if (!ev.orderId || !ev.toStatus) return;
    const commit = COMMITTED.has(ev.toStatus);
    const undo = UNDONE.has(ev.toStatus);
    if (!commit && !undo) return;
    try {
      await this.syncOrder(ev.orderId, undo ? "undo" : "commit");
    } catch (err) {
      this.logger.warn(`Stock sync for order ${ev.orderId} failed: ${(err as Error).message}`);
    }
  }

  async syncOrder(orderId: string, direction: "commit" | "undo"): Promise<number> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        location: { select: { businessType: true } },
        items: { select: { id: true, menuItemId: true, quantity: true, metadata: true } },
      },
    });
    if (!order?.locationId || !isRetailType(order.location?.businessType)) return 0;

    const itemIds = [...new Set(order.items.map((i) => i.menuItemId).filter(Boolean))] as string[];
    const explicitIds = order.items
      .map((i) => (i.metadata as any)?.variantId)
      .filter((v): v is string => typeof v === "string");
    if (!itemIds.length && !explicitIds.length) return 0;

    const variants: VariantRef[] = await this.prisma.productVariant.findMany({
      where: {
        tenantId: order.tenantId,
        OR: [{ menuItemId: { in: itemIds } }, { id: { in: explicitIds } }],
      },
      select: { id: true, menuItemId: true, sku: true, trackStock: true },
    });
    const byItem = new Map<string, VariantRef[]>();
    const byId = new Map<string, VariantRef>();
    for (const v of variants) {
      byId.set(v.id, v);
      byItem.set(v.menuItemId, [...(byItem.get(v.menuItemId) ?? []), v]);
    }

    // Undo only reverses what a commit actually took — if the sale never
    // deducted (cancelled while still PENDING) there is nothing to give back.
    const committed =
      direction === "undo"
        ? new Set(
            (
              await this.prisma.productStockMovement.findMany({
                where: { orderId, dedupeKey: { startsWith: "sale:" } },
                select: { dedupeKey: true },
              })
            ).map((m) => m.dedupeKey),
          )
        : null;

    const moves: StockMove[] = [];
    for (const line of order.items) {
      const v = resolveVariantForLine(line, byItem, byId);
      if (!v?.trackStock) continue;
      const saleKey = `sale:${line.id}`;
      if (direction === "commit") {
        moves.push({
          tenantId: order.tenantId,
          locationId: order.locationId,
          variantId: v.id,
          type: "SALE_DEDUCTION",
          quantity: -line.quantity,
          orderId,
          dedupeKey: saleKey,
        });
      } else if (committed!.has(saleKey)) {
        moves.push({
          tenantId: order.tenantId,
          locationId: order.locationId,
          variantId: v.id,
          type: "ADJUSTMENT",
          quantity: line.quantity,
          reason: "Sale cancelled",
          orderId,
          dedupeKey: `unsale:${line.id}`,
        });
      }
    }
    return this.applyMoves(moves);
  }
}
