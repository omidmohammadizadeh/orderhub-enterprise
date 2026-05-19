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

    // 2. Look up active integration to get webhook secret and tenantId
    const integration = await this.prisma.integration.findFirst({
      where: { locationId, platform: platform as any, status: "ACTIVE" },
      include: { location: { include: { brand: { select: { tenantId: true } } } } },
    });
    if (!integration) {
      throw new NotFoundException(`No active integration for ${platform}/${locationId}`);
    }

    // 3. Decrypt credentials (passthrough if plaintext — dev/test)
    const credentials = this.encryption.decrypt(
      integration.credentials as Record<string, unknown>,
    ) as Record<string, string>;
    const secret: string = credentials.webhookSecret ?? credentials.secret ?? "";
    const tenantId: string = integration.location.brand.tenantId;

    // 4. Verify signature
    const { valid, reason } = adapter.verifySignature(rawBody, headers, secret);
    if (!valid) {
      this.logger.warn(`Webhook signature invalid for ${platform}: ${reason}`);
      throw new UnauthorizedException(`Invalid webhook signature: ${reason}`);
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
