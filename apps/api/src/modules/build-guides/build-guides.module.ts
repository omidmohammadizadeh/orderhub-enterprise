import { Module } from "@nestjs/common";
import { UploadsModule } from "../uploads/uploads.module";
import { BuildGuidesController } from "./build-guides.controller";
import { BuildGuidesService } from "./build-guides.service";

@Module({
  imports: [UploadsModule],
  controllers: [BuildGuidesController],
  providers: [BuildGuidesService],
})
export class BuildGuidesModule {}
