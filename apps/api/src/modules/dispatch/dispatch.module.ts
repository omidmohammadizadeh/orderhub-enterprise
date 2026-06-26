import { Module } from "@nestjs/common";
import { DispatchController } from "./dispatch.controller";
import { DispatchService } from "./dispatch.service";
import { GeocodingService } from "./geocoding.service";
import { DriverAppModule } from "../driver-app/driver-app.module";

@Module({
  imports: [DriverAppModule],
  controllers: [DispatchController],
  providers: [DispatchService, GeocodingService],
  exports: [DispatchService, GeocodingService],
})
export class DispatchModule {}
