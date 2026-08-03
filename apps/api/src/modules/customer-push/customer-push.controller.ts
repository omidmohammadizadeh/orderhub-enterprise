import { Body, Controller, Get, Headers, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import { CustomerPushService } from "./customer-push.service";

// Every route here is @Public — the callers are customers on a storefront,
// who have no account and no token. The order id is the credential, exactly
// as it already is for GET /v1/ordering/orders/:orderId/status.
//
// @BillingExempt because a lapsed subscription must not stop a customer being
// told their food is ready. That's a fight to have with the restaurant, not
// with someone waiting on a delivery.
@ApiTags("customer-push")
@BillingExempt()
@Controller({ path: "customer-push", version: "1" })
export class CustomerPushController {
  constructor(private readonly push: CustomerPushService) {}

  @Public()
  @Get("key")
  @ApiOperation({ summary: "VAPID public key for browser subscription" })
  key() {
    // Null rather than an error when unconfigured: the storefront uses this to
    // decide whether to offer notifications at all, and an install without
    // VAPID keys should quietly not show the button.
    return { key: this.push.publicKey() };
  }

  @Public()
  @Post("subscribe")
  @ApiOperation({ summary: "Subscribe this browser to an order's updates" })
  subscribe(
    @Body()
    body: {
      orderId: string;
      endpoint: string;
      keys: { p256dh: string; auth: string };
      deviceRef?: string;
      trackPath?: string;
    },
    @Headers("user-agent") userAgent?: string,
  ) {
    return this.push.subscribe({
      orderId: body.orderId,
      endpoint: body.endpoint,
      p256dh: body.keys?.p256dh,
      auth: body.keys?.auth,
      deviceRef: body.deviceRef ?? null,
      userAgent: userAgent ?? null,
      trackPath: body.trackPath ?? null,
    });
  }

  @Public()
  @Post("unsubscribe")
  @ApiOperation({ summary: "Stop notifications for this browser" })
  unsubscribe(@Body() body: { endpoint: string }) {
    return this.push.unsubscribe(body.endpoint);
  }
}
