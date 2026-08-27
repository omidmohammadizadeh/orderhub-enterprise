// Phase AV-2 — HubRise delivery.create / delivery.update handler.
//
// When the marketplace courier (Uber Eats / Deliveroo / Just Eat)
// assigns, picks up, or drops off the order, HubRise emits a
// `resource_type: "delivery"` webhook. This service:
//
//   1. Resolves the matching local Order by `externalId = hubriseOrderId`.
//   2. Hydrates the full delivery resource from HubRise's REST API
//      if the event payload only ships the new_state stub.
//   3. Writes the courier-tracking columns onto the Order row.
//   4. Bumps Order.status to the equivalent of the courier's stage
//      (ASSIGNED_DRIVER / OUT_FOR_DELIVERY / COMPLETED / CANCELLED)
//      via OrdersService.updateStatus(actorType="WEBHOOK") so the
//      PLATFORM-gate the operator UI enforces is bypassed cleanly.
//
// We never write to HubRise from here — the courier flow is
// inbound-only. The kitchen flow (Accept / Mark preparing / Mark
// ready) still pushes to HubRise via the existing order-status-sync
// service.

import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { OrdersService } from "../../orders/orders.service";

interface DeliveryWebhookArgs {
  hubriseOrderId: string | undefined;
  hubriseDeliveryId: string | undefined;
  ourLocationId: string;
  hubriseLocationId: string;
  credentialsBlob: unknown;
  // Some webhook configurations inline the delivery shape under
  // `new_state`. When present we use it; otherwise we hydrate via
  // GET /locations/{loc}/deliveries/{id}.
  inlineDelivery: Record<string, any> | null | undefined;
}

interface HubRiseDelivery {
  id?: string;
  order_id?: string;
  status?: string;
  carrier?: string;
  driver_name?: string;
  driver_phone?: string;
  // HubRise's anonymised-call PIN for the courier. The marketplace
  // routes outgoing calls through a masking number; without this
  // code the carrier doesn't know which active delivery the call
  // belongs to and the call fails.
  driver_phone_access_code?: string;
  tracking_url?: string;
  assigned_at?: string;
  pickup_at?: string;
  delivered_at?: string;
  cancelled_at?: string;
  // ESTIMATES, as opposed to the actual times above. HubRise's own docs have
  // been wrong about field names twice on this integration, so every plausible
  // spelling is read and the raw object is kept until a real delivery settles
  // which one they actually send.
  // CONFIRMED from a live delivery payload, not guessed:
  //   estimated_pickup_at   — rider reaching the SHOP
  //   estimated_dropoff_at  — rider reaching the CUSTOMER
  // The other spellings stay as fallbacks; they cost nothing and HubRise's
  // documented names have been wrong on this integration before.
  estimated_pickup_at?: string;
  expected_pickup_at?: string;
  pickup_eta?: string;
  estimated_dropoff_at?: string;
  estimated_delivery_at?: string;
  expected_delivery_at?: string;
  delivery_eta?: string;
  // Allows the defensive reads below without widening every call site.
  [key: string]: unknown;
}

/** First value that parses as a real date. Undefined when none do. */
function firstDate(...values: Array<unknown>): Date | undefined {
  for (const v of values) {
    if (!v) continue;
    const d = new Date(String(v));
    if (Number.isFinite(d.getTime())) return d;
  }
  return undefined;
}

@Injectable()
export class HubRiseDeliverySyncService {
  private readonly logger = new Logger(HubRiseDeliverySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly credentialEncryption: CredentialEncryptionService,
    // OrdersService is forwardRef'd at the module level — same module
    // imports OrdersModule via forwardRef, OrdersModule imports
    // HubRiseModule via forwardRef. Nest needs the matching token
    // here too.
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
  ) {}

