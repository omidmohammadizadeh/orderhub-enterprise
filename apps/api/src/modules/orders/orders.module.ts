import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { QUEUES } from "@orderhub/shared";
import { OrdersService } from "./orders.service";
import { OrdersController } from "./orders.controller";
import { SocketModule } from "../../infrastructure/socket/socket.module";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUES.ORDER_PROCESSING },
      { name: QUEUES.PRINTING },
    ),
    SocketModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
