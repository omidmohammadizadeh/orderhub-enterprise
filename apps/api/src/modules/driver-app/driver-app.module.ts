import { Module } from "@nestjs/common";
import { DriverAppController } from "./driver-app.controller";
import { DriverAppService } from "./driver-app.service";

@Module({
  controllers: [DriverAppController],
  providers: [DriverAppService],
  exports: [DriverAppService],
})
export class DriverAppModule {}
