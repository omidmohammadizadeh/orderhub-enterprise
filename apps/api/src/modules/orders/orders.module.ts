import { Module, forwardRef } from "@nestjs/common";
import { OrdersService } from "./orders.service";
import { OrdersController } from "./orders.controller";
import { OrdersAutoCompleteCron } from "./orders-auto-complete.cron";
import { LoyaltyModule } from "../loyalty/loyalty.module";
import { VoidItemsService } from "./void-items.service";
import { SocketModule } from "../../infrastructure/socket/socket.module";
import { AuthModule } from "../auth/auth.module";
import { OutboxModule } from "../outbox/outbox.module";
import { PrintersModule } from "../printers/printers.module";
import { PromoCodesModule } from "../promo-codes/promo-codes.module";
import { PaymentsModule } from "../payments/payments.module";
import { HubRiseModule } from "../integrations/hubrise/hubrise.module";
import { CustomerPushModule } from "../customer-push/customer-push.module";

@Module({
  imports: [
    // The 5am rollover completes orders with raw SQL and no event, so it has
    // to award their stamps itself. One-way: Loyalty never reaches back.
    LoyaltyModule,
    SocketModule,
    AuthModule,
    OutboxModule,
    PrintersModule, // Phase AM — wire PrintQueueService for POS auto-print
    PromoCodesModule, // Phase AM — incrementUsage on confirmed order
    // Phase AP-8 — OrdersService calls PaymentsService.captureForOrder /
    // refundForOrder on status transitions. PaymentsModule transitively
    // pulls in the Stripe SDK and Connect-account lookups. forwardRef in
    // case a circular ever arises down the line (none today).
    forwardRef(() => PaymentsModule),
    // Phase AU — OrdersService pushes status transitions back to
    // HubRise. forwardRef because HubRiseModule transitively imports
    // WebhooksModule which currently has its own OrdersModule
    // dependency (for canonical ingestion).
    forwardRef(() => HubRiseModule),
    // Phase AX — a status change tells the customer's browser. One-way
    // (orders → push), so no forwardRef needed.
    CustomerPushModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersAutoCompleteCron, VoidItemsService],
  exports: [OrdersService, VoidItemsService],
})
export class OrdersModule {}
