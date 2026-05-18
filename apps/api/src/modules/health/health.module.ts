import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { QUEUES } from "@orderhub/shared";
import { HealthController } from "./health.controller";
import { DatabaseModule } from "../../infrastructure/database/database.module";

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue({ name: QUEUES.ORDER_PROCESSING }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}
