// Phase AU — push internal status transitions back to HubRise.
//
// When an operator clicks Accept / Mark Preparing / Out for Delivery /
// etc. on an order that originated from HubRise (Order.viaHubrise=true),
// we POST the new status to HubRise so every downstream channel
// (Uber Eats, Deliveroo, Just Eat) sees the same lifecycle the
// operator sees in our dashboard.
//
// All HubRise calls are fire-and-forget — a network blip mustn't roll
// back the status change in our DB, because the bag still has to leave
// the kitchen either way. Failures are logged and surfaced via the
// audit log so ops can replay later if needed.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";

// Our canonical OrderStatus → HubRise's `new_state` value.
// Sources:
//   - HubRise docs: /v1/orders/{id} accepts a `new_state` from the
//     list new | received | accepted | in_preparation |
//     awaiting_shipment | awaiting_collection | in_delivery |
//     completed | cancelled | rejected | delivery_failed.
//   - Our OrderStatus enum is defined in @orderhub/database.
//
// Statuses that don't have a 1:1 mapping (e.g. our "READY" which can
// mean "kitchen done, awaiting either pickup or driver") fall through
// to the closest HubRise equivalent based on fulfillmentType.
const STATIC_MAP: Record<string, string> = {
  ACCEPTED: "accepted",
  PREPARING: "in_preparation",
  OUT_FOR_DELIVERY: "in_delivery",
  DISPATCHED: "in_delivery",
  COMPLETED: "completed",
  DELIVERED: "completed",
  CANCELLED: "cancelled",
  REJECTED: "rejected",
};

@Injectable()
export class HubRiseOrderSyncService {
  private readonly logger = new Logger(HubRiseOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly credentialEncryption: CredentialEncryptionService,
  ) {}

  /**
   * Best-effort push of a status change to HubRise. Caller never awaits
   * a failure — this throws ONLY for genuinely unrecoverable misuses
   * (missing internal ids), which are caller bugs. Network / 4xx / 5xx
   * from HubRise are logged and swallowed.
   */
  async pushStatus(args: {
    orderId: string;
    newStatus: string;
    fulfillmentType?: string;
  }): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: args.orderId },
      select: {
        id: true,
        viaHubrise: true,
        externalId: true,
        locationId: true,
        fulfillmentType: true,
      },
    });
    if (!order) {
      this.logger.warn(`pushStatus called with unknown orderId ${args.orderId}`);
      return;
    }
    if (!order.viaHubrise || !order.externalId || !order.locationId) {
      // Not a HubRise order — nothing to do.
      return;
    }

    const hubriseState = this.mapStatus(
      args.newStatus,
      args.fulfillmentType ?? order.fulfillmentType,
    );
    if (!hubriseState) {
      this.logger.debug(
        `Internal status ${args.newStatus} has no HubRise equivalent — skipping push for order ${order.id}`,
      );
      return;
    }

    const location = await this.prisma.location.findUnique({
      where: { id: order.locationId },
      select: { hubriseCredentials: true, hubriseLocationId: true },
    });
    if (!location?.hubriseCredentials || !location?.hubriseLocationId) {
      this.logger.warn(
        `HubRise order ${order.externalId} has no saved credentials at location ${order.locationId} — cannot push status`,
      );
      return;
    }

    const decrypted = this.credentialEncryption.decrypt(
      location.hubriseCredentials as Record<string, unknown>,
    ) as Record<string, string>;
    const accessToken = decrypted.accessToken;
    if (!accessToken) {
      this.logger.warn(
        `HubRise order ${order.externalId} location has credentials envelope but no accessToken`,
      );
      return;
    }

    const baseUrl =
      this.config.get<string>("app.platforms.hubrise.baseUrl") ??
      "https://api.hubrise.com/v1";
    const url = `${baseUrl}/orders/${encodeURIComponent(order.externalId)}`;

    try {
      const res = await fetch(url, {
        // HubRise uses PATCH /v1/orders/{id} for status updates, not
        // POST. Per their docs the body is { new_state: "..." }; older
        // examples on the web sometimes show POST which 404s on prod.
        method: "PATCH",
        headers: {
          "X-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ new_state: hubriseState }),
      });
      if (!res.ok) {
        const body = await res.text();
        this.logger.error(
          `HubRise status push failed for order ${order.externalId} → ${hubriseState}: ${res.status} ${body}`,
        );
        return;
      }
      this.logger.log(
        `HubRise status pushed: order ${order.externalId} → ${hubriseState}`,
      );
    } catch (err: any) {
      this.logger.error(
        `HubRise status push errored for order ${order.externalId}: ${err?.message}`,
      );
    }
  }

  // ── Mapping ────────────────────────────────────────────────────────

  private mapStatus(
    internalStatus: string,
    fulfillmentType: string,
  ): string | null {
    const direct = STATIC_MAP[internalStatus];
    if (direct) return direct;

    // READY is fulfillment-dependent. Collection orders → "awaiting
    // collection". Delivery orders → "awaiting shipment" so a courier
    // dispatcher knows the food is ready to leave.
    if (internalStatus === "READY") {
      return fulfillmentType === "PICKUP" || fulfillmentType === "COLLECTION"
        ? "awaiting_collection"
        : "awaiting_shipment";
    }

    return null;
  }
}
