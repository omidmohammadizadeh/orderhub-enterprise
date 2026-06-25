import { Module } from "@nestjs/common";
import { DispatchController } from "./dispatch.controller";
import { DispatchService } from "./dispatch.service";
import { GeocodingService } from "./geocoding.service";

@Module({
  controllers: [DispatchController],
  providers: [DispatchService, GeocodingService],
  exports: [DispatchService, GeocodingService],
})
export class DispatchModule {}
