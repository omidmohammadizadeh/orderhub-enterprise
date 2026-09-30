// Retail R1 — shops alongside restaurants: barcoded variants, per-location
// stock and item-level returns. See retail.logic.ts for the rules.

import { Module } from "@nestjs/common";
import { SocketModule } from "../../infrastructure/socket/socket.module";
import { LocationAccessService } from "../../common/access/location-access.service";
import { MenusModule } from "../menus/menus.module";
import { MenuAssignmentsModule } from "../menus/menu-assignments.module";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsModule } from "../payments/payments.module";
import { RetailController } from "./retail.controller";
import { RetailCatalogService } from "./retail-catalog.service";
import { RetailReturnsService } from "./retail-returns.service";
import { RetailStockService } from "./retail-stock.service";
import { RetailPickingService } from "./retail-picking.service";
import { RetailDealsService } from "./retail-deals.service";
import { MarketingModule } from "../marketing/marketing.module";

@Module({
  imports: [SocketModule, MenusModule, MenuAssignmentsModule, OrdersModule, PaymentsModule, MarketingModule],
  controllers: [RetailController],
  providers: [RetailCatalogService, RetailStockService, RetailReturnsService, RetailPickingService, RetailDealsService, LocationAccessService],
  exports: [RetailCatalogService, RetailStockService],
})
export class RetailModule {}
