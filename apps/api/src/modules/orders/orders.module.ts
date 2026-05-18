import { Module } from "@nestjs/common";
import { OrdersService } from "./orders.service";
import { OrdersController } from "./orders.controller";
import { SocketModule } from "../../infrastructure/socket/socket.module";
import { AuthModule } from "../auth/auth.module";
import { OutboxModule } from "../outbox/outbox.module";

@Module({
  imports: [
    SocketModule,
    AuthModule,
    OutboxModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
