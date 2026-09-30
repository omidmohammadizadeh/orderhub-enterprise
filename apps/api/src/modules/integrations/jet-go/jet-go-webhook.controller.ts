// Phase BJ — public JET Go webhook receiver.
//
// URL: POST /api/v1/webhooks/jet-go/:webhookToken
//
// The path carries webhookToken rather than a location id, because JET Go keeps
// one notification config per client credential — so several locations sharing a
// credential necessarily share one callback URL. Routing never depends on it:
// every event carries the requestId, which is unique platform-wide.
//
// The path token is NOT the credential. It only selects which config this is;
// the caller is authenticated against webhookSecret, a separate value that never
// appears in the URL. That matters because the URL is displayed in the dashboard
// and gets pasted into support tickets — if the path segment were also the
// secret, anyone who saw it could post fake courier updates.
//
// Auth: JET's notification config supports TOKEN (it sends `x-api-key: <secret>`)
// and BASIC (an Authorization: Basic header). We register TOKEN, but accept
// either, because a config set up by JET's own ops team may well be BASIC. Both
// are compared against the same stored token in constant time.

import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  RawBodyRequest,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { timingSafeEqual } from "crypto";
import { Public } from "../../../common/decorators/public.decorator";
import { BillingExempt } from "../../../common/guards/billing.guard";
import { JetGoConfigService } from "./jet-go-config.service";
import { JetGoWebhookService } from "./jet-go-webhook.service";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

@ApiTags("webhooks")
@BillingExempt()
@Controller({ path: "webhooks/jet-go", version: "1" })
export class JetGoWebhookController {
  private readonly logger = new Logger(JetGoWebhookController.name);

  constructor(
    private readonly config: JetGoConfigService,
    private readonly webhook: JetGoWebhookService,
  ) {}

  @Post(":webhookToken")
  @Public()
  @HttpCode(HttpStatus.OK)
  // COURIERLOCATION and the two ETA events fire every 15 seconds per live
  // delivery in EU markets, so a busy shop legitimately produces a lot of these.
  @Throttle({ short: { ttl: 60_000, limit: 1200 }, medium: { ttl: 60_000, limit: 1200 } })
  @ApiOperation({ summary: "Receive a JET Go courier webhook" })
  async receive(
    @Param("webhookToken") webhookToken: string,
    @Headers("x-api-key") apiKey: string | undefined,
    @Headers("authorization") authorization: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const configs = await this.config.findByWebhookToken(webhookToken);
    if (!configs.length) {
      // Deliberately not 401: an unknown token is more likely a stale JET config
      // pointing at a location we've since deleted than an attack, and a 200 stops
      // JET retrying forever. Nothing is done with the body.
      this.logger.warn(`JET Go webhook with an unknown token — ignoring`);
      return { received: true, reason: "not_configured" };
    }
    const expected = configs[0]!.webhookSecret;
    if (!expected) {
      // A row from before webhookSecret existed. Refuse rather than fall back to
      // accepting anything; re-saving the credentials mints one.
      this.logger.error(
        `JET Go config has no webhook secret — re-save the credentials in Location settings`,
      );
      throw new UnauthorizedException("JET Go webhook credentials are not set up");
    }

    let authed = false;
    if (apiKey && safeEqual(apiKey.trim(), expected)) authed = true;
    if (!authed && authorization?.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
        const secret = decoded.slice(decoded.indexOf(":") + 1);
        if (decoded.includes(":") && safeEqual(secret, expected)) authed = true;
      } catch {
        /* fall through to the 401 below */
      }
    }
    if (!authed) {
      throw new UnauthorizedException("Invalid JET Go webhook credentials");
    }

    let body: any;
    try {
      const raw = req.rawBody;
      body = raw ? JSON.parse(raw.toString("utf8")) : (req.body ?? {});
    } catch {
      return { received: true, ignored: true, reason: "bad_json" };
    }

    try {
      const result = await this.webhook.handle(body);
      return { received: true, ...result };
    } catch (err: any) {
      // Always 200. JET does not retry, and a 500 here would only lose the event
      // while making the failure harder to see than this log line.
      this.logger.error(`JET Go webhook processing failed: ${err?.message ?? err}`);
      return { received: true, ignored: true, reason: err?.message };
    }
  }
}
