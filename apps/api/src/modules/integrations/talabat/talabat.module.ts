import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MenuAssignmentsService } from "../../menus/menu-assignments.service";
import { VariantPriceResolverModule } from "../../menus/variant-price-resolver.module";
import { OrdersModule } from "../../orders/orders.module";
import { TalabatClientService } from "./talabat-client.service";
import { TalabatConnectionService } from "./talabat-connection.service";
import { TalabatItemAvailabilityService } from "./talabat-item-availability.service";
import { TalabatMenuPublishService } from "./talabat-menu-publish.service";
import { TalabatOrderService } from "./talabat-order.service";
import { TalabatOrderSyncService } from "./talabat-order-sync.service";
import { TalabatPluginController } from "./talabat-plugin.controller";
import { TalabatReportService } from "./talabat-report.service";
import { TalabatSandboxController } from "./talabat-sandbox.controller";
import { TalabatSandboxService } from "./talabat-sandbox.service";
import { TalabatStoreService } from "./talabat-store.service";
import { TalabatWebhookLogService } from "./talabat-webhook-log.service";
import { TalabatController } from "./talabat.controller";

// Phase TB — direct Talabat integration through Delivery Hero's POS
// Middleware (the RESTAURANT API documented at integration.talabat.com, not
// developer.talabat.com's grocery Partner API). See docs/talabat-integration.md.
//
//   TB-0 transport (login, token cache, callbacks)       talabat-client
//   TB-1 plugin endpoints + JWT, vendor connections      talabat-plugin / -connection
//   TB-2 order intake + middleware notifications         talabat-order
//   TB-3 accept / reject / ready / picked up / AWT       talabat-order-sync
//   TB-4 catalog import                                  talabat-menu-*
//   TB-5 item + choice availability, vendor open/closed  talabat-item-availability / -store
//   TB-6 promotions (discount sponsorship) + reconcile   talabat-promotions / -report
//   TB-7 sandbox middleware                              talabat-sandbox
//
// OrdersModule is a one-way import (as for Glovo/Careem/Keeta): Orders never
// reaches back in, and the outbound sync listens on order.status_changed.
@Module({
  imports: [ConfigModule, OrdersModule, VariantPriceResolverModule],
  controllers: [TalabatPluginController, TalabatController, TalabatSandboxController],
  providers: [
    MenuAssignmentsService,
    TalabatClientService,
    TalabatConnectionService,
    TalabatOrderService,
    TalabatOrderSyncService,
    TalabatMenuPublishService,
    TalabatItemAvailabilityService,
    TalabatStoreService,
    TalabatReportService,
    TalabatWebhookLogService,
    TalabatSandboxService,
  ],
  exports: [TalabatClientService, TalabatMenuPublishService, TalabatItemAvailabilityService, TalabatStoreService],
})
export class TalabatModule {}
