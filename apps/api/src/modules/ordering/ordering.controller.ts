import { Controller, Get, Post, Body, Param, Query, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { OrderingService, CheckoutDto } from "./ordering.service";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("ordering")
@Controller({ path: "ordering", version: "1" })
export class OrderingController {
  constructor(private readonly ordering: OrderingService) {}

  @Public()
  @Get("store/:slug")
  @ApiOperation({ summary: "Get public storefront menu and store info" })
  // Phase AW — optional `?brand=<id>` from /brand/<slug> redirects so
  // the storefront renders the brand's identity (name, logo, address,
  // about) instead of the underlying physical location's.
  getStorefront(
    @Param("slug") slug: string,
    @Query("brand") brandId?: string,
  ) {
    return this.ordering.getStorefrontBySlug(slug, brandId);
  }

  @Public()
  @Post("store/:slug/checkout")
  @Throttle({ short: { limit: 3, ttl: 10000 }, medium: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: "Submit an online order" })
  // Phase AW — forward the optional ?brand=<id> from the brand
  // storefront so the resulting Order is tagged to the right brand
  // (drives receipt header, dashboard column, and per-brand Stripe
  // Connect payout resolution).
  checkout(
    @Param("slug") slug: string,
    @Body() dto: CheckoutDto,
    @Query("brand") brandId?: string,
  ) {
    return this.ordering.checkout(slug, dto, brandId);
  }

  @Public()
  @Get("orders/:orderId/status")
  @ApiOperation({ summary: "Get public order status (for customer tracking)" })
  getOrderStatus(@Param("orderId") orderId: string) {
    return this.ordering.getOrderStatus(orderId);
  }

  // Phase AP — public promo-code redemption from the storefront cart.
  // Resolves the slug → tenant + location, then delegates to the same
  // PromoCodesService.validate the POS uses. No customer-side auth
  // because the storefront has none yet.
  @Public()
  @Post("store/:slug/promo")
  @ApiOperation({ summary: "Validate a promo code for the storefront cart" })
  validatePromo(
    @Param("slug") slug: string,
    @Body() body: { code: string; subtotal: number },
  ) {
    return this.ordering.validatePromoForStorefront(slug, body);
  }
}
