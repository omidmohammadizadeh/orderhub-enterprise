import { Module } from "@nestjs/common";
import { StuartModule } from "../integrations/stuart/stuart.module";
import { UberDirectModule } from "../integrations/uber-direct/uber-direct.module";
import { JetGoModule } from "../integrations/jet-go/jet-go.module";
import { YangoModule } from "../integrations/yango/yango.module";
import { AutoDispatchController } from "./auto-dispatch.controller";
import { AutoDispatchService } from "./auto-dispatch.service";
import { AutoDispatchCron } from "./auto-dispatch.cron";

// Auto dispatch — rules that book a third-party courier on their own. Sits on
// top of the four courier modules and books through their DispatchServices,
// so nothing imports this module back (no cycle through Orders).
@Module({
  imports: [StuartModule, UberDirectModule, JetGoModule, YangoModule],
  controllers: [AutoDispatchController],
  providers: [AutoDispatchService, AutoDispatchCron],
})
export class AutoDispatchModule {}
