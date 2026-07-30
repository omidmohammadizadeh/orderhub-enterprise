import { Module, forwardRef } from "@nestjs/common";
import { OrdersService } from "./orders.service";
import { OrdersController } from "./orders.controller";
import { OrdersAutoCompleteCron } from "./orders-auto-complete.cron";
import { VoidItemsService } from "./void-items.service";
import { SocketModule } from "../../infrastructure/socket/socket.module";
import { AuthModule } from "../auth/auth.module";
import { OutboxModule } from "../outbox/outbox.module";
import { PrintersModule } from "../printers/printers.module";
import { PromoCodesModule } from "../promo-codes/promo-codes.module";
import { PaymentsModule } from "../payments/payments.module";
import { HubRiseModule } from "../integrations/hubrise/hubrise.module";

@Module({
  imports: [
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
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersAutoCompleteCron, VoidItemsService],
  exports: [OrdersService, VoidItemsService],
})
export class OrdersModule {}
