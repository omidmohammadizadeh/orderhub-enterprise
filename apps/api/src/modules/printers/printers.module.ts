import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { QUEUES } from "@orderhub/shared";
import { PrintersController } from "./printers.controller";
import { PrinterJobsLegacyController } from "./printer-jobs-legacy.controller";
import { PrintersService } from "./printers.service";
import { PrintQueueService } from "./print-queue.service";
import { PrinterHeartbeatCron } from "./printer-heartbeat.cron";
import { SocketModule } from "../../infrastructure/socket/socket.module";

// Phase AS-1 — print engine pieces.
import {
  PrinterStationsController,
  PrintAgentsController,
  PrintJobsController,
} from "./print-engine.controller";
import { PrintRoutingService } from "./print-routing.service";
import { PrintAgentsService } from "./print-agents.service";
import { PrintJobsService } from "./print-jobs.service";
import { PrinterStationsService } from "./printer-stations.service";
import { ServerDirectPrintCron } from "./server-direct.cron";
import { LocationAccessService } from "../../common/access/location-access.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.PRINTING }),
    SocketModule,
  ],
  controllers: [
    PrintersController,
    PrinterJobsLegacyController,
    PrinterStationsController,
    PrintAgentsController,
    PrintJobsController,
  ],
  providers: [
    LocationAccessService,
    PrintersService,
    PrintQueueService,
    PrinterHeartbeatCron,
    PrintRoutingService,
    PrintAgentsService,
    PrintJobsService,
    PrinterStationsService,
    ServerDirectPrintCron,
  ],
  exports: [
    PrintQueueService,
    PrintRoutingService,
    PrintJobsService,
  ],
})
export class PrintersModule {}
