import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Res,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
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
  // `?channel=POS` serves the till's menu instead of the web one. A table
  // QR asks for it: a guest at table 4 must see what the till sees. Anything
  // other than POS resolves ONLINE, so a mistyped value can only ever give
  // the customer today's storefront.
  getStorefront(
    @Param("slug") slug: string,
    @Query("brand") brandId?: string,
    @Query("channel") channel?: string,
  ) {
    return this.ordering.getStorefrontBySlug(
      slug,
      brandId,
      channel === "POS" ? "POS" : "ONLINE",
    );
  }

  // Phase BS — just enough of the storefront to render its <head> on the
  // server: name, description, preview image, canonical host. Separate from
  // the full storefront read because that one carries the entire menu (a
  // couple of MB on a real shop) and the web app would have to fetch it on
  // every cold page render just to write a <title>.
  @Public()
  @Get("store/:slug/seo")
  @ApiOperation({ summary: "Public storefront identity for page metadata" })
  getStorefrontSeo(@Param("slug") slug: string, @Query("brand") brandId?: string) {
    return this.ordering.getStorefrontSeo(slug, brandId);
  }

  // The shop's preview image as actual bytes. Link-preview crawlers fetch
  // og:image over HTTP, so a banner stored as a base64 data URI — which is
  // most of them — had no preview picture at all until it had a URL.
  //
  // Cached hard and immutably-ish: the bytes behind one storefront change
  // only when the operator uploads a new banner, and every crawler that
  // scrapes a shared link hits this.
  @Public()
  @Get("store/:slug/preview-image")
  @ApiOperation({ summary: "Storefront preview image for link previews" })
  async getStorefrontPreviewImage(
    @Param("slug") slug: string,
    @Res() res: Response,
    @Query("brand") brandId?: string,
  ) {
    const image = await this.ordering.getStorefrontPreviewImage(slug, brandId);
    if (!image) {
      // 404 so a crawler drops the image and renders the rest of the card,
      // rather than retrying or showing a broken one.
      res.status(HttpStatus.NOT_FOUND).json({ message: "No preview image" });
      return;
    }
    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Content-Length", image.buffer.length);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.send(image.buffer);
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
