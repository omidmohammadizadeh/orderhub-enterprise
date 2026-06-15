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
    const payload: unknown = opts.payload ?? (() => {
      try {
        return JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new Error("Webhook body is not valid JSON");
      }
    })();

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
}
