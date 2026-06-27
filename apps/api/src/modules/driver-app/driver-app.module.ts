import { Module } from "@nestjs/common";
import { DriverAppController } from "./driver-app.controller";
import { DriverAppService } from "./driver-app.service";
import { ExpoPushService } from "./expo-push.service";
import { HubRiseModule } from "../integrations/hubrise/hubrise.module";
import { ChatModule } from "../chat/chat.module";

@Module({
  // HubRiseModule provides HubRiseOrderSyncService so driver-driven status
  // transitions (out-for-delivery / delivered / failed) propagate back to
  // HubRise. ChatModule provides ChatService for operator + customer chat.
  imports: [HubRiseModule, ChatModule],
  controllers: [DriverAppController],
  providers: [DriverAppService, ExpoPushService],
  exports: [DriverAppService, ExpoPushService],
})
export class DriverAppModule {}
