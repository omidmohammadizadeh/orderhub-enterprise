import { Module, forwardRef } from "@nestjs/common";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";
import { MenuAvailabilityController } from "./menu-availability.controller";
import { MenuAvailabilityService } from "./menu-availability.service";
import { SocketModule } from "../../infrastructure/socket/socket.module";
import { HubRiseModule } from "../integrations/hubrise/hubrise.module";
import { DeliverooModule } from "../integrations/deliveroo/deliveroo.module";
import { UberEatsModule } from "../integrations/ubereats/ubereats.module";
import { JetModule } from "../integrations/jet/jet.module";
import { CareemModule } from "../integrations/careem/careem.module";
import { LocationAccessService } from "../../common/access/location-access.service";

@Module({
  // HubRise exports HubRiseCatalogService which MenuAvailabilityService
  // calls when an operator 86s a HubRise-sourced item — push the snooze
  // through to the marketplace via PATCH /inventory.
  // DeliverooModule provides DeliverooClientService so a DELIVEROO 86 pushes
  // the item_unavailabilities replace-all to Deliveroo (one-way, no cycle).
  // UberEatsModule provides UberEatsMenuPublishService so an UBER_EATS 86
  // pushes a sparse per-item suspension (Update Menu Item, the Uber-correct
  // way to take items off the menu).
  // JetModule provides JetItemAvailabilityService so a JUST_EAT 86 posts to
  // /item-availability — the only one of the four that carries a real expiry
  // (nextAvailableAt), so a timed snooze restores itself on their side.
  imports: [
    SocketModule,
    forwardRef(() => HubRiseModule),
    DeliverooModule,
    UberEatsModule,
    JetModule,
    CareemModule,
  ],
  controllers: [InventoryController, MenuAvailabilityController],
  providers: [InventoryService, MenuAvailabilityService, LocationAccessService],
  exports: [InventoryService, MenuAvailabilityService],
})
export class InventoryModule {}
