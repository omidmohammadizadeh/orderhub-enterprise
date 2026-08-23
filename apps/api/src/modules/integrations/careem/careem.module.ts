import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { OrdersModule } from "../../orders/orders.module";
import { CareemClientService } from "./careem-client.service";
import { CareemController } from "./careem.controller";
import { CareemWebhookController } from "./careem-webhook.controller";
import { CareemWebhookLogService } from "./careem-webhook-log.service";
import { CareemOrderService } from "./careem-order.service";
import { CareemOrderSyncService } from "./careem-order-sync.service";
import { CareemMenuPublishService } from "./careem-menu-publish.service";

// Phase CA — direct Careem (Now/SuperApp) POS integration.
//
// CA-0 transport: OAuth2 client_credentials against Careem's identity service,
// token caching, and the authenticated request helper.
// CA-1 webhook receiver: one endpoint, four event types, static-key auth.
//
// CA-3 catalog publish: our menu → their flat catalog, validated against their
// own rules before it leaves, then tracked asynchronously.
//
// CA-2 order intake: ORDER_CREATED becomes one of our orders, ORDER_STATUS_UPDATED
// mirrors their courier lifecycle onto it, and our own accept/ready/cancel is
// pushed back.
//
// OrdersModule is a one-way import — nothing in Orders reaches back into
// Careem — so no forwardRef, matching JetModule and DeliverooModule. The
// outbound sync listens on the order.status_changed event rather than being
// called, which is what keeps that direction one-way.
@Module({
  imports: [ConfigModule, OrdersModule],
  controllers: [CareemController, CareemWebhookController],
  providers: [
    CareemClientService,
    CareemWebhookLogService,
    CareemOrderService,
    CareemOrderSyncService,
    CareemMenuPublishService,
  ],
  exports: [CareemClientService, CareemOrderService, CareemMenuPublishService],
})
export class CareemModule {}
