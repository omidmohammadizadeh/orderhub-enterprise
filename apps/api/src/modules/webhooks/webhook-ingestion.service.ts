import {
  Injectable,
  Logger,
  UnauthorizedException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { WebhookAdapterFactory } from "./webhook-adapter.factory";
import { CredentialEncryptionService } from "../integrations/credential-encryption.service";

export interface IngestWebhookOptions {
  platform: string;
  locationId: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  payload?: unknown; // optional pre-parsed payload; parsed from rawBody when absent
}

@Injectable()
export class WebhookIngestionService {
  private readonly logger = new Logger(WebhookIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly adapterFactory: WebhookAdapterFactory,
    private readonly encryption: CredentialEncryptionService,
  ) {}

  async ingest(opts: IngestWebhookOptions) {
    const { platform, locationId, rawBody, headers } = opts;

    // 1. Resolve adapter — throws early for unknown platforms
    const adapter = this.adapterFactory.get(platform);
    if (!adapter) throw new Error(`No adapter registered for platform: ${platform}`);

    // 2. Resolve tenantId + webhook secret. HubRise is the special
    //    case: AU stores its access token on Location.hubriseCredentials
    //    (not the Integration table), and the webhook secret usually
    //    isn't given out — HubRise simply trusts the connection. Look
    //    the location up directly and skip the Integration lookup for
    //    HUBRISE; everything else stays on the original path.
    let tenantId: string;
    let secret = "";
    let skipSignature = false;
    // HubRise order webhooks are metadata-only (order id, no line items);
    // we fetch the full order below. Capture the creds that fetch needs.
    let hubriseCredentialsBlob: unknown = null;
    let hubriseLocationId: string | null = null;
    if (platform === "HUBRISE") {
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, deletedAt: null },
        include: { brand: { select: { tenantId: true } } },
      });
      if (!loc || !(loc as any).hubriseCredentials) {
        throw new NotFoundException(
          `HubRise is not connected for location ${locationId}`,
        );
      }
      tenantId = loc.brand.tenantId;
      hubriseCredentialsBlob = (loc as any).hubriseCredentials;
      hubriseLocationId = (loc as any).hubriseLocationId ?? null;
      // HUBRISE_WEBHOOK_SECRET is an optional global override. When
      // unset (the common case — HubRise doesn't issue per-integration
      // webhook secrets by default) we accept the body without HMAC
      // verification and log it so it's still auditable. Real
      // authenticity comes from the path token: only HubRise knows
      // which locationId we paired to which token, so an attacker
      // would have to guess both.
      secret = process.env.HUBRISE_WEBHOOK_SECRET ?? "";
      if (!secret) {
        skipSignature = true;
        this.logger.warn(
          `HubRise webhook accepted without signature verification (HUBRISE_WEBHOOK_SECRET not set)`,
        );
      }
    } else {
      const integration = await this.prisma.integration.findFirst({
        where: { locationId, platform: platform as any, status: "ACTIVE" },
        include: {
          location: { include: { brand: { select: { tenantId: true } } } },
        },
      });
      if (!integration) {
        throw new NotFoundException(
          `No active integration for ${platform}/${locationId}`,
        );
      }
      const credentials = this.encryption.decrypt(
        integration.credentials as Record<string, unknown>,
      ) as Record<string, string>;
      secret = credentials.webhookSecret ?? credentials.secret ?? "";
      tenantId = integration.location.brand.tenantId;
    }

    // 4. Verify signature (HubRise without a secret is an explicit
    //    bypass — see step 2). Anything else MUST pass HMAC.
    if (!skipSignature) {
      const { valid, reason } = adapter.verifySignature(rawBody, headers, secret);
      if (!valid) {
        this.logger.warn(`Webhook signature invalid for ${platform}: ${reason}`);
        throw new UnauthorizedException(`Invalid webhook signature: ${reason}`);
      }
    }

    // 5. Parse payload
    let payload: unknown = opts.payload ?? (() => {
      try {
        return JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new Error("Webhook body is not valid JSON");
      }
    })();

    // 5b. HubRise order webhooks carry only the event envelope (an order
    // id, NO line items), so the adapter's normalize() would drop them.
    // Fetch the full order and merge it in — the same thing the global
    // /integrations/hubrise/webhook receiver does, but here so the
    // per-location URL we actually register with HubRise works without a
    // reconnect. Log the raw envelope so the exact HubRise field shape is
    // visible if anything still looks off.
    if (platform === "HUBRISE") {
      this.logger.log(
        `HubRise webhook envelope: ${JSON.stringify(payload).slice(0, 700)}`,
      );
      const env = (payload ?? {}) as Record<string, any>;

      // The 700-character slice above cuts off before `new_state` on every
      // real payload, so the raw line shows only where an order HAS BEEN, never
      // where it is going. This says the transition itself.
      //
      // It is also how we answer whether Just Eat's "don't cook / cook now"
      // signal reaches us at all. HubRise's own status vocabulary has no such
      // concept, so if it arrives it must be either a transition we are not
      // expecting or a field we do not read — and both show up here.
      //
      // Status values and FIELD NAMES only. No customer data.
      {
        const prev = env.previous_state ?? {};
        const next = env.new_state ?? {};
        const KNOWN = new Set([
          "id", "location_id", "ref", "private_ref", "status", "service_type",
          "service_type_ref", "created_at", "created_by", "channel",
          "connection_name", "expected_time", "expected_time_pickup", "asap",
          "confirmed_time", "driver_pickup_url", "customer_notes",
          "seller_notes", "collection_code", "coupon_codes", "total",
          "total_discrepancy", "payments", "items", "customer", "deliveries",
          "customer_list_id", "loyalty_operations", "charges", "discounts",
          "deleted_items", "currency", "temporary_id",
        ]);
        const unknown = Object.keys(next).filter((k) => !KNOWN.has(k));
        this.logger.log(
          `HubRise ${env.resource_type}/${env.event_type} order=${env.order_id ?? "?"} ` +
            `status ${prev.status ?? "-"} → ${next.status ?? "-"} ` +
            `service=${next.service_type ?? prev.service_type ?? "-"} ` +
            `by=${next.created_by ?? prev.created_by ?? "-"}` +
            (unknown.length ? ` UNREAD_FIELDS=${unknown.join(",")}` : ""),
        );
      }

      // Courier/driver updates arrive as their OWN resource_type:"delivery"
      // webhook (driver name, phone, PIN, ETA + stage: pending → pickup_* →
      // dropoff_* → delivered). They must NOT go through the order-enrich
      // path below — that fetches the order and dedups the event against the
      // order-create (extractEventId collapses to the order id), silently
      // dropping every rider update. Route them straight to the courier sync
      // (Phase AV-2), the same handler the global receiver uses.
      if (
        env.resource_type === "delivery" &&
        (env.event_type === "create" || env.event_type === "update")
      ) {
        if (!hubriseLocationId) {
          this.logger.warn(
            `HubRise delivery webhook for location ${locationId} has no hubriseLocationId — ignoring`,
          );
          return { ignored: true };
        }
        try {
          const result = await this.orders.handleHubriseDelivery({
            hubriseOrderId: env.order_id ?? env.new_state?.order_id,
            // The delivery's own id lives in new_state.id — the envelope's
            // top-level `id` is the EVENT id, not the delivery id.
            hubriseDeliveryId:
              env.new_state?.id ?? env.delivery_id ?? env.resource_id,
            ourLocationId: locationId,
            hubriseLocationId,
            credentialsBlob: hubriseCredentialsBlob,
            inlineDelivery: env.new_state ?? null,
          });
          return { duplicate: false, ...result };
        } catch (err: any) {
          // 200 + reason so HubRise stops retrying a malformed event; the
          // error is logged for the operator.
          this.logger.error(
            `HubRise delivery webhook failed: ${err?.message ?? err}`,
          );
          return { ignored: true, reason: err?.message ?? String(err) };
        }
      }

      payload = await this.enrichHubRiseOrderPayload(
        payload,
        hubriseCredentialsBlob,
        hubriseLocationId,
      );
    }

    // 6. Idempotency — check via create + catch P2002 (prevents TOCTOU race)
    const externalEventId =
      adapter.extractEventId(payload, headers) || `${platform}-${Date.now()}`;

    let event: { id: string };
    try {
      event = await this.prisma.webhookEvent.create({
        data: {
          platform,
          externalEventId,
          signature:
            (headers["x-uber-signature"] ??
              headers["deliveroo-signature"] ??
              headers["x-je-signature"] ??
              headers["x-hubrise-signature"] ??
              null) as string | null,
          rawPayload: payload as any,
        },
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        this.logger.debug(`Duplicate webhook ignored: ${platform}/${externalEventId}`);
        return { duplicate: true };
      }
      throw err;
    }

    // 7. Normalize to canonical form
    const canonical = adapter.normalize(payload, locationId);
    if (!canonical) {
      this.logger.debug(`Non-order webhook skipped: ${platform}/${externalEventId}`);
      return { ignored: true };
    }

    // 8. Ingest order (outbox pattern — no direct queue call)
    try {
      const order = await this.orders.ingestCanonical(canonical, tenantId, locationId);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { orderId: order.id, processedAt: new Date() },
      });
      return { duplicate: false, orderId: order.id };
    } catch (err) {
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processingError: String(err) },
      });
      throw err;
    }
  }

  /**
   * HubRise sends order webhooks as an event envelope with only an order
   * id — no line items. Fetch the full order via the location's HubRise
   * token and merge it over the envelope so the adapter can normalise it.
   * Tolerant on the id field (order_id / resource_id) since HubRise's docs
   * have understated payload shapes before; if there's no order id or the
   * body already has items, the payload is returned untouched.
   */
  private async enrichHubRiseOrderPayload(
    payload: unknown,
    credentialsBlob: unknown,
    hubriseLocationId: string | null,
  ): Promise<unknown> {
    const p = (payload ?? {}) as Record<string, any>;
    if (Array.isArray(p.items)) return payload; // already a full order body
    const orderId: string | undefined = p.order_id ?? p.resource_id;
    if (!orderId) return payload; // not an order event we can hydrate

    if (!credentialsBlob || !hubriseLocationId) {
      this.logger.warn(
        `HubRise order ${orderId} can't be hydrated — missing token/locationId`,
      );
      return payload;
    }
    const decrypted = this.encryption.decrypt(
      credentialsBlob as Record<string, unknown>,
    ) as Record<string, string>;
    const accessToken = decrypted?.accessToken;
    if (!accessToken) return payload;

    const baseUrl = process.env.HUBRISE_BASE_URL ?? "https://api.hubrise.com/v1";
    // HubRise's REST API is case-sensitive on the location segment.
    const url = `${baseUrl}/locations/${encodeURIComponent(
      hubriseLocationId.toLowerCase(),
    )}/orders/${encodeURIComponent(orderId)}`;
    const res = await fetch(url, { headers: { "X-Access-Token": accessToken } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Throw → 5xx → HubRise retries. Common cause: token revoked.
      throw new Error(
        `HubRise order fetch ${res.status} for ${orderId}: ${text.slice(0, 200)}`,
      );
    }
    const order = (await res.json()) as Record<string, any>;
    this.logger.log(
      `HubRise order ${orderId} hydrated (${(order.items ?? []).length} items)`,
    );
    // Full order body wins; keep the envelope's event id for idempotency.
    return { ...p, ...order, event_id: p.id, order_id: orderId };
  }
}
