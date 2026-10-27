import { Module } from "@nestjs/common";
import { OrderingModule } from "../ordering/ordering.module";
import { DeliveryZonesModule } from "../delivery-zones/delivery-zones.module";
import { PauseModule } from "../pauses/pause.module";
import { UploadsModule } from "../uploads/uploads.module";
import { PaymentsModule } from "../payments/payments.module";
import { ChatModule } from "../chat/chat.module";
import { CustomerPushModule } from "../customer-push/customer-push.module";
import { TelnyxCallControlService } from "../voice/telnyx-call-control.service";
import { EflAdminController, EflAppController, EflListingController } from "./efl.controller";
import { EflService } from "./efl.service";
import { EflApplicationsService } from "./efl-applications.service";
import { EflChecksService } from "./efl-checks";
import { EflHygieneService } from "./efl-hygiene.service";
import { EflAccountService } from "./efl-account.service";
import { EflPresenceService } from "./efl-presence.service";
import { EflCallsService } from "./efl-calls.service";
import { EflCallsController } from "./efl-calls.controller";
import { EflAdsService } from "./efl-ads.service";
import { EflStatementsService } from "./efl-statements.service";
import { EflCampaignsService } from "./efl-campaigns.service";

@Module({
  // Ordering: the menu and the checkout are the storefront's. Delivery zones:
  // the same delivery answer the storefront gives, and shop coordinates.
  imports: [OrderingModule, DeliveryZonesModule, PauseModule, UploadsModule, PaymentsModule, ChatModule, CustomerPushModule],
  controllers: [EflAppController, EflListingController, EflAdminController, EflCallsController],
  providers: [EflService, EflApplicationsService, EflChecksService, EflHygieneService, EflAccountService, EflPresenceService,
    // Its own instance: config only, and the private line shares nothing with
    // the AI phone line but the HTTP client.
    TelnyxCallControlService, EflCallsService, EflAdsService, EflStatementsService, EflCampaignsService],
  exports: [EflService],
})
export class EflModule {}
