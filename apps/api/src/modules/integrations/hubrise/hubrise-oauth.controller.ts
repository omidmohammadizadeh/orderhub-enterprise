// Phase AU — HubRise OAuth2 entry + callback endpoints.
//
//   GET /v1/integrations/hubrise/connect?locationId=...
//     — JWT-authed; builds the HubRise authorize URL with a signed
//       state param and returns it. Web sends operator there.
//
//   GET /v1/integrations/hubrise/callback?code=...&state=...
//     — public (HubRise hits it after consent); exchanges the code,
//       registers the per-location webhook, persists everything,
//       then 302-redirects the operator back into the dashboard.

import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import { BillingExempt } from "../../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { WebhookIngestionService } from "../../webhooks/webhook-ingestion.service";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { HubRiseOauthService } from "./hubrise-oauth.service";
import { HubRiseDeliverySyncService } from "./hubrise-delivery-sync.service";

@ApiTags("hubrise")
@Controller({ path: "integrations/hubrise", version: "1" })
export class HubRiseOauthController {
  private readonly logger = new Logger(HubRiseOauthController.name);

  constructor(
    private readonly oauth: HubRiseOauthService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ingestion: WebhookIngestionService,
    private readonly credentialEncryption: CredentialEncryptionService,
    private readonly deliverySync: HubRiseDeliverySyncService,
  ) {}

