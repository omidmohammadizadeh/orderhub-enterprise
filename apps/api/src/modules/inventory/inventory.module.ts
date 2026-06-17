import { Module, forwardRef } from "@nestjs/common";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";
import { MenuAvailabilityController } from "./menu-availability.controller";
import { MenuAvailabilityService } from "./menu-availability.service";
import { SocketModule } from "../../infrastructure/socket/socket.module";
import { HubRiseModule } from "../integrations/hubrise/hubrise.module";

@Module({
  // HubRise exports HubRiseCatalogService which MenuAvailabilityService
  // calls when an operator 86s a HubRise-sourced item — push the snooze
  // through to the marketplace via PATCH /inventory.
  imports: [SocketModule, forwardRef(() => HubRiseModule)],
  controllers: [InventoryController, MenuAvailabilityController],
  providers: [InventoryService, MenuAvailabilityService],
  exports: [InventoryService, MenuAvailabilityService],
})
export class InventoryModule {}
