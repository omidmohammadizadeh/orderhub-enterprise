import { Injectable } from "@nestjs/common";
import type { Prisma } from "@orderhub/database";

export type OutboxEventInput = Prisma.OutboxEventCreateInput;

@Injectable()
export class OutboxService {
  /**
   * Builds the Prisma create input for an "order received" outbox event.
   * Include this inside a prisma.$transaction alongside the order.create.
   *
   * idempotencyKey mirrors the order's own deduplication key so concurrent
   * webhook replays that trigger a P2002 on the order will also produce a
   * P2002 on the outbox event, keeping the two in sync.
   */
  forOrderReceived(
    tenantId: string,
    locationId: string,
    orderId: string,
    platform: string,
    externalId: string,
  ): OutboxEventInput {
    return {
      tenantId,
      locationId,
      aggregateType: "order",
      aggregateId: orderId,
      eventType: "order.received",
      payload: { orderId, tenantId, locationId } as Prisma.InputJsonValue,
      idempotencyKey: `recv-${platform}-${externalId}`,
    };
  }

  /**
   * Builds the Prisma create input for an "order status changed" outbox event.
   * Include this inside the prisma.$transaction that updates the order status.
   *
   * The state machine guarantees each (orderId, toStatus) combination is unique
   * across the order lifecycle, so the idempotency key never collides.
   */
  forStatusChanged(
    tenantId: string,
    locationId: string,
    orderId: string,
    fromStatus: string,
    toStatus: string,
    cancelReason?: string,
  ): OutboxEventInput {
    return {
      tenantId,
      locationId,
      aggregateType: "order",
      aggregateId: orderId,
      eventType: "order.status_changed",
      payload: {
        orderId,
        tenantId,
        locationId,
        fromStatus,
        toStatus,
        ...(cancelReason ? { cancelReason } : {}),
      } as Prisma.InputJsonValue,
      idempotencyKey: `status-${orderId}-${toStatus}`,
    };
  }
}
