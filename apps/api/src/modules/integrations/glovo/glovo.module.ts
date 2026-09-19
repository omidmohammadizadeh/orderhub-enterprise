import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VariantPriceResolverModule } from "../../menus/variant-price-resolver.module";
import { OrdersModule } from "../../orders/orders.module";
import { GlovoClientService } from "./glovo-client.service";
import { GlovoConnectionService } from "./glovo-connection.service";
import { GlovoOrderService } from "./glovo-order.service";
import { GlovoOrderSyncService } from "./glovo-order-sync.service";
import { GlovoMenuPublishService } from "./glovo-menu-publish.service";
import { GlovoItemAvailabilityService } from "./glovo-item-availability.service";
import { GlovoStoreStatusService } from "./glovo-store-status.service";
import { GlovoController } from "./glovo.controller";
import { GlovoWebhookController } from "./glovo-webhook.controller";

// Phase GL — direct Glovo integration (restaurant Partners API).
//
// GL-1 client + probe, GL-2 order webhooks + intake, GL-3 status push,
// GL-4 menu upload (served feed) + 86, GL-5 temporary closing, GL-6 connect.
// See docs/glovo-integration.md for what the API can and cannot do.
//
// OrdersModule is a one-way import, as for JetModule. ActivityLogService comes
// from the @Global() LogsModule and is injected @Optional().
@Module({
  imports: [ConfigModule, OrdersModule, VariantPriceResolverModule],
  controllers: [GlovoController, GlovoWebhookController],
  providers: [
    GlovoClientService,
    GlovoConnectionService,
    GlovoOrderService,
    GlovoOrderSyncService,
    GlovoMenuPublishService,
    GlovoItemAvailabilityService,
    GlovoStoreStatusService,
  ],
  exports: [
    GlovoClientService,
    GlovoMenuPublishService,
    GlovoItemAvailabilityService,
    GlovoStoreStatusService,
  ],
})
export class GlovoModule {}
