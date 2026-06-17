import { Module } from "@nestjs/common";
import { OrderingController } from "./ordering.controller";
import { OrderingService } from "./ordering.service";
import { OrdersModule } from "../orders/orders.module";
import { PromoCodesModule } from "../promo-codes/promo-codes.module";
import { PaymentsModule } from "../payments/payments.module";
import { InventoryModule } from "../inventory/inventory.module";

@Module({
  // Phase AP-8 — PaymentsModule provides Stripe Checkout Session creation
  // for the CARD branch of /checkout. Cash orders skip it entirely so a
  // tenant without Stripe credentials can still take cash orders online.
  // Phase AW-14 — InventoryModule exports MenuAvailabilityService so the
  // storefront response filters out items snoozed for ONLINE.
  imports: [OrdersModule, PromoCodesModule, PaymentsModule, InventoryModule],
  controllers: [OrderingController],
  providers: [OrderingService],
})
export class OrderingModule {}
