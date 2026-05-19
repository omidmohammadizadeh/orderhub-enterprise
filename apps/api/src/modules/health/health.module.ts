import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { QUEUES } from "@orderhub/shared";
import { HealthController } from "./health.controller";
import { ProductionStartupService } from "./production-startup.service";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { OutboxModule } from "../outbox/outbox.module";
import { IntegrationsModule } from "../integrations/integrations.module";

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue({ name: QUEUES.ORDER_PROCESSING }),
    OutboxModule,
    IntegrationsModule,
  ],
  controllers: [HealthController],
  providers: [ProductionStartupService],
})
export class HealthModule {}
