import { Module, forwardRef } from "@nestjs/common";
import { PauseController } from "./pause.controller";
import { PauseService } from "./pause.service";
import { HubRiseModule } from "../integrations/hubrise/hubrise.module";
import { DeliverooModule } from "../integrations/deliveroo/deliveroo.module";
import { UberEatsModule } from "../integrations/ubereats/ubereats.module";
import { JetModule } from "../integrations/jet/jet.module";

@Module({
  // Phase BA-2 — DeliverooModule provides DeliverooConnectionService so a
  // pause/resume can close/open the direct Deliveroo store (one-way import,
  // no cycle).
  imports: [
    forwardRef(() => HubRiseModule),
    DeliverooModule,
    UberEatsModule,
    JetModule,
  ],
  controllers: [PauseController],
  providers: [PauseService],
  exports: [PauseService],
})
export class PauseModule {}
