import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { QUEUES } from "@orderhub/shared";
import { PrintersController } from "./printers.controller";
import { PrintersService } from "./printers.service";
import { PrintQueueService } from "./print-queue.service";
import { SocketModule } from "../../infrastructure/socket/socket.module";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.PRINTING }),
    SocketModule,
  ],
  controllers: [PrintersController],
  providers: [PrintersService, PrintQueueService],
  exports: [PrintQueueService],
})
export class PrintersModule {}
