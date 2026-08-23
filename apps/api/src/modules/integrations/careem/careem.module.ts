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
import { CareemStoreService } from "./careem-store.service";
import { CareemSandboxService } from "./careem-sandbox.service";
import { CareemSandboxController } from "./careem-sandbox.controller";
import { CareemMockController } from "./careem-mock.controller";

// Phase CA — direct Careem (Now/SuperApp) POS integration.
//
// CA-0 transport: OAuth2 client_credentials against Careem's identity service,
// token caching, and the authenticated request helper.
// CA-1 webhook receiver: one endpoint, four event types, static-key auth.
//
// CA-3 catalog publish: our menu → their flat catalog, validated against their
// own rules before it leaves, then tracked asynchronously.
//
// CA-4 store control: brand + branch registration carrying OUR ids, the POS
// integration switch, SuperApp visibility including a timed pause, and opening
// hours split across midnight the way Careem model them.
//
// CA-5 sandbox: Careem's own API answering on our server, so the whole
// integration can be driven before they issue a client. Off unless
// CAREEM_SANDBOX=true, and refuses to run against their production.
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
  controllers: [
    CareemController,
    CareemWebhookController,
    CareemSandboxController,
    CareemMockController,
  ],
  providers: [
    CareemClientService,
    CareemWebhookLogService,
    CareemOrderService,
    CareemOrderSyncService,
    CareemMenuPublishService,
    CareemStoreService,
    CareemSandboxService,
  ],
  exports: [
    CareemClientService,
    CareemOrderService,
    CareemMenuPublishService,
    CareemStoreService,
  ],
})
export class CareemModule {}
