import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { Public } from "../../../common/decorators/public.decorator";
import { JetClientService } from "./jet-client.service";
import { JetLifecycleService } from "./jet-lifecycle.service";
import { JetMenuPublishService } from "./jet-menu-publish.service";
import { JetOrderModificationService } from "./jet-order-modification.service";

// Phase JE-2 — JET Connect lifecycle webhooks.
//
//   POST /v1/integrations/jet/cancel          → order cancelled
//   POST /v1/integrations/jet/driver-status   → driver moved
//   POST /v1/integrations/jet/store-status    → service type went offline/online
//   POST /v1/integrations/jet/failed-order    → JET rejected an order (backup flow)
//   POST /v1/integrations/jet/menu-callback   → asynchronous menu ingest result
//   POST /v1/integrations/jet/modification-callback → out-of-stock result
//
// TWO THINGS THESE DO DIFFERENTLY FROM THE ORDER WEBHOOK:
//
// 1. THEY MUST ECHO THE PAYLOAD BACK. The spec is explicit for all four:
//    "return a 200 status code and the same payload we sent you as
//    acknowledgement". A bare {ok:true} is a 400 to them. Every handler here
//    therefore returns `body` verbatim.
//
// 2. THEY CARRY NO HMAC. Only the Authorization header — the API key we issued
//    JET — authenticates them, so it is checked strictly and a mismatch is a
//    401 rather than a swallowed 200.
//
// JET retries 5× on a 5xx, so a handler failure is caught and still answered
// with the echo: reprocessing a cancellation or a driver stage gains nothing
// (updateStatus refuses to regress a terminal order, and courier timestamps
// are first-value-wins), while a 500 loop against a live shop costs everyone.
@ApiTags("jet")
@Controller({ path: "integrations/jet", version: "1" })
export class JetLifecycleController {
  private readonly logger = new Logger(JetLifecycleController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: JetClientService,
    private readonly lifecycle: JetLifecycleService,
    private readonly menu: JetMenuPublishService,
    private readonly modifications: JetOrderModificationService,
  ) {}

  @Public()
  @Post("cancel")
  @HttpCode(HttpStatus.OK)
  async cancel(@Body() body: any, @Headers("authorization") auth: string) {
    return this.handle("cancel", body, auth, (p) =>
      this.lifecycle.handleCancellation(p),
    );
  }

  @Public()
  @Post("driver-status")
  @HttpCode(HttpStatus.OK)
  async driverStatus(@Body() body: any, @Headers("authorization") auth: string) {
    return this.handle("driver-status", body, auth, (p) =>
      this.lifecycle.handleDriverStatus(p),
    );
  }

  @Public()
  @Post("store-status")
  @HttpCode(HttpStatus.OK)
  async storeStatus(@Body() body: any, @Headers("authorization") auth: string) {
    return this.handle("store-status", body, auth, (p) =>
      this.lifecycle.handleRestaurantTempOffline(p),
    );
  }

  @Public()
  @Post("failed-order")
  @HttpCode(HttpStatus.OK)
  async failedOrder(@Body() body: any, @Headers("authorization") auth: string) {
    return this.handle("failed-order", body, auth, (p) =>
      this.lifecycle.handleFailedOrder(p),
    );
  }

  /**
   * The asynchronous menu-ingest result.
   *
   * Lives here rather than with the publish service's own routes because this
   * is a JET-calls-us endpoint and shares the dedupe/record plumbing below.
   *
   * Unlike the four notification webhooks this one takes a plain 200 rather
   * than an echo — the spec's response for the menu callback is bare `OK`.
   * It is nevertheless the single most important inbound message for the 97%
   * menu-injection target: `POST /menus` answering 202 only means the JSON
   * parsed, and a structurally valid menu can still be rejected downstream.
   */
  @Public()
  @Post("menu-callback")
  @HttpCode(HttpStatus.OK)
  async menuCallback(@Body() body: any, @Headers("authorization") auth: string) {
    await this.handle("menu-callback", body, auth, (p) =>
      this.menu.handleMenuCallback(p),
    );
    return { ok: true };
  }

