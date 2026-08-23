import { Injectable, Logger } from "@nestjs/common";
import { OrdersService } from "../../orders/orders.service";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import {
  transformCareemOrder,
  type CareemNameLookup,
  type CareemOrder,
  type CareemOrderGroup,
} from "./careem-order.transformer";

// Phase CA-2 — a Careem notification becomes one of our orders.
//
// ── How a Careem branch finds its way to one of our shops ───────────────────
//
// It doesn't need a mapping table. Careem's brand and branch endpoints take an
// id "provided by vendor or restaurant" — we choose it — so we publish OUR
// Location id as the branch id and OUR Brand id as the brand id. An order then
// names the location it belongs to directly, and there is no join to drift.
//
// The same trick carries the menu: catalog item and option ids are our own
// MenuItem and ModifierOption ids, which is the only reason an order that
// carries no product names at all can still print a ticket.

/** Careem states → ours. Their courier lifecycle is richer than our board. */
const INBOUND_STATUS: Record<string, string | null> = {
  accepted: "ACCEPTED",
  // Scheduled-order warm-ups. Informational: acting on them would start
  // cooking hours early.
  slot_upcoming: null,
  slot_started: null,
  driver_coming: "ASSIGNED_DRIVER",
  driver_here: "RIDER_ARRIVED",
  trip_started: "OUT_FOR_DELIVERY",
  trip_ended: "COMPLETED",
  cancelled: "CANCELLED",
};

/** Ours → the three states Careem's PUT /orders/{id} accepts. */
const OUTBOUND_STATE: Record<string, "accepted" | "ready" | "cancelled" | null> = {
  ACCEPTED: "accepted",
  // Their `ready` means "ready for pickup", which is what our READY means and
  // what tells their captain to set off. PREPARING has no counterpart.
  PREPARING: null,
  READY: "ready",
  CANCELLED: "cancelled",
  REJECTED: "cancelled",
};

@Injectable()
export class CareemOrderService {
  private readonly logger = new Logger(CareemOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * Take an ORDER_CREATED notification and land it on the board.
   *
   * Idempotent through ingestCanonical, which is create-only and keyed on
   * (externalId, platform). That matters more here than elsewhere: Careem
   * retries a webhook up to five times, and their notifications carry no
   * signature over the body, so a replay is indistinguishable from a fresh
   * delivery.
   */
  async ingest(order: CareemOrder): Promise<{ orderId: string } | null> {
    const branchId = String(order.branch?.id ?? "");
    const location = branchId
      ? await this.prisma.location.findFirst({
          where: { id: branchId, deletedAt: null },
          select: { id: true, country: true, brand: { select: { tenantId: true } } },
        })
      : null;

    if (!location) {
      // Not retryable — it will not resolve on the fifth attempt either. Loud,
      // because it means a branch was published to Careem that no longer
      // exists here, and every order for it is being dropped.
      this.logger.error(
        `Careem order ${order.id} names branch "${branchId}", which matches no location. ` +
          `Dropping. Re-publish the branch or check the id we registered with Careem.`,
      );
      return null;
    }

    const names = await this.nameLookup(order);
    const canonical = transformCareemOrder(order, names, {
      country: location.country ?? "AE",
    });

    const created = await this.orders.ingestCanonical(
      canonical,
      location.brand.tenantId,
      location.id,
    );
    this.logger.log(
      `Careem order ${order.id} ingested as ${created.id} at ${location.id}`,
    );
    return { orderId: created.id };
  }

  /**
   * Mirror a Careem status change onto our order.
   *
   * Only states that mean something to a kitchen are applied — see
   * INBOUND_STATUS. WEBHOOK is the actor so the transition guard allows the
   * courier lifecycle to outrun our own kitchen state, which it routinely
   * does: a captain can arrive while the board still says PREPARING.
   */
  async applyStatus(order: CareemOrder): Promise<void> {
    const next = INBOUND_STATUS[String(order.status ?? "")];
    if (!next) {
      this.logger.log(
        `Careem order ${order.id} is "${order.status}" — nothing to apply`,
      );
      return;
    }
    const existing = await this.prisma.order.findFirst({
      where: { externalId: String(order.id), platform: "CAREEM" as any },
      select: { id: true, tenantId: true, status: true },
    });
    if (!existing) {
      this.logger.warn(
        `Careem status "${order.status}" for order ${order.id}, which we have not ingested`,
      );
      return;
    }
    if (existing.status === next) return;

    await this.orders
      .updateStatus(
        existing.id,
        existing.tenantId,
        {
          status: next as any,
          ...(order.cancellation_reason
            ? { cancelReason: order.cancellation_reason }
            : {}),
        } as any,
        // changedBy — Careem, not a member of staff. The status history shows
        // where the change actually came from.
        "careem",
        "WEBHOOK" as any,
      )
      .catch((err: Error) =>
        // A refused transition is information, not a failure — Careem's
        // lifecycle and ours will not always agree on order, and their retries
        // must not be provoked by our own state machine.
        this.logger.warn(
          `Careem status ${existing.status} → ${next} refused for ${existing.id}: ${err.message}`,
        ),
      );
  }

  /** Which of Careem's three accepted states, if any, our status maps to. */
  static outboundState(status: string) {
    return OUTBOUND_STATE[status] ?? null;
  }

  /**
   * Resolve product and option names from our own menu.
   *
   * Careem sends ids and nothing else. The ids are ours — we published them —
   * so this is a direct lookup rather than a fuzzy match, and anything missing
   * simply isn't found: the transformer prints the id instead of dropping the
   * line.
   */
  private async nameLookup(order: CareemOrder): Promise<CareemNameLookup> {
    const itemIds = new Set<string>();
    const optionIds = new Set<string>();
    // Options can carry their own groups, arbitrarily deep — Careem supports
    // nested modifiers natively — so collecting ids is a walk, not a loop.
    const walk = (groups: CareemOrderGroup[] | undefined): void => {
      for (const g of groups ?? []) {
        for (const o of g.options ?? []) {
          if (o.id) optionIds.add(String(o.id));
          if (o.groups?.length) walk(o.groups);
        }
      }
    };
    for (const line of order.items ?? []) {
      if (line.id) itemIds.add(String(line.id));
      walk(line.groups);
    }

    const [items, options] = await Promise.all([
      itemIds.size
        ? this.prisma.menuItem.findMany({
            where: { id: { in: [...itemIds] } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      optionIds.size
        ? (this.prisma as any).modifierOption.findMany({
            where: { id: { in: [...optionIds] } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const itemNames = new Map(items.map((i) => [i.id, i.name]));
    const optionNames = new Map(
      (options as Array<{ id: string; name: string }>).map((o) => [o.id, o.name]),
    );
    return {
      item: (id) => itemNames.get(id),
      option: (id) => optionNames.get(id),
    };
  }
}
