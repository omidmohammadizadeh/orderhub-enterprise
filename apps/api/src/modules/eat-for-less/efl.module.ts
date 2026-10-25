import { Module } from "@nestjs/common";
import { OrderingModule } from "../ordering/ordering.module";
import { DeliveryZonesModule } from "../delivery-zones/delivery-zones.module";
import { PauseModule } from "../pauses/pause.module";
import { UploadsModule } from "../uploads/uploads.module";
import { PaymentsModule } from "../payments/payments.module";
import { EflAdminController, EflAppController, EflListingController } from "./efl.controller";
import { EflService } from "./efl.service";
import { EflApplicationsService } from "./efl-applications.service";
import { EflChecksService } from "./efl-checks";
import { EflHygieneService } from "./efl-hygiene.service";
import { EflAccountService } from "./efl-account.service";
import { EflPresenceService } from "./efl-presence.service";

@Module({
  // Ordering: the menu and the checkout are the storefront's. Delivery zones:
  // the same delivery answer the storefront gives, and shop coordinates.
  imports: [OrderingModule, DeliveryZonesModule, PauseModule, UploadsModule, PaymentsModule],
  controllers: [EflAppController, EflListingController, EflAdminController],
  providers: [EflService, EflApplicationsService, EflChecksService, EflHygieneService, EflAccountService, EflPresenceService],
  exports: [EflService],
})
export class EflModule {}
