import { Module } from "@nestjs/common";
import { OrderingController } from "./ordering.controller";
import { OrderingService } from "./ordering.service";
import { OrdersModule } from "../orders/orders.module";
import { PromoCodesModule } from "../promo-codes/promo-codes.module";
import { PaymentsModule } from "../payments/payments.module";
import { InventoryModule } from "../inventory/inventory.module";
import { PauseModule } from "../pauses/pause.module";
import { MarketingModule } from "../marketing/marketing.module";

@Module({
  // Phase AP-8 — PaymentsModule provides Stripe Checkout Session creation
  // for the CARD branch of /checkout. Cash orders skip it entirely so a
  // tenant without Stripe credentials can still take cash orders online.
  // Phase AW-14 — InventoryModule exports MenuAvailabilityService so the
  // storefront response filters out items snoozed for ONLINE.
  // Phase AW-15 — PauseModule exports PauseService so the storefront
  // response carries a `closed` block when the brand/location/channel
  // is currently paused, and so checkout() refuses to land an order
  // against a paused storefront.
  imports: [
    OrdersModule,
    PromoCodesModule,
    PaymentsModule,
    InventoryModule,
    PauseModule,
    MarketingModule,
  ],
  controllers: [OrderingController],
  providers: [OrderingService],
})
export class OrderingModule {}