  async handleDeliveryWebhook(
    args: DeliveryWebhookArgs,
  ): Promise<{ orderId?: string; updated?: boolean; ignored?: boolean; reason?: string }> {
    if (!args.hubriseOrderId) {
      return { ignored: true, reason: "no_order_id_on_event" };
    }

    // Match the matching Order by externalId. HubRise's order_id is
    // exactly what the order-create webhook stored as externalId.
    // findFirst returns the full Order; we cast to `any` further down
    // to read the courier-timestamp columns the generated Prisma
    // client doesn't know about yet (added in migration AV-1).
    const orderRow = await this.prisma.order.findFirst({
      where: { externalId: args.hubriseOrderId, viaHubrise: true },
    });
    const order = orderRow as any;
    if (!order) {
      // Order hasn't landed yet (HubRise sometimes sends delivery
      // before order in fast flows) or it's for a different tenant.
      // 200 OK, ignore — next replay will find it.
      this.logger.warn(
        `Delivery webhook for unknown HubRise order ${args.hubriseOrderId} — ignoring`,
      );
      return { ignored: true, reason: "order_not_found" };
    }

    // Hydrate the full delivery if the payload doesn't include the
    // courier fields we need (driver name, tracking, status).
    let delivery: HubRiseDelivery = args.inlineDelivery ?? {};
    const haveCourierFields =
      delivery.status &&
      (delivery.driver_name || delivery.tracking_url || delivery.assigned_at);
    if (!haveCourierFields && args.hubriseDeliveryId) {
      try {
        delivery = await this.fetchDeliveryFromHubRise(
          args.hubriseLocationId,
          args.hubriseDeliveryId,
          args.credentialsBlob,
          args.hubriseOrderId,
        );
      } catch (err: any) {
        this.logger.error(
          `Failed to hydrate delivery ${args.hubriseDeliveryId}: ${err?.message}`,
        );
        // Continue with what we have — at minimum the status from the
        // event still lets us nudge the Order.status forward.
      }
    }

    const newOrderStatus = this.mapStatusToOrderStatus(delivery.status);

    // Write courier-tracking columns. Use a single update so a partial
    // failure can't leave half-populated rows. Timestamp fields are
    // only set when we don't already have them — HubRise sometimes
    // resends update events and we don't want to overwrite the
    // first-pickup timestamp with a later re-pickup event.
    const updates: Record<string, any> = {};
    if (delivery.driver_name) updates.courierName = delivery.driver_name;
    if (delivery.driver_phone) updates.courierPhone = delivery.driver_phone;
    if (delivery.driver_phone_access_code) {
      updates.courierPhoneAccessCode = delivery.driver_phone_access_code;
    }
    if (delivery.tracking_url) updates.courierTrackingUrl = delivery.tracking_url;
    if (delivery.status) updates.courierStatus = delivery.status;
    if (delivery.assigned_at && !(order as any).courierAssignedAt) {
      updates.courierAssignedAt = new Date(delivery.assigned_at);
    }
    if (delivery.pickup_at && !(order as any).courierPickedUpAt) {
      updates.courierPickedUpAt = new Date(delivery.pickup_at);
    }
    if (delivery.delivered_at && !(order as any).courierDeliveredAt) {
      updates.courierDeliveredAt = new Date(delivery.delivered_at);
    }

    // ── The two estimates, kept apart ────────────────────────────────────────
    //
    // Pickup is when the rider reaches the SHOP; delivery is when they reach
    // the CUSTOMER. The board's ETA column asks the first question, and
    // courierEtaAt drives auto-completion off the second — so conflating them
    // would close orders the moment a rider arrived at the door.
    //
    // Always overwritten rather than written once: an estimate that cannot
    // move is not an estimate, and a rider's ETA changes as they travel.
    const pickupEta = firstDate(
      delivery.estimated_pickup_at,
      delivery.expected_pickup_at,
      delivery.pickup_eta,
    );
    if (pickupEta) updates.courierPickupEtaAt = pickupEta;

    const deliveryEta = firstDate(
      delivery.estimated_dropoff_at,
      delivery.estimated_delivery_at,
      delivery.expected_delivery_at,
      delivery.delivery_eta,
    );
    if (deliveryEta) updates.courierEtaAt = deliveryEta;

    // Log the field names we actually received, once per delivery that has an
    // estimate we could not place. HubRise's docs have misnamed fields on this
    // integration twice; this turns the third time into a one-line fix rather
    // than another round of guessing. Keys only — no customer data.
    {
      const KNOWN = new Set([
        "estimated_pickup_at",
        "expected_pickup_at",
        "pickup_eta",
        "estimated_dropoff_at",
        "estimated_delivery_at",
        "expected_delivery_at",
        "delivery_eta",
      ]);
      const estimateish = Object.keys(delivery).filter(
        (k) => /eta|estimat|expect/i.test(k) && !KNOWN.has(k),
      );
      if (estimateish.length) {
        this.logger.warn(
          `HubRise delivery ${delivery.id ?? "?"} carries estimate fields we do ` +
            `not read: ${estimateish.join(", ")}`,
        );
      }
    }

    if (Object.keys(updates).length) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: updates as any,
      });
    }

    // Transition Order.status if the courier moved into a new stage
    // we care about.
    let statusChanged = false;
    if (newOrderStatus && newOrderStatus !== order.status) {
      try {
        await this.orders.updateStatus(
          order.id,
          order.tenantId,
          {
            status: newOrderStatus as any,
            cancelReason:
              newOrderStatus === "CANCELLED"
                ? "Courier cancelled the delivery"
                : undefined,
          } as any,
          "hubrise-delivery-webhook",
          "WEBHOOK",
        );
        statusChanged = true;
      } catch (err: any) {
        // If the transition is illegal for the current state (e.g.
        // courier_status arrived before order_status caught up),
        // log + swallow. We still wrote the courier columns above so
        // the dashboard renders the tracking info correctly.
        this.logger.warn(
          `Order ${order.id} transition to ${newOrderStatus} rejected: ${err?.message}`,
        );
      }
    }

    this.logger.log(
      `HubRise delivery → order ${order.id}: courier_status=${delivery.status ?? "?"} order_status=${newOrderStatus ?? "(unchanged)"} fields=${Object.keys(updates).length}`,
    );

    return {
      orderId: order.id,
      updated: Object.keys(updates).length > 0 || statusChanged,
    };
  }

  /**
   * GET /v1/locations/{hubriseLocationId}/deliveries/{deliveryId}.
   * Same auth pattern as the order fetch path — decrypt the envelope
   * once per call (no token cache yet, the volume doesn't warrant it).
   */
  private async fetchDeliveryFromHubRise(
    hubriseLocationId: string,
    deliveryId: string,
    credentialsBlob: unknown,
    hubriseOrderId?: string,
  ): Promise<HubRiseDelivery> {
    if (!credentialsBlob) {
      throw new Error("No HubRise credentials saved for this location");
    }
    const decrypted = this.credentialEncryption.decrypt(
      credentialsBlob as Record<string, unknown>,
    ) as Record<string, string>;
    const accessToken = decrypted.accessToken;
    if (!accessToken) {
      throw new Error("HubRise access token missing from credentials envelope");
    }
    const baseUrl =
      this.config.get<string>("app.platforms.hubrise.baseUrl") ??
      "https://api.hubrise.com/v1";
    // The flat path 404s with `routing_error` on every single delivery — that
    // is HubRise saying the ROUTE does not exist, not that the delivery is
    // missing. Deliveries hang off an order in their model, so the nested path
    // is tried first and the flat one kept as a fallback. Whichever answers is
    // logged, so the loser can be deleted once a real delivery has proved it.
    const loc = hubriseLocationId.toLowerCase();
    const candidates = [
      ...(hubriseOrderId
        ? [`${baseUrl}/locations/${loc}/orders/${hubriseOrderId}/deliveries/${deliveryId}`]
        : []),
      `${baseUrl}/locations/${loc}/deliveries/${deliveryId}`,
    ];

    let res!: Response;
    let url = candidates[candidates.length - 1]!;
    for (const candidate of candidates) {
      res = await fetch(candidate, {
        headers: {
          "X-Access-Token": accessToken,
          Accept: "application/json",
        },
      });
      url = candidate;
      if (res.ok) {
        this.logger.log(`HubRise delivery hydrate OK via ${candidate}`);
        break;
      }
    }
    if (!res.ok) {
      throw new Error(
        `HubRise GET ${url} → ${res.status}: ${await res.text()}`,
      );
    }
    return (await res.json()) as HubRiseDelivery;
  }

  /**
   * Map HubRise delivery status → our OrderStatus. Returns null when
   * we don't want to move the Order (e.g. `pending` — courier was
   * created but hasn't been assigned yet; status doesn't change).
   *
   * Mapping (per AV-1 plan + HubRise docs):
   *   pending             → no change
   *   pickup_*            → ASSIGNED_DRIVER
   *   dropoff_*           → OUT_FOR_DELIVERY
   *   delivered           → COMPLETED
   *   cancelled           → CANCELLED
   */
  private mapStatusToOrderStatus(
    courierStatus: string | undefined,
  ): string | null {
    if (!courierStatus) return null;
    if (courierStatus === "pending") return null;
    if (courierStatus.startsWith("pickup_")) return "ASSIGNED_DRIVER";
    if (courierStatus.startsWith("dropoff_")) return "OUT_FOR_DELIVERY";
    if (courierStatus === "delivered") return "COMPLETED";
    if (courierStatus === "cancelled") return "CANCELLED";
    return null;
  }
}
