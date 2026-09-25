import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { QUEUES } from "@orderhub/shared";
import { AdminController } from "./admin.controller";
import { DashboardAccessController } from "./dashboard-access.controller";
import { AdminService } from "./admin.service";
import { DashboardAccessService } from "./dashboard-access.service";
import { DatabaseModule } from "../../infrastructure/database/database.module";

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue(
      { name: QUEUES.ORDER_PROCESSING },
      { name: QUEUES.ORDER_SYNC },
      { name: QUEUES.PRINTING },
    ),
  ],
  controllers: [AdminController, DashboardAccessController],
  providers: [AdminService, DashboardAccessService],
})
export class AdminModule {}
