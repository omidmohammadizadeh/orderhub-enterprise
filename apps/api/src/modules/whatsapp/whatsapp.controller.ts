import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  RawBodyRequest,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import { WhatsAppService } from "./whatsapp.service";

// Meta WhatsApp Cloud API webhook. Public — Meta's verify token (GET) and the
// X-Hub-Signature-256 (POST) are the auth. Billing-exempt like other inbound
// provider webhooks.
@ApiTags("whatsapp")
@BillingExempt()
@Controller({ path: "whatsapp", version: "1" })
export class WhatsAppController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  // GET /api/v1/whatsapp/webhook — Meta verification handshake.
  @Get("webhook")
  @Public()
  @ApiOperation({ summary: "WhatsApp Cloud API webhook verification (Meta handshake)" })
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
  ): string {
    // Must echo the challenge back as a plain string.
    return this.whatsapp.verifyWebhook(mode, token, challenge);
  }

  // POST /api/v1/whatsapp/webhook — inbound messages + status events.
  @Post("webhook")
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ webhook: { ttl: 60000, limit: 600 } })
  @ApiOperation({ summary: "Receive WhatsApp Cloud API events" })
  async receive(@Req() req: RawBodyRequest<Request>) {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    await this.whatsapp.handleInbound(req.rawBody, headers);
    // Always 200 quickly so Meta doesn't retry/disable the webhook.
    return { received: true };
  }
}
