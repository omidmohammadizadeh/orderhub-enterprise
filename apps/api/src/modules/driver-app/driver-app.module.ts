import { Module } from "@nestjs/common";
import { DriverAppController } from "./driver-app.controller";
import { DriverAppService } from "./driver-app.service";
import { HubRiseModule } from "../integrations/hubrise/hubrise.module";
import { ChatModule } from "../chat/chat.module";
import { CustomerPushModule } from "../customer-push/customer-push.module";

@Module({
  // HubRiseModule provides HubRiseOrderSyncService so driver-driven status
  // transitions (out-for-delivery / delivered / failed) propagate back to
  // HubRise. ChatModule provides ChatService for operator + customer chat.
  // ExpoPushService now comes from the global ExpoPushModule.
  // CustomerPushModule tells the customer "on its way / at your door /
  // delivered" when the driver taps those.
  imports: [HubRiseModule, ChatModule, CustomerPushModule],
  controllers: [DriverAppController],
  providers: [DriverAppService],
  exports: [DriverAppService],
})
export class DriverAppModule {}
