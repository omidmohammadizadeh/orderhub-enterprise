import { Module } from "@nestjs/common";
import { DirectOrderingController } from "./direct-ordering.controller";
import { DirectOrderingService } from "./direct-ordering.service";
import { UploadsModule } from "../uploads/uploads.module";

@Module({
  // Rehost an inline hero image on write instead of storing it in a column.
  imports: [UploadsModule],
  controllers: [DirectOrderingController],
  providers: [DirectOrderingService],
  exports: [DirectOrderingService],
})
export class DirectOrderingModule {}
