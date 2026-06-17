import { Module, forwardRef } from "@nestjs/common";
import { PauseController } from "./pause.controller";
import { PauseService } from "./pause.service";
import { HubRiseModule } from "../integrations/hubrise/hubrise.module";

@Module({
  imports: [forwardRef(() => HubRiseModule)],
  controllers: [PauseController],
  providers: [PauseService],
  exports: [PauseService],
})
export class PauseModule {}
