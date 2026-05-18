import {
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { QUEUES } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { UberEatsAdapter } from "./adapters/uber-eats.adapter";
import { DeliverooAdapter } from "./adapters/deliveroo.adapter";
import { JustEatAdapter } from "./adapters/just-eat.adapter";
import { HubRiseAdapter } from "./adapters/hubrise.adapter";
import type { BaseWebhookAdapter } from "./adapters/base.adapter";

export interface IngestWebhookOptions {
  platform: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  tenantId: string;
  locationId: string;
}

@Injectable()
export class WebhookIngestionService {
  private readonly logger = new Logger(WebhookIngestionService.name);
  private readonly adapters: Map<string, BaseWebhookAdapter> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    @InjectQueue(QUEUES.WEBHOOK_DISPATCH) private readonly webhookQueue: Queue,
    uberEats: UberEatsAdapter,
    deliveroo: DeliverooAdapter,
    justEat: JustEatAdapter,
    hubrise: HubRiseAdapter,
  ) {
    this.adapters.set("UBER_EATS", uberEats);
    this.adapters.set("DELIVEROO", deliveroo);
    this.adapters.set("JUST_EAT", justEat);
    this.adapters.set("HUBRISE", hubrise);
  }

  async ingest(opts: IngestWebhookOptions) {
    const { platform, rawBody, headers, secret, tenantId, locationId } = opts;
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`No adapter registered for platform: ${platform}`);

    // 1. Verify signature
    const { valid, reason } = adapter.verifySignature(rawBody, headers, secret);
    if (!valid) {
      this.logger.warn(`Webhook signature invalid for ${platform}: ${reason}`);
      throw new UnauthorizedException(`Invalid webhook signature: ${reason}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new Error("Webhook body is not valid JSON");
    }

    // 2. Idempotency — check by (platform, externalEventId)
    const externalEventId = adapter.extractEventId(payload, headers) || `${platform}-${Date.now()}`;
    const existing = await this.prisma.webhookEvent.findUnique({
      where: { platform_externalEventId: { platform, externalEventId } },
    });
    if (existing) {
      this.logger.debug(`Duplicate webhook ignored: ${platform}/${externalEventId}`);
      return { duplicate: true };
    }

    // 3. Store raw event immediately (before processing so crashes don't re-process).
    // Use try/catch to handle P2002 from a concurrent duplicate webhook — same fix as ingestCanonical.
    let event: { id: string };
    try {
      event = await this.prisma.webhookEvent.create({
        data: {
          platform,
          externalEventId,
          signature: (headers["x-uber-signature"] ?? headers["deliveroo-signature"] ??
            headers["x-je-signature"] ?? headers["x-hubrise-signature"] ?? null) as string | null,
          rawPayload: payload as any,
        },
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        this.logger.warn(`Concurrent duplicate webhook for ${platform}/${externalEventId} — ignoring`);
        return { duplicate: true };
      }
      throw err;
    }

    // 4. Normalize to canonical form
    const canonical = adapter.normalize(payload, locationId);
    if (!canonical) {
      this.logger.debug(`Non-order webhook skipped: ${platform}/${externalEventId}`);
      return { ignored: true };
    }

    // 5. Ingest order
    try {
      const order = await this.orders.ingestCanonical(canonical, tenantId, locationId);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { orderId: order.id, processedAt: new Date() },
      });
      return { orderId: order.id };
    } catch (err) {
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processingError: String(err) },
      });
      throw err;
    }
  }
}
