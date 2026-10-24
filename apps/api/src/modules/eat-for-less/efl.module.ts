import { Module } from "@nestjs/common";
import { OrderingModule } from "../ordering/ordering.module";
import { DeliveryZonesModule } from "../delivery-zones/delivery-zones.module";
import { PauseModule } from "../pauses/pause.module";
import { EflAdminController, EflAppController, EflListingController } from "./efl.controller";
import { EflService } from "./efl.service";

@Module({
  // Ordering: the menu and the checkout are the storefront's. Delivery zones:
  // the same delivery answer the storefront gives, and shop coordinates.
  imports: [OrderingModule, DeliveryZonesModule, PauseModule],
  controllers: [EflAppController, EflListingController, EflAdminController],
  providers: [EflService],
  exports: [EflService],
})
export class EflModule {}
