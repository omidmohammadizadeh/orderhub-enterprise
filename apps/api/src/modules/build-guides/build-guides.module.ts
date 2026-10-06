import { Module } from "@nestjs/common";
import { UploadsModule } from "../uploads/uploads.module";
import { BuildGuidesController } from "./build-guides.controller";
import { AssemblyChartsController } from "./assembly-charts.controller";
import { AssemblyChartsService } from "./assembly-charts.service";
import { BuildGuidesService } from "./build-guides.service";
import { BuildStepLibraryService } from "./build-step-library.service";
import { BuildGuideTrainingService } from "./build-guide-training.service";
import { BuildGuideAiService } from "./build-guide-ai.service";

@Module({
  imports: [UploadsModule],
  controllers: [BuildGuidesController, AssemblyChartsController],
  providers: [BuildGuidesService, BuildStepLibraryService, BuildGuideTrainingService, BuildGuideAiService, AssemblyChartsService],
})
export class BuildGuidesModule {}
