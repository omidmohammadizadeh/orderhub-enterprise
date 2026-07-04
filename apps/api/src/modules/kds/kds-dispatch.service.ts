// Phase KD — wires the KDS into the order lifecycle.
//
//   ACCEPTED   → dispatch station tickets now, unless the order is scheduled
//                for later (KdsFireCron creates those tickets at fire time =
//                scheduled time − prep − buffer, so the screen isn't
//                cluttered for hours).
//   CANCELLED/REJECTED/FAILED → void the tickets (screens drop them).
//   READY/COMPLETED (from the POS, not the KDS itself) → auto-bump anything
//                still open so screens never show stale tickets.
//
// KDS-driven progressions run through OrdersService.updateStatus with
// actorType SYSTEM — so the existing platform syncs fire exactly as if the
// operator tapped the POS (Uber /ready, Deliveroo prep_stage, WhatsApp
// notifications, printing…). The hook is installed on KdsService at module
// init to keep OrdersModule → KdsModule one-way.

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { KdsService } from "./kds.service";

interface OrderStatusChangedEvent {
  orderId: string;
  tenantId: string;
  locationId: string;
  fromStatus: string;
  toStatus: string;
  actorType?: string;
}

/** Fire scheduled tickets this many minutes before prep needs to start. */
const FIRE_BUFFER_MINUTES = 5;

@Injectable()
export class KdsDispatchService implements OnModuleInit {
  private readonly logger = new Logger(KdsDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly kds: KdsService,
  ) {}

  onModuleInit() {
    this.kds.onOrderProgress = async (orderId, status) => {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { tenantId: true, status: true },
      });
      if (!order || order.status === status) return;
      await this.orders.updateStatus(
        orderId,
        order.tenantId,
        { status } as any,
        "kds",
        "SYSTEM",
      );
    };
  }

  @OnEvent("order.items_edited")
  async onItemsEdited(ev: {
    orderId: string;
    locationId: string;
  }): Promise<void> {
    try {
      await this.kds.resyncOrderTickets(ev.orderId, ev.locationId);
    } catch (err: any) {
      this.logger.error(
        `KDS resync failed for edited order ${ev.orderId}: ${err?.message ?? err}`,
      );
    }
  }

  @OnEvent("order.status_changed")
  async onStatusChanged(ev: OrderStatusChangedEvent): Promise<void> {
    try {
      switch (ev.toStatus) {
        case "ACCEPTED": {
          const order = await this.prisma.order.findUnique({
            where: { id: ev.orderId },
            select: {
              scheduledFor: true,
              location: { select: { prepTime: true } },
            },
          });
          if (!order) return;
          if (
            order.scheduledFor &&
            order.scheduledFor.getTime() > Date.now() + this.leadMs(order)
          ) {
            // KdsFireCron creates the tickets when the slot approaches.
            return;
          }
          await this.kds.dispatchOrderToScreens(ev.orderId, ev.locationId);
          return;
        }
        case "CANCELLED":
        case "REJECTED":
        case "FAILED":
          await this.kds.voidTicketsForOrder(ev.orderId, ev.toStatus);
          return;
        case "READY":
        case "COMPLETED":
          // POS raced the kitchen (or a platform webhook completed the
          // order) — clear any open tickets. Idempotent for KDS-driven
          // READY transitions (their tickets are already bumped).
          await this.kds.bumpAllForOrder(ev.orderId);
          return;
        default:
          return;
      }
    } catch (err: any) {
      this.logger.error(
        `KDS dispatch failed for order ${ev.orderId} → ${ev.toStatus}: ${err?.message ?? err}`,
      );
    }
  }

  /** How long before the scheduled slot tickets should appear (ms). */
  leadMs(order: { location: { prepTime: number | null } | null }): number {
    const prep = order.location?.prepTime ?? 15;
    return (prep + FIRE_BUFFER_MINUTES) * 60_000;
  }
}
