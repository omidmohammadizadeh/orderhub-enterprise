import { Module } from "@nestjs/common";
import { DirectOrderingController } from "./direct-ordering.controller";
import { DirectOrderingService } from "./direct-ordering.service";

@Module({
  controllers: [DirectOrderingController],
  providers: [DirectOrderingService],
  exports: [DirectOrderingService],
})
export class DirectOrderingModule {}
