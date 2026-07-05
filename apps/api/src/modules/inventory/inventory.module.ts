import { Module, forwardRef } from "@nestjs/common";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";
import { MenuAvailabilityController } from "./menu-availability.controller";
import { MenuAvailabilityService } from "./menu-availability.service";
import { SocketModule } from "../../infrastructure/socket/socket.module";
import { HubRiseModule } from "../integrations/hubrise/hubrise.module";
import { DeliverooModule } from "../integrations/deliveroo/deliveroo.module";
import { UberEatsModule } from "../integrations/ubereats/ubereats.module";

@Module({
  // HubRise exports HubRiseCatalogService which MenuAvailabilityService
  // calls when an operator 86s a HubRise-sourced item — push the snooze
  // through to the marketplace via PATCH /inventory.
  // DeliverooModule provides DeliverooClientService so a DELIVEROO 86 pushes
  // the item_unavailabilities replace-all to Deliveroo (one-way, no cycle).
  // UberEatsModule provides UberEatsMenuPublishService so an UBER_EATS 86
  // pushes a sparse per-item suspension (Update Menu Item, the Uber-correct
  // way to take items off the menu).
  imports: [
    SocketModule,
    forwardRef(() => HubRiseModule),
    DeliverooModule,
    UberEatsModule,
  ],
  controllers: [InventoryController, MenuAvailabilityController],
  providers: [InventoryService, MenuAvailabilityService],
  exports: [InventoryService, MenuAvailabilityService],
})
export class InventoryModule {}
