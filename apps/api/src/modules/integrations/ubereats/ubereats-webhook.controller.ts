import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Post,
  Req,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { ApiTags } from "@nestjs/swagger";
import { Public } from "../../../common/decorators/public.decorator";
import { BillingExempt } from "../../../common/guards/billing.guard";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { UberEatsClientService } from "./ubereats-client.service";
import { UberEatsConnectionService } from "./ubereats-connection.service";
import { UberEatsMenuPublishService } from "./ubereats-menu-publish.service";
import { UberEatsOrderService } from "./ubereats-order.service";
import { ActivityLogService } from "../../logs/activity-log.service";

// Phase UE-1 — Uber Eats inbound webhook receiver.
//
// Uber POSTs every event here (orders.notification, orders.cancel,
// store.provisioned, store.deprovisioned, menu refresh requests, …).
// Contract (webhooks guide): reply 200 fast; Uber retries non-2xx with
// exponential backoff up to 7 attempts. Signature: X-Uber-Signature =
// lowercase hex HMAC-SHA256 of the raw body keyed with the client secret.
//
// Same discipline as the Deliveroo receiver: ALWAYS 200, verify HMAC,
// record the event idempotently (event_id / X-Uber-Request-UUID), route the
// first valid delivery, and swallow handler failures so Uber never sees a
// non-200 for something we can retry internally.
@ApiTags("ubereats")
@Controller({ path: "integrations/ubereats", version: "1" })
export class UberEatsWebhookController {
  private readonly logger = new Logger(UberEatsWebhookController.name);

  constructor(
    private readonly client: UberEatsClientService,
    private readonly prisma: PrismaService,
    private readonly connections: UberEatsConnectionService,
    private readonly menuPublish: UberEatsMenuPublishService,
    private readonly orderRouter: UberEatsOrderService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  @Public()
  @BillingExempt()
  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-uber-signature") signature: string,
    @Headers("x-uber-request-uuid") requestUuid: string,
  ) {
    const raw: Buffer =
      req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

    let body: any = {};
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      /* keep {} */
    }

    const event: string = body?.event_type ?? body?.type ?? "unknown";
    const eventId: string =
      body?.event_id ??
      body?.webhook_meta?.webhook_msg_uuid ??
      body?.id ??
      requestUuid ??
      "";
    const valid = this.client.verifyWebhookSignature(raw, signature);

    // Idempotent record — Uber retries reuse the same event id, so a
    // duplicate must not re-run the handler (create-catch-P2002 gives the
    // clean "first delivery" signal; safe here because it's NOT inside a
    // wrapping transaction).
    let firstSeen = false;
    if (eventId) {
      try {
        await this.prisma.webhookEvent.create({
          data: {
            platform: "UBER_EATS",
            externalEventId: eventId,
            signature: signature ?? null,
            rawPayload: body,
            metadata: { event, valid },
          },
        });
        firstSeen = true;
      } catch (e: any) {
        if (e?.code !== "P2002") {
          this.logger.warn(`Uber Eats webhook persist failed: ${e?.message}`);
        }
      }
    }

    this.logger.log(
      `Uber Eats webhook event=${event} valid=${valid} first=${firstSeen} id=${eventId || "—"}`,
    );

    if (!valid && signature) {
      const diag = this.client.signatureDiagnostics();
      this.logger.error(
        `Uber Eats webhook REJECTED: signature did not verify (clientSecretSet=${diag.clientSecretSet} webhookSecretSet=${diag.webhookSecretSet}). ` +
          `Uber signs with the CLIENT SECRET — check UBER_EATS_CLIENT_SECRET matches the app that sent this. ` +
          `received=${String(signature).slice(0, 16)}… rawLen=${raw.length}`,
      );
    }

    // Route the first valid delivery. Best-effort — errors are logged, Uber
    // still gets its 200. Order events (UE-4) plug in here.
    if (valid && firstSeen) {
      try {
        const result = await this.route(event, body);
        if (result) {
          await this.prisma.webhookEvent
            .update({
              where: {
                platform_externalEventId: {
                  platform: "UBER_EATS",
                  externalEventId: eventId,
                },
              },
              data: {
                processedAt: new Date(),
                metadata: { event, valid, ...result },
              },
            })
            .catch(() => {
              /* best-effort bookkeeping */
            });
        }
      } catch (err: any) {
        this.logger.error(
          `Uber Eats webhook routing failed for ${event}/${eventId}: ${err?.message}`,
        );
      }
      // Phase LG — show the event AND our acknowledgment on the Logs page.
      // Uber's contract is "reply 200 fast"; this row is the proof per event.
      void this.logWebhookAck(event, eventId, body);
    }

    return { ok: true };
  }

  /**
   * Record "webhook received → acknowledged 200 OK" for the tenant that owns
   * the store. Best-effort: unknown stores (not connected here) are skipped.
   */
  private async logWebhookAck(
    event: string,
    eventId: string,
    body: any,
  ): Promise<void> {
    try {
      if (!this.activity) return;
      const storeId = String(
        body?.meta?.user_id ?? body?.store_id ?? body?.user_id ?? "",
      );
      if (!storeId) return;
      const conn = await this.prisma.brandPlatformConnection.findFirst({
        where: { platform: "UBER_EATS", externalStoreId: storeId },
        select: { tenantId: true, brandId: true, locationId: true },
      });
      if (!conn?.tenantId) return;
      const category = event.startsWith("orders.")
        ? "ORDERS"
        : event.startsWith("store.status")
          ? "STATUS"
          : event.includes("menu")
            ? "MENU"
            : "CONNECTION";
      this.activity.record({
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        category: category as any,
        channel: "UBER_EATS",
        action: `webhook.${event}`,
        status: "INFO",
        message: `Uber webhook "${event}" received → acknowledged 200 OK`,
        details: { eventId, storeId },
      });
    } catch {
      /* logging must never affect the 200 back to Uber */
    }
  }

  /** Event routing. UE-2 handles provisioning; UE-3/UE-4 extend this. */
  private async route(
    event: string,
    body: any,
  ): Promise<Record<string, unknown> | null> {
    switch (event) {
      case "store.provisioned":
      case "store.deprovisioned": {
        const storeId: string =
          body?.store_id ?? body?.resource_id ?? body?.user_id ?? "";
        if (!storeId) return { handled: false, reason: "no_store_id" };
        const connectionId = await this.connections.applyProvisioningEvent(
          storeId,
          event === "store.provisioned",
        );
        return { handled: true, connectionId };
      }
      case "eats.report.success": {
        // The receiver already recorded the payload (download URLs live in
        // rawPayload.report_metadata.sections); the reporting service joins
        // it with the tenant's requested jobs on read. Nothing else to do.
        const sections = body?.report_metadata?.sections?.length ?? 0;
        this.logger.log(
          `Uber Eats report ready: job=${body?.job_id ?? "?"} type=${body?.report_type ?? "?"} sections=${sections}`,
        );
        return { handled: true, sections };
      }
      case "store.menu_refresh_request": {
        const storeId: string = body?.store_id ?? body?.resource_id ?? "";
        if (!storeId) return { handled: false, reason: "no_store_id" };
        const result = await this.menuPublish.republishForStore(storeId);
        return { handled: true, ...result };
      }
      default: {
        // orders.notification / orders.cancel / orders.release /
        // order.fulfillment_issues.resolved → the order router.
        if (event.startsWith("order")) {
          const result = await this.orderRouter.route(event, body);
          return { ...result };
        }
        return { handled: false, reason: "no_handler" };
      }
    }
  }
}
