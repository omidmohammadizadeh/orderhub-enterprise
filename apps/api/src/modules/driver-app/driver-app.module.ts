import { Module } from "@nestjs/common";
import { DriverAppController } from "./driver-app.controller";
import { DriverAppService } from "./driver-app.service";
import { ExpoPushService } from "./expo-push.service";

@Module({
  controllers: [DriverAppController],
  providers: [DriverAppService, ExpoPushService],
  exports: [DriverAppService, ExpoPushService],
})
export class DriverAppModule {}