  @Get("connect")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the HubRise authorize URL for a location" })
  async connect(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
  ) {
    // Verify the operator actually has access to this location before
    // we mint a state token that grants the OAuth flow rights to it.
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId: user.tenantId } },
      select: { id: true },
    });
    if (!loc) throw new UnauthorizedException("Location not in your tenant");

    return {
      authorizeUrl: this.oauth.buildAuthorizeUrl({
        tenantId: user.tenantId,
        userId: user.userId,
        locationId,
      }),
    };
  }

  @Public()
  @Get("callback")
  @ApiOperation({ summary: "HubRise OAuth redirect lands here" })
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    // If HubRise itself rejected the consent (operator cancelled,
    // app suspended, etc.), bounce back to the dashboard with the
    // reason in the query string so the UI can show it.
    if (error) {
      const back = this.dashboardUrl("/dashboard/locations");
      back.searchParams.set("hubrise_error", error);
      if (errorDescription)
        back.searchParams.set("hubrise_error_description", errorDescription);
      return res.redirect(back.toString());
    }
    if (!code || !state) {
      const back = this.dashboardUrl("/dashboard/locations");
      back.searchParams.set(
        "hubrise_error",
        "missing_code_or_state",
      );
      return res.redirect(back.toString());
    }

    try {
      const { locationId } = await this.oauth.handleCallback({ code, state });
      const back = this.dashboardUrl("/dashboard/locations");
      back.searchParams.set("hubrise_connected", locationId);
      return res.redirect(back.toString());
    } catch (err: any) {
      const back = this.dashboardUrl("/dashboard/locations");
      back.searchParams.set("hubrise_error", "callback_failed");
      back.searchParams.set(
        "hubrise_error_description",
        err?.message ?? "Unknown error",
      );
      return res.redirect(back.toString());
    }
  }

  /**
   * APP_URL in production may be scheme-less ("www.example.com") — bare
   * `new URL(appUrl + path)` throws Invalid URL, which turned every OAuth
   * landing into a 500 JSON page (the connect itself still saved). Normalise
   * the scheme and fall back to the public site if it's still unparseable.
   */
  private dashboardUrl(path: string): URL {
    let base = (this.config.get<string>("app.appUrl") ?? "").trim();
    if (base && !/^https?:\/\//i.test(base)) base = `https://${base}`;
    try {
      return new URL(`${base.replace(/\/$/, "")}${path}`);
    } catch {
      return new URL(`https://www.orderhubsolutions.com${path}`);
    }
  }

  // ── Global webhook receiver ────────────────────────────────────────
  //
  // HubRise sends EVERY order/catalog event to a single URL registered
  // in the partner app. The payload carries `location_id` (HubRise's
  // id), which we resolve to our internal Location via the
  // `hubriseLocationId` column. From there the event flows through the
  // same WebhookIngestionService chain as the per-location URLs.
  //
  // Two paths land on the same logic so we don't have to ask the
  // operator to re-register a URL they've already pasted into HubRise:
  //
  //   POST /v1/integrations/hubrise/webhook   ← preferred
  //   POST /v1/integrations/hubrise/callback  ← backward compat
  //
  // The GET version of /callback (just above) is the OAuth redirect
  // landing — completely separate flow.

  @Public()
  @BillingExempt()
  @Post(["webhook", "callback"])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "HubRise global webhook receiver" })
  async receiveWebhook(@Req() req: RawBodyRequest<Request>) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException(
        "Raw body unavailable — webhook bridge misconfigured",
      );
    }

    // Parse only enough to figure out which Location this belongs to.
    // The full payload goes through the existing ingestion path which
    // re-parses internally; we let it do the canonical work so a
    // single bug here can't desync the two interpretations.
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Webhook body is not valid JSON");
    }
    const hubriseLocationId: string | undefined =
      parsed?.location_id ?? parsed?.resource?.location_id;
    if (!hubriseLocationId) {
      this.logger.warn(
        "HubRise webhook arrived without a location_id field — ignoring",
      );
      // 200 so HubRise stops retrying. Any non-2xx triggers their
      // exponential-backoff retry queue, which would just keep
      // pinging this same bad payload.
      return { received: true, reason: "no_location_id" };
    }

    // Match case-insensitively. HubRise sends lowercase ids in the
    // webhook payload but the operator may have pasted the version they
    // see in HubRise's dashboard (which is rendered uppercase). Either
    // shape is the same id; we shouldn't drop the order over caps.
    const location = await this.prisma.location.findFirst({
      where: {
        hubriseLocationId: {
          equals: hubriseLocationId.trim(),
          mode: "insensitive",
        },
        deletedAt: null,
      },
      select: {
        id: true,
        hubriseCredentials: true,
        hubriseLocationId: true,
      },
    });
    if (!location) {
      this.logger.warn(
        `HubRise webhook for hubriseLocationId=${hubriseLocationId} but no Location is connected — ignoring`,
      );
      // Same as above: 200 to stop retries. If the operator connects
      // later, they can replay from HubRise's webhook log.
      return { received: true, reason: "location_not_connected" };
    }

    // Phase AV-2 — delivery events. HubRise emits `delivery.create`
    // and `delivery.update` when the marketplace courier assigns,
    // picks up, or drops off the order. These are independent of the
    // order webhook and arrive at the same global URL. Dispatch them
    // to the courier-update handler before falling through to the
    // order ingestion path.
    if (
      parsed?.resource_type === "delivery" &&
      (parsed?.event_type === "create" || parsed?.event_type === "update")
    ) {
      try {
        const result = await this.deliverySync.handleDeliveryWebhook({
          hubriseOrderId: parsed?.order_id,
          hubriseDeliveryId: parsed?.delivery_id ?? parsed?.id,
          ourLocationId: location.id,
          hubriseLocationId: location.hubriseLocationId!,
          credentialsBlob: location.hubriseCredentials,
          inlineDelivery: parsed?.new_state ?? parsed, // event payloads may inline the new state
        });
        return { received: true, ...result };
      } catch (err: any) {
        this.logger.error(
          `HubRise delivery webhook failed: ${err?.message}`,
        );
        // 200 OK with reason so HubRise doesn't retry forever on a
        // malformed event we can't process anyway. The error is in
        // our logs for the operator to chase.
        return { received: true, ignored: true, reason: err?.message };
      }
    }

    // HubRise webhook payloads for order events carry only the event
    // metadata + order_id, NOT the full order body. We have to fetch
    // the order ourselves via GET /locations/<hubriseLocationId>/orders/<orderId>
    // before passing it to the ingestion service — the HubRise adapter
    // expects items[], payments[], customer{} etc. at the top level.
    //
    // If the operator-supplied payload already contains items (e.g.
    // some webhook configurations DO inline them, or a test replay
    // pasted the full body), we skip the fetch and use what we have.
    let enrichedPayload: Record<string, any> = parsed;
    const isOrderEvent =
      parsed?.resource_type === "order" &&
      (parsed?.event_type === "create" || parsed?.event_type === "update");
    const hasItems = Array.isArray(parsed?.items);
    const orderId: string | undefined = parsed?.order_id ?? parsed?.id;

    if (isOrderEvent && !hasItems && orderId) {
      try {
        const fetched = await this.fetchOrderFromHubRise(
          location.hubriseLocationId!,
          orderId,
          location.hubriseCredentials,
        );
        // Merge event metadata + the fetched order body. The adapter
        // reads from one flat object so this is the easiest shape.
        // Order body fields win over event metadata where they overlap
        // (status, channel, etc. on the actual order, not the event).
        enrichedPayload = {
          ...parsed,
          ...fetched,
          // Preserve the HubRise event id so extractEventId still has
          // a stable idempotency key per webhook delivery.
          event_id: parsed?.id,
          order_id: orderId,
        };
        this.logger.log(
          `HubRise webhook order ${orderId} hydrated from API (${
            (fetched.items ?? []).length
          } items)`,
        );
      } catch (err: any) {
        // Bubble up to HubRise with 5xx so they retry. A common cause
        // is the access token being revoked; the operator needs to
        // reconnect, and HubRise's retry queue will replay once they do.
        this.logger.error(
          `Failed to fetch HubRise order ${orderId}: ${err?.message}`,
        );
        throw new BadRequestException(
          `Could not fetch order ${orderId} from HubRise: ${err?.message}`,
        );
      }
    }

    try {
      const result = await this.ingestion.ingest({
        platform: "HUBRISE",
        locationId: location.id,
        rawBody,
        payload: enrichedPayload,
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      this.logger.log(
        `HubRise webhook → location ${location.id} → ${JSON.stringify(result)}`,
      );

      // Phase AV-2 follow-up — Base44-style. HubRise embeds the
      // delivery state inside the order body's `delivery` field on
      // every order.update event. Most accounts never see standalone
      // `delivery.*` events at all (they require a webhook
      // subscription change), but every account DOES see
      // `order.update` events. Pulling courier stage from the inline
      // block here means we transition PLATFORM orders without the
      // operator having to touch HubRise's webhook subscription
      // config.
      const inlineDelivery = enrichedPayload?.delivery;
      if (
        inlineDelivery &&
        typeof inlineDelivery === "object" &&
        inlineDelivery.status
      ) {
        try {
          await this.deliverySync.handleDeliveryWebhook({
            hubriseOrderId: enrichedPayload.order_id ?? enrichedPayload.id,
            hubriseDeliveryId: inlineDelivery.id,
            ourLocationId: location.id,
            hubriseLocationId: location.hubriseLocationId!,
            credentialsBlob: location.hubriseCredentials,
            inlineDelivery,
          });
        } catch (err: any) {
          // Never let the embedded-delivery side path fail the main
          // ingest — order.update has already saved the order
          // changes. Log and continue.
          this.logger.warn(
            `Inline-delivery sync failed for ${enrichedPayload.order_id}: ${err?.message}`,
          );
        }
      }

      return { received: true, ...result };
    } catch (err: any) {
      this.logger.error(
        `HubRise webhook ingestion failed: ${err?.message}`,
      );
      // Rethrow only for genuine 5xx; auth/signature failures already
      // bubble up as 401/403 with a meaningful body so HubRise's log
      // tab tells the operator what went wrong.
      throw err;
    }
  }

  /**
   * GET /v1/locations/{hubriseLocationId}/orders/{orderId} on HubRise's
   * REST API. Requires the location's saved access token (decrypted
   * from the encrypted credentials envelope).
   */
  private async fetchOrderFromHubRise(
    hubriseLocationId: string,
    orderId: string,
    credentialsBlob: unknown,
  ): Promise<Record<string, any>> {
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
    // HubRise's REST API is case-sensitive on the location segment —
    // it stores ids lowercase server-side and returns 404
    // "Location does not exist" if we send the uppercase variant some
    // operators paste from the dashboard. Our DB lookup is
    // case-insensitive so we already matched the location; just
    // normalise on the way out to keep the API happy.
    const url = `${baseUrl}/locations/${encodeURIComponent(
      hubriseLocationId.toLowerCase(),
    )}/orders/${encodeURIComponent(orderId)}`;
    const res = await fetch(url, {
      headers: { "X-Access-Token": accessToken },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HubRise GET ${url} → ${res.status}: ${text}`);
    }
    return (await res.json()) as Record<string, any>;
  }
}