  /**
   * The asynchronous modification result (JE-6).
   *
   * Success and failure share this endpoint as two different shapes,
   * distinguished by whether `errors` is present. Neither carries the
   * resulting basket — the amended order arrives separately as the Final
   * Picked Order, which the order webhook already ingests.
   *
   * The spec asks for 202 here, not the 200-with-echo the notification
   * webhooks want.
   */
  @Public()
  @Post("modification-callback")
  @HttpCode(HttpStatus.ACCEPTED)
  async modificationCallback(
    @Body() body: any,
    @Headers("authorization") auth: string,
  ) {
    await this.handle("modification-callback", body, auth, (p) =>
      this.modifications.handleModificationCallback(p),
    );
    return { ok: true };
  }

  private async handle(
    kind: string,
    body: any,
    auth: string | undefined,
    run: (payload: any) => Promise<{ handled: boolean; reason?: string; orderId?: string }>,
  ): Promise<any> {
    if (!this.client.verifyInboundApiKey(auth)) {
      this.logger.error(
        `JET ${kind} webhook REJECTED: the Authorization header did not match ` +
          `JET_INBOUND_API_KEY. These webhooks carry no HMAC, so this is their only check.`,
      );
      throw new UnauthorizedException("Invalid API key");
    }

    const eventId = this.eventId(kind, body);
    const firstSeen = await this.record(kind, eventId, body);

    this.logger.log(
      `JET ${kind} webhook: ${JSON.stringify(body).slice(0, 2000)} (first=${firstSeen})`,
    );

    if (!firstSeen) {
      // A retry of something already handled. Still echoed, so JET stops.
      return body;
    }

    try {
      const result = await run(body);
      if (!result.handled) {
        this.logger.warn(
          `JET ${kind} webhook not handled: ${result.reason ?? "unknown"}`,
        );
      }
      await this.markProcessed(eventId, result);
    } catch (err: any) {
      // Swallowed on purpose — see the class comment. A 500 would put JET into
      // a five-attempt retry loop for something reprocessing cannot fix.
      this.logger.error(`JET ${kind} webhook handler failed: ${err?.message}`);
      await this.markError(eventId, err);
    }

    // The echo. This IS the acknowledgement.
    return body;
  }

  /**
   * A dedupe key that cannot collide with the order's own WebhookEvent row.
   *
   * WebhookEvent is unique on [platform, externalEventId], and order intake
   * already occupies the bare JET order id — so a lifecycle event keyed on the
   * order id alone would silently look like a duplicate of the order itself
   * and never be recorded. The kind and the event's own timestamp keep each
   * notification distinct while a genuine retry still collapses.
   */
  private eventId(kind: string, body: any): string {
    const subject =
      body?.orderID ?? body?.orderId ?? body?.restaurantId ?? "unknown";
    const at =
      body?.happenedAt ??
      body?.lastChangedTimeStampUtc ??
      body?.order?.friendlyOrderReference ??
      "";
    const detail = body?.driverStatus?.code ?? body?.reason?.code ?? "";
    return [kind, subject, detail, at].filter(Boolean).join(":");
  }

  private async record(kind: string, eventId: string, body: any): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          platform: "JUST_EAT",
          externalEventId: eventId,
          rawPayload: body ?? {},
          metadata: { kind },
        },
      });
      return true;
    } catch (e: any) {
      if (e?.code !== "P2002") {
        this.logger.warn(`JET ${kind} webhook persist failed: ${e?.message}`);
        // Unrecorded, but still worth handling — losing a delivered
        // cancellation because bookkeeping failed is the worse outcome.
        return true;
      }
      return false;
    }
  }

  private async markProcessed(eventId: string, result: unknown): Promise<void> {
    await this.prisma.webhookEvent
      .update({
        where: {
          platform_externalEventId: {
            platform: "JUST_EAT",
            externalEventId: eventId,
          },
        },
        data: { processedAt: new Date(), metadata: result as any },
      })
      .catch(() => {
        /* best-effort bookkeeping */
      });
  }

  private async markError(eventId: string, err: unknown): Promise<void> {
    await this.prisma.webhookEvent
      .update({
        where: {
          platform_externalEventId: {
            platform: "JUST_EAT",
            externalEventId: eventId,
          },
        },
        data: { processingError: String(err).slice(0, 500) },
      })
      .catch(() => {
        /* best-effort bookkeeping */
      });
  }
}
