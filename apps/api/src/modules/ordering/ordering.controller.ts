import { Controller, Get, Post, Body, Param, HttpCode, HttpStatus } from "@nestjs/common";
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
  getStorefront(@Param("slug") slug: string) {
    return this.ordering.getStorefrontBySlug(slug);
  }

  @Public()
  @Post("store/:slug/checkout")
  @Throttle({ short: { limit: 3, ttl: 10000 }, medium: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: "Submit an online order" })
  checkout(@Param("slug") slug: string, @Body() dto: CheckoutDto) {
    return this.ordering.checkout(slug, dto);
  }

  @Public()
  @Get("orders/:orderId/status")
  @ApiOperation({ summary: "Get public order status (for customer tracking)" })
  getOrderStatus(@Param("orderId") orderId: string) {
    return this.ordering.getOrderStatus(orderId);
  }
}
